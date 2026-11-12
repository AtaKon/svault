import { AI_ENV, AI_LOG_PREVIEW_CHARS } from "./config.js";
import { ApiError } from "./http.js";
import { recordAiCall } from "./services/ai-logs.js";
import { OutboundBlockedError, assertOutboundUrl, outboundRedirectMode } from "./lib/outbound.js";
import {
  canRetryRecipeReasoningOff,
  normaliseRecipeReasoning,
  reasoningRequestFor,
  supportsReasoningControl,
  type RecipeReasoningMode,
  type ReasoningRequest,
} from "../shared/ai-reasoning.js";
import {
  MAX_RECIPE_VISION_CHAIN,
  MAX_RECIPE_VISION_TOKENS,
  RECIPE_ARCHIVIST_SYSTEM,
  RECIPE_LIST_SCHEMA,
  RECIPE_SCHEMA,
  droppedRecipeVisionModels,
  extractJsonValue,
  parseRecipeVisionModels,
  recipeArchivistPrompt,
  recipeListFromJson,
  recipeVisionChain,
  type RecipeVisionCandidate,
} from "../shared/recipe-vision.js";
import { MAX_VISION_IMAGE_BYTES, imageMimeForPathName } from "../shared/vision-image.js";
import type { HouseSettings } from "../shared/types.js";

export { MAX_VISION_IMAGE_BYTES, RECIPE_ARCHIVIST_SYSTEM, RECIPE_LIST_SCHEMA, RECIPE_SCHEMA };

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
  /** True when `visionModel` was chosen deliberately instead of inherited from the text model. */
  visionModelExplicit: boolean;
  /** Ordered models a recipe scan may use, at most four. */
  recipeVisionCandidates: RecipeVisionCandidate[];
  /**
   * Set when the configured list was longer than the chain cap, so the caller
   * can tell the operator which models were dropped instead of losing them
   * silently.
   */
  recipeVisionWarning: string | null;
  /** USD per 1M prompt tokens. Used when the provider does not report a price. */
  inputPrice: number | null;
  /** USD per 1M completion tokens. Used when the provider does not report a price. */
  outputPrice: number | null;
  /** True when the house points at its own endpoint instead of the server's default. */
  customEndpoint: boolean;
  /** Recipe-only reasoning setting. `auto` sends no provider-specific field. */
  recipeReasoning: RecipeReasoningMode;
  /** True when the endpoint is OpenRouter, whose API accepts the `reasoning` field. */
  reasoningControl: boolean;
}

/** What an AI call cost, in USD, plus the token counts it was billed for. */
export interface AiUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Completion tokens the provider spent on hidden reasoning, when reported. */
  reasoningTokens: number;
  /** Provider-reported or estimated price in USD, rounded to micro-dollars. */
  cost: number | null;
}

export interface AiResult<T> {
  data: T;
  usage: AiUsage;
  /** Plain-language notes the caller can show to the user (retries, truncation). */
  notes?: string[];
  /**
   * True when the provider said the answer was cut off at the output limit but
   * the text still parsed. The data is a best-effort partial read, so a caller
   * that persists it must warn the user (or refuse an unattended save).
   */
  truncated?: boolean;
  /** Model that produced the answer, when a fallback chain was used. */
  model?: string;
  /** Every model the call tried, in order. */
  models?: string[];
}

/**
 * The provider stopped before writing an answer. `reasoning` means the output
 * budget went to hidden thinking; `truncated` means the token limit cut the
 * answer off. Both are recoverable by retrying with reasoning disabled.
 */
export class AiIncompleteResponseError extends ApiError {
  readonly reason: "reasoning" | "truncated";
  usage?: AiUsage;

  constructor(reason: "reasoning" | "truncated", message: string) {
    super(502, message);
    this.reason = reason;
  }
}

/**
 * The provider hit the output token limit, but the text that arrived still
 * parsed into a recipe. It is an objective truncation, so the chain may try
 * another model; the partial answer is kept as a last resort rather than
 * showing an empty recipe.
 */
export class AiTruncatedRecipesError extends ApiError {
  usage?: AiUsage;
  readonly recipes: Record<string, unknown>[];

