import { AI_ENV, AI_LOG_PREVIEW_CHARS } from "./config.js";
import { ApiError } from "./http.js";
import { recordAiCall } from "./services/ai-logs.js";
import { OutboundBlockedError, assertOutboundUrl, outboundRedirectMode } from "./lib/outbound.js";
import type { HouseSettings } from "../shared/types.js";

/** Extra context attached to the AI audit trail. */
export interface AiCallContext {
  operation: string;
  houseId?: string | null;
  userId?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AiConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel: string;
  /** USD per 1M prompt tokens. Used when the provider does not report a price. */
  inputPrice: number | null;
  /** USD per 1M completion tokens. Used when the provider does not report a price. */
  outputPrice: number | null;
  /** True when the house points at its own endpoint instead of the server's default. */
  customEndpoint: boolean;
}

/** What an AI call cost, in USD, plus the token counts it was billed for. */
export interface AiUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Provider-reported or estimated price in USD, rounded to micro-dollars. */
  cost: number | null;
}

export interface AiResult<T> {
  data: T;
  usage: AiUsage;
}

function optionalPrice(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Compare endpoints without caring about trailing slashes or host case. */
export function normaliseBaseUrl(value: unknown): string {
  const trimmed = String(value ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}`.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

/**
 * Resolve the provider for a house. The server's own key (OPENAI_API_KEY) is
 * only ever sent to the server's own base URL: a house that points SVault at
 * a different endpoint must bring its own key, or the endpoint must be a
 * keyless local one (Ollama, LM Studio) that the house explicitly enabled.
 */
export function resolveAi(settings: HouseSettings | Record<string, any>): AiConfig {
  const ai = (settings as HouseSettings)?.ai ?? {};
  const houseBase = String(ai.baseUrl ?? "").trim().replace(/\/+$/, "");
  const envBase = String(AI_ENV.baseUrl ?? "").trim().replace(/\/+$/, "");
  const customEndpoint = Boolean(houseBase) && normaliseBaseUrl(houseBase) !== normaliseBaseUrl(envBase);
  const houseKey = ai.apiKey && ai.apiKey !== "***" ? String(ai.apiKey) : "";
  const apiKey = houseKey || (customEndpoint ? "" : AI_ENV.apiKey) || "";
  const enabled = ai.enabled !== false && (Boolean(apiKey) || (customEndpoint && ai.enabled === true));
  return {
    enabled,
    baseUrl: houseBase || envBase,
    apiKey,
    model: ai.model || AI_ENV.model,
    visionModel: ai.visionModel || AI_ENV.visionModel || ai.model || AI_ENV.model,
    inputPrice: optionalPrice(ai.inputPrice) ?? AI_ENV.inputPrice,
    outputPrice: optionalPrice(ai.outputPrice) ?? AI_ENV.outputPrice,
    customEndpoint,
  };
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** Strip credentials and query strings before storing an endpoint in a log. */
function providerLabel(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.host}${url.pathname.replace(/\/+$/, "")}`.slice(0, 200);
  } catch {
    return (baseUrl || "").replace(/\/+$/, "").slice(0, 200);
  }
}

function previewRequest(system: string, user: string): string {
  const joined = [`SYSTEM:\n${system}`, `USER:\n${user}`].join("\n\n");
  return joined.length <= AI_LOG_PREVIEW_CHARS ? joined : joined.slice(0, AI_LOG_PREVIEW_CHARS);
}

