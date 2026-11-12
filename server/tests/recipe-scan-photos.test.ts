import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createRecipeScanFixture } from "./helpers/recipe-scan-fixture.js";

const fixture = await createRecipeScanFixture();
const { request, aiRequests, aiBase, houseId, base, cookie } = fixture;
const { encodePng } = await import("../lib/png.js");

async function uploadPhoto(name: string): Promise<string> {
  const png = encodePng(16, 16, Buffer.alloc(16 * 16 * 4, 200));
  const bytes = new ArrayBuffer(png.length);
  new Uint8Array(bytes).set(png);
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: "image/png" }), name);
  const upload = await fetch(`${base}/api/houses/${houseId}/recipes/upload`, {
    method: "POST",
    body: form,
    headers: { cookie },
  });
  assert.equal(upload.status, 201);
  return (await upload.json()).path as string;
}

after(async () => {
  await fixture.close();
});

describe("recipe scan photos and multi-recipe pages", () => {
  it("sends the photo to the configured model even without a separate vision model", async () => {
    const png = encodePng(16, 16, Buffer.alloc(16 * 16 * 4, 200));
    const bytes = new ArrayBuffer(png.length);
    new Uint8Array(bytes).set(png);
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: "image/png" }), "card.png");
    const upload = await fetch(`${base}/api/houses/${houseId}/recipes/upload`, {
      method: "POST",
      body: form,
      headers: { cookie },
    });
    assert.equal(upload.status, 201);
    const { path: imagePath } = await upload.json();
    assert.ok(imagePath.startsWith("/uploads/recipes/"));

    aiRequests.length = 0;
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "flour eggs milk", image: imagePath },
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "ai");
    assert.equal(aiRequests[0].body.max_tokens, 8192);
    // The default leaves reasoning to the model; no provider-specific field.
    assert.equal(aiRequests[0].body.reasoning, undefined);
    const content = aiRequests[0].body.messages[1].content;
    assert.ok(Array.isArray(content), "the photo must reach the model by default");
    assert.ok(content.some((part: any) => part.type === "image_url"));
    assert.equal(scan.data.aiAvailable, true);
  });

  it("does not re-bill a text-only retry for a non-image provider error", async () => {
    const png = encodePng(16, 16, Buffer.alloc(16 * 16 * 4, 200));
    const bytes = new ArrayBuffer(png.length);
    new Uint8Array(bytes).set(png);
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: "image/png" }), "card.png");
    const upload = await fetch(`${base}/api/houses/${houseId}/recipes/upload`, {
      method: "POST",
      body: form,
      headers: { cookie },
    });
    const { path: imagePath } = await upload.json();

    // A 400 that says "Unsupported parameter" is not an image-input failure.
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: {
        settings: {
          ai: {
            enabled: true,
            baseUrl: aiBase,
            apiKey: "test-key",
            model: "reasoning-unsupported-model",
            visionModel: null,
            recipeReasoning: "high",
          },
        },
      },
    });
    aiRequests.length = 0;
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs", image: imagePath },
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "local");
    assert.equal(scan.data.warning.includes("did not accept the photo"), false);
    assert.equal(aiRequests.length, 3, "only the request-field retries are allowed");
    assert.ok(
      aiRequests.every((entry) => Array.isArray(entry.body.messages[1].content)),
      "no text-only retry was sent",
    );

    // A 429 that happens to mention images is a rate limit, not an input error.
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "image-rate-limited-model", recipeReasoning: "auto" } } },
    });
    aiRequests.length = 0;
    const limited = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs", image: imagePath },
    });
    assert.equal(limited.status, 200);
    assert.equal(limited.data.provider, "local");
    assert.equal(aiRequests.length, 1, "a rate limit must not trigger a second billed call");

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", recipeReasoning: "auto" } } },
    });
  });

  it("retries only the model that rejected the photo after an earlier chain failure", async () => {
    const png = encodePng(16, 16, Buffer.alloc(16 * 16 * 4, 200));
    const bytes = new ArrayBuffer(png.length);
    new Uint8Array(bytes).set(png);
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: "image/png" }), "chain.png");
    const upload = await fetch(`${base}/api/houses/${houseId}/recipes/upload`, {
      method: "POST",
      body: form,
      headers: { cookie },
    });
    const { path: imagePath } = await upload.json();

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: {
        settings: {
          ai: {
            enabled: true,
            baseUrl: aiBase,
            apiKey: "test-key",
            model: "mock-model",
            recipeVisionModels: ["chain-500-model", "image-reject-model"],
          },
        },
      },
    });
    aiRequests.length = 0;
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs", image: imagePath },
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "ai");
    assert.match(scan.data.warning, /did not accept the photo/i);
    // The 500 was not re-sent: only the image-rejecting model is retried, and
    // its own image rejection is not retried a second time inside `chat`.
    assert.deepEqual(
      aiRequests.map((entry) => entry.body.model),
      ["chain-500-model", "image-reject-model", "image-reject-model"],
    );
    assert.ok(Array.isArray(aiRequests[1].body.messages[1].content), "the photo reached the rejecting model");
    assert.equal(typeof aiRequests[2].body.messages[1].content, "string", "the retry is text only");
    assert.equal(scan.data.aiCost, 0.00125, "only the successful text-only retry is priced");
    assert.deepEqual(scan.data.aiModels, ["chain-500-model", "image-reject-model"]);

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", recipeVisionModels: [] } } },
    });
  });

  it("does not treat an unrelated content-type error as an image-input failure", async () => {
    const png = encodePng(16, 16, Buffer.alloc(16 * 16 * 4, 200));
    const bytes = new ArrayBuffer(png.length);
    new Uint8Array(bytes).set(png);
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: "image/png" }), "content-type.png");
    const upload = await fetch(`${base}/api/houses/${houseId}/recipes/upload`, {
      method: "POST",
      body: form,
      headers: { cookie },
    });
    const { path: imagePath } = await upload.json();

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: {
        settings: {
          ai: {
            enabled: true,
            baseUrl: aiBase,
            apiKey: "test-key",
            model: "content-type-model",
            visionModel: null,
            recipeVisionModels: [],
            recipeReasoning: "auto",
          },
        },
      },
    });
    aiRequests.length = 0;
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs", image: imagePath },
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "local");
    assert.equal(
      String(scan.data.warning).includes("did not accept the photo"),
      false,
      "a content-type error says nothing about the image",
    );
    assert.equal(aiRequests.length, 1, "the photo must not be re-sent without the image");

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", recipeVisionModels: [] } } },
    });
  });

  it("does not retry without the photo when the photo itself was rejected", async () => {
    const imagePath = await uploadPhoto("too-large.png");
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "image-too-large-model", visionModel: null } } },
    });
    aiRequests.length = 0;
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs", image: imagePath },
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "local");
    assert.equal(aiRequests.length, 1, "an oversized photo must not buy a second text-only call");
    assert.ok(Array.isArray(aiRequests[0].body.messages[1].content));
    assert.equal(
      String(scan.data.warning).includes("did not accept the photo"),
      false,
      "the model accepts photos; this one was just too large",
    );
    assert.match(scan.data.warning, /AI cleanup failed/i);

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", visionModel: null } } },
    });
  });

  it("recognises OpenAI's image_url support wording as an image-input failure", async () => {
    const imagePath = await uploadPhoto("image-url.png");
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "image_url-only-supported-model", visionModel: null } } },
    });
    aiRequests.length = 0;
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs", image: imagePath },
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "ai");
    assert.match(scan.data.warning, /did not accept the photo/i);
    assert.equal(aiRequests.length, 2);
    assert.ok(Array.isArray(aiRequests[0].body.messages[1].content), "the first attempt carried the photo");
    assert.equal(typeof aiRequests[1].body.messages[1].content, "string", "the retry is text only");
    assert.equal(scan.data.aiCost, 0.00125);

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", visionModel: null } } },
    });
  });

  it("lists the photo chain models when the text-only retry also fails", async () => {
    const png = encodePng(16, 16, Buffer.alloc(16 * 16 * 4, 200));
    const bytes = new ArrayBuffer(png.length);
    new Uint8Array(bytes).set(png);
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: "image/png" }), "retry-fail.png");
    const upload = await fetch(`${base}/api/houses/${houseId}/recipes/upload`, {
      method: "POST",
      body: form,
      headers: { cookie },
    });
    const { path: imagePath } = await upload.json();

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: {
        settings: {
          ai: {
            enabled: true,
            baseUrl: aiBase,
            apiKey: "test-key",
            model: "mock-model",
            recipeVisionModels: ["chain-500-model", "image-reject-then-fail-model"],
          },
        },
      },
    });
    aiRequests.length = 0;
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs", image: imagePath },
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "local");
    assert.match(scan.data.warning, /AI cleanup failed/i);
    assert.match(scan.data.warning, /Mock text-only retry exploded/i);
    assert.deepEqual(
      aiRequests.map((entry) => entry.body.model),
      ["chain-500-model", "image-reject-then-fail-model", "image-reject-then-fail-model"],
    );
    // The photo chain's first model must not disappear because the retry failed.
    assert.deepEqual(scan.data.aiModels, ["chain-500-model", "image-reject-then-fail-model"]);
    assert.equal(scan.data.aiCost, null, "none of the failed calls reported a price");

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", recipeVisionModels: [] } } },
    });
  });

  it("validates recipe vision models and reasoning at the settings boundary", async () => {
    const tooMany = await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { recipeVisionModels: ["a", "b", "c", "d", "e"] } } },
    });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.data.error, /at most 4/i);

    const invalid = await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { recipeVisionModels: ["a", 3] } } },
    });
    assert.equal(invalid.status, 400);
    assert.match(invalid.data.error, /model IDs/i);

    const badReasoning = await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { recipeReasoning: "sometimes" } } },
    });
    assert.equal(badReasoning.status, 400);
    assert.match(badReasoning.data.error, /reasoning must be/i);

    const saved = await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { recipeVisionModels: ["a", "b", "c", "d"], recipeReasoning: "low" } } },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.settings.ai.recipeVisionModels, ["a", "b", "c", "d"]);
    assert.equal(saved.data.settings.ai.recipeReasoning, "low");

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { recipeVisionModels: [], recipeReasoning: "auto" } } },
    });
  });

  it("defaults to the single vision model on a non-OpenRouter endpoint", async () => {
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", visionModel: "mock-vision", recipeVisionModels: [] } } },
    });
    aiRequests.length = 0;
    const test = await request(`/api/houses/${houseId}/ai/test`, { method: "POST" });
    assert.equal(test.status, 200);
    assert.deepEqual(test.data.visionModels, ["mock-vision"]);

    aiRequests.length = 0;
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs" },
    });
    assert.equal(scan.status, 200);
    assert.equal(aiRequests[0].body.model, "mock-vision");
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model", visionModel: null } } },
    });
  });

  it("retries without the photo when the model rejects images", async () => {
    const png = encodePng(16, 16, Buffer.alloc(16 * 16 * 4, 200));
    const bytes = new ArrayBuffer(png.length);
    new Uint8Array(bytes).set(png);
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: "image/png" }), "card.png");
    const upload = await fetch(`${base}/api/houses/${houseId}/recipes/upload`, {
      method: "POST",
      body: form,
      headers: { cookie },
    });
    const { path: imagePath } = await upload.json();

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "text-only-model", visionModel: null } } },
    });
    aiRequests.length = 0;
    const scan = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n2 eggs", image: imagePath },
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.provider, "ai");
    assert.equal(scan.data.draft.title, "AI pancakes");
    assert.match(scan.data.warning, /did not accept the photo/i);
    assert.match(scan.data.warning, /vision model/i);
    assert.equal(scan.data.aiCost, 0.00125, "the successful text-only retry is billed once");
    // First attempts carried the image; the last attempt is the text-only retry.
    assert.ok(Array.isArray(aiRequests[0].body.messages[1].content));
    assert.equal(typeof aiRequests[aiRequests.length - 1].body.messages[1].content, "string");
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model" } } },
    });
  });

  it("returns every recipe on a photographed page separately", async () => {
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "multi-model" } } },
    });
    const res = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Tsoureki\n17 eggs" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.provider, "ai");
    assert.equal(res.data.count, 2);
    assert.equal(res.data.drafts.length, 2);
    assert.equal(res.data.drafts[0].title, "AI pancakes");
    assert.equal(res.data.drafts[1].title, "AI biscuits");
    assert.equal(res.data.drafts[1].ingredients[0].name, "Coconut");
    // One model call paid for the whole page; each draft carries its share so
    // saving both does not count the same spend twice.
    assert.equal(res.data.aiCost, 0.00125);
    assert.equal(res.data.drafts[0].aiCost, 0.000625);
    assert.equal(res.data.drafts[1].aiCost, 0.000625);
    // The flat `draft` stays the first section for older clients.
    assert.equal(res.data.draft.title, "AI pancakes");
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model" } } },
    });
  });

  it("warns when a save keeps only the first of several recipes and links the first photo", async () => {
    const first = await uploadPhoto("page-one.png");
    const second = await uploadPhoto("page-two.png");

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "multi-model" } } },
    });
    aiRequests.length = 0;
    const res = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Tsoureki\n17 eggs", images: [first, second], save: true },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.saved, true);
    assert.equal(res.data.count, 2, "the page held two recipes");
    assert.equal(res.data.savedCount, 1, "one call saves one recipe");
    assert.match(res.data.warning, /only the first was saved/i);
    assert.equal(res.data.recipe.sourceImage, first, "the link must name the first photo, not null");
    // Both photos reached the model on the multi-photo path.
    const content = aiRequests[0].body.messages[1].content;
    assert.equal(content.filter((part: any) => part.type === "image_url").length, 2);

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { model: "mock-model" } } },
    });
  });

  it("links the first photo actually sent when a request carries both image and images", async () => {
    // `images` wins over `image` in the loader, so that is the only photo the
    // model saw. The saved link must not point at the photo that was ignored.
    const sent = await uploadPhoto("page-sent.png");
    const skipped = await uploadPhoto("page-not-sent.png");

    aiRequests.length = 0;
    const res = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Tsoureki\n17 eggs", image: skipped, images: [sent] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.provider, "ai");
    const content = aiRequests[0].body.messages[1].content;
    assert.equal(content.filter((part: any) => part.type === "image_url").length, 1);
    assert.equal(res.data.drafts[0].sourceImage, sent, "the link must name the sent photo, not body.image");
  });
});
