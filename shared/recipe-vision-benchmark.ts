/**
 * Manifest, request and report helpers for the developer recipe-vision
 * benchmark (`scripts/recipe-vision-benchmark.mjs`).
 *
 * The benchmark is manual and developer-invoked: it needs real photos, an API
 * key and money. This module deliberately contains no I/O so the validation
 * and aggregation rules can be tested without a provider.
 *
 * Safety rules encoded here:
 * - only image **paths** are allowed, never inline image bytes;
 * - API keys, tokens and passwords in the manifest are rejected, because the
 *   manifest is meant to be committed or shared with the team;
 * - at most four models and eight images per run, mirroring the production
 *   chain limit and keeping an accidental run affordable.
 */
import {
  MAX_RECIPE_VISION_CHAIN,
  MAX_RECIPE_VISION_TOKENS,
  RECIPE_ARCHIVIST_SYSTEM,
  recipeArchivistPrompt,
} from "./recipe-vision.js";
import { normaliseRecipeReasoning, reasoningRequestFor, type RecipeReasoningMode } from "./ai-reasoning.js";
import type { RecipeTruth } from "./recipe-vision-score.js";

export const MAX_BENCHMARK_IMAGES = 8;

export class BenchmarkManifestError extends Error {}

export interface BenchmarkModelSpec {
  id: string;
  /** Per-model reasoning override; undefined uses the manifest `reasoning`. */
  reasoning?: RecipeReasoningMode;
}

export interface BenchmarkImage {
  path: string;
  label: string;
  /** Written ground truth, or null when a reference model is used instead. */
  truth: RecipeTruth | null;
}

export interface BenchmarkPrices {
  /** USD per 1M prompt tokens. */
  input: number | null;
  /** USD per 1M completion tokens. */
  output: number | null;
}

export interface BenchmarkManifest {
  baseUrl: string | null;
  models: BenchmarkModelSpec[];
  referenceModel: string | null;
  reasoning: RecipeReasoningMode;
  prices: BenchmarkPrices;
  images: BenchmarkImage[];
}

const SECRET_KEYS = new Set([
  "apikey",
  "api_key",
  "authorization",
  "auth",
  "token",
  "secret",
  "password",
  "bearer",
]);