export async function chat(
  cfg: AiConfig,
  opts: {
    system: string;
    user: string;
    images?: string[];
    json?: boolean;
    temperature?: number;
  },
  ctx: AiCallContext = { operation: "chat" },
): Promise<{ text: string; usage: AiUsage }> {
  if (!cfg.enabled) throw new ApiError(400, "No AI provider configured");
  if (cfg.customEndpoint) {
    try {
      await assertOutboundUrl(cfg.baseUrl, "The AI base URL");
    } catch (error) {
      if (error instanceof OutboundBlockedError) throw new ApiError(400, error.message);
      throw error;
    }
  }

  const startedAt = Date.now();
  const content: string | ContentPart[] = opts.images?.length
    ? [
        { type: "text", text: opts.user },
        ...opts.images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
      ]
    : opts.user;

  const model = opts.images?.length ? cfg.visionModel : cfg.model;
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content },
    ],
    temperature: opts.temperature ?? 0.2,
  };
  if (opts.json) body.response_format = { type: "json_object" };

  let attempts = 0;
  let lastStatus: number | null = null;
  let lastError: string | null = null;
  let responseText = "";
  let requestBytes = 0;
  let responseBytes = 0;

  const attempt = async (withJson: boolean) => {
    attempts += 1;
    const payload = { ...body };
    if (!withJson) delete payload.response_format;
    const payloadText = JSON.stringify(payload);
    requestBytes = Math.max(requestBytes, payloadText.length);
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: payloadText,
      redirect: cfg.customEndpoint ? outboundRedirectMode() : "follow",
      signal: AbortSignal.timeout(90_000),
    });
    lastStatus = res.status;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      lastError = `AI provider error (${res.status}): ${text.slice(0, 500) || "no response"}`;
      return { ok: false as const, status: res.status, text: text.slice(0, 2000) };
    }
    const raw = await res.text().catch(() => "");
    responseBytes = Math.max(responseBytes, raw.length);
    let data: any;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      lastError = "AI provider returned invalid JSON";
      return { ok: false as const, status: res.status, text: raw.slice(0, 2000) };
    }
    const message = data?.choices?.[0]?.message?.content;
    const text =
      typeof message === "string"
        ? message
        : Array.isArray(message)
          ? message.map((p: any) => p?.text ?? "").join("\n")
          : "";
    lastError = null;
    return { ok: true as const, text, rawUsage: data?.usage, model: data?.model || model };
  };

  const metadata: Record<string, unknown> = {
    ...(ctx.metadata ?? {}),
    json: Boolean(opts.json),
    temperature: opts.temperature ?? 0.2,
    hasImages: Boolean(opts.images?.length),
    systemChars: opts.system.length,
    userChars: opts.user.length,
    ...(ctx.targetId ? { targetId: ctx.targetId } : {}),
  };

  let result = await attempt(Boolean(opts.json)).catch((err) => {
    lastStatus = 0;
    lastError = err instanceof Error ? err.message : "network error";
    return { ok: false as const, status: 0, text: lastError ?? "network error" };
  });
  if (!result.ok && opts.json && result.status >= 400 && result.status < 500) {
    result = await attempt(false).catch((err) => {
      lastStatus = 0;
      lastError = err instanceof Error ? err.message : "network error";
      return { ok: false as const, status: 0, text: lastError ?? "network error" };
    });
  }
  responseText = result.text ?? "";

  try {
    if (!result.ok) {
      throw new ApiError(502, `AI provider error (${result.status}): ${result.text || "no response"}`);
    }
    if (!result.text.trim()) {
      lastError = "AI provider returned an empty answer";
      throw new ApiError(502, lastError);
    }
    const usage = buildUsage(result.rawUsage, result.model, cfg);
    await recordAiCall({
      houseId: ctx.houseId,
      userId: ctx.userId,
      operation: ctx.operation,
      provider: providerLabel(cfg.baseUrl),
      model: usage.model,
      status: "ok",
      httpStatus: lastStatus,
      attempts,
      durationMs: Date.now() - startedAt,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      cost: usage.cost,
      imageCount: opts.images?.length ?? 0,
      requestBytes,
      responseBytes,
      requestPreview: previewRequest(opts.system, opts.user),
      responsePreview: result.text,
      metadata,
    });
    return { text: result.text, usage };
  } catch (error) {
    await recordAiCall({
      houseId: ctx.houseId,
      userId: ctx.userId,
      operation: ctx.operation,
      provider: providerLabel(cfg.baseUrl),
      model,
      status: "error",
      httpStatus: lastStatus,
      attempts,
      durationMs: Date.now() - startedAt,
      imageCount: opts.images?.length ?? 0,
      requestBytes,
      responseBytes,
      requestPreview: previewRequest(opts.system, opts.user),
      responsePreview: responseText.slice(0, AI_LOG_PREVIEW_CHARS),
      error: error instanceof Error ? error.message : lastError ?? "AI call failed",
      metadata,
    });
    throw error;
  }
}

