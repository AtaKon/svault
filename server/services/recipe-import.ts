import { OutboundBlockedError, fetchOutbound } from "../lib/outbound.js";
import { heuristicRecipe, parseIngredientLine, type ParsedRecipe } from "./recipe-local.js";

/**
 * Recipe import from a pasted link.
 *
 * Most recipe sites publish schema.org `Recipe` JSON-LD, which gives clean
 * ingredients, steps, yield and timing. When that is missing we fall back to a
 * tolerant text read of the page so the user still gets an editable draft.
 */

const MAX_RESPONSE_BYTES = 3_000_000;
const MAX_HTML_CHARS = 600_000;
const FETCH_TIMEOUT_MS = 15_000;

export type ImportProvider = "structured" | "html";

export interface RecipeImportResult {
  draft: ParsedRecipe;
  provider: ImportProvider;
  /** Human-readable note when the import was not fully structured. */
  warning: string | null;
  /** Page text, truncated, for an optional AI clean-up pass. */
  textForAi: string;
  /** Remote cover image advertised by the page, if any. */
  image: string | null;
  sourceUrl: string;
  pageTitle: string | null;
}

export class RecipeImportError extends Error {}

/** Accept "example.com/recipe" as well as a full URL. */
export function normaliseRecipeUrl(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) throw new RecipeImportError("Paste a link to the recipe first");
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new RecipeImportError("That does not look like a valid link");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RecipeImportError("The recipe link must start with http:// or https://");
  }
  url.hash = "";
  return url.toString();
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  deg: "°",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
};

/** Decode the handful of HTML entities that show up in recipe copy. */
export function decodeEntities(value: string): string {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_match, dec: string) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&([a-z][a-z0-9]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

function stripHtml(value: unknown): string {
  const text = decodeEntities(String(value ?? ""));
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const cleaned = stripHtml(value).replace(/\s+/g, " ").trim();
  return cleaned || null;
}

function firstString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstString(entry);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return firstString(record.url ?? record["@id"] ?? record.contentUrl ?? record.name);
  }
  return null;
}

/** Parse ISO-8601 durations such as PT1H30M. */
export function isoDurationMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const total = days * 1440 + hours * 60 + minutes + Math.round(seconds / 60);
  return total > 0 ? total : null;
}

/** Read a numeric yield from "4", "4 servings", ["4", "6"] or an object. */
export function parseRecipeYield(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate === "object" && candidate) {
    return parseRecipeYield((candidate as Record<string, unknown>).value);
  }
  const match = String(candidate).match(/\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0].replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function stepTimerSeconds(value: string): number | null {
  const hours = value.match(/(\d+(?:[.,]\d+)?)\s*(?:hours?|hrs?|ώρες|ωρεσ)/i);
  if (hours) return Math.round(Number.parseFloat(hours[1].replace(",", ".")) * 3600);
  const minutes = value.match(/(\d+)\s*(?:minutes?|mins?|λεπτά|λεπτα)/i);
  if (minutes) return Number(minutes[1]) * 60;
  return null;
}

