import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_RECIPE_VISION_MODELS,
  MAX_RECIPE_VISION_CHAIN,
  checkRecipeVisionModels,
  droppedRecipeVisionModels,
  extractJsonValue,
  isOpenRouterBaseUrl,
  parseRecipeVisionModels,
  recipeArchivistPrompt,
  recipeListFromJson,
  recipeVisionChain,
} from "../../shared/recipe-vision.js";
import {
  RECIPE_SCORE_WEIGHTS,
  normaliseText,
  normaliseUnit,
  readIngredients,
  readSteps,
  scoreRecipeAgainstTruth,
  scoreSimilarityToReference,
  textSimilarity,
} from "../../shared/recipe-vision-score.js";
import {
  BenchmarkManifestError,
  aggregateBenchmark,
  benchmarkChatBody,
  benchmarkCost,
  parseBenchmarkManifest,
  type BenchmarkRun,
} from "../../shared/recipe-vision-benchmark.js";
import { MAX_RECIPE_VISION_TOKENS } from "../../shared/recipe-vision.js";

const truth = {
  title: "Ρεβάνι με ινδοκάρυδο",
  ingredients: [
    { name: "βούτυρο", quantity: 160, unit: "γραμμ." },
    { name: "ζάχαρη", quantity: 200, unit: "g" },
    { name: "ινδοκάρυδο", quantity: 100, unit: "g" },
  ],
  steps: ["Χτυπάμε το βούτυρο με τη ζάχαρη.", "Ψήνουμε στους 180 βαθμούς."],
};

const exactRecipe = {
  title: "Ρεβανι με ινδοκαρυδο",
  ingredients: [
    { name: "Βούτυρο", quantity: 160, unit: "g" },
    { name: "Ζάχαρη", quantity: 200, unit: "γραμμάρια" },
    { name: "Ινδοκάρυδο", quantity: 100, unit: "g" },
  ],
  steps: [{ text: "Χτυπάμε το βούτυρο με τη ζάχαρη." }, { text: "Ψήνουμε στους 180 βαθμούς." }],
};