function roundCost(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Work out what a call cost. Providers such as OpenRouter return the exact
 * charge on `usage.cost`; other OpenAI-compatible endpoints only report token
 * counts, so fall back to the per-house prices when they are configured.
 */
function buildUsage(raw: any, model: string, cfg: AiConfig): AiUsage {
  const promptTokens = Math.max(0, Math.round(Number(raw?.prompt_tokens ?? 0) || 0));
  const completionTokens = Math.max(0, Math.round(Number(raw?.completion_tokens ?? 0) || 0));
  const totalTokens = Math.max(
    promptTokens + completionTokens,
    Math.round(Number(raw?.total_tokens ?? 0) || 0),
  );

  let cost: number | null = null;
  const reported = raw?.cost ?? raw?.total_cost;
  if (reported != null) {
    const parsed = Number(reported);
    if (Number.isFinite(parsed) && parsed >= 0) cost = roundCost(parsed);
  }
  if (cost == null && (cfg.inputPrice != null || cfg.outputPrice != null)) {
    cost = roundCost(
      (promptTokens * (cfg.inputPrice ?? 0) + completionTokens * (cfg.outputPrice ?? 0)) / 1_000_000,
    );
  }

  return { model, promptTokens, completionTokens, totalTokens, cost };
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
  ctx: AiCallContext = { operation: "receipt.scan" },
): Promise<AiResult<Record<string, unknown>>> {
  const { text, usage } = await chat(cfg, {
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
  }, ctx);
  return { data: extractJson<Record<string, unknown>>(text), usage };
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
  ctx: AiCallContext = { operation: "recipe.scan" },
): Promise<AiResult<Record<string, unknown>>> {
  const { text, usage } = await chat(cfg, {
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
  }, ctx);
  return { data: extractJson<Record<string, unknown>>(text), usage };
}

export async function aiCompleteRecipe(
  cfg: AiConfig,
  recipe: unknown,
  ctx: AiCallContext = { operation: "recipe.complete" },
): Promise<AiResult<Record<string, unknown>>> {
  const { text, usage } = await chat(cfg, {
    system:
      "You are a recipe editor restoring an old family recipe. Improve the given JSON: fill missing quantities and units, " +
      "fix unclear or out-of-order steps, add missing temperatures and timings, and add short practical tips. " +
      "Keep the original spirit and ingredients; only add very common staples when obviously required. " +
      "Return the same JSON shape plus 'notes' describing what you changed. Respond with JSON only.",
    user: `Recipe JSON:\n${JSON.stringify(recipe).slice(0, 12000)}\n\nReturn JSON with this shape:\n${RECIPE_SCHEMA}`,
    json: true,
    temperature: 0.2,
  }, ctx);
  return { data: extractJson<Record<string, unknown>>(text), usage };
}

export async function aiSuggestIdeas(
  cfg: AiConfig,
  inventory: { name: string; quantity: number; unit: string; category?: string | null }[],
  recipes: { id: string; title: string; ingredients: string[] }[],
  prompt: string,
  ctx: AiCallContext = { operation: "ideas.suggest" },
): Promise<AiResult<Record<string, unknown>>> {
  const inventoryText = inventory
    .slice(0, 150)
    .map((i) => `- ${i.name} (${Math.round(i.quantity * 100) / 100} ${i.unit}${i.category ? `, ${i.category}` : ""})`)
    .join("\n");
  const recipeText = recipes
    .slice(0, 25)
    .map((r) => `- ${r.title}: ${r.ingredients.join(", ")}`)
    .join("\n");

  const { text, usage } = await chat(cfg, {
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
  }, ctx);
  return { data: extractJson<Record<string, unknown>>(text), usage };
}

/** Convert a local upload into a data URL for vision models. */
export async function fileToDataUrl(filePath: string, mime: string): Promise<string | null> {
  const fs = await import("node:fs/promises");
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || stat.size > 8 * 1024 * 1024) return null;
  const buf = await fs.readFile(filePath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}