function pushInstruction(value: unknown, steps: ParsedRecipe["steps"], depth = 0): void {
  if (depth > 6 || value == null) return;
  if (typeof value === "string") {
    for (const line of stripHtml(value).split(/\n+/)) {
      const body = line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim();
      if (body) steps.push({ text: body.slice(0, 4000), timerSeconds: stepTimerSeconds(body) });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) pushInstruction(entry, steps, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const type = String(record["@type"] ?? "");
  if (/HowToSection/i.test(type) || Array.isArray(record.itemListElement)) {
    pushInstruction(record.itemListElement, steps, depth + 1);
    return;
  }
  const body = record.text ?? record.name ?? record.description;
  if (body != null) pushInstruction(body, steps, depth + 1);
}

function gatherNodes(value: unknown, found: Record<string, unknown>[], depth = 0): void {
  if (depth > 8 || value == null) return;
  if (Array.isArray(value)) {
    for (const entry of value) gatherNodes(entry, found, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const type = record["@type"];
  const types = Array.isArray(type) ? type.map(String) : [String(type ?? "")];
  if (types.some((entry) => /(^|\/)Recipe$/i.test(entry.trim()))) found.push(record);
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement"]) {
    if (key in record) gatherNodes(record[key], found, depth + 1);
  }
}

/** Split a block that holds several concatenated JSON objects. */
function splitJsonObjects(body: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        parts.push(body.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return parts.length ? parts : null;
}

/** Pull every parseable JSON-LD block from the page. */
export function readJsonLd(html: string): unknown[] {
  const blocks: unknown[] = [];
  const pattern = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    let body = match[1].replace(/^\s*<!--/, "").replace(/-->\s*$/, "").trim();
    if (!body) continue;
    try {
      blocks.push(JSON.parse(body));
      continue;
    } catch {
      /* try the next repair step */
    }
    // Trailing commas are the most common breakage.
    body = body.replace(/,\s*([}\]])/g, "$1");
    try {
      blocks.push(JSON.parse(body));
      continue;
    } catch {
      /* try the next repair step */
    }
    // Some sites emit several objects in one script tag.
    for (const part of splitJsonObjects(body) ?? []) {
      try {
        blocks.push(JSON.parse(part.replace(/,\s*([}\]])/g, "$1")));
      } catch {
        /* ignore malformed fragments */
      }
    }
  }
  return blocks;
}

function fromJsonLd(node: Record<string, unknown>, pageTitle: string | null): ParsedRecipe {
  const title = text(node.name) ?? pageTitle ?? "Imported recipe";
  const description = text(node.description);

  const rawIngredients = Array.isArray(node.recipeIngredient)
    ? node.recipeIngredient
    : Array.isArray(node.ingredients)
      ? node.ingredients
      : [];
  const ingredients = rawIngredients
    .map((entry) => (typeof entry === "string" ? entry : text((entry as any)?.name ?? entry)))
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => {
      const parsed = parseIngredientLine(entry);
      if (parsed) return { ...parsed, raw: entry };
      return {
        raw: entry,
        name: entry.slice(0, 120),
        quantity: null,
        unit: null,
        itemId: null,
        optional: false,
        note: null,
      };
    })
    .slice(0, 80);

  const steps: ParsedRecipe["steps"] = [];
  pushInstruction(node.recipeInstructions ?? node.instructions, steps);

  const tags: string[] = [];
  const addTags = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const entry of value) addTags(entry);
      return;
    }
    if (typeof value !== "string") return;
    for (const tag of value.split(/[,;|]/)) {
      const cleaned = tag.trim().toLowerCase().slice(0, 30);
      if (cleaned && !tags.includes(cleaned) && tags.length < 8) tags.push(cleaned);
    }
  };
  addTags(node.keywords);
  addTags(node.recipeCategory);
  addTags(node.recipeCuisine);

  const prepMinutes = isoDurationMinutes(node.prepTime);
  const cookMinutes = isoDurationMinutes(node.cookTime);
  const totalMinutes = isoDurationMinutes(node.totalTime);
  const notes = text(node.tips ?? node.notes);

  return {
    title: title.slice(0, 160),
    description: description?.slice(0, 1200) ?? null,
    servings: parseRecipeYield(node.recipeYield ?? node.yield),
    prepMinutes,
    cookMinutes: cookMinutes ?? (prepMinutes == null ? totalMinutes : null),
    tags,
    ingredients,
    steps: steps.slice(0, 60),
    notes: notes?.slice(0, 1200) ?? null,
  };
}

function metaContent(html: string, property: string): string | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*content\\s*=\\s*["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${escaped}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeEntities(match[1]).trim() || null;
  }
  return null;
}

function pageTitle(html: string): string | null {
  return metaContent(html, "og:title") ?? text(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]) ?? null;
}

