/**
 * Recipe vision model fallback chain and the shared recipe-reading prompt.
 *
 * Handwriting is only read reliably by a vision model, and a single model can
 * fail for reasons that have nothing to do with the photo: rate limits, an
 * empty answer, hidden reasoning that eats the output budget, or a truncated
 * JSON body. The scan therefore keeps an ordered list of at most four models
 * and moves to the next one only when the previous *failed*. A successful
 * answer is never replaced because another model "looks more accurate": that
 * is a subjective judgement and would bill the user twice.
 *
 * The built-in candidates are OpenRouter model IDs. They are only used when
 * the endpoint is OpenRouter, so a house on OpenAI, Ollama or LM Studio is
 * never sent an ID that its provider does not know. Any provider can be given
 * an explicit list in Settings → AI → Recipe vision models.
 */
import type { ReasoningRequest } from "./ai-reasoning.js";

/** A recipe scan never tries more than this many models. */
export const MAX_RECIPE_VISION_CHAIN = 4;

/** Output budget for one recipe page (multiple recipes share it). */
export const MAX_RECIPE_VISION_TOKENS = 8192;

export interface RecipeVisionCandidate {
  model: string;
  /**
   * Reasoning override for this candidate. When set it wins over the house
   * setting, because the built-in chain knows that e.g. Qwen3.6 needs thinking
   * turned off to answer at all. Undefined means "use the house setting".
   */
  reasoning?: ReasoningRequest;
}

/**
 * Default chain for OpenRouter. The order comes from the one-photo
 * observations in `docs/recipe-ocr-evaluation.md`: Gemini 3 Flash Preview read
 * the key quantities correctly and was the cheapest correct reading, Qwen3.6
 * 35B is a low-cost alternative that needs reasoning off but made ingredient errors, and
 * Gemini 3.8 Flash read the quantities correctly as a third opinion. The
 * cheaper Gemini 2.5 models are deliberately absent: they misread a `2` as a
 * `9`. This is a starting point, not a measured accuracy ranking.
 */
export const DEFAULT_RECIPE_VISION_MODELS: readonly RecipeVisionCandidate[] = [
  { model: "google/gemini-3-flash-preview" },
  { model: "qwen/qwen3.6-35b-a3b", reasoning: { enabled: false } },
  { model: "google/gemini-3.8-flash" },
];

/** OpenRouter's own hosts, not a lookalike domain. */
export function isOpenRouterBaseUrl(baseUrl: unknown): boolean {
  try {
    const host = new URL(String(baseUrl ?? "")).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

function cleanModelList(values: unknown[]): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const model = value.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
    if (models.length >= MAX_RECIPE_VISION_CHAIN) break;
  }
  return models;
}

/**
 * Read a stored or environment list. `null` means "not configured" so the
 * caller can apply the provider default; an empty list is treated the same
 * way. To remove the extra fallbacks, list only the one model to use.
 *
 * This is the tolerant reader for values that are already stored (or come from
 * the environment): unusable entries are skipped and the list is capped. A
 * settings write goes through `checkRecipeVisionModels` instead, which reports
 * what would be lost so the API can answer 400 rather than silently truncate.
 */
export function parseRecipeVisionModels(value: unknown): string[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return cleanModelList(value);
  if (typeof value === "string") {
    if (!value.trim()) return null;
    return cleanModelList(value.split(","));
  }
  return null;
}

export type RecipeVisionModelsCheck =
  | { ok: true; models: string[] }
  | { ok: false; reason: "invalid" | "too-many"; count: number };

/**
 * Validate a *new* recipe vision model list before it is stored. Unlike
 * `parseRecipeVisionModels` it never guesses: a non-string entry, a value that
 * cannot be a model ID, or more models than the chain can use is an error. An
 * empty list is valid and means "clear the setting".
 */
