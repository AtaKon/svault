#!/usr/bin/env node
/**
 * Developer recipe-vision benchmark.
 *
 * Compares user-supplied model IDs on real recipe photos using the *same*
 * prompt, JSON schema, temperature and output budget as the recipe scanner,
 * then scores every answer against an explicit ground truth (or an explicitly
 * named reference model) and reports tokens and cost.
 *
 * This is deliberately manual: it needs real photos, an API key and money, so
 * it is not part of `npm test`.
 *
 *   OPENAI_API_KEY=... node --import tsx scripts/recipe-vision-benchmark.mjs \
 *     data/recipe-vision/manifest.json --json data/recipe-vision/results.json
 *
 * The manifest never contains the key or the image bytes:
 *
 *   {
 *     "baseUrl": "https://openrouter.ai/api/v1",
 *     "models": ["google/gemini-3-flash-preview", "qwen/qwen3.6-35b-a3b"],
 *     "referenceModel": "google/gemini-3-flash-preview",   // optional
 *     "reasoning": "auto",
 *     "images": [
 *       {
 *         "path": "../private-photos/revani.jpg",
 *         "label": "revani",
 *         "truth": {
 *           "title": "Ρεβάνι με ινδοκάρυδο",
 *           "ingredients": [{"name": "βούτυρο", "quantity": 160, "unit": "g"}],
 *           "steps": ["Χτυπάμε το βούτυρο με τη ζάχαρη."]
 *         }
 *       }
 *     ]
 *   }
 *
 * A photo with no `truth` needs a `referenceModel`; the result is then
 * similarity to that model's answer, which is not accuracy.
 */
import fs from "node:fs";
import path from "node:path";

import {
  aggregateBenchmark,
  benchmarkChatBody,
  benchmarkCost,
  parseBenchmarkManifest,
} from "../shared/recipe-vision-benchmark.ts";
import { extractJsonValue, recipeListFromJson } from "../shared/recipe-vision.ts";
import { scoreRecipeAgainstTruth, scoreSimilarityToReference } from "../shared/recipe-vision-score.ts";
import { MAX_VISION_IMAGE_BYTES, imageMimeForPathName } from "../shared/vision-image.ts";

const TIMEOUT_MS = 90_000;

function usage() {
  return [
    "Usage: node --import tsx scripts/recipe-vision-benchmark.mjs <manifest.json> [options]",
    "",
    "Options:",
    "  --json <file>      Write the full report as JSON (no image data, no key).",
    "  --base-url <url>   Override the manifest base URL.",
    "  --models <ids>     Comma-separated model IDs, overriding the manifest (max 4).",
    "  --help             Show this help.",
    "",
    "The API key is read from OPENAI_API_KEY (or SVAI_API_KEY) and is never",
    "written to the report or printed. Photos are read from the paths in the",
    "manifest and sent to the provider; no image bytes are stored.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { manifest: null, json: null, baseUrl: null, models: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = argv[++index] ?? null;
    else if (arg === "--base-url") options.baseUrl = argv[++index] ?? null;
    else if (arg === "--models") options.models = argv[++index] ?? null;
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else if (!options.manifest) options.manifest = arg;
    else throw new Error(`Unexpected argument ${arg}`);
  }
  return options;
}

function isLocalHost(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "host.docker.internal";
  } catch {
    return false;
  }
}