const EMBEDDED_IMAGE_KEYS = new Set([
  "dataurl",
  "data_url",
  "base64",
  "image",
  "images",
  "bytes",
  "content",
  "blob",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
  throw new BenchmarkManifestError(message);
}

function assertNoSecrets(value: unknown, where: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecrets(entry, `${where}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.has(key.toLowerCase())) {
      fail(
        `${where}.${key} looks like a credential. Never put API keys or tokens in the manifest; ` +
          "pass the key through OPENAI_API_KEY when you run the benchmark.",
      );
    }
    assertNoSecrets(child, `${where}.${key}`);
  }
}

function optionalPrice(value: unknown, name: string): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    fail(`prices.${name} must be a non-negative number when set (USD per 1M tokens).`);
  }
  return parsed;
}

function parseModel(value: unknown, index: number): BenchmarkModelSpec {
  let id: unknown;
  let reasoning: unknown;
  if (typeof value === "string") {
    id = value;
  } else if (isRecord(value)) {
    id = value.id ?? value.model;
    reasoning = value.reasoning;
  }
  const model = typeof id === "string" ? id.trim() : "";
  if (!model) fail(`models[${index}] must be a model ID such as "google/gemini-3-flash-preview".`);
  if (model.length > 200 || /\s/.test(model)) {
    fail(`models[${index}] "${model.slice(0, 60)}" is not a valid model ID (no spaces, at most 200 characters).`);
  }
  const parsedReasoning =
    reasoning == null || reasoning === "" ? undefined : normaliseRecipeReasoning(reasoning);
  if (reasoning != null && reasoning !== "" && parsedReasoning === "auto" && reasoning !== "auto") {
    fail(`models[${index}].reasoning must be auto, off, low, medium or high.`);
  }
  return parsedReasoning ? { id: model, reasoning: parsedReasoning } : { id: model };
}

function parseTruth(value: unknown, where: string): RecipeTruth {
  if (!isRecord(value)) fail(`${where} must be an object with a title, ingredients and/or steps.`);
  const truth: RecipeTruth = {};
  if (value.title != null) {
    if (typeof value.title !== "string") fail(`${where}.title must be a string.`);
    truth.title = value.title;
  }
  if (value.ingredients != null) {
    if (!Array.isArray(value.ingredients)) fail(`${where}.ingredients must be an array.`);
    truth.ingredients = value.ingredients.map((entry, index) => {
      if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name.trim()) {
        fail(`${where}.ingredients[${index}] needs a non-empty name.`);
      }
      const quantity = entry.quantity ?? null;
      if (quantity != null && (typeof quantity !== "number" || !Number.isFinite(quantity))) {
        fail(`${where}.ingredients[${index}].quantity must be a number or null.`);
      }
      if (entry.unit != null && typeof entry.unit !== "string") {
        fail(`${where}.ingredients[${index}].unit must be a string or null.`);
      }
      return {
        name: entry.name,
        quantity: quantity as number | null,
        unit: (entry.unit as string | null | undefined) ?? null,
        ...(typeof entry.optional === "boolean" ? { optional: entry.optional } : {}),
      };
    });
  }
  if (value.steps != null) {
    if (!Array.isArray(value.steps)) fail(`${where}.steps must be an array of strings.`);
    truth.steps = value.steps.map((step, index) => {
      if (typeof step !== "string") fail(`${where}.steps[${index}] must be a string.`);
      return step;
    });
  }
  if (!truth.title && !truth.ingredients?.length && !truth.steps?.length) {
    fail(`${where} is empty. Record at least a title, one ingredient or one step.`);
  }
  return truth;
}

function parseImage(value: unknown, index: number): BenchmarkImage {
  const where = `images[${index}]`;
  if (!isRecord(value)) fail(`${where} must be an object with a path.`);
  for (const key of Object.keys(value)) {
    if (EMBEDDED_IMAGE_KEYS.has(key.toLowerCase())) {
      fail(
        `${where}.${key} embeds image content. Reference the photo by "path" instead, so raw photos ` +
          "and base64 blobs never end up in the manifest or the report.",
      );
    }
  }
  const imagePath = typeof value.path === "string" ? value.path.trim() : "";
  if (!imagePath) fail(`${where}.path must name an image file (a path, not image data).`);
  const label =
    typeof value.label === "string" && value.label.trim() ? value.label.trim() : imagePath;
  return {
    path: imagePath,
    label,
    truth: value.truth == null ? null : parseTruth(value.truth, `${where}.truth`),
  };
}

/**
 * Validate a manifest and fill in defaults. Throws `BenchmarkManifestError`
 * with a message written for a developer, not a stack trace.
 */
export function parseBenchmarkManifest(input: unknown): BenchmarkManifest {
  if (!isRecord(input)) fail("The benchmark manifest must be a JSON object.");
  assertNoSecrets(input, "manifest");

  if (!Array.isArray(input.models) || input.models.length === 0) {
    fail("models must be a non-empty array of model IDs.");
  }
  if (input.models.length > MAX_RECIPE_VISION_CHAIN) {
    fail(`models may list at most ${MAX_RECIPE_VISION_CHAIN} IDs, the same limit as the recipe fallback chain.`);
  }
  const models = input.models.map((value, index) => parseModel(value, index));
  const ids = models.map((model) => model.id);
  if (new Set(ids).size !== ids.length) fail("models contains the same model ID more than once.");

  if (!Array.isArray(input.images) || input.images.length === 0) {
    fail("images must be a non-empty array of { path, label?, truth? } entries.");
  }
  if (input.images.length > MAX_BENCHMARK_IMAGES) {
    fail(`images may list at most ${MAX_BENCHMARK_IMAGES} files per run: every extra photo costs money.`);
  }
  const images = input.images.map((value, index) => parseImage(value, index));

  const referenceModel =
    typeof input.referenceModel === "string" && input.referenceModel.trim()
      ? input.referenceModel.trim()
      : null;
  if (referenceModel && !ids.includes(referenceModel)) {
    fail(`referenceModel "${referenceModel}" must also be listed in models so it is measured on the same photos.`);
  }
  const baseUrl =
    typeof input.baseUrl === "string" && input.baseUrl.trim() ? input.baseUrl.trim() : null;
  if (baseUrl) {
    let parsedBase: URL;
    try {
      parsedBase = new URL(baseUrl);
    } catch {
      fail("baseUrl is not a valid URL.");
    }
    if (parsedBase.username || parsedBase.password) {
      fail("baseUrl must not contain credentials. Pass the key through OPENAI_API_KEY instead.");
    }
  }
  for (const image of images) {
    if (!image.truth && !referenceModel) {
      fail(
        `images entry "${image.label}" has no truth and the manifest has no referenceModel. ` +
          "Write down the expected recipe or name a reference model; guessing accuracy from a single output is not allowed.",
      );
    }
  }

  const rawPrices = input.prices;
  if (rawPrices != null && !isRecord(rawPrices)) fail("prices must be an object with input/output USD per 1M tokens.");
  const prices: BenchmarkPrices = {
    input: optionalPrice(isRecord(rawPrices) ? rawPrices.input : null, "input"),
    output: optionalPrice(isRecord(rawPrices) ? rawPrices.output : null, "output"),
  };

  return {
    baseUrl,
    models,
    referenceModel,
    reasoning: normaliseRecipeReasoning(input.reasoning),
    prices,
    images,
  };
}

export interface BenchmarkRequestInput {
  model: string;
  imageDataUrl: string | null;
  rawText?: string;
  reasoning?: RecipeReasoningMode;
}

/**
 * An OpenAI-compatible chat body identical in prompt, schema, temperature and
 * output budget to the production recipe scan, so the benchmark measures the
 * real request rather than a simplified one.
 */
export function benchmarkChatBody(input: BenchmarkRequestInput): Record<string, unknown> {
  const imageCount = input.imageDataUrl ? 1 : 0;
  const reasoning = reasoningRequestFor(input.reasoning ?? "auto");
  const user = recipeArchivistPrompt(input.rawText ?? "", imageCount);
  return {
    model: input.model,
    messages: [
      { role: "system", content: RECIPE_ARCHIVIST_SYSTEM },
      {
        role: "user",
        content: imageCount
          ? [
              { type: "text", text: user },
              { type: "image_url", image_url: { url: input.imageDataUrl } },
            ]
          : user,
      },
    ],
    temperature: 0.1,
    max_tokens: MAX_RECIPE_VISION_TOKENS,
    response_format: { type: "json_object" },
    ...(reasoning ? { reasoning } : {}),
  };
}

/** Cost of one provider response. Provider-reported cost wins; prices are a fallback. */
export function benchmarkCost(
  usage: { cost?: unknown; prompt_tokens?: unknown; completion_tokens?: unknown } | null | undefined,
  prices: BenchmarkPrices,
): number | null {
  const reported = Number(usage?.cost);
  if (usage?.cost != null && Number.isFinite(reported) && reported >= 0) {
    return Math.round(reported * 1e6) / 1e6;
  }
  if (prices.input == null && prices.output == null) return null;
  const prompt = Number(usage?.prompt_tokens ?? 0) || 0;
  const completion = Number(usage?.completion_tokens ?? 0) || 0;
  return Math.round(((prompt * (prices.input ?? 0) + completion * (prices.output ?? 0)) / 1_000_000) * 1e6) / 1e6;
}

export interface BenchmarkRun {
  model: string;
  image: string;
  /** Ground-truth score 0…1, or null when only a reference was available. */
  score: number | null;
  /** Similarity to the reference model's answer 0…1, or null. */
  referenceScore: number | null;
  cost: number | null;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  ok: boolean;
  error: string | null;
  notes: string[];
}

export interface BenchmarkModelSummary {
  model: string;
  runs: number;
  failures: number;
  meanScore: number | null;
  meanReferenceScore: number | null;
  cost: number;
  /** False when at least one run had no price, so `cost` is a lower bound. */
  costComplete: boolean;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000;
}

export function aggregateBenchmark(runs: BenchmarkRun[]): {
  models: BenchmarkModelSummary[];
  totals: { runs: number; failures: number; cost: number; costComplete: boolean };
} {
  const byModel = new Map<string, BenchmarkRun[]>();
  for (const run of runs) {
    const list = byModel.get(run.model) ?? [];
    list.push(run);
    byModel.set(run.model, list);
  }
  const models = [...byModel.entries()].map(([model, entries]) => ({
    model,
    runs: entries.length,
    failures: entries.filter((entry) => !entry.ok).length,
    meanScore: mean(entries.map((entry) => entry.score).filter((value): value is number => value != null)),
    meanReferenceScore: mean(
      entries.map((entry) => entry.referenceScore).filter((value): value is number => value != null),
    ),
    cost: Math.round(entries.reduce((sum, entry) => sum + (entry.cost ?? 0), 0) * 1e6) / 1e6,
    costComplete: entries.every((entry) => entry.cost != null),
    promptTokens: entries.reduce((sum, entry) => sum + entry.promptTokens, 0),
    completionTokens: entries.reduce((sum, entry) => sum + entry.completionTokens, 0),
    durationMs: entries.reduce((sum, entry) => sum + entry.durationMs, 0),
  }));
  // Best ground-truth score first, then reference similarity when no truth was
  // recorded, then cheapest. Models with no score at all go last.
  models.sort((left, right) => {
    if (left.meanScore != null || right.meanScore != null) {
      if (left.meanScore == null) return 1;
      if (right.meanScore == null) return -1;
      if (right.meanScore !== left.meanScore) return right.meanScore - left.meanScore;
    } else if (left.meanReferenceScore != null || right.meanReferenceScore != null) {
      if (left.meanReferenceScore == null) return 1;
      if (right.meanReferenceScore == null) return -1;
      if (right.meanReferenceScore !== left.meanReferenceScore) {
        return right.meanReferenceScore - left.meanReferenceScore;
      }
    }
    return left.cost - right.cost;
  });
  return {
    models,
    totals: {
      runs: runs.length,
      failures: runs.filter((run) => !run.ok).length,
      cost: Math.round(runs.reduce((sum, run) => sum + (run.cost ?? 0), 0) * 1e6) / 1e6,
      costComplete: runs.every((run) => run.cost != null),
    },
  };
}