export function checkRecipeVisionModels(value: unknown): RecipeVisionModelsCheck {
  if (value == null) return { ok: true, models: [] };
  let entries: unknown[];
  if (Array.isArray(value)) entries = value;
  else if (typeof value === "string") entries = value.split(",");
  else return { ok: false, reason: "invalid", count: 0 };

  const seen = new Set<string>();
  const models: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") return { ok: false, reason: "invalid", count: models.length };
    const model = entry.trim();
    if (!model) continue;
    if (model.length > 200 || /\s/.test(model)) return { ok: false, reason: "invalid", count: models.length };
    if (seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  if (models.length > MAX_RECIPE_VISION_CHAIN) return { ok: false, reason: "too-many", count: models.length };
  return { ok: true, models };
}

/**
 * How many usable model IDs a stored/environment list had to drop to fit the
 * chain. Counts every non-empty string (deduplicated) rather than trusting the
 * validator's `count`, so a list that also contains a malformed entry still
 * reports how many valid models were lost.
 */
export function droppedRecipeVisionModels(value: unknown): number {
  let entries: unknown[];
  if (Array.isArray(value)) entries = value;
  else if (typeof value === "string") entries = value.split(",");
  else return 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const model = entry.trim();
    if (model) seen.add(model);
  }
  return Math.max(0, seen.size - MAX_RECIPE_VISION_CHAIN);
}

export interface RecipeVisionChainInput {
  baseUrl: string;
  /** Explicit list from the house or the operator, or null when unset. */
  configured?: string[] | null;
  /** The model a single-model scan would use (`visionModel`). */
  visionModel: string;
  /** True when that model was chosen on purpose instead of inherited from the text model. */
  visionModelExplicit?: boolean;
}

function dedupeCandidates(candidates: RecipeVisionCandidate[]): RecipeVisionCandidate[] {
  const seen = new Set<string>();
  const result: RecipeVisionCandidate[] = [];
  for (const candidate of candidates) {
    const model = candidate.model.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    result.push({ ...candidate, model });
    if (result.length >= MAX_RECIPE_VISION_CHAIN) break;
  }
  return result;
}

/**
 * Resolve the ordered models for one recipe scan.
 *
 * - an explicit list is honoured exactly (and capped at four);
 * - on OpenRouter, a deliberately configured vision model goes first and the
 *   tested defaults follow it, so a successful scan is unchanged; a house
 *   that never picked a vision model gets the default chain;
 * - on every other endpoint only the configured vision model is used, because
 *   the defaults are OpenRouter IDs and another provider would reject them.
 *
 * A single entry is the way to opt out of the extra fallbacks: list only your
 * chosen model in Settings → AI → Recipe vision models.
 */
export function recipeVisionChain(input: RecipeVisionChainInput): RecipeVisionCandidate[] {
  const visionModel = String(input.visionModel ?? "").trim();
  const configured = input.configured ?? null;

  if (configured && configured.length) {
    // An explicit list must not lose a known per-model override: listing the
    // built-in Qwen3.6 ID by hand would otherwise turn thinking back on and the
    // model may answer with nothing but reasoning.
    return dedupeCandidates(
      configured.map((model) => {
        const known = DEFAULT_RECIPE_VISION_MODELS.find((candidate) => candidate.model === model);
        return known?.reasoning ? { model, reasoning: known.reasoning } : { model };
      }),
    );
  }

  if (isOpenRouterBaseUrl(input.baseUrl)) {
    const candidates = [...DEFAULT_RECIPE_VISION_MODELS];
    if (input.visionModelExplicit && visionModel) {
      // An explicit vision model may be one of the built-in candidates, and
      // dropping its override would turn thinking back on for Qwen3.6 — the
      // model can then answer with nothing but reasoning.
      const known = DEFAULT_RECIPE_VISION_MODELS.find((candidate) => candidate.model === visionModel);
      candidates.unshift(known?.reasoning ? { model: visionModel, reasoning: known.reasoning } : { model: visionModel });
    }
    return dedupeCandidates(candidates);
  }

  return visionModel ? [{ model: visionModel }] : [];
}

/* ------------------------------------------------------- shared recipe prompt */

export const RECIPE_SCHEMA = `{
  "title": string,
  "description": string,
  "servings": number | null,
  "prepMinutes": number | null,
  "cookMinutes": number | null,
  "tags": string[],
  "ingredients": [{"name": string, "quantity": number | null, "unit": string | null, "note": string | null, "optional": boolean}],
  "steps": [{"text": string, "timerSeconds": number | null}],
  "notes": string | null
}`;

/** A photographed page may hold more than one recipe. */
export const RECIPE_LIST_SCHEMA = `{
  "recipes": [${RECIPE_SCHEMA}]
}`;

