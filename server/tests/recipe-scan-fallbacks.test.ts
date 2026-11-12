import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createRecipeScanFixture } from "./helpers/recipe-scan-fixture.js";

const fixture = await createRecipeScanFixture();
const { request, aiRequests, aiBase, houseId, base, cookie } = fixture;
const { aiReadRecipes, resolveAi } = await import("../ai.js");
const { encodePng } = await import("../lib/png.js");

after(async () => {
  await fixture.close();
});

describe("recipe scan fallback chains and truncation", () => {
  it("falls back to the next recipe model only after a failure", async () => {
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: {
        settings: {
          ai: {
            model: "mock-model",
            recipeVisionModels: ["chain-500-model", "chain-empty-model", "chain-ok-model"],
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
    assert.equal(scan.data.provider, "ai");
    assert.equal(scan.data.draft.title, "Fallback pancakes");
    assert.deepEqual(scan.data.aiModels, ["chain-500-model", "chain-empty-model", "chain-ok-model"]);
    assert.equal(scan.data.aiModel, "chain-ok-model");
    assert.equal(aiRequests.length, 3);
    assert.deepEqual(
      aiRequests.map((entry) => entry.body.model),
      ["chain-500-model", "chain-empty-model", "chain-ok-model"],
    );
    assert.match(scan.data.warning, /chain-500-model did not return a usable recipe/i);
    assert.match(scan.data.warning, /chain-empty-model did not return a usable recipe/i);
    // The successful attempt costs 0.00125 and the empty one 0.0009; the
    // provider failure is free but must not hide the known spend.
    assert.equal(scan.data.aiCost, 0.00215);

    const logs = await request(`/api/houses/${houseId}/ai/logs?scope=mine`);
    const successful = logs.data.logs.find((log: any) => log.status === "ok" && log.model === "chain-ok-model");
    assert.deepEqual(successful.metadata.visionChain, ["chain-500-model", "chain-empty-model", "chain-ok-model"]);
    assert.equal(successful.metadata.visionIndex, 2);

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", recipeVisionModels: [] } } },
    });
  });

  it("keeps the known spend when an earlier attempt reported no price", async () => {
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", recipeVisionModels: ["unpriced-empty-model", "chain-ok-model"] } } },
    });
    aiRequests.length = 0;
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs" },
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "ai");
    // The empty attempt had usage but no price; the successful model still
    // reported 0.00125, which must not be hidden behind a null total.
    assert.equal(scan.data.aiCost, 0.00125);
    assert.match(scan.data.warning, /unpriced-empty-model did not report a price/i);
    assert.match(scan.data.warning, /lower than the actual spend/i);

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", recipeVisionModels: [] } } },
    });
  });

  it("falls back to the next model when a usable answer is truncated", async () => {
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: {
        settings: { ai: { model: "mock-model", recipeVisionModels: ["truncated-json-model", "chain-ok-model"] } },
      },
    });
    aiRequests.length = 0;
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs\n1 cup flour" },
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "ai");
    assert.equal(scan.data.draft.title, "Fallback pancakes", "the complete answer wins over the truncated one");
    assert.match(scan.data.warning, /hit the output token limit/i);
    assert.match(scan.data.warning, /next model was tried/i);
    assert.equal(scan.data.aiCost, 0.0025, "both the truncated and the complete call are billed");
    assert.deepEqual(scan.data.aiModels, ["truncated-json-model", "chain-ok-model"]);

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", recipeVisionModels: [] } } },
    });
  });

  it("keeps a usable truncated recipe when no later model can improve it", async () => {
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", recipeVisionModels: ["truncated-json-model"] } } },
    });
    aiRequests.length = 0;
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs\n1 cup flour" },
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "ai", "the partial answer is better than the local draft");
    assert.equal(scan.data.draft.title, "AI pancakes");
    assert.equal(scan.data.truncated, true, "the caller can tell the answer was cut off");
    assert.match(scan.data.warning, /may be incomplete/i);
    assert.equal(scan.data.aiCost, 0.00125);
    assert.deepEqual(scan.data.aiModels, ["truncated-json-model"]);

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", recipeVisionModels: [] } } },
    });
  });

  it("does not accept a title-only truncated answer as a read", async () => {
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: {
        settings: {
          ai: {
            enabled: true,
            baseUrl: aiBase,
            apiKey: "test-key",
            model: "mock-model",
            recipeVisionModels: ["truncated-title-model"],
          },
        },
      },
    });
    aiRequests.length = 0;
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs\n1 cup flour" },
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "local", "a title is not a usable AI read");
    assert.equal(scan.data.truncated, false);
    assert.match(scan.data.warning, /token limit/i);
    assert.equal(scan.data.aiCost, 0.00125, "the failed attempt is still billed");
    assert.ok(scan.data.draft.ingredients.length > 0, "the local draft must survive");

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", recipeVisionModels: [] } } },
    });
  });

  it("refuses to save a truncated AI read unattended", async () => {
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: {
        settings: {
          ai: {
            enabled: true,
            baseUrl: aiBase,
            apiKey: "test-key",
            model: "mock-model",
            recipeVisionModels: ["truncated-json-model"],
          },
        },
      },
    });
    const before = await request(`/api/houses/${houseId}/recipes`);
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs\n1 cup flour", save: true },
    });
    assert.equal(scan.status, 409, "a partial read must be reviewed, not saved silently");
    assert.match(scan.data.error, /cut off at the output token limit/i);
    const after = await request(`/api/houses/${houseId}/recipes`);
    assert.equal(after.data.length, before.data.length, "nothing was persisted");

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", recipeVisionModels: [] } } },
    });
  });

  it("does not save a blank recipe when nothing was read", async () => {
    const png = encodePng(16, 16, Buffer.alloc(16 * 16 * 4, 200));
    const bytes = new ArrayBuffer(png.length);
    new Uint8Array(bytes).set(png);
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: "image/png" }), "empty.png");
    const upload = await fetch(`${base}/api/houses/${houseId}/recipes/upload`, {
      method: "POST",
      body: form,
      headers: { cookie },
    });
    const { path: imagePath } = await upload.json();

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { enabled: false } } },
    });
    try {
      const preview = await request(`/api/houses/${houseId}/recipes/scan`, {
        method: "POST",
        body: { image: imagePath },
      });
      assert.equal(preview.status, 200);
      assert.equal(preview.data.count, 0);
      assert.deepEqual(preview.data.drafts, []);
      assert.equal(preview.data.draft, null);
      // An empty result still has to tell the client why, otherwise the UI has
      // nothing to show after the user pressed "read the recipe".
      assert.match(String(preview.data.warning), /No AI provider configured|No text was recognised/i);

      const saved = await request(`/api/houses/${houseId}/recipes/scan`, {
        method: "POST",
        body: { image: imagePath, save: true },
      });
      assert.equal(saved.status, 400);
      assert.match(saved.data.error, /No recipe could be read/i);
    } finally {
      await request(`/api/houses/${houseId}`, {
        method: "PATCH",
        body: { settings: { ai: { enabled: true } } },
      });
    }
  });

  it("does not replace a successful recipe with a later model", async () => {
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: {
        settings: { ai: { model: "mock-model", recipeVisionModels: ["chain-ok-model", "mock-model"] } },
      },
    });
    aiRequests.length = 0;
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs" },
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "ai");
    assert.equal(scan.data.draft.title, "Fallback pancakes");
    assert.equal(aiRequests.length, 1, "the second model must not be billed after a success");
    assert.deepEqual(scan.data.aiModels, ["chain-ok-model"]);
    assert.equal(scan.data.warning, null);
    assert.equal(scan.data.aiCost, 0.00125);

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", recipeVisionModels: [] } } },
    });
  });

  it("keeps the local draft and reports every failed model when the chain is exhausted", async () => {
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: {
        settings: { ai: { model: "mock-model", recipeVisionModels: ["chain-429-model", "truncated-model"] } },
      },
    });
    aiRequests.length = 0;
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs\n1 cup flour" },
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "local");
    assert.match(scan.data.warning, /chain-429-model did not return a usable recipe/i);
    assert.match(scan.data.warning, /truncated-model did not return a usable recipe/i);
    // The 429 has no price, the truncated answer reported 0.0018; a partial
    // sum is better than nothing, so the known spend is exposed and the
    // warning says the total may be lower than the actual bill.
    assert.equal(scan.data.aiCost, 0.0018);
    assert.match(scan.data.warning, /did not report a price/i);
    assert.ok(scan.data.draft.ingredients.length > 0, "the local draft must survive");
    assert.deepEqual(scan.data.aiModels, ["chain-429-model", "truncated-model"]);

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", recipeVisionModels: [] } } },
    });
  });

  it("sums two billed failures without double counting the spend", async () => {
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: {
        settings: {
          ai: {
            enabled: true,
            baseUrl: aiBase,
            apiKey: "test-key",
            model: "mock-model",
            recipeVisionModels: ["chain-empty-model", "truncated-model"],
          },
        },
      },
    });
    aiRequests.length = 0;
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs\n1 cup flour" },
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "local");
    assert.match(scan.data.warning, /chain-empty-model did not return a usable recipe/i);
    assert.match(scan.data.warning, /truncated-model did not return a usable recipe/i);
    // 0.0009 (empty answer) + 0.0018 (truncated answer), each billed once.
    assert.equal(scan.data.aiCost, 0.0027);
    assert.deepEqual(scan.data.aiModels, ["chain-empty-model", "truncated-model"]);

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", recipeVisionModels: [] } } },
    });
  });

  it("attributes a kept partial answer to the model that produced it and keeps its cost", async () => {
    // Model A is truncated but usable; the later model fails without ever
    // producing text. The returned recipe belongs to A, so the attribution and
    // its billed cost must both survive the chain walk.
    const cfg = resolveAi({
      ai: { enabled: true, baseUrl: aiBase, apiKey: "test-key", model: "mock-model" },
    });
    aiRequests.length = 0;
    const result = await aiReadRecipes(cfg, "Pancakes\n2 eggs", [], { operation: "recipe.scan", houseId }, {
      models: [{ model: "truncated-json-model" }, { model: "chain-500-model" }],
    });
    assert.equal(result.model, "truncated-json-model");
    assert.deepEqual(result.models, ["truncated-json-model", "chain-500-model"]);
    assert.equal(result.truncated, true);
    assert.equal(result.data.recipes.length, 1);
    // The producer's usage must be in the total even though its error was the
    // one that carried it, not the successful return.
    assert.equal(result.usage.cost, 0.00125, "the truncated model's cost is counted once");
    assert.match(result.notes?.join(" ") ?? "", /output token limit/i);
  });
});