  constructor(recipes: Record<string, unknown>[], usage?: AiUsage) {
    super(502, "The AI answer was cut off at the output token limit, so it may be incomplete.");
    this.recipes = recipes;
    this.usage = usage;
  }
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
  const baseUrl = houseBase || envBase;
  const visionModel = ai.visionModel || AI_ENV.visionModel || ai.model || AI_ENV.model;
  const visionModelExplicit = Boolean(ai.visionModel || AI_ENV.visionModel);
  const rawVisionModels = ai.recipeVisionModels ?? AI_ENV.recipeVisionModels;
  const droppedVisionModels = droppedRecipeVisionModels(rawVisionModels);
  return {
    enabled,
    baseUrl,
    apiKey,
    model: ai.model || AI_ENV.model,
    visionModel,
    visionModelExplicit,
    recipeVisionCandidates: recipeVisionChain({
      baseUrl,
      configured: parseRecipeVisionModels(rawVisionModels),
      visionModel,
      visionModelExplicit,
    }),
    recipeVisionWarning: droppedVisionModels
      ? `Only the first ${MAX_RECIPE_VISION_CHAIN} recipe vision models are used; ${droppedVisionModels} configured model(s) were dropped.`
      : null,
    inputPrice: optionalPrice(ai.inputPrice) ?? AI_ENV.inputPrice,
    outputPrice: optionalPrice(ai.outputPrice) ?? AI_ENV.outputPrice,
    customEndpoint,
    recipeReasoning: normaliseRecipeReasoning(ai.recipeReasoning ?? AI_ENV.recipeReasoning),
    reasoningControl: supportsReasoningControl(baseUrl),
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

interface ChatAttemptResult {
  ok: boolean;
  status: number;
  text: string;
  rawUsage?: any;
  model?: string;
  finishReason?: string | null;
  reasoningChars?: number;
}

export async function chat(
  cfg: AiConfig,
  opts: {
    system: string;
    user: string;
    images?: string[];
    json?: boolean;
    temperature?: number;
    maxTokens?: number;
    /** Override the model for this call (used by the recipe fallback chain). */
    model?: string;
    /**
     * OpenRouter's `reasoning` object. Omit it (or pass null) to let the model
     * and endpoint decide. Other providers may reject the field; the request
     * is retried without it in that case.
     */
    reasoning?: ReasoningRequest | null;
  },
  ctx: AiCallContext = { operation: "chat" },
): Promise<{ text: string; usage: AiUsage; finishReason: string | null; notes: string[] }> {
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

  const model = opts.model || (opts.images?.length ? cfg.visionModel : cfg.model);
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content },
    ],
    temperature: opts.temperature ?? 0.2,
  };
  if (opts.json) body.response_format = { type: "json_object" };
  if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
  if (opts.reasoning) body.reasoning = opts.reasoning;

  let attempts = 0;
  let lastStatus: number | null = null;
  let lastError: string | null = null;
  let responseText = "";
  let requestBytes = 0;
  let responseBytes = 0;
  const notes: string[] = [];

  const metadata: Record<string, unknown> = {
    ...(ctx.metadata ?? {}),
    json: Boolean(opts.json),
    temperature: opts.temperature ?? 0.2,
    hasImages: Boolean(opts.images?.length),
    systemChars: opts.system.length,
    userChars: opts.user.length,
    ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
    ...(ctx.targetId ? { targetId: ctx.targetId } : {}),
  };

  const attempt = async (withJson: boolean, withReasoning: boolean): Promise<ChatAttemptResult> => {
    attempts += 1;
    const payload = { ...body };
    if (!withJson) delete payload.response_format;
    if (!withReasoning) delete payload.reasoning;
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
    const choice = data?.choices?.[0];
    const message = choice?.message?.content;
    const text =
      typeof message === "string"
        ? message
        : Array.isArray(message)
          ? message.map((p: any) => p?.text ?? "").join("\n")
          : "";
    // OpenRouter reports hidden reasoning as `reasoning`; some providers use
    // `reasoning_content`. Its presence with empty content means the model
    // spent the whole output budget thinking.
    const reasoningValue = choice?.message?.reasoning ?? choice?.message?.reasoning_content;
    const reasoningChars =
      typeof reasoningValue === "string"
        ? reasoningValue.length
        : Array.isArray(choice?.message?.reasoning_details)
          ? choice.message.reasoning_details.length
          : 0;
    lastError = null;
    return {
      ok: true as const,
      status: res.status,
      text,
      rawUsage: data?.usage,
      model: data?.model || model,
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
      reasoningChars,
    };
  };

  const runAttempt = (json: boolean, reasoning: boolean): Promise<ChatAttemptResult> =>
    attempt(json, reasoning).catch((err) => {
      lastStatus = 0;
      lastError = err instanceof Error ? err.message : "network error";
      return { ok: false as const, status: 0, text: lastError ?? "network error" };
    });

  let useReasoning = Boolean(opts.reasoning);
  let result = await runAttempt(Boolean(opts.json), useReasoning);
  // An endpoint that does not know OpenRouter's field answers 400/422. Drop the
  // field rather than failing the scan; the user is told in the response.
  if (!result.ok && useReasoning && isFieldRejection(result.status, result.text)) {
    useReasoning = false;
    notes.push("The AI endpoint rejected the reasoning setting, so the request was retried without it.");
    result = await runAttempt(Boolean(opts.json), false);
  }
  if (!result.ok && opts.json && isFieldRejection(result.status, result.text)) {
    result = await runAttempt(false, useReasoning);
  }
  responseText = result.text ?? "";
  metadata.finishReason = result.finishReason ?? null;
  metadata.reasoningChars = result.reasoningChars ?? 0;
  metadata.reasoningTokens = Math.max(
    0,
    Math.round(
      Number(result.rawUsage?.completion_tokens_details?.reasoning_tokens ?? result.rawUsage?.reasoning_tokens ?? 0) || 0,
    ),
  );
  if (notes.length) metadata.retryNotes = notes;

  try {
    if (!result.ok) {
      // Keep the retry notes on the failure too: the caller shows them next to
      // "AI cleanup failed", so a field-rejection retry is not invisible.
      throw new ApiError(
        502,
        `AI provider error (${result.status}): ${result.text || "no response"}`,
        notes.length ? { notes } : undefined,
      );
    }
    if (!result.text.trim()) {
      if ((result.reasoningChars ?? 0) > 0) {
        lastError = "AI provider returned reasoning but no answer";
        throw new AiIncompleteResponseError("reasoning", lastError);
      }
      if (result.finishReason === "length") {
        lastError = "AI provider cut the answer off at the token limit before any text";
        throw new AiIncompleteResponseError("truncated", lastError);
      }
      lastError = "AI provider returned an empty answer";
      const empty = new ApiError(502, lastError, { usage: buildUsage(result.rawUsage, result.model ?? model, cfg) });
      throw empty;
    }
    const usage = buildUsage(result.rawUsage, result.model ?? model, cfg);
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
    return { text: result.text, usage, finishReason: result.finishReason ?? null, notes };
  } catch (error) {
    const failedUsage = result.ok ? buildUsage(result.rawUsage, result.model ?? model, cfg) : null;
    if (error instanceof AiIncompleteResponseError && failedUsage) error.usage = failedUsage;
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
      promptTokens: failedUsage?.promptTokens,
      completionTokens: failedUsage?.completionTokens,
      totalTokens: failedUsage?.totalTokens,
      cost: failedUsage?.cost,
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

/**
 * Statuses a provider uses for "I do not know this request field". Retrying
 * without the field only makes sense when the body names a request field:
 * a genuine 400 (image too large, unknown model, bad content type) would fail
 * identically the second time and bill the user twice.
 */
const FIELD_REJECTION =
  /(?:unknown|unrecognized|unexpected|unsupported|invalid)\s+(?:request\s+)?(?:parameter|field|argument|property|option|response_format|reasoning|max_tokens|temperature)/i;
const FIELD_NOT_SUPPORTED =
  /(?:parameter|field|argument|property|option|response_format|reasoning|max_tokens|temperature)\b[^.]{0,40}\b(?:not supported|unsupported|unknown|unrecognized|invalid)/i;

function isFieldRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return FIELD_REJECTION.test(body) || FIELD_NOT_SUPPORTED.test(body);
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
  const reasoningTokens = Math.max(
    0,
    Math.round(Number(raw?.completion_tokens_details?.reasoning_tokens ?? raw?.reasoning_tokens ?? 0) || 0),
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

  return { model, promptTokens, completionTokens, totalTokens, reasoningTokens, cost };
}

export function extractJson<T = any>(text: string): T {
  const result = extractJsonValue(text);
  if (!result.ok) {
    throw new ApiError(502, result.reason === "missing" ? "AI did not return JSON" : "AI returned malformed JSON");
  }
  if (result.partial) {
    throw new ApiError(502, "AI returned JSON that was cut off before the answer was complete");
  }
  return result.value as T;
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
      (rawText ? `RAW OCR TEXT:\n${rawText.slice(0, 12000)}` : "The receipt is in the attached image. Read it carefully.") +
      (images.length > 1
        ? `\n\nThe receipt was photographed in ${images.length} overlapping parts, attached top to bottom. ` +
          "Lines visible in two photos are the same purchase: list them once."
        : ""),
    images,
    json: true,
    temperature: 0.1,
  }, ctx);
  return { data: extractJson<Record<string, unknown>>(text), usage };
}