export const RECIPE_ARCHIVIST_SYSTEM =
  "You are a meticulous family-recipe archivist. Turn handwritten recipe scans or raw OCR text into clean, structured JSON. " +
  "When a photo is attached it is the primary source: read the handwriting directly, character by character, and treat any " +
  "OCR text as a weak hint that may be complete nonsense (ruled paper is often misread as Ξ or =). " +
  "Fix OCR mistakes, expand abbreviations (tbsp, tsp, °C), normalise units and split ingredients from steps. " +
  "The source is often a page torn from a Greek diary: ignore the printed planner furniture completely (the hour gutter " +
  "07:00, 08:00 …, weekday and month headings, week numbers, saints' names, printer codes) and never let it reach the title, " +
  "ingredients or steps. Keep the source language exactly as written (Greek stays Greek, English stays English) and keep the " +
  "recipe's own title rather than a margin note. " +
  "Handwritten lists use a ditto mark (», >>, 〃) after a quantity to repeat the unit from the line above, and Greek " +
  "abbreviations such as γραμμ. (grams), φλιτζ. (cup), κουτ. (tbsp), κ.γ. (tsp), κιλ. (kg), λίτρ. (l), τεμ. (pieces), " +
  "ματσ. (bunch); expand them. Join a row that wraps onto the next ruled line back into one ingredient. " +
  "If the page contains more than one recipe, return every recipe separately in recipes[], in page order. Never merge two " +
  "recipes into one list: a second title line starts a new entry. " +
  "Do not invent missing ingredients, quantities, temperatures or instructions. Mark uncertain readings in notes. " +
  "Respond with JSON only, no markdown.";

/**
 * The user half of the recipe request. The server and the developer benchmark
 * share it so a benchmark result describes the real prompt.
 */
export function recipeArchivistPrompt(rawText: string, imageCount = 0): string {
  const images = imageCount > 0;
  const limit = 12000;
  const truncated = rawText.length > limit;
  return (
    `Return every recipe on the page as JSON with this exact shape:\n${RECIPE_LIST_SCHEMA}\n\n` +
    (images
      ? "The page is in the attached photo. Read the handwriting carefully. "
      : "Read the recipe text below. ") +
    (rawText
      ? `\n\n${images ? "OCR TEXT (unreliable — use it only to confirm what you can also see)" : "RECIPE TEXT"}:\n${rawText.slice(0, limit)}` +
        (truncated ? `\n\n[The text was cut off at ${limit} characters.]` : "")
      : "")
  );
}

/* --------------------------------------------------------------- JSON parsing */

export type JsonExtraction =
  | { ok: true; value: unknown; partial?: true }
  | { ok: false; reason: "missing" | "malformed" };

/**
 * Tolerant JSON extraction: accepts a markdown fence, a leading sentence and a
 * body that was cut off after a complete object/array. Shared with the
 * benchmark so both judge the same text the same way.
 *
 * A parse that only covers a prefix of the answer is flagged as `partial` when
 * the remaining text continues the JSON value (`{`, `[`, `,`, `}` or a quote).
 * Trailing prose is not a truncation: "Here you go: {...}. Hope it helps" is a
 * complete answer. A partial result must be treated as a failure by callers
 * that need every recipe on the page, because a cut-off multi-recipe answer can
 * otherwise look like a complete single-recipe one.
 */
export function extractJsonValue(text: string): JsonExtraction {
  let cleaned = String(text ?? "").trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cleaned = fence[1].trim();
  const start = cleaned.search(/[[{]/);
  if (start < 0) return { ok: false, reason: "missing" };
  const candidate = cleaned.slice(start);
  try {
    return { ok: true, value: JSON.parse(candidate) as unknown };
  } catch {
    // find the last closing bracket and retry
    const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
    if (end > 0) {
      try {
        const value = JSON.parse(candidate.slice(0, end + 1)) as unknown;
        const rest = candidate.slice(end + 1).trim();
        const continues = ["[", "{", ",", "]", "}", '"', ":"].some((character) =>
          rest.startsWith(character),
        );
        return continues ? { ok: true, value, partial: true } : { ok: true, value };
      } catch {
        /* fall through */
      }
    }
    return { ok: false, reason: "malformed" };
  }
}

/**
 * Every recipe object from a parsed answer, whether it used `recipes[]`, a
 * top-level array (which models occasionally return despite the schema) or a
 * bare object. Entries that are not objects are ignored.
 */
export function recipeListFromJson(value: unknown): Record<string, unknown>[] {
  const source = Array.isArray(value)
    ? value
    : (value as { recipes?: unknown } | null)?.recipes;
  const list = Array.isArray(source) ? source : [value];
  return list.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
  );
}