describe("recipe vision fallback chain", () => {
  it("uses the documented OpenRouter defaults, capped at four", () => {
    const chain = recipeVisionChain({ baseUrl: "https://openrouter.ai/api/v1", visionModel: "openai/gpt-4o" });
    assert.ok(chain.length > 0 && chain.length <= MAX_RECIPE_VISION_CHAIN);
    assert.equal(chain[0].model, "google/gemini-3-flash-preview");
    assert.equal(chain[1].model, "qwen/qwen3.6-35b-a3b");
    // Qwen3.6 35B needs reasoning off, as the evaluation note records.
    assert.deepEqual(chain[1].reasoning, { enabled: false });
    assert.deepEqual(
      chain.map((candidate) => candidate.model),
      DEFAULT_RECIPE_VISION_MODELS.map((candidate) => candidate.model),
    );
  });

  it("never imposes OpenRouter IDs on another provider", () => {
    for (const baseUrl of [
      "https://api.openai.com/v1",
      "http://127.0.0.1:11434/v1",
      "https://api.groq.com/openai/v1",
      "https://openrouter.ai.example.com/v1",
    ]) {
      const chain = recipeVisionChain({ baseUrl, visionModel: "local-vision" });
      assert.deepEqual(chain, [{ model: "local-vision" }], baseUrl);
    }
    assert.equal(isOpenRouterBaseUrl("https://openrouter.ai/api/v1"), true);
    assert.equal(isOpenRouterBaseUrl("https://OPENROUTER.AI"), true);
    assert.equal(isOpenRouterBaseUrl("https://notopenrouter.ai/v1"), false);
    assert.equal(isOpenRouterBaseUrl("not a url"), false);
  });

  it("keeps a deliberately configured vision model first on OpenRouter", () => {
    const chain = recipeVisionChain({
      baseUrl: "https://openrouter.ai/api/v1",
      visionModel: "openai/gpt-4o-mini",
      visionModelExplicit: true,
    });
    assert.equal(chain[0].model, "openai/gpt-4o-mini");
    assert.equal(chain[1].model, "google/gemini-3-flash-preview");
    assert.ok(chain.every((candidate) => candidate.model !== "openai/gpt-4o-mini" || chain.indexOf(candidate) === 0));
  });

  it("keeps the built-in reasoning override for a deliberately configured vision model", () => {
    // Picking the built-in Qwen3.6 ID as the house vision model must not turn
    // thinking back on: with reasoning asked for, the model can answer with
    // nothing but reasoning tokens.
    const chain = recipeVisionChain({
      baseUrl: "https://openrouter.ai/api/v1",
      visionModel: "qwen/qwen3.6-35b-a3b",
      visionModelExplicit: true,
    });
    assert.equal(chain[0].model, "qwen/qwen3.6-35b-a3b");
    assert.deepEqual(chain[0].reasoning, { enabled: false }, "the first entry must carry its override");
    assert.equal(chain.filter((candidate) => candidate.model === "qwen/qwen3.6-35b-a3b").length, 1, "no duplicate entry");
  });

  it("honours an explicit list, dedupes it and caps it at four", () => {
    const chain = recipeVisionChain({
      baseUrl: "https://api.openai.com/v1",
      configured: ["a", "b", "a", "c", "d", "e"],
      visionModel: "ignored",
    });
    assert.deepEqual(
      chain.map((candidate) => candidate.model),
      ["a", "b", "c", "d"],
    );
    const single = recipeVisionChain({
      baseUrl: "https://openrouter.ai/api/v1",
      configured: ["only-model"],
      visionModel: "something-else",
    });
    assert.deepEqual(single, [{ model: "only-model" }]);
  });

  it("keeps the known reasoning override when its model is listed explicitly", () => {
    const chain = recipeVisionChain({
      baseUrl: "https://openrouter.ai/api/v1",
      configured: ["qwen/qwen3.6-35b-a3b", "google/gemini-3-flash-preview"],
      visionModel: "ignored",
    });
    assert.deepEqual(chain[0], { model: "qwen/qwen3.6-35b-a3b", reasoning: { enabled: false } });
    assert.deepEqual(chain[1], { model: "google/gemini-3-flash-preview" });
  });

  it("parses stored and environment lists", () => {
    assert.equal(parseRecipeVisionModels(undefined), null);
    assert.equal(parseRecipeVisionModels(null), null);
    assert.equal(parseRecipeVisionModels(""), null);
    assert.deepEqual(parseRecipeVisionModels("a, b ,, c"), ["a", "b", "c"]);
    assert.deepEqual(parseRecipeVisionModels(["a", 3, " b "]), ["a", "b"]);
    assert.deepEqual(parseRecipeVisionModels("a,b,c,d,e"), ["a", "b", "c", "d"]);
  });

  it("validates a new settings list instead of silently cutting it", () => {
    assert.deepEqual(checkRecipeVisionModels(["a", "b", "a"]), { ok: true, models: ["a", "b"] });
    assert.deepEqual(checkRecipeVisionModels("a, b"), { ok: true, models: ["a", "b"] });
    assert.deepEqual(checkRecipeVisionModels("  "), { ok: true, models: [] });
    assert.equal(checkRecipeVisionModels(["a", 3]).ok, false);
    assert.equal(checkRecipeVisionModels("a b").ok, false);
    const tooMany = checkRecipeVisionModels(["a", "b", "c", "d", "e"]);
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.ok ? 0 : tooMany.reason, "too-many");
    assert.equal(tooMany.ok ? 0 : tooMany.count, 5);
    assert.equal(droppedRecipeVisionModels("a,b,c,d,e,f"), 2);
    assert.equal(droppedRecipeVisionModels("a,b"), 0);
    // A non-string entry must not hide the valid models that were cut off.
    assert.equal(droppedRecipeVisionModels(["a", "b", "c", "d", "e", "f", 3]), 2);
    assert.equal(droppedRecipeVisionModels(["a", "a", "b", "c", "d", "e"]), 1);
    assert.equal(droppedRecipeVisionModels(42), 0);
  });
});