/**
 * A recipe the user can actually keep. A title with no ingredients or steps is
 * a truncated fragment, not a usable read, and must not be saved as success.
 */
function isUsableRecipe(recipe: Record<string, unknown>): boolean {
  return (
    (Array.isArray(recipe.ingredients) && recipe.ingredients.length > 0) ||
    (Array.isArray(recipe.steps) && recipe.steps.length > 0)
  );
}

/**
 * Read a recipe page, returning one structured recipe per recipe written on it.
 * The image is sent whenever the caller has one; the prompt tells the model to
 * trust the photo over OCR text because handwriting is not reliably recognised
 * by the on-device engine.
 *
 * Models are tried in order and only a *failure* moves to the next one: a
 * provider error, a reasoning-only answer, a truncation that leaves no usable
 * JSON, or malformed JSON. A successful answer is returned as-is, even if a
 * later model might subjectively read the page better, because replacing it
 * would bill the user twice and make the result unpredictable.
 */
export async function aiReadRecipes(
  cfg: AiConfig,
  rawText: string,
  images: string[] = [],
  ctx: AiCallContext = { operation: "recipe.scan" },
  options: { models?: RecipeVisionCandidate[] } = {},
): Promise<AiResult<{ recipes: Record<string, unknown>[] }>> {
  const notes: string[] = [];
  const candidates = (options.models?.length ? options.models : cfg.recipeVisionCandidates).filter(
    (candidate) => Boolean(candidate.model),
  );
  if (!candidates.length) throw new ApiError(400, "No AI vision model configured");
  const chain = candidates.map((candidate) => candidate.model);
  const spent: AiUsage[] = [];
  const partial: { model: string; recipes: Record<string, unknown>[] }[] = [];

  const noteUnpriced = (model: string) => {
    const note = `${model} did not report a price, so the AI cost shown may be lower than the actual spend.`;
    if (!notes.includes(note)) notes.push(note);
  };

  const readOnce = async (
    candidate: RecipeVisionCandidate,
    index: number,
    reasoning: ReasoningRequest | null,
  ) => {
    const attemptCtx: AiCallContext = {
      ...ctx,
      metadata: {
        ...(ctx.metadata ?? {}),
        visionIndex: index,
        visionChain: chain,
        visionModel: candidate.model,
      },
    };
    const { text, usage, finishReason, notes: chatNotes } = await chat(cfg, {
      system: RECIPE_ARCHIVIST_SYSTEM,
      user: recipeArchivistPrompt(rawText, images.length),
      images,
      model: candidate.model,
      json: true,
      temperature: 0.1,
      // Multiple handwritten recipes and reasoning tokens share this budget.
      maxTokens: MAX_RECIPE_VISION_TOKENS,
      reasoning,
    }, attemptCtx);
    notes.push(...chatNotes);

    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch (error) {
      if (finishReason === "length") {
        const incomplete = new AiIncompleteResponseError(
          "truncated",
          "The AI answer was cut off at the token limit before the recipe JSON was complete",
        );
        incomplete.usage = usage;
        throw incomplete;
      }
      throw new ApiError(502, error instanceof Error ? error.message : "AI returned malformed JSON", { usage });
    }
    if (finishReason === "length") {
      const recipes = recipeListFromJson(parsed);
      throw new AiTruncatedRecipesError(recipes, usage);
    }
    const recipes = recipeListFromJson(parsed);
    if (!recipes.some(isUsableRecipe)) {
      throw new ApiError(502, "AI returned no usable recipe", { usage });
    }
    return { data: { recipes }, usage };
  };

  const readCandidate = async (candidate: RecipeVisionCandidate, index: number) => {
    const configured = candidate.reasoning ?? reasoningRequestFor(cfg.recipeReasoning);
    try {
      const result = await readOnce(candidate, index, configured);
      if (result.usage.cost == null) noteUnpriced(candidate.model);
      return result;
    } catch (error) {
      const incomplete = error instanceof AiIncompleteResponseError ? error : null;
      // Retrying only helps where the endpoint honours the field (OpenRouter).
      // Elsewhere the retry would send the same photo again for an ignored
      // setting, so the failure is reported after one billed call. A 4xx
      // rejection is already handled inside `chat`.
      const canRetryWithReasoningOff = canRetryRecipeReasoningOff(cfg.reasoningControl, configured);
      if (!incomplete || !canRetryWithReasoningOff) throw error;

      notes.push(
        incomplete.reason === "truncated"
          ? "The AI ran out of output tokens before writing the recipe, so the scan was retried with reasoning disabled."
          : "The AI model spent its whole output budget on reasoning, so the scan was retried with reasoning disabled.",
      );
      try {
        const result = await readOnce(candidate, index, { enabled: false });
        if (result.usage.cost == null) noteUnpriced(candidate.model);
        const usage = addUsages([incomplete.usage, result.usage]);
        return { ...result, usage: usage ?? result.usage };
      } catch (retryError) {
        if (usageOf(retryError)?.cost == null) noteUnpriced(candidate.model);
        // The retry may itself have produced a parseable but truncated answer.
        // Keep those recipes so the chain can still offer them as a last resort
        // instead of replacing the error with a generic message.
        if (retryError instanceof AiTruncatedRecipesError) {
          throw new AiTruncatedRecipesError(
            retryError.recipes,
            addUsages([incomplete.usage, retryError.usage]) ?? undefined,
          );
        }
        throw new ApiError(502, retryError instanceof Error ? retryError.message : String(retryError), {
          notes: notesFromError(retryError),
          usage: addUsages([incomplete.usage, usageOf(retryError)]),
        });
      }
    }
  };

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      const result = await readCandidate(candidate, index);
      return {
        ...result,
        usage: addUsages([...spent, result.usage]) ?? result.usage,
        notes,
        model: candidate.model,
        models: chain.slice(0, index + 1),
      };
    } catch (error) {
      if (error instanceof AiTruncatedRecipesError && error.recipes.length) {
        partial.push({ model: candidate.model, recipes: error.recipes });
      }
      const usage = usageOf(error);
      if (usage) spent.push(usage);
      // An attempt the provider never billed is invisible in the totals above.
      // Say so instead of quietly reporting a lower spend than the user paid.
      if (!usage || usage.cost == null) noteUnpriced(candidate.model);
      const message = error instanceof Error ? error.message : String(error);
      for (const note of notesFromError(error)) {
        if (!notes.includes(note)) notes.push(note);
      }
      if (index === candidates.length - 1) {
        const best = partial[partial.length - 1];
        // A partial answer with only a title is not a recipe. Returning it as
        // success would let an unattended save persist an empty draft.
        const usable = best?.recipes.filter(isUsableRecipe) ?? [];
        if (best && usable.length) {
          if (!(error instanceof AiTruncatedRecipesError)) {
            notes.push(`${candidate.model} did not return a usable recipe (${shorten(message, 160)}).`);
          }
          notes.push("The AI answer hit the output token limit, so the recipe may be incomplete.");
          return {
            data: { recipes: usable },
            usage: addUsages(spent) ?? {
              model: best.model,
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              reasoningTokens: 0,
              cost: null,
            },
            notes,
            truncated: true,
            model: best.model,
            models: chain,
          };
        }
        notes.push(`${candidate.model} did not return a usable recipe (${shorten(message, 160)}).`);
        // Name the model whose error ended the chain so a caller can retry only
        // that model (e.g. a text-only retry) instead of re-billing earlier ones.
        const details: Record<string, unknown> = { notes, models: chain, model: candidate.model };
        const total = addUsages(spent);
        if (total) details.usage = total;
        throw new ApiError(502, message || "AI could not read the recipe", details);
      }
      notes.push(
        error instanceof AiTruncatedRecipesError
          ? `${candidate.model} hit the output token limit before finishing the recipe, so the next model was tried.`
          : `${candidate.model} did not return a usable recipe (${shorten(message, 160)}), ` +
            "so the next model in the fallback chain was tried.",
      );
    }
  }

  throw new ApiError(502, "AI could not read the recipe", { notes });
}

