import { AI_ENV } from "./config.js";
import { ApiError } from "./http.js";
import type { HouseSettings } from "../shared/types.js";

export interface AiConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel: string;
}

export function resolveAi(settings: HouseSettings | Record<string, any>): AiConfig {
  const ai = (settings as HouseSettings)?.ai ?? {};
  const apiKey = (ai.apiKey && ai.apiKey !== "***" ? ai.apiKey : AI_ENV.apiKey) || "";
  return {
    enabled: Boolean(apiKey) && ai.enabled !== false,
    baseUrl: (ai.baseUrl || AI_ENV.baseUrl || "").replace(/\/+$/, ""),
    apiKey,
    model: ai.model || AI_ENV.model,
    visionModel: ai.visionModel || AI_ENV.visionModel || ai.model || AI_ENV.model,
  };
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export async function chat(
  cfg: AiConfig,
  opts: {
    system: string;
    user: string;
    images?: string[];
    json?: boolean;
    temperature?: number;
  },
): Promise<string> {
  if (!cfg.enabled) throw new ApiError(400, "No AI provider configured");
  const content: string | ContentPart[] = opts.images?.length
    ? [
        { type: "text", text: opts.user },
        ...opts.images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
      ]
    : opts.user;

  const body: Record<string, unknown> = {
    model: opts.images?.length ? cfg.visionModel : cfg.model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content },
    ],
    temperature: opts.temperature ?? 0.2,
  };
  if (opts.json) body.response_format = { type: "json_object" };

  const attempt = async (withJson: boolean) => {
    const payload = { ...body };
    if (!withJson) delete payload.response_format;
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false as const, status: res.status, text: text.slice(0, 500) };
    }
    const data: any = await res.json();
    const message = data?.choices?.[0]?.message?.content;
    const text =
      typeof message === "string"
        ? message
        : Array.isArray(message)
          ? message.map((p: any) => p?.text ?? "").join("\n")
          : "";
    return { ok: true as const, text };
  };

  let result = await attempt(Boolean(opts.json)).catch((err) => ({
    ok: false as const,
    status: 0,
    text: err instanceof Error ? err.message : "network error",
  }));
  if (!result.ok && opts.json && result.status >= 400 && result.status < 500) {
    result = await attempt(false).catch((err) => ({
      ok: false as const,
      status: 0,
      text: err instanceof Error ? err.message : "network error",
    }));
  }
  if (!result.ok) {
    throw new ApiError(502, `AI provider error (${result.status}): ${result.text || "no response"}`);
  }
  if (!result.text.trim()) throw new ApiError(502, "AI provider returned an empty answer");
  return result.text;
}