describe("shared recipe prompt", () => {
  it("describes the photo as the primary source and OCR as unreliable", () => {
    const prompt = recipeArchivistPrompt("noise", 1);
    assert.match(prompt, /OCR TEXT \(unreliable/);
    assert.match(prompt, /attached photo/);
    assert.match(prompt, /"recipes"/);
    const textOnly = recipeArchivistPrompt("Pancakes\n2 eggs", 0);
    assert.match(textOnly, /RECIPE TEXT/);
    assert.doesNotMatch(textOnly, /OCR TEXT/);
  });

  it("extracts fenced, chatty and truncated JSON the way the scanner does", () => {
    assert.deepEqual(extractJsonValue('```json\n{"a":1}\n```'), { ok: true, value: { a: 1 } });
    assert.deepEqual(extractJsonValue('Here you go: {"a":1}'), { ok: true, value: { a: 1 } });
    assert.deepEqual(extractJsonValue('{"a":1}\n\nand then the answer stopped'), { ok: true, value: { a: 1 } });
    assert.deepEqual(extractJsonValue("no json at all"), { ok: false, reason: "missing" });
    assert.deepEqual(extractJsonValue('{"a":'), { ok: false, reason: "malformed" });
  });

  it("flags a prefix parse whose text continues the JSON as partial", () => {
    // The first value is complete, but the answer kept going: a cut-off
    // multi-recipe page must not look like a complete single-recipe one.
    assert.deepEqual(extractJsonValue('{"recipes":[{"title":"A"}]}, {"recipes":[{"title":"B"'), {
      ok: true,
      value: { recipes: [{ title: "A" }] },
      partial: true,
    });
    assert.deepEqual(extractJsonValue('{"a":1} trailing }'), { ok: true, value: { a: 1 } });
    // Trailing prose is not a truncation.
    assert.deepEqual(extractJsonValue('{"a":1} — hope that helps'), { ok: true, value: { a: 1 } });
    // Trailing prose may itself contain a bracket; the answer is still complete.
    assert.deepEqual(extractJsonValue('{"recipes":[{"title":"A"}]} Hope it helps [see docs]'), {
      ok: true,
      value: { recipes: [{ title: "A" }] },
    });
    assert.deepEqual(extractJsonValue('{"a":1} Note: see the {appendix}'), { ok: true, value: { a: 1 } });
    // A cut-off multi-recipe answer that stops on a complete inner object is
    // rejected outright, never returned as a complete single-recipe answer.
    assert.deepEqual(extractJsonValue('{"recipes":[{"title":"A"}'), { ok: false, reason: "malformed" });
    assert.deepEqual(extractJsonValue('{"recipes":[{"title":"A"},{"title":"B"}'), {
      ok: false,
      reason: "malformed",
    });
    assert.deepEqual(extractJsonValue('{"recipes":[{"title":"A","ingredients":[{"name":"wa'), {
      ok: false,
      reason: "malformed",
    });
  });

  it("marks a long text prompt as cut off instead of truncating silently", () => {
    const long = recipeArchivistPrompt("x".repeat(13000), 0);
    assert.match(long, /cut off at 12000 characters/);
    assert.equal(long.includes("x".repeat(12001)), false);
    assert.doesNotMatch(recipeArchivistPrompt("short", 0), /cut off/);
  });

  it("accepts a bare recipe object, a recipes array or a top-level array", () => {
    assert.deepEqual(recipeListFromJson({ title: "x" }), [{ title: "x" }]);
    assert.deepEqual(recipeListFromJson({ recipes: [{ title: "a" }, null, "nope", { title: "b" }] }), [
      { title: "a" },
      { title: "b" },
    ]);
    // Some models answer with the array itself instead of wrapping it in
    // `recipes`. Returning [] made the caller reject a usable page.
    assert.deepEqual(recipeListFromJson([{ title: "a" }, { title: "b" }, null]), [
      { title: "a" },
      { title: "b" },
    ]);
    assert.deepEqual(recipeListFromJson([]), []);
    assert.deepEqual(recipeListFromJson(null), []);
  });
});

describe("recipe truth scoring", () => {
  it("folds Greek accents, case and final sigma", () => {
    assert.equal(normaliseText("Ρεβάνι ΜΕ Ινδοκάρυδο"), "ρεβανι με ινδοκαρυδο");
    assert.equal(normaliseText("Τσουρέκια, Λαμπριάτικα!"), "τσουρεκια λαμπριατικα");
    assert.equal(textSimilarity("βούτυρο", "βουτυρο"), 1);
    assert.ok(textSimilarity("βούτυρο", "βουτίρο") > 0.5);
  });

  it("normalises the units a handwritten page uses", () => {
    assert.equal(normaliseUnit("γραμμ."), "g");
    assert.equal(normaliseUnit("γραμμάρια"), "g");
    assert.equal(normaliseUnit("gr"), "g");
    assert.equal(normaliseUnit("κιλά"), "kg");
    assert.equal(normaliseUnit("λίτρ."), "l");
    // The prompt advertises the dotted abbreviation; punctuation normalisation
    // turns it into "κ γ", which must still canonicalise to teaspoons.
    assert.equal(normaliseUnit("κ.γ."), "tsp");
    assert.equal(normaliseUnit("κγ"), "tsp");
    assert.equal(normaliseUnit(""), "");
  });

  it("recognises the Greek singular and plural forms as one unit", () => {
    // A truth row that says "κουταλιές" and a model that writes "κουταλιά"
    // describe the same unit; the plural must not fall through as raw text.
    assert.equal(normaliseUnit("κουταλιές"), "tbsp");
    assert.equal(normaliseUnit("κουταλιά"), "tbsp");
    assert.equal(normaliseUnit("κουταλάκι"), "tsp");
    assert.equal(normaliseUnit("φλιτζάνια"), "cup");
    assert.equal(normaliseUnit("φλιτζάνι"), "cup");
    assert.equal(normaliseUnit("γραμμάριο"), "g");
    assert.equal(normaliseUnit("κιλό"), "kg");
    assert.equal(normaliseUnit("λίτρο"), "l");
    assert.equal(normaliseUnit("τεμάχιο"), "pcs");
    assert.equal(normaliseUnit("πρέζες"), "pinch");
  });

  it("scores an exact reading as 1 even when spelled differently", () => {
    const score = scoreRecipeAgainstTruth(exactRecipe, truth);
    assert.equal(score.score, 1);
    assert.equal(score.matchedIngredients, 3);
    assert.equal(score.matchedQuantities, 3);
    assert.equal(score.inventedIngredients, 0);
  });

  it("punishes a wrong quantity rather than ignoring it", () => {
    const wrong = { ...exactRecipe, ingredients: exactRecipe.ingredients.map((row, index) => (index === 0 ? { ...row, quantity: 610 } : row)) };
    const score = scoreRecipeAgainstTruth(wrong, truth);
    assert.equal(score.matchedQuantities, 2);
    assert.ok(score.score < 0.95, `expected a visible penalty, got ${score.score}`);
    assert.ok(score.score >= 0.8);
    // Quantity loss is exactly the configured weight for one of three rows.
    assert.ok(Math.abs(score.score - (1 - RECIPE_SCORE_WEIGHTS.quantities / 3)) < 0.01);
  });

  it("counts invented ingredients against precision", () => {
    const invented = {
      ...exactRecipe,
      ingredients: [...exactRecipe.ingredients, { name: "Κανέλα", quantity: 5, unit: "g" }],
    };
    const score = scoreRecipeAgainstTruth(invented, truth);
    assert.equal(score.inventedIngredients, 1);
    assert.ok(score.namesScore < 1);
    assert.ok(score.score < 1);
  });

  it("never lets two truth rows claim the same draft ingredient", () => {
    const single = { ingredients: [{ name: "ζάχαρη", quantity: 200, unit: "g" }] };
    const duplicatedTruth = {
      ingredients: [
        { name: "ζάχαρη", quantity: 200, unit: "g" },
        { name: "ζαχαρη", quantity: 200, unit: "g" },
      ],
    };
    const score = scoreRecipeAgainstTruth(single, duplicatedTruth);
    assert.equal(score.matchedIngredients, 1, "one draft row cannot satisfy two truth rows");
    assert.equal(score.inventedIngredients, 0);
    assert.ok(score.namesScore < 1, "recall must not be inflated by the duplicate");
  });

  it("renormalises weights when the truth records only ingredients", () => {
    const onlyIngredients = { ingredients: truth.ingredients };
    const score = scoreRecipeAgainstTruth(exactRecipe, onlyIngredients);
    assert.equal(score.score, 1);
    assert.equal(score.titleScore, 1);
    assert.equal(score.stepsScore, 1);
  });

  it("penalises ingredients the truth never recorded", () => {
    // A steps-only truth cannot confirm any ingredient, but a draft that lists
    // them is unverified content: it must not earn a perfect score, because the
    // docs promise the names score is F1 against invented rows.
    const stepsOnly = { title: "Ρεβάνι", ingredients: [], steps: ["Χτυπάμε το βούτυρο με τη ζάχαρη."] };
    const invented = {
      title: "Ρεβάνι",
      steps: [{ text: "Χτυπάμε το βούτυρο με τη ζάχαρη." }],
      ingredients: [
        { name: "βούτυρο", quantity: 160, unit: "g" },
        { name: "ζάχαρη", quantity: 200, unit: "g" },
      ],
    };
    const score = scoreRecipeAgainstTruth(invented, stepsOnly);
    assert.equal(score.inventedIngredients, 2);
    assert.equal(score.namesScore, 0);
    assert.ok(score.score < 1, `score ${score.score} must not be perfect without recorded ingredients`);
    assert.equal(scoreRecipeAgainstTruth(invented, { title: stepsOnly.title, steps: stepsOnly.steps }).score, 1);

    // A draft that also lists no ingredients is still a complete reading.
    const empty = { title: "Ρεβάνι", steps: [{ text: "Χτυπάμε το βούτυρο με τη ζάχαρη." }] };
    assert.equal(scoreRecipeAgainstTruth(empty, stepsOnly).score, 1);
  });

  it("does not award quantity or unit credit the truth never recorded", () => {
    // The truth names two ingredients but carries no quantities or units, so
    // those dimensions cannot be judged. Leaving their weights in would award
    // 35 % of the score for free and inflate an incomplete reading.
    const namesOnly = {
      title: "Ρεβάνι",
      ingredients: [{ name: "βούτυρο" }, { name: "ζάχαρη" }],
    };
    const partial = { title: "Ρεβάνι", ingredients: [{ name: "βούτυρο" }] };
    const score = scoreRecipeAgainstTruth(partial, namesOnly);
    assert.equal(score.expectedQuantities, 0);
    assert.equal(score.expectedUnits, 0);
    // names F1 = 2 * 0.5 / 1.5, title = 1; no steps in the truth.
    const expected = (0.1 * 1 + 0.35 * (2 * 0.5 * 1) / 1.5) / (0.1 + 0.35);
    assert.ok(Math.abs(score.score - expected) < 0.01, `score ${score.score} should be ${expected}`);
    assert.ok(score.score < 0.8, "the missing ingredient must not be hidden by free quantity credit");
  });

  it("scores steps by word coverage, not exact wording", () => {
    const loose = {
      ...exactRecipe,
      steps: [{ text: "Χτυπάμε καλά το βούτυρο μαζί με τη ζάχαρη." }, { text: "Ψήσιμο στους 180 βαθμούς." }],
    };
    const score = scoreRecipeAgainstTruth(loose, truth);
    assert.ok(score.stepsScore > 0.6, `steps=${score.stepsScore}`);
    assert.ok(score.score > 0.8);
  });

  it("reports similarity to a reference separately from accuracy", () => {
    const reference = {
      title: "Ρεβάνι",
      ingredients: [
        { name: "βούτυρο", quantity: 610, unit: "g" },
        { name: "ζάχαρη", quantity: 200, unit: "g" },
      ],
      steps: ["Χτυπάμε το βούτυρο."],
    };
    const copied = scoreSimilarityToReference(reference, reference);
    assert.equal(copied.score, 1, "a model is identical to itself");
    const different = scoreSimilarityToReference(exactRecipe, reference);
    assert.ok(different.score < 1);
    assert.ok(different.score >= 0);
    // The reference itself carries the wrong 610; copying it must not be "accurate".
    assert.equal(scoreRecipeAgainstTruth(reference, truth).matchedQuantities, 1);
  });

  it("reads only usable ingredients and steps", () => {
    assert.deepEqual(readIngredients([{ name: " Flour ", quantity: "200", unit: "g" }, { name: "" }, null]), [
      { name: "Flour", quantity: 200, unit: "g" },
    ]);
    assert.deepEqual(readSteps(["Mix.", { text: "Bake." }, { text: "" }, 3]), ["Mix.", "Bake."]);
  });
});

const baseManifest = {
  baseUrl: "https://openrouter.ai/api/v1",
  models: ["google/gemini-3-flash-preview", "qwen/qwen3.6-35b-a3b"],
  images: [
    {
      path: "../private-photos/revani.jpg",
      label: "revani",
      truth: { title: "Ρεβάνι", ingredients: [{ name: "βούτυρο", quantity: 160, unit: "g" }] },
    },
  ],
};

describe("benchmark manifest", () => {
  it("accepts a manifest with explicit truth and fills defaults", () => {
    const manifest = parseBenchmarkManifest(baseManifest);
    assert.equal(manifest.models[0].id, "google/gemini-3-flash-preview");
    assert.equal(manifest.reasoning, "auto");
    assert.equal(manifest.referenceModel, null);
    assert.equal(manifest.images[0].label, "revani");
    assert.equal(manifest.images[0].path, "../private-photos/revani.jpg");
  });

  it("refuses credentials and embedded image bytes", () => {
    assert.throws(
      () => parseBenchmarkManifest({ ...baseManifest, apiKey: "sk-secret" }),
      (error: unknown) => error instanceof BenchmarkManifestError && /API keys|credential/i.test(error.message),
    );
    assert.throws(
      () =>
        parseBenchmarkManifest({
          ...baseManifest,
          images: [{ ...baseManifest.images[0], dataUrl: "data:image/jpeg;base64,AAAA" }],
        }),
      (error: unknown) => error instanceof BenchmarkManifestError && /image content|path/i.test(error.message),
    );
    assert.throws(
      () => parseBenchmarkManifest({ ...baseManifest, models: [{ id: "a", token: "secret" }] }),
      (error: unknown) => error instanceof BenchmarkManifestError && /credential/i.test(error.message),
    );
    assert.throws(
      () => parseBenchmarkManifest({ ...baseManifest, baseUrl: "https://user:pass@openrouter.ai/api/v1" }),
      (error: unknown) => error instanceof BenchmarkManifestError && /credentials/i.test(error.message),
    );
  });

  it("caps models and images and rejects duplicates", () => {
    assert.throws(
      () => parseBenchmarkManifest({ ...baseManifest, models: ["a", "b", "c", "d", "e"] }),
      (error: unknown) => error instanceof BenchmarkManifestError && /at most 4/.test(error.message),
    );
    assert.throws(
      () => parseBenchmarkManifest({ ...baseManifest, models: ["a", "a"] }),
      (error: unknown) => error instanceof BenchmarkManifestError && /more than once/.test(error.message),
    );
    assert.throws(
      () => parseBenchmarkManifest({ ...baseManifest, models: [" "], images: baseManifest.images }),
      (error: unknown) => error instanceof BenchmarkManifestError && /model ID/.test(error.message),
    );
  });

  it("requires truth or an explicit reference model", () => {
    assert.throws(
      () =>
        parseBenchmarkManifest({
          ...baseManifest,
          images: [{ path: "photo.jpg", label: "no-truth" }],
        }),
      (error: unknown) => error instanceof BenchmarkManifestError && /no truth and the manifest has no referenceModel/.test(error.message),
    );
    assert.throws(
      () => parseBenchmarkManifest({ ...baseManifest, referenceModel: "not-listed" }),
      (error: unknown) => error instanceof BenchmarkManifestError && /must also be listed/.test(error.message),
    );
    const withReference = parseBenchmarkManifest({
      ...baseManifest,
      referenceModel: "google/gemini-3-flash-preview",
      images: [{ path: "photo.jpg", label: "no-truth" }],
    });
    assert.equal(withReference.referenceModel, "google/gemini-3-flash-preview");
  });

  it("rejects an empty truth and non-numeric quantities", () => {
    assert.throws(
      () => parseBenchmarkManifest({ ...baseManifest, images: [{ path: "p.jpg", truth: {} }] }),
      (error: unknown) => error instanceof BenchmarkManifestError && /is empty/.test(error.message),
    );
    assert.throws(
      () =>
        parseBenchmarkManifest({
          ...baseManifest,
          images: [{ path: "p.jpg", truth: { ingredients: [{ name: "flour", quantity: "200g" }] } }],
        }),
      (error: unknown) => error instanceof BenchmarkManifestError && /quantity must be a number/.test(error.message),
    );
    assert.throws(
      () =>
        parseBenchmarkManifest({
          ...baseManifest,
          images: [{ path: "p.jpg", truth: { ingredients: [{ name: "flour", quantity: -200 }] } }],
        }),
      (error: unknown) => error instanceof BenchmarkManifestError && /quantity must be non-negative/.test(error.message),
    );
  });

  it("rejects an unknown reasoning mode on a model", () => {
    assert.throws(
      () =>
        parseBenchmarkManifest({
          ...baseManifest,
          models: [{ id: "a", reasoning: "maximum" }],
        }),
      (error: unknown) =>
        error instanceof BenchmarkManifestError && /reasoning must be auto, off, low, medium, high/.test(error.message),
    );
    assert.throws(
      () => parseBenchmarkManifest({ ...baseManifest, models: [{ id: "a", reasoning: 5 }] }),
      (error: unknown) =>
        error instanceof BenchmarkManifestError && /reasoning must be auto, off, low, medium, high/.test(error.message),
    );
    const parsed = parseBenchmarkManifest({ ...baseManifest, models: [{ id: "a", reasoning: "high" }] });
    assert.equal(parsed.models[0].reasoning, "high");
  });

  it("normalises a model's reasoning the same way the server does", () => {
    const parsed = parseBenchmarkManifest({
      ...baseManifest,
      models: [
        { id: "a", reasoning: " High " },
        { id: "b", reasoning: "AUTO" },
      ],
    });
    assert.equal(parsed.models[0].reasoning, "high");
    assert.equal(parsed.models[1].reasoning, "auto");
  });
});

describe("benchmark request and report", () => {
  it("sends the production prompt and shape", () => {
    const body = benchmarkChatBody({ model: "google/gemini-3-flash-preview", imageDataUrl: "data:image/png;base64,AAAA" }) as any;
    assert.equal(body.model, "google/gemini-3-flash-preview");
    assert.equal(body.max_tokens, MAX_RECIPE_VISION_TOKENS);
    assert.equal(body.temperature, 0.1);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.reasoning, undefined);
    assert.match(String(body.messages[0].content), /family-recipe archivist/);
    const parts = body.messages[1].content;
    assert.ok(Array.isArray(parts));
    assert.equal(parts[0].type, "text");
    assert.equal(parts[1].type, "image_url");
    assert.equal(parts[1].image_url.url, "data:image/png;base64,AAAA");

    const withReasoning = benchmarkChatBody({
      model: "qwen/qwen3.6-35b-a3b",
      imageDataUrl: null,
      reasoning: "off",
    }) as any;
    assert.deepEqual(withReasoning.reasoning, { enabled: false });
    assert.equal(typeof withReasoning.messages[1].content, "string");
  });

  it("uses provider cost first and configured prices otherwise", () => {
    assert.equal(benchmarkCost({ cost: 0.001557, prompt_tokens: 1000, completion_tokens: 500 }, { input: null, output: null }), 0.001557);
    assert.equal(benchmarkCost({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, { input: 1, output: 2 }), 3);
    assert.equal(benchmarkCost({ prompt_tokens: 1000, completion_tokens: 500 }, { input: null, output: null }), null);
    // A reported zero is a real price, not an unknown one.
    assert.equal(benchmarkCost({ cost: 0, prompt_tokens: 10 }, { input: 1, output: 1 }), 0);
    // No usage at all with configured prices is unknown, not free.
    assert.equal(benchmarkCost(null, { input: 1, output: 2 }), null);
    assert.equal(benchmarkCost(undefined, { input: 1, output: 2 }), null);
    // A usage object without token counts cannot be priced either.
    assert.equal(benchmarkCost({}, { input: 1, output: 2 }), null);
    // Explicit null counts are absent, not zero priced tokens.
    assert.equal(benchmarkCost({ cost: null, prompt_tokens: null, completion_tokens: null }, { input: 1, output: 2 }), null);
    // Half a usage object is unknown, not a free half: pricing the reported
    // side and calling the other zero would report a complete but understated
    // cost.
    assert.equal(benchmarkCost({ prompt_tokens: 1_000_000 }, { input: 1, output: 2 }), null);
    assert.equal(benchmarkCost({ completion_tokens: 1_000_000 }, { input: 1, output: 2 }), null);
    assert.equal(
      benchmarkCost({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, { input: null, output: 2 }),
      null,
      "one configured price cannot price both token sides",
    );
  });

  it("summarises scores and flags incomplete cost", () => {
    const runs: BenchmarkRun[] = [
      { model: "a", image: "one", score: 0.9, referenceScore: 0.8, cost: 0.001, promptTokens: 10, completionTokens: 5, durationMs: 10, ok: true, error: null, notes: [] },
      { model: "a", image: "two", score: 0.7, referenceScore: null, cost: 0.002, promptTokens: 20, completionTokens: 10, durationMs: 20, ok: true, error: null, notes: [] },
      { model: "b", image: "one", score: null, referenceScore: null, cost: null, promptTokens: 0, completionTokens: 0, durationMs: 5, ok: false, error: "HTTP 429", notes: [] },
      { model: "c", image: "one", score: 1, referenceScore: 1, cost: 0.0005, promptTokens: 1, completionTokens: 1, durationMs: 1, ok: true, error: null, notes: [] },
    ];
    const report = aggregateBenchmark(runs);
    assert.equal(report.models[0].model, "c", "best score first");
    assert.equal(report.models[1].model, "a");
    assert.equal(report.models[1].meanScore, 0.8);
    assert.equal(report.models[1].cost, 0.003);
    assert.equal(report.models[1].costComplete, true);
    assert.equal(report.models[2].model, "b");
    assert.equal(report.models[2].failures, 1);
    assert.equal(report.models[2].costComplete, false);
    assert.equal(report.totals.runs, 4);
    assert.equal(report.totals.failures, 1);
    assert.equal(report.totals.cost, 0.0035);
    assert.equal(report.totals.costComplete, false);
  });
});

describe("recipe vision benchmark script", () => {
  it("rejects a --models override that drops the reference model with a clear error", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "svault-bench-override-"));
    try {
      const manifestPath = path.join(directory, "manifest.json");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          models: ["mock-a", "mock-b"],
          referenceModel: "mock-a",
          images: [{ path: "page.png", label: "page" }],
        }),
      );
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.resolve("scripts/recipe-vision-benchmark.mjs"),
          manifestPath,
          "--models",
          "mock-b",
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(result.stderr, /must also be listed in models/);
      assert.doesNotMatch(result.stderr, /TypeError/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a flag whose value is missing", () => {
    const missingManifest = path.join(tmpdir(), "svault-bench-missing-manifest.json");
    const cases: Array<[string[], RegExp]> = [
      [["--json"], /--json needs a value/],
      [["--base-url"], /--base-url needs a value/],
      [["--models"], /--models needs a value/],
      // A following flag is not a value either: without this guard `--json`
      // would consume `--models` as its report path and still run the calls.
      [["--json", "--models", "mock-a"], /--json needs a value/],
    ];
    for (const [args, expected] of cases) {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.resolve("scripts/recipe-vision-benchmark.mjs"),
          missingManifest,
          ...args,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 1, `${args.join(" ")} must exit 1`);
      assert.match(result.stderr, expected);
      assert.doesNotMatch(result.stderr, /ENOENT|Cannot read manifest/);
    }
  });

  it("runs end to end against a local provider and keeps secrets and photos out of the report", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "svault-bench-"));
    const requests: any[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push({ headers: req.headers, body });
        if (body.model === "mock-fail") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Mock upstream exploded" } }));
          return;
        }
        if (body.model === "mock-retry-fail") {
          if (body.reasoning?.enabled !== false) {
            // Reasoning-only answer with no usage, then the retry fails too.
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                choices: [{ message: { content: null, reasoning: "thinking…" }, finish_reason: "length" }],
              }),
            );
            return;
          }
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Mock retry exploded" } }));
          return;
        }
        const payload =
          body.model === "mock-a"
            ? {
                recipes: [
                  {
                    title: "Pancakes",
                    ingredients: [{ name: "flour", quantity: 200, unit: "g" }],
                    steps: [{ text: "Mix well." }],
                  },
                ],
              }
            : {
                recipes: [
                  {
                    title: "Pancakes",
                    ingredients: [{ name: "flour", quantity: 900, unit: "g" }],
                    steps: [{ text: "Mix well." }],
                  },
                ],
              };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(payload) } }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 50,
              total_tokens: 150,
              // A provider may report usage but no price at all.
              ...(body.model === "mock-usage-no-price" ? {} : { cost: 0.001 }),
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    try {
      writeFileSync(path.join(directory, "page.png"), Buffer.alloc(64, 7));
      const manifestPath = path.join(directory, "manifest.json");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          models: ["mock-a", "mock-b"],
          images: [
            {
              path: "page.png",
              label: "page",
              truth: {
                title: "Pancakes",
                ingredients: [{ name: "flour", quantity: 200, unit: "g" }],
                steps: ["Mix well."],
              },
            },
          ],
        }),
      );
      const secret = "super-secret-test-key";
      const runBenchmark = async (manifestFile: string, reportFile: string) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            path.resolve("scripts/recipe-vision-benchmark.mjs"),
            manifestFile,
            "--base-url",
            `http://127.0.0.1:${address.port}/v1`,
            "--json",
            reportFile,
          ],
          {
            env: { ...process.env, OPENAI_API_KEY: secret },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        return await new Promise<string>((resolve, reject) => {
          let stdout = "";
          let stderr = "";
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`benchmark timed out. stderr: ${stderr.slice(0, 500)}`));
          }, 60_000);
          child.stdout.on("data", (chunk) => {
            stdout += String(chunk);
          });
          child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(stdout);
            else reject(new Error(`benchmark exited ${code}: ${stderr.slice(0, 1000) || stdout.slice(0, 1000)}`));
          });
        });
      };

      const reportPath = path.join(directory, "report.json");
      const output = await runBenchmark(manifestPath, reportPath);
      assert.match(output, /mock-a/);
      assert.doesNotMatch(output, new RegExp(secret));

      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      assert.deepEqual(report.models, ["mock-a", "mock-b"]);
      assert.equal(report.summary.models[0].model, "mock-a");
      assert.equal(report.summary.models[0].meanScore, 1);
      assert.ok(report.summary.models[1].meanScore < 1, "the wrong quantity must lower the score");
      assert.equal(report.summary.totals.cost, 0.002);
      assert.equal(report.summary.totals.failures, 0);
      // Only a data URL goes to the provider; the report must not carry it.
      assert.ok(requests.length > 0, "the benchmark must actually call the provider");
      assert.ok(requests.every((entry) => JSON.stringify(entry.body).includes("data:image/png;base64,")));
      const rawReport = readFileSync(reportPath, "utf8");
      assert.doesNotMatch(rawReport, /data:image/);
      assert.doesNotMatch(rawReport, new RegExp(secret));

      // With no written truth, an explicitly named reference model is the
      // basis instead. The reference is measured once and reused.
      requests.length = 0;
      const referenceManifestPath = path.join(directory, "reference-manifest.json");
      writeFileSync(
        referenceManifestPath,
        JSON.stringify({
          models: ["mock-a", "mock-b"],
          referenceModel: "mock-a",
          images: [{ path: "page.png", label: "page" }],
        }),
      );
      const referenceReportPath = path.join(directory, "reference-report.json");
      await runBenchmark(referenceManifestPath, referenceReportPath);
      assert.equal(requests.length, 2, "the reference model must not be billed twice");
      const referenceReport = JSON.parse(readFileSync(referenceReportPath, "utf8"));
      assert.equal(referenceReport.referenceModel, "mock-a");
      assert.equal(referenceReport.summary.models[0].model, "mock-b", "the differing answer sorts first on similarity");
      assert.ok(referenceReport.summary.models[0].meanReferenceScore > 0.5);
      assert.equal(referenceReport.summary.models[0].meanScore, null);
      // The reference model's own row has no similarity-to-itself score, and
      // that null must not be averaged in as a zero.
      const referenceRow = referenceReport.summary.models.find((model: any) => model.model === "mock-a");
      assert.equal(referenceRow.meanReferenceScore, null);

      // Failed calls report an unknown price, not a free one. A request that
      // never reached usage, a response with usage but no price, and a failed
      // reasoning retry must all end up as `null` in the report.
      requests.length = 0;
      const failureManifestPath = path.join(directory, "failure-manifest.json");
      writeFileSync(
        failureManifestPath,
        JSON.stringify({
          models: ["mock-fail", "mock-usage-no-price", "mock-retry-fail"],
          images: [
            {
              path: "page.png",
              label: "page",
              truth: { title: "Pancakes", ingredients: [{ name: "flour", quantity: 200, unit: "g" }] },
            },
          ],
        }),
      );
      const failureReportPath = path.join(directory, "failure-report.json");
      await runBenchmark(failureManifestPath, failureReportPath);
      const failureReport = JSON.parse(readFileSync(failureReportPath, "utf8"));
      const byModel = Object.fromEntries(failureReport.runs.map((run: any) => [run.model, run]));
      assert.ok(failureReport.runs.length > 0, "the report must describe the runs");
      assert.equal(byModel["mock-fail"].cost, null, "an HTTP failure before usage has unknown cost");
      assert.equal(byModel["mock-usage-no-price"].cost, null, "usage without a price is unknown");
      assert.equal(byModel["mock-retry-fail"].cost, null, "a failed retry with no usage is unknown");
      assert.equal(failureReport.summary.totals.costComplete, false);
      assert.equal(failureReport.summary.totals.cost, 0);
    } finally {
      server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
