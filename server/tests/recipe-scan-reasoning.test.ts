import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createRecipeScanFixture } from "./helpers/recipe-scan-fixture.js";

const fixture = await createRecipeScanFixture();
const { request, aiRequests, aiBase, houseId } = fixture;
const { aiCleanRecipe, aiReadRecipes, extractJson, resolveAi } = await import("../ai.js");

after(async () => {
  await fixture.close();
});

describe("recipe scan reasoning and provider fields", () => {
  it("sends the recipe reasoning setting and records reasoning tokens", async () => {
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", recipeReasoning: "low" } } },
    });
    aiRequests.length = 0;
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs" },
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "ai");
    assert.deepEqual(aiRequests[0].body.reasoning, { effort: "low" });

    const logs = await request(`/api/houses/${houseId}/ai/logs?scope=mine`);
    const entry = logs.data.logs.find((log: any) => log.operation === "recipe.scan" && log.status === "ok");
    assert.deepEqual(entry.metadata.reasoning, { effort: "low" });
    assert.equal(entry.metadata.reasoningTokens, 0);

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", recipeReasoning: "auto" } } },
    });
  });

  it("does not pay twice for a reasoning retry on a non-OpenRouter endpoint", async () => {
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "reasoning-only-model", recipeReasoning: "high" } } },
    });
    aiRequests.length = 0;
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs" },
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "local");
    assert.match(scan.data.warning, /reasoning/i);
    // This endpoint ignores (or does not know) OpenRouter's reasoning field, so
    // a {"enabled": false} retry would send the same photo again for nothing.
    assert.equal(aiRequests.length, 1);
    assert.deepEqual(aiRequests[0].body.reasoning, { effort: "high" });
    assert.ok(scan.data.draft.ingredients.length > 0, "the local draft must survive");

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", recipeReasoning: "auto" } } },
    });
  });

  it("retries with reasoning disabled on an endpoint that honours it", async () => {
    // OpenRouter is the endpoint that accepts the field; this exercises the
    // same server helper the route uses with that capability turned on.
    const cfg = {
      ...resolveAi({
        ai: { enabled: true, baseUrl: aiBase, apiKey: "test-key", model: "mock-model", recipeReasoning: "auto" },
      }),
      reasoningControl: true,
    };
    aiRequests.length = 0;
    const result = await aiReadRecipes(
      cfg,
      "Pancakes\n2 eggs",
      [],
      { operation: "recipe.scan", houseId },
      { models: [{ model: "reasoning-only-model" }] },
    );
    assert.equal(result.data.recipes.length, 1);
    assert.equal(result.model, "reasoning-only-model");
    assert.equal(aiRequests.length, 2);
    assert.equal(aiRequests[0].body.reasoning, undefined);
    assert.deepEqual(aiRequests[1].body.reasoning, { enabled: false });
    assert.match(result.notes?.join(" ") ?? "", /retried with reasoning disabled/i);
    // Both attempts are billed in the reported usage.
    assert.equal(result.usage.cost, 0.00305);
  });

  it("names a reasoning attempt that reported no price before the retry", async () => {
    // The first attempt returns no text and no usage at all. Its spend cannot
    // be priced, so the total (which sums both attempts) must warn instead of
    // silently reporting only the retry's cost.
    const cfg = {
      ...resolveAi({
        ai: { enabled: true, baseUrl: aiBase, apiKey: "test-key", model: "mock-model", recipeReasoning: "auto" },
      }),
      reasoningControl: true,
    };
    aiRequests.length = 0;
    const result = await aiReadRecipes(
      cfg,
      "Pancakes\n2 eggs",
      [],
      { operation: "recipe.scan", houseId },
      { models: [{ model: "reasoning-unpriced-model" }] },
    );
    assert.equal(result.data.recipes.length, 1);
    assert.equal(aiRequests.length, 2);
    assert.deepEqual(aiRequests[1].body.reasoning, { enabled: false });
    assert.equal(result.usage.cost, 0.00125, "the priced retry is still reported");
    const notes = result.notes?.join(" ") ?? "";
    assert.match(notes, /reasoning-unpriced-model did not report a price/i);
    assert.match(notes, /lower than the actual spend/i);
  });

  it("honours an explicit reasoning mode instead of retrying it away", async () => {
    const cfg = {
      ...resolveAi({
        ai: { enabled: true, baseUrl: aiBase, apiKey: "test-key", model: "mock-model", recipeReasoning: "high" },
      }),
      reasoningControl: true,
    };
    aiRequests.length = 0;
    await assert.rejects(
      aiReadRecipes(
        cfg,
        "Pancakes\n2 eggs",
        [],
        { operation: "recipe.scan", houseId },
        { models: [{ model: "reasoning-only-model" }] },
      ),
      /reasoning/i,
    );
    // The user chose High, so the failure is reported after one billed call;
    // switching reasoning off would silently override that choice.
    assert.equal(aiRequests.length, 1);
    assert.deepEqual(aiRequests[0].body.reasoning, { effort: "high" });
  });

  it("carries notes and accumulated usage on the thrown chain failure", async () => {
    const cfg = resolveAi({
      ai: { enabled: true, baseUrl: aiBase, apiKey: "test-key", model: "mock-model" },
    });
    await assert.rejects(
      aiReadRecipes(
        cfg,
        "Pancakes\n2 eggs",
        [],
        { operation: "recipe.scan", houseId },
        { models: [{ model: "chain-500-model" }, { model: "chain-empty-model" }] },
      ),
      (error: any) => {
        assert.equal(error.status, 502);
        assert.ok(Array.isArray(error.details?.notes), "the route reads details.notes for its warning");
        assert.ok(error.details.notes.length >= 2);
        // The 500 reported no usage; the empty answer cost 0.0009 and must
        // survive on details.usage so the route can show the spend.
        assert.equal(error.details?.usage?.cost, 0.0009);
        return true;
      },
    );
  });

  it("keeps the local parse when a truncated answer is not retried", async () => {
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "truncated-model", recipeReasoning: "high" } } },
    });
    aiRequests.length = 0;
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs\n1 cup flour" },
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "local");
    assert.match(scan.data.warning, /token limit/i);
    assert.equal(aiRequests.length, 1, "no second identical call on a non-OpenRouter endpoint");
    assert.ok(scan.data.draft.ingredients.length > 0, "the local draft must survive");
    // The failed attempt still reported a price, so the spend stays visible.
    assert.equal(scan.data.aiCost, 0.0018);

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", recipeReasoning: "auto" } } },
    });
  });

  it("drops the reasoning field when an endpoint rejects it", async () => {
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "reject-reasoning-model", recipeReasoning: "medium" } } },
    });
    aiRequests.length = 0;
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs" },
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "ai");
    assert.match(scan.data.warning, /rejected the reasoning setting/i);
    assert.equal(aiRequests.length, 2);
    assert.deepEqual(aiRequests[0].body.reasoning, { effort: "medium" });
    assert.equal(aiRequests[1].body.reasoning, undefined);

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", recipeReasoning: "auto" } } },
    });
  });

  it("keeps the field-rejection note when the retry also fails", async () => {
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: {
        settings: {
          ai: {
            model: "reasoning-reject-then-fail-model",
            recipeVisionModels: [],
            recipeReasoning: "high",
          },
        },
      },
    });
    aiRequests.length = 0;
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs" },
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "local");
    assert.match(scan.data.warning, /AI cleanup failed/i);
    assert.match(scan.data.warning, /rejected the reasoning setting/i);
    assert.equal(aiRequests.length, 2);
    assert.deepEqual(aiRequests[0].body.reasoning, { effort: "high" });
    assert.equal(aiRequests[1].body.reasoning, undefined);

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", recipeReasoning: "auto" } } },
    });
  });

  it("does not retry an auth failure without the reasoning field", async () => {
    const cfg = {
      ...resolveAi({
        ai: { enabled: true, baseUrl: aiBase, apiKey: "test-key", model: "mock-model", recipeReasoning: "high" },
      }),
      reasoningControl: true,
    };
    aiRequests.length = 0;
    await assert.rejects(
      aiReadRecipes(
        cfg,
        "Pancakes\n2 eggs",
        [],
        { operation: "recipe.scan", houseId },
        { models: [{ model: "unauthorised-model" }] },
      ),
      /Invalid API key/,
    );
    assert.equal(aiRequests.length, 1, "401 must not be retried without the field");
    assert.deepEqual(aiRequests[0].body.reasoning, { effort: "high" });
  });

  it("rejects a JSON answer that was cut off mid-value", () => {
    assert.throws(
      () => extractJson('{"recipes":[{"title":"A"}]}, {"recipes":[{"title":"B"'),
      /cut off before the answer was complete/i,
    );
  });

  it("retries JSON mode without response_format when a provider sends a generic 400", async () => {
    const cfg = resolveAi({
      ai: { enabled: true, baseUrl: aiBase, apiKey: "test-key", model: "json-reject-model" },
    });
    aiRequests.length = 0;
    const result = await aiReadRecipes(cfg, "Pancakes\n2 eggs", [], { operation: "recipe.scan", houseId }, {
      models: [{ model: "json-reject-model" }],
    });
    assert.equal(result.data.recipes.length, 1);
    assert.equal(aiRequests.length, 2, "the JSON-mode request is retried once without response_format");
    assert.deepEqual(aiRequests[0].body.response_format, { type: "json_object" });
    assert.equal(aiRequests[1].body.response_format, undefined);
  });

  it("does not retry a content-type 400 without response_format", async () => {
    const cfg = resolveAi({
      ai: { enabled: true, baseUrl: aiBase, apiKey: "test-key", model: "content-type-model" },
    });
    aiRequests.length = 0;
    await assert.rejects(
      aiCleanRecipe(cfg, "A note about soup", [], { operation: "recipe.import", houseId }),
      /Unsupported content type/,
    );
    assert.equal(aiRequests.length, 1, "an error that blames the request body is not a field rejection");
  });

  it("reports input truncation as an incomplete import", async () => {
    const cfg = resolveAi({
      ai: { enabled: true, baseUrl: aiBase, apiKey: "test-key", model: "mock-model" },
    });
    const result = await aiCleanRecipe(cfg, "x".repeat(12001), [], {
      operation: "recipe.import",
      houseId,
    });
    assert.equal(result.truncated, true, "the 12000-character cut leaves the recipe incomplete");
    assert.match(result.notes?.join(" ") ?? "", /cut off at 12000 characters/i);
  });

  it("cleans link-import text without the photo prompt or vision budget", async () => {
    const cfg = resolveAi({
      ai: { enabled: true, baseUrl: aiBase, apiKey: "test-key", model: "title-only-model" },
    });
    aiRequests.length = 0;
    const result = await aiCleanRecipe(cfg, "A note about soup", [], {
      operation: "recipe.import",
      houseId,
    });
    assert.equal(result.data.title, "Notes only");
    assert.equal(result.data.ingredients, undefined, "a title/notes answer is accepted, not rejected");
    assert.equal(aiRequests[0].body.model, "title-only-model", "the text model is used, not a vision model");
    assert.equal(aiRequests[0].body.max_tokens, undefined, "the vision output budget is not applied");
    assert.match(String(aiRequests[0].body.messages[0].content), /raw recipe text/i);

    const multi = resolveAi({
      ai: { enabled: true, baseUrl: aiBase, apiKey: "test-key", model: "multi-model" },
    });
    const two = await aiCleanRecipe(multi, "Tsoureki and biscuits", [], {
      operation: "recipe.import",
      houseId,
    });
    assert.equal(two.data.title, "AI pancakes", "a single-recipe import keeps the first recipe");
    assert.match(two.notes?.join(" ") ?? "", /2 recipes; only the first was imported/i);
  });
});