export function extractJson<T = any>(text: string): T {
  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cleaned = fence[1].trim();
  const start = cleaned.search(/[[{]/);
  if (start < 0) throw new ApiError(502, "AI did not return JSON");
  const candidate = cleaned.slice(start);
  try {
    return JSON.parse(candidate) as T;
  } catch {
    // find the last closing bracket and retry
    const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
    if (end > 0) {
      try {
        return JSON.parse(candidate.slice(0, end + 1)) as T;
      } catch {
        /* fall through */
      }
    }
    throw new ApiError(502, "AI returned malformed JSON");
  }
}

export const RECEIPT_SCHEMA = `{
  "vendorName": string | null,
  "purchasedAt": string | null (YYYY-MM-DD),
  "currency": string | null (ISO 4217),
  "total": number | null,
  "subtotal": number | null,
  "tax": number | null,
  "taxBreakdown": [{"rate": number | null, "net": number, "tax": number, "gross": number}],
  "savings": number | null,
  "lines": [{"description": string, "quantity": number, "unit": string | null, "unitPrice": number | null, "lineTotal": number | null, "discount": number | null}],
  "notes": string | null
}`;

export async function aiParseReceipt(
  cfg: AiConfig,
  rawText: string,
  images: string[] = [],
): Promise<Record<string, unknown>> {
  const text = await chat(cfg, {
    system:
      "You are a meticulous receipt archivist for a home inventory. Turn shopping-receipt scans or raw OCR text into clean JSON. " +
      "Read the shop name, purchase date, currency, total, net subtotal, VAT/tax and every purchased product line. " +
      "When the receipt prints VAT rates, fill taxBreakdown with one entry per rate (net, tax and gross for that rate); " +
      "otherwise use an empty array. Never invent products, prices, taxes or lines that are not present. Ignore payment, " +
      "loyalty, change and cashier lines. Discount and savings lines are not products: put a product's own discount in " +
      "that line's discount field and sum every discount into savings, or use null when the receipt prints none. " +
      "Keep product names as printed (expand only obvious abbreviations), include pack " +
      "sizes in the description, and put the purchased amount in quantity/unit when the receipt states it (2 pcs, 1.5 kg, " +
      "750 ml). Use unitPrice per single selling unit and lineTotal for the printed line total. If a value is unreadable, " +
      "return null instead of guessing. Respond with JSON only, no markdown.",
    user:
      `Extract this shopping receipt into JSON with this exact shape:\n${RECEIPT_SCHEMA}\n\n` +
      (rawText ? `RAW OCR TEXT:\n${rawText.slice(0, 12000)}` : "The receipt is in the attached image. Read it carefully."),
    images,
    json: true,
    temperature: 0.1,
  });
  return extractJson<Record<string, unknown>>(text);
}

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

export async function aiCleanRecipe(
  cfg: AiConfig,
  rawText: string,
  images: string[] = [],
): Promise<Record<string, unknown>> {
  const text = await chat(cfg, {
    system:
      "You are a meticulous family-recipe archivist. Turn handwritten recipe scans or raw OCR text into clean, structured JSON. " +
      "Fix OCR mistakes, expand abbreviations (tbsp, tsp, °C), normalise units and split ingredients from steps. " +
      "You may infer obvious missing details (preheat temperature, resting time, pan size) but never invent ingredients that are not present. " +
      "List every inference in notes. Write steps so a beginner can follow them, one action per step. Respond with JSON only, no markdown.",
    user:
      `Structure this recipe into JSON with this exact shape:\n${RECIPE_SCHEMA}\n\n` +
      (rawText ? `RAW TEXT:\n${rawText.slice(0, 12000)}` : "The recipe is in the attached image. Read it carefully."),
    images,
    json: true,
    temperature: 0.1,
  });
  return extractJson<Record<string, unknown>>(text);
}

export async function aiCompleteRecipe(cfg: AiConfig, recipe: unknown): Promise<Record<string, unknown>> {
  const text = await chat(cfg, {
    system:
      "You are a recipe editor restoring an old family recipe. Improve the given JSON: fill missing quantities and units, " +
      "fix unclear or out-of-order steps, add missing temperatures and timings, and add short practical tips. " +
      "Keep the original spirit and ingredients; only add very common staples when obviously required. " +
      "Return the same JSON shape plus 'notes' describing what you changed. Respond with JSON only.",
    user: `Recipe JSON:\n${JSON.stringify(recipe).slice(0, 12000)}\n\nReturn JSON with this shape:\n${RECIPE_SCHEMA}`,
    json: true,
    temperature: 0.2,
  });
  return extractJson<Record<string, unknown>>(text);
}

export async function aiSuggestIdeas(
  cfg: AiConfig,
  inventory: { name: string; quantity: number; unit: string; category?: string | null }[],
  recipes: { id: string; title: string; ingredients: string[] }[],
  prompt: string,
): Promise<Record<string, unknown>> {
  const inventoryText = inventory
    .slice(0, 150)
    .map((i) => `- ${i.name} (${Math.round(i.quantity * 100) / 100} ${i.unit}${i.category ? `, ${i.category}` : ""})`)
    .join("\n");
  const recipeText = recipes
    .slice(0, 25)
    .map((r) => `- ${r.title}: ${r.ingredients.join(", ")}`)
    .join("\n");

  const text = await chat(cfg, {
    system:
      "You are a practical home cook helping someone cook from what they already own. Suggest 3-5 realistic meals. " +
      "Prefer the saved recipes when they fit. Be honest about missing ingredients and keep missing lists short (only essentials). " +
      "Respect dietary requests. Steps must be short and actionable. Respond with JSON only.",
    user:
      `WHAT IS AT HOME:\n${inventoryText || "(nothing recorded)"}\n\nSAVED RECIPES:\n${recipeText || "(none)"}\n\n` +
      `REQUEST: ${prompt || "Any nice meal ideas for today"}\n\n` +
      `Return JSON: {"summary": string, "ideas": [{"title": string, "rationale": string, "timeMinutes": number|null, "servings": number|null, ` +
      `"uses": [{"name": string, "quantity": number|null, "unit": string|null}], "missing": [{"name": string, "quantity": number|null, "unit": string|null}], ` +
      `"steps": string[], "recipeId": string|null}]}`,
    json: true,
    temperature: 0.7,
  });
  return extractJson<Record<string, unknown>>(text);
}

/** Convert a local upload into a data URL for vision models. */
export async function fileToDataUrl(filePath: string, mime: string): Promise<string | null> {
  const fs = await import("node:fs/promises");
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || stat.size > 8 * 1024 * 1024) return null;
  const buf = await fs.readFile(filePath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}