function readImageDataUrl(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`${filePath} is not a file`);
  if (stat.size > MAX_VISION_IMAGE_BYTES) {
    throw new Error(`${filePath} is larger than ${Math.round(MAX_VISION_IMAGE_BYTES / 1024 / 1024)} MB`);
  }
  const mime = imageMimeForPathName(filePath);
  return `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

function textOf(message) {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return message.map((part) => part?.text ?? "").join("\n");
  return "";
}

function reasoningChars(choice) {
  const value = choice?.message?.reasoning ?? choice?.message?.reasoning_content;
  if (typeof value === "string") return value.length;
  return Array.isArray(choice?.message?.reasoning_details) ? choice.message.reasoning_details.length : 0;
}

/**
 * One model × one image. The retry mirrors the server: an answer that is only
 * hidden reasoning, or that hits the token limit before any text, is retried
 * once with reasoning disabled and both attempts are billed.
 */
async function runOnce({ baseUrl, apiKey, manifest, model, image, referenceRecipe }) {
  const startedAt = Date.now();
  const notes = [];
  let cost = 0;
  let costKnown = true;
  let promptTokens = 0;
  let completionTokens = 0;
  let attempt = 0;

  let dataUrl;
  try {
    dataUrl = readImageDataUrl(image.path);
  } catch (error) {
    return {
      ok: false,
      recipe: null,
      score: null,
      scoreDetail: null,
      referenceScore: null,
      cost: null,
      promptTokens: 0,
      completionTokens: 0,
      durationMs: Date.now() - startedAt,
      notes,
      error: `could not read photo: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const send = async (reasoning) => {
    attempt += 1;
    const body = benchmarkChatBody({ model: model.id, imageDataUrl: dataUrl, reasoning });
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const raw = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${raw.slice(0, 300) || "no response"}`);
    }
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error("provider returned invalid JSON");
    }
    const choice = data?.choices?.[0];
    const usage = data?.usage ?? null;
    promptTokens += Number(usage?.prompt_tokens ?? 0) || 0;
    completionTokens += Number(usage?.completion_tokens ?? 0) || 0;
    const reported = benchmarkCost(usage, manifest.prices);
    if (reported == null) costKnown = false;
    else cost = Math.round((cost + reported) * 1e6) / 1e6;
    return {
      text: textOf(choice?.message?.content),
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
      hiddenReasoning: reasoningChars(choice),
    };
  };

  try {
    const effectiveReasoning = model.reasoning ?? manifest.reasoning;
    let result = await send(effectiveReasoning);
    const incomplete = !result.text.trim();
    const retryReasoningOff =
      incomplete &&
      effectiveReasoning !== "off" &&
      (result.hiddenReasoning > 0 || result.finishReason === "length");
    if (retryReasoningOff) {
      notes.push(
        result.hiddenReasoning > 0
          ? "The first attempt returned only reasoning; retried with reasoning disabled."
          : "The first attempt hit the token limit before writing text; retried with reasoning disabled.",
      );
      result = await send("off");
    }

    const parsed = extractJsonValue(result.text);
    if (!parsed.ok) {
      throw new Error(
        parsed.reason === "missing"
          ? "no JSON in the answer"
          : result.finishReason === "length"
            ? "the answer was cut off at the token limit"
            : "malformed JSON",
      );
    }
    const recipes = recipeListFromJson(parsed.value);
    if (!recipes.length) throw new Error("the answer contained no recipe object");
    if (recipes.length > 1) notes.push(`The answer held ${recipes.length} recipes; scored the first.`);
    if (result.finishReason === "length") notes.push("The answer hit the token limit, so it may be incomplete.");

    const recipe = recipes[0];
    const score = image.truth ? scoreRecipeAgainstTruth(recipe, image.truth) : null;
    const similarity = referenceRecipe ? scoreSimilarityToReference(recipe, referenceRecipe) : null;
    return {
      ok: true,
      recipe,
      score: score ? score.score : null,
      scoreDetail: score,
      referenceScore: manifest.referenceModel === model.id ? null : similarity ? similarity.score : null,
      cost: costKnown ? cost : null,
      promptTokens,
      completionTokens,
      durationMs: Date.now() - startedAt,
      notes,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      recipe: null,
      score: null,
      scoreDetail: null,
      referenceScore: null,
      cost: costKnown && attempt > 0 ? cost : null,
      promptTokens,
      completionTokens,
      durationMs: Date.now() - startedAt,
      notes,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatCost(value, complete) {
  if (value == null) return "—";
  const label = value > 0 && value < 0.000001 ? "< $0.000001" : `$${value.toFixed(6)}`;
  return complete ? label : `${label} (lower bound)`;
}

function formatScore(value) {
  return value == null ? "—" : value.toFixed(3);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!options.manifest) {
    console.error(usage());
    return 1;
  }

  const manifestPath = path.resolve(options.manifest);
  const manifestText = fs.readFileSync(manifestPath, "utf8");
  let manifest;
  try {
    manifest = parseBenchmarkManifest(JSON.parse(manifestText));
  } catch (error) {
    console.error(`Invalid manifest: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (options.models) {
    manifest = parseBenchmarkManifest({
      ...JSON.parse(manifestText),
      models: options.models.split(",").map((value) => value.trim()).filter(Boolean),
    });
  }
  // Photo paths are relative to the manifest so the manifest can live next to
  // private photos outside version control.
  manifest = {
    ...manifest,
    images: manifest.images.map((image) => ({ ...image, path: path.resolve(path.dirname(manifestPath), image.path) })),
  };

  const baseUrl = options.baseUrl ?? manifest.baseUrl ?? process.env.OPENAI_BASE_URL ?? process.env.SVAI_BASE_URL ?? "https://api.openai.com/v1";
  try {
    const parsed = new URL(baseUrl);
    if (parsed.username || parsed.password) {
      console.error("The base URL must not contain credentials. Set OPENAI_API_KEY instead.");
      return 1;
    }
  } catch {
    console.error(`The base URL is not a valid URL: ${baseUrl}`);
    return 1;
  }
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.SVAI_API_KEY ?? "";
  if (!apiKey && !isLocalHost(baseUrl)) {
    console.error(`No API key. Set OPENAI_API_KEY (never put it in the manifest) for ${baseUrl}.`);
    return 1;
  }

  const repositoryRoot = process.cwd();
  for (const image of manifest.images) {
    const relative = path.relative(repositoryRoot, image.path);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      console.warn(
        `[warning] ${image.label} lives inside the repository (${relative}). ` +
          "Family photos should stay outside version control; only paths are sent, never committed.",
      );
    }
  }

  const referenceRecipes = {};
  const referenceResults = {};
  if (manifest.referenceModel) {
    const reference = manifest.models.find((model) => model.id === manifest.referenceModel);
    for (const image of manifest.images) {
      const referenceRun = await runOnce({ baseUrl, apiKey, manifest, model: reference, image });
      if (!referenceRun.ok) {
        console.error(`Reference model ${manifest.referenceModel} failed on ${image.label}: ${referenceRun.error}`);
        return 1;
      }
      referenceRecipes[image.path] = referenceRun.recipe;
      referenceResults[image.path] = referenceRun;
    }
  }

  console.log(`Recipe vision benchmark · ${manifest.models.length} models × ${manifest.images.length} photos`);
  console.log(`Endpoint: ${baseUrl}`);
  console.log(
    `Basis: ${manifest.referenceModel ? `reference model ${manifest.referenceModel}` : "written ground truth"}` +
      `${manifest.images.some((image) => image.truth) ? " (+ ground truth where supplied)" : ""}`,
  );

  const runs = [];
  for (const model of manifest.models) {
    for (const image of manifest.images) {
      process.stdout.write(`  ${model.id} · ${image.label} … `);
      const result =
        model.id === manifest.referenceModel && referenceResults[image.path]
          ? referenceResults[image.path]
          : await runOnce({
              baseUrl,
              apiKey,
              manifest,
              model,
              image,
              referenceRecipe: referenceRecipes[image.path],
            });
      console.log(result.ok ? `ok (${formatScore(result.score)})` : `failed: ${result.error}`);
      runs.push({
        model: model.id,
        image: image.label,
        path: image.path,
        score: result.score,
        referenceScore: result.referenceScore,
        cost: result.cost,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        durationMs: result.durationMs,
        ok: result.ok,
        error: result.error,
        notes: result.notes,
      });
    }
  }

  const report = aggregateBenchmark(runs);
  console.log("");
  const header = ["Model", "Images", "Fail", "Mean truth", "Mean ref", "Cost", "Prompt tok", "Completion tok"];
  console.log(header.join("\t"));
  for (const model of report.models) {
    console.log(
      [
        model.model,
        String(model.runs),
        String(model.failures),
        formatScore(model.meanScore),
        formatScore(model.meanReferenceScore),
        formatCost(model.cost, model.costComplete),
        String(model.promptTokens),
        String(model.completionTokens),
      ].join("\t"),
    );
  }
  console.log("");
  console.log(
    `Total: ${report.totals.runs} calls, ${report.totals.failures} failed, ` +
      `${formatCost(report.totals.cost, report.totals.costComplete)}`,
  );

  const remarks = runs.filter((run) => !run.ok || run.notes.length);
  if (remarks.length) {
    console.log("\nNotes:");
    for (const run of remarks) {
      console.log(`  ${run.model} · ${run.image}: ${run.error ?? run.notes.join(" ")}`);
    }
  }

  console.log(
    "\nScores are computed against the manifest's explicit truth/reference, not from model confidence. " +
      "One photo per model does not establish accuracy; see docs/recipe-ocr-evaluation.md.",
  );

  if (options.json) {
    const output = {
      generatedAt: new Date().toISOString(),
      manifest: path.basename(manifestPath),
      baseUrl,
      models: manifest.models.map((model) => model.id),
      referenceModel: manifest.referenceModel,
      prices: manifest.prices,
      runs,
      summary: report,
      method:
        "Same prompt, JSON schema, temperature and max_tokens as the recipe scanner. " +
        "Truth scores are explicit ground truth; reference scores are similarity to a named model, not accuracy.",
    };
    fs.mkdirSync(path.dirname(path.resolve(options.json)), { recursive: true });
    fs.writeFileSync(path.resolve(options.json), `${JSON.stringify(output, null, 2)}\n`);
    console.log(`JSON written to ${path.resolve(options.json)}`);
  }

  return report.totals.failures === report.totals.runs ? 2 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