/**
 * Resolve relative cover images against the page that advertised them. The
 * result is saved as the recipe image, which elsewhere accepts only the house's
 * uploads or an http(s) link, so any other scheme (javascript:, data:, file:)
 * or an unparsable or oversized value is dropped.
 */
function absoluteUrl(value: string | null, base: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const text = url.toString();
    return text.length <= 2000 ? text : null;
  } catch {
    return null;
  }
}

/** Strip scripts, styles and markup so the heuristic parser only sees copy. */
export function readablePageText(html: string): string {
  const withoutHead = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  return stripHtml(withoutHead).slice(0, 30_000);
}

/** Turn a fetched page into an editable recipe draft. */
export function parseRecipePage(html: string, sourceUrl: string): RecipeImportResult {
  const title = pageTitle(html);
  const image = absoluteUrl(firstString(metaContent(html, "og:image")), sourceUrl);
  const nodes: Record<string, unknown>[] = [];
  for (const block of readJsonLd(html)) gatherNodes(block, nodes);

  const node = nodes.find((entry) => Array.isArray(entry.recipeIngredient) || entry.recipeInstructions) ?? nodes[0];
  if (node) {
    const draft = fromJsonLd(node, title);
    // A structured recipe with neither ingredients nor steps is not useful.
    if (draft.ingredients.length || draft.steps.length) {
      return {
        draft,
        provider: "structured",
        warning: null,
        textForAi: `${draft.title}\n\n${draft.ingredients.map((i) => i.raw).join("\n")}\n\n${draft.steps.map((s) => s.text).join("\n")}`,
        image: absoluteUrl(firstString(node.image), sourceUrl) ?? image,
        sourceUrl,
        pageTitle: title,
      };
    }
  }

  const textForAi = readablePageText(html);
  const draft = heuristicRecipe(textForAi, title ?? "Imported recipe");
  if (!draft.description) draft.description = metaContent(html, "og:description") ?? metaContent(html, "description");
  return {
    draft,
    provider: "html",
    warning: "No structured recipe data was found on the page, so this is a rough text read. Check the ingredients and steps before saving.",
    textForAi,
    image,
    sourceUrl,
    pageTitle: title,
  };
}

/** Fetch a recipe page with time, size and network guards. */
export async function importRecipeFromUrl(rawUrl: string): Promise<RecipeImportResult> {
  const requestedUrl = normaliseRecipeUrl(rawUrl);

  let response: Response;
  // The final URL after redirects is what the recipe remembers, so a site that
  // bounces http -> https or adds www still stores a link that opens.
  let sourceUrl: string;
  try {
    const fetched = await fetchOutbound(requestedUrl, {
      label: "The recipe link",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5",
        "accept-language": "en,el;q=0.8",
        "user-agent": "SVaultRecipeImporter/1.0",
      },
    });
    response = fetched.response;
    sourceUrl = fetched.url;
  } catch (error) {
    if (error instanceof OutboundBlockedError) throw new RecipeImportError(error.message);
    const reason = error instanceof Error && error.name === "TimeoutError" ? "it took too long to answer" : "it could not be reached";
    throw new RecipeImportError(`Could not open the recipe link — ${reason}.`);
  }

  if (!response.ok) {
    throw new RecipeImportError(`The site answered with ${response.status}. Try opening the recipe in a browser, then copy the text instead.`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !/(text\/html|application\/xhtml\+xml|text\/plain|application\/ld\+json)/i.test(contentType)) {
    throw new RecipeImportError("That link is not a web page with a recipe.");
  }

  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new RecipeImportError("That page is too large to import.");
  }

  // Content-Length may be absent or describe compressed bytes. Enforce the
  // limit on the decoded response stream before buffering it in memory.
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new RecipeImportError("That page is too large to import.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const html = new TextDecoder().decode(Buffer.concat(chunks)).slice(0, MAX_HTML_CHARS);
  if (!html.trim()) throw new RecipeImportError("The recipe link returned an empty page.");
  return parseRecipePage(html, sourceUrl);
}