function usageOf(error: unknown): AiUsage | null {
  const candidate = (error as { usage?: unknown; details?: { usage?: unknown } } | null)?.usage
    ?? (error as { details?: { usage?: unknown } } | null)?.details?.usage;
  return candidate && typeof candidate === "object" ? (candidate as AiUsage) : null;
}

function notesFromError(error: unknown): string[] {
  const notes = (error as { details?: { notes?: unknown } } | null)?.details?.notes;
  return Array.isArray(notes) ? notes.filter((note): note is string => typeof note === "string") : [];
}

function shorten(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Add the token counts of every attempt and the prices of the attempts that
 * reported one. A missing price is excluded from the total rather than turning
 * the whole sum into null: the caller already has a note for each unpriced
 * attempt, so the known spend is shown with a warning that it may be lower.
 * Attempts with no usage at all are invisible here; `aiReadRecipes` adds a note
 * for those so a low total is never silent.
 */
function addUsages(usages: (AiUsage | null | undefined)[]): AiUsage | null {
  const present = usages.filter((usage): usage is AiUsage => Boolean(usage));
  if (!present.length) return null;
  const totals = present.reduce(
    (sum, usage) => ({
      promptTokens: sum.promptTokens + usage.promptTokens,
      completionTokens: sum.completionTokens + usage.completionTokens,
      totalTokens: sum.totalTokens + usage.totalTokens,
      reasoningTokens: sum.reasoningTokens + usage.reasoningTokens,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0 },
  );
  const priced = present.filter((usage) => usage.cost != null);
  const cost = priced.length
    ? roundCost(priced.reduce((sum, usage) => sum + (usage.cost ?? 0), 0))
    : null;
  return { model: present[present.length - 1].model, ...totals, cost };
}

/** Text-only clean-up prompt, used by link imports. A photo read uses RECIPE_ARCHIVIST_SYSTEM. */
const RECIPE_CLEANUP_SYSTEM =
  "You are a meticulous family-recipe archivist. Turn raw recipe text into clean, structured JSON. " +
  "Fix OCR mistakes, expand abbreviations (tbsp, tsp, °C), normalise units and split ingredients from steps. " +
  "You may infer obvious missing details (preheat temperature, resting time, pan size) but never invent ingredients that are not present. " +
  "List every inference in notes. Write steps so a beginner can follow them, one action per step. " +
  "Return exactly one recipe object in the requested shape; if the text holds several recipes, return the main one. " +
  "Respond with JSON only, no markdown.";

/**
 * Clean up recipe text (a link import or pasted text). This is deliberately not
 * `aiReadRecipes`: that prompt is written for a photo and insists on a usable
 * ingredient/step list, so a page that only yields a title or notes would fail
 * here. The text model is used without the recipe vision fallback chain and
 * without the vision output budget.
 */
export async function aiCleanRecipe(
  cfg: AiConfig,
  rawText: string,
  images: string[] = [],
  ctx: AiCallContext = { operation: "recipe.scan" },
): Promise<AiResult<Record<string, unknown>>> {
  const limit = 12000;
  const truncated = rawText.length > limit;
  const { text, usage, finishReason, notes: chatNotes } = await chat(cfg, {
    system: RECIPE_CLEANUP_SYSTEM,
    user:
      `Structure this recipe into JSON with this exact shape:\n${RECIPE_SCHEMA}\n\n` +
      (rawText
        ? `RAW TEXT:\n${rawText.slice(0, limit)}` + (truncated ? `\n\n[The text was cut off at ${limit} characters.]` : "")
        : "The recipe is in the attached image. Read it carefully."),
    images,
    json: true,
    temperature: 0.1,
  }, ctx);
  const parsed = extractJson(text);
  const recipes = recipeListFromJson(parsed);
  const notes = [...chatNotes];
  if (!recipes.length) throw new ApiError(502, "AI did not return a recipe", { usage });
  if (recipes.length > 1) {
    notes.push(`The AI returned ${recipes.length} recipes; only the first was imported.`);
  }
  if (finishReason === "length") {
    notes.push("The AI answer hit the output token limit, so the imported recipe may be incomplete.");
  }
  return {
    data: recipes[0],
    usage,
    notes,
    truncated: finishReason === "length",
    model: usage.model,
    models: [usage.model],
  };
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

/** Mime type for an upload, from its file extension. */
export function imageMimeForPath(filePath: string, fallback = "image/jpeg"): string {
  return imageMimeForPathName(filePath, fallback);
}

/**
 * Convert a local upload into a data URL for vision models. The mime type
 * comes from the file extension; `mime` is only the fallback for unknown ones.
 * Returns null when the file is missing or larger than MAX_VISION_IMAGE_BYTES.
 */
export async function fileToDataUrl(filePath: string, mime = "image/jpeg"): Promise<string | null> {
  const fs = await import("node:fs/promises");
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile() || stat.size > MAX_VISION_IMAGE_BYTES) return null;
  const buf = await fs.readFile(filePath);
  return `data:${imageMimeForPathName(filePath, mime)};base64,${buf.toString("base64")}`;
}
