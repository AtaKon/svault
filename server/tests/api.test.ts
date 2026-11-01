import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(tmpdir(), "svault-test-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "";
process.env.SVAI_API_KEY = "";

const { app } = await import("../index.js");
const { db } = await import("../db.js");
const { heuristicRecipe, parseIngredientLine, localIdeas } = await import("../services/recipe-local.js");
const { convert, pricePerUnit } = await import("../units.js");
const { encodePng } = await import("../lib/png.js");
const JSZip = (await import("jszip")).default;
const http = await import("node:http");

let server: import("node:http").Server;
let aiServer: import("node:http").Server;
let base = "";
let aiBase = "";
let cookie = "";
const aiRequests: any[] = [];

async function request(pathname: string, options: { method?: string; body?: unknown; auth?: string } = {}) {
  const headers: Record<string, string> = {};
  const useCookie = options.auth === undefined ? cookie : options.auth;
  if (useCookie) headers.cookie = useCookie;
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const res = await fetch(base + pathname, { method: options.method ?? (body ? "POST" : "GET"), headers, body });
  const setCookie = res.headers.get("set-cookie");
  const nextCookie = setCookie ? setCookie.split(";")[0] : null;
  const text = await res.text();
  return {
    status: res.status,
    data: text ? JSON.parse(text) : null,
    cookie: nextCookie,
  };
}

let houseId = "";
let itemId = "";
let barcode = "0123456789012";
let secondUserCookie = "";

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;

  // OpenAI-compatible mock so the AI code paths can be tested without a key.
  await new Promise<void>((resolve) => {
    aiServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        let body: any = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          body = {};
        }
        aiRequests.push({ headers: req.headers, body });
        const system = String(body?.messages?.[0]?.content ?? "");
        let payload: any;
        if (system.includes("archivist")) {
          payload = {
            title: "AI pancakes",
            description: "Cleaned by the mock model",
            servings: 3,
            prepMinutes: 5,
            cookMinutes: 10,
            tags: ["breakfast"],
            ingredients: [{ name: "Flour", quantity: 200, unit: "g", optional: false }],
            steps: [{ text: "Mix everything." }, { text: "Fry until golden.", timerSeconds: 120 }],
            notes: "Mock cleanup",
          };
        } else if (system.includes("home cook")) {
          payload = {
            summary: "Mock ideas from stock",
            ideas: [
              {
                title: "Mock soup",
                rationale: "You have everything",
                timeMinutes: 20,
                servings: 2,
                uses: [{ name: "Milk", quantity: 1, unit: "l" }],
                missing: [],
                steps: ["Warm it up."],
              },
            ],
          };
        } else {
          payload = {
            title: "Pancakes improved",
            description: "Completed",
            servings: 4,
            prepMinutes: 10,
            cookMinutes: 15,
            tags: ["breakfast"],
            ingredients: [{ name: "Flour", quantity: 250, unit: "g", optional: false }],
            steps: [{ text: "Whisk the batter." }, { text: "Cook for 3 minutes." }],
            notes: "completed by mock",
          };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
      });
    });
    aiServer.listen(0, "127.0.0.1", () => {
      const aiAddress = aiServer.address();
      if (!aiAddress || typeof aiAddress === "string") throw new Error("no ai address");
      aiBase = `http://127.0.0.1:${aiAddress.port}/v1`;
      resolve();
    });
  });

  const reg = await request("/api/auth/register", {
    method: "POST",
    body: { name: "Test Owner", email: "owner@example.com", password: "test password" },
  });
  assert.equal(reg.status, 201);
  cookie = reg.cookie!;
  houseId = reg.data.houses[0].id;

  const second = await request("/api/auth/register", {
    method: "POST",
    body: { name: "Test Stranger", email: "stranger@example.com", password: "test password" },
  });
  secondUserCookie = second.cookie!;
});

after(() => {
  server?.close();
  aiServer?.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("units", () => {
  it("converts mass and volume", () => {
    assert.equal(convert(2, "kg", "g"), 2000);
    assert.equal(convert(1, "l", "ml"), 1000);
    assert.equal(convert(1, "pcs", "kg"), null);
  });
  it("normalises price per base unit", () => {
    assert.equal(pricePerUnit(10, "kg", "g"), 0.01);
    assert.equal(pricePerUnit(3, "pcs", "pcs"), 3);
  });
});

describe("recipe text parsing", () => {
  it("reads an ingredient line", () => {
    const parsed = parseIngredientLine("1 1/2 cups plain flour");
    assert.equal(parsed?.quantity, 1.5);
    assert.equal(parsed?.unit, "cup");
    assert.equal(parsed?.name, "plain flour");
  });

  it("splits headers, ingredients and steps", () => {
    const draft = heuristicRecipe(
      "GRANDMA'S LEMON CAKE\n\nIngredients\n2 eggs\n½ cup sugar\n\nInstructions\n1. Whisk the eggs.\n2. Bake for 30 minutes.\n\nServes 6",
    );
    assert.equal(draft.title, "GRANDMA'S LEMON CAKE");
    assert.equal(draft.ingredients.length, 2);
    assert.equal(draft.steps.length, 2);
    assert.equal(draft.servings, 6);
    assert.equal(draft.steps[1].timerSeconds, 1800);
  });

  it("handles OCR noise and two-line titles", () => {
    const draft = heuristicRecipe(
      "Grandmae Margot's\nLemon Cake\n| for Sunday afternoons\n| INGREDIENTS\n| * 3 eggs\n| * 200 g smgor\n| * 2 lemons - zest and juice\n| METHOD\n| 1. Oven 180 C. Butter a tin.\n| 2. Whisk eggs.\n| serves 8",
    );
    assert.equal(draft.title, "Grandmae Margot's Lemon Cake");
    assert.equal(draft.ingredients.length, 3);
    assert.equal(draft.steps.length, 2);
    assert.equal(draft.servings, 8);
  });

  it("suggests recipes from stock", () => {
    const ideas = localIdeas(
      [
        { name: "eggs", quantity: 4, unit: "pcs", categoryName: "Dairy" },
        { name: "flour", quantity: 500, unit: "g", categoryName: "Food" },
        { name: "milk", quantity: 1, unit: "l", categoryName: "Dairy" },
      ],
      [{ id: "r1", title: "Pancakes", ingredients: [{ name: "eggs", quantity: 2, unit: "pcs", optional: false }, { name: "flour", quantity: 200, unit: "g", optional: false }, { name: "sugar", quantity: 10, unit: "g", optional: false }], steps: [{ text: "Mix" }] }],
      "",
    );
    assert.equal(ideas.ideas[0].title, "Pancakes");
    assert.equal(ideas.ideas[0].source, "recipe");
    assert.ok(ideas.ideas[0].missing.some((entry) => entry.name === "sugar"));
  });
});

describe("auth and houses", () => {
  it("rejects unauthenticated access", async () => {
    const res = await request("/api/houses", { auth: "" });
    assert.equal(res.status, 401);
  });

  it("creates default places, categories and attributes", async () => {
    const locations = await request(`/api/houses/${houseId}/locations`);
    assert.equal(locations.status, 200);
    assert.ok(locations.data.length >= 6);

    const categories = await request(`/api/houses/${houseId}/categories`);
    assert.ok(categories.data.some((category: any) => category.name === "Food"));

    const attributes = await request(`/api/houses/${houseId}/attributes`);
    assert.ok(attributes.data.some((attribute: any) => attribute.key === "brand"));
  });

  it("keeps houses private", async () => {
    const res = await request(`/api/houses/${houseId}`, { auth: secondUserCookie });
    assert.equal(res.status, 404);
  });

  it("creates extra houses per user", async () => {
    const created = await request("/api/houses", { method: "POST", body: { name: "Cabin", kind: "cabin", currency: "EUR" } });
    assert.equal(created.status, 201);
    assert.equal(created.data.name, "Cabin");
    const list = await request("/api/houses");
    assert.equal(list.data.length, 2);
  });

  it("adds unique dynamic attributes", async () => {
    const attribute = await request(`/api/houses/${houseId}/attributes`, {
      method: "POST",
      body: { key: "flavour", label: "Flavour", type: "select", options: ["vanilla", "chocolate"] },
    });
    assert.equal(attribute.status, 201);
    const duplicate = await request(`/api/houses/${houseId}/attributes`, {
      method: "POST",
      body: { key: "flavour", label: "Other", type: "text" },
    });
    assert.equal(duplicate.status, 409);
  });
});

describe("inventory and stock", () => {
  it("creates an item with attributes, barcode and initial stock", async () => {
    const locations = await request(`/api/houses/${houseId}/locations`);
    const fridge = locations.data.find((entry: any) => entry.name === "Fridge");
    const res = await request(`/api/houses/${houseId}/items`, {
      method: "POST",
      body: {
        name: "Milk",
        unit: "l",
        reorderPoint: 2,
        attributes: { flavour: "vanilla" },
        tags: ["breakfast"],
        barcodes: [barcode],
        initialStock: { quantity: 1.5, unitPrice: 1.2, locationId: fridge.id, expiresAt: "2030-01-01" },
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.quantity, 1.5);
    assert.equal(res.data.attributes.flavour, "vanilla");
    assert.equal(res.data.barcodes.length, 1);
    assert.equal(res.data.priceStats.latest, 1.2);
    itemId = res.data.id;
  });

  it("rejects duplicate barcodes", async () => {
    const res = await request(`/api/houses/${houseId}/items`, {
      method: "POST",
      body: { name: "Other milk", unit: "l", barcodes: [barcode] },
    });
    assert.equal(res.status, 409);
  });

  it("scans barcodes locally", async () => {
    const res = await request(`/api/houses/${houseId}/scan?code=${barcode}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.match, "local");
    assert.equal(res.data.item.id, itemId);
  });

  it("adds stock in another unit and keeps price history", async () => {
    const res = await request(`/api/items/${itemId}/stock`, {
      method: "POST",
      body: { action: "add", quantity: 0.5, unit: "l", unitPrice: 0.8 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.quantity, 2);
    assert.equal(res.data.priceHistory.length, 2);
    assert.equal(res.data.priceHistory[1].price, 0.8);
  });

  it("consumes FIFO and recalculates totals", async () => {
    const res = await request(`/api/items/${itemId}/stock`, {
      method: "POST",
      body: { action: "remove", quantity: 1, reason: "Breakfast" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.quantity, 1);
    assert.equal(res.data.movements[0].type, "out");
  });

  it("cannot remove more than available", async () => {
    const res = await request(`/api/items/${itemId}/stock`, {
      method: "POST",
      body: { action: "remove", quantity: 99 },
    });
    assert.equal(res.status, 400);
  });

  it("adjusts to an absolute count", async () => {
    const res = await request(`/api/items/${itemId}/stock`, {
      method: "POST",
      body: { action: "set", target: 4 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.quantity, 4);
  });

  it("moves stock between places", async () => {
    const locations = await request(`/api/houses/${houseId}/locations`);
    const fridge = locations.data.find((entry: any) => entry.name === "Fridge");
    const pantry = locations.data.find((entry: any) => entry.name === "Pantry");
    // Put one unit in the fridge, then move it to the pantry.
    const added = await request(`/api/items/${itemId}/stock`, {
      method: "POST",
      body: { action: "add", quantity: 1, locationId: fridge.id },
    });
    assert.equal(added.status, 200);
    const res = await request(`/api/items/${itemId}/stock`, {
      method: "POST",
      body: { action: "move", quantity: 1, fromLocationId: fridge.id, toLocationId: pantry.id },
    });
    assert.equal(res.status, 200);
    const after = await request(`/api/items/${itemId}`);
    const atPantry = after.data.lots
      .filter((lot: any) => lot.locationId === pantry.id)
      .reduce((sum: number, lot: any) => sum + lot.quantity, 0);
    assert.equal(Math.round(atPantry * 1000) / 1000, 1);
  });

  it("creates low-stock reminders after a change", async () => {
    await request(`/api/items/${itemId}/stock`, { method: "POST", body: { action: "remove", quantity: 3 } });
    const res = await request(`/api/houses/${houseId}/notifications`);
    assert.ok(res.data.notifications.some((entry: any) => entry.type === "low_stock" && entry.data.itemId === itemId));
  });

  it("filters items by search and category", async () => {
    const bySearch = await request(`/api/houses/${houseId}/items?q=milk`);
    assert.equal(bySearch.data.items.length, 1);
    const byBarcode = await request(`/api/houses/${houseId}/items?q=${barcode}`);
    assert.equal(byBarcode.data.items.length, 1);
  });

  it("validates stock updates", async () => {
    const res = await request(`/api/items/${itemId}/stock`, { method: "POST", body: { action: "add", quantity: -1 } });
    assert.equal(res.status, 400);
  });
});

describe("recipes", () => {
  it("parses a scan without an AI provider", async () => {
    const res = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\n\nIngredients\n2 eggs\n100 g flour\n\nMethod\n1. Mix.\n2. Fry for 5 minutes." },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.provider, "local");
    assert.ok(res.data.warning.includes("No AI provider"));
    assert.equal(res.data.draft.ingredients.length, 2);
  });

  it("saves recipes and matches stock", async () => {
    const res = await request(`/api/houses/${houseId}/recipes`, {
      method: "POST",
      body: {
        title: "Pancakes",
        steps: [{ text: "Mix" }, { text: "Fry" }],
        ingredients: [
          { name: "Milk", quantity: 0.2, unit: "l" },
          { name: "Sugar", quantity: 10, unit: "g" },
        ],
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.match.available, 1);
    assert.equal(res.data.match.total, 2);
  });

  it("rejects AI completion without config", async () => {
    const list = await request(`/api/houses/${houseId}/recipes`);
    const res = await request(`/api/recipes/${list.data[0].id}/ai`, { method: "POST", body: { action: "complete" } });
    assert.equal(res.status, 400);
  });

  it("patches every recipe field", async () => {
    const list = await request(`/api/houses/${houseId}/recipes`);
    const id = list.data[0].id;
    const res = await request(`/api/recipes/${id}`, {
      method: "PATCH",
      body: {
        servings: 10,
        description: "Updated description",
        prepMinutes: 12,
        cookMinutes: 34,
        tags: "edited, breakfast",
        favorite: true,
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.servings, 10);
    assert.equal(res.data.description, "Updated description");
    assert.equal(res.data.prepMinutes, 12);
    assert.equal(res.data.cookMinutes, 34);
    assert.deepEqual(res.data.tags, ["edited", "breakfast"]);
    assert.equal(res.data.favorite, true);
    assert.equal(res.data.ingredients.length, list.data[0].ingredients.length);
  });
});

describe("ideas", () => {
  it("falls back to local suggestions", async () => {
    const res = await request(`/api/houses/${houseId}/ideas`, { method: "POST", body: { prompt: "quick" } });
    assert.equal(res.status, 200);
    assert.equal(res.data.provider, "local");
    assert.ok(Array.isArray(res.data.ideas));
    assert.ok(res.data.ideas.length > 0);
  });
});

describe("ai integration", () => {
  it("saves a per-house provider and masks the key", async () => {
    const res = await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: {
        settings: { ai: { enabled: true, baseUrl: aiBase, apiKey: "test-key", model: "mock-model" } },
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.settings.ai.apiKey, "***");
    assert.equal(res.data.settings.ai.model, "mock-model");
  });

  it("cleans scans through the provider", async () => {
    aiRequests.length = 0;
    const res = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "flour eggs milk" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.provider, "ai");
    assert.equal(res.data.draft.title, "AI pancakes");
    assert.equal(res.data.warning, null);
    assert.ok(aiRequests.some((entry) => entry.headers.authorization === "Bearer test-key"));
  });

  it("tests the saved connection", async () => {
    const res = await request(`/api/houses/${houseId}/ai/test`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.model, "mock-model");
  });

  it("only sends scan images when a vision model is configured", async () => {
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
    const withoutVision = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "flour eggs milk", image: imagePath },
    });
    assert.equal(withoutVision.status, 200);
    assert.equal(withoutVision.data.provider, "ai");
    assert.equal(typeof aiRequests[0].body.messages[1].content, "string");

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { visionModel: "mock-vision" } } },
    });
    aiRequests.length = 0;
    const withVision = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "flour eggs milk", image: imagePath },
    });
    assert.equal(withVision.data.provider, "ai");
    const content = aiRequests[0].body.messages[1].content;
    assert.ok(Array.isArray(content));
    assert.ok(content.some((part: any) => part.type === "image_url"));

    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { visionModel: null } } },
    });
    const noText = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { image: imagePath },
    });
    assert.equal(noText.data.provider, "local");
    assert.match(noText.data.warning, /vision-capable model/);
  });

  it("generates ideas through the provider", async () => {
    const res = await request(`/api/houses/${houseId}/ideas`, { method: "POST", body: { prompt: "dinner" } });
    assert.equal(res.status, 200);
    assert.equal(res.data.provider, "ai");
    assert.equal(res.data.ideas[0].title, "Mock soup");
  });

  it("completes a recipe through the provider", async () => {
    const list = await request(`/api/houses/${houseId}/recipes`);
    const res = await request(`/api/recipes/${list.data[0].id}/ai`, { method: "POST", body: { action: "complete" } });
    assert.equal(res.status, 200);
    assert.equal(res.data.title, "Pancakes improved");
    assert.equal(res.data.aiNotes, "completed by mock");
    assert.ok(res.data.steps.length >= 2);
  });

  it("falls back to local parsing when the provider is unreachable", async () => {
    await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { ai: { enabled: true, baseUrl: "http://127.0.0.1:1/v1", apiKey: "bad", model: "x" } } },
    });
    const res = await request(`/api/houses/${houseId}/recipes/scan`, {
      method: "POST",
      body: { text: "Pancakes\nIngredients\n2 eggs\nMethod\n1. Fry." },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.provider, "local");
    assert.ok(res.data.warning?.includes("AI cleanup failed"));
  });
});

describe("photos and datasets", () => {
  let photoId = "";

  it("creates folders", async () => {
    const res = await request(`/api/houses/${houseId}/collections`, { method: "POST", body: { name: "Shelf" } });
    assert.equal(res.status, 201);
  });

  it("uploads a photo and labels it", async () => {
    const png = encodePng(8, 8, Buffer.alloc(8 * 8 * 4, 220));
    const imageBytes = new ArrayBuffer(png.length);
    new Uint8Array(imageBytes).set(png);
    const form = new FormData();
    form.append("photos", new Blob([imageBytes], { type: "image/png" }), "unit.png");
    form.append("meta", JSON.stringify([{ width: 8, height: 8, originalName: "unit.png" }]));
    const upload = await fetch(`${base}/api/houses/${houseId}/photos`, {
      method: "POST",
      body: form,
      headers: { cookie },
    });
    assert.equal(upload.status, 201);
    const body = await upload.json();
    photoId = body.photos[0].id;
    assert.ok(photoId);

    const label = await request(`/api/photos/${photoId}/labels`, {
      method: "POST",
      body: { label: "milk", x: 0.1, y: 0.1, w: 0.4, h: 0.3 },
    });
    assert.equal(label.status, 201);

    const split = await request(`/api/photos/${photoId}`, { method: "PATCH", body: { split: "train" } });
    assert.equal(split.status, 200);
    assert.equal(split.data.split, "train");
  });

  it("exports an empty dataset", async () => {
    const res = await fetch(`${base}/api/houses/${houseId}/photos/export?format=yolo`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/zip");
  });

  it("exports images, labels and classes as a YOLO zip", async () => {
    const res = await fetch(`${base}/api/houses/${houseId}/photos/export?format=yolo`, { headers: { cookie } });
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    assert.ok(zip.file("svault-dataset/classes.txt"));
    assert.ok(zip.file("svault-dataset/data.yaml"));
    assert.ok(zip.file("svault-dataset/manifest.csv"));
    assert.ok(zip.file("svault-dataset/annotations.coco.json"));
    const labelFile = zip.file(/svault-dataset\/labels\/train\/.+\.txt/)[0];
    assert.ok(labelFile, "a training label file exists");
    const labelText = await labelFile.async("string");
    assert.match(labelText.trim(), /^0 0\.300000 0\.250000 0\.400000 0\.300000$/);
    const images = zip.file(/svault-dataset\/images\/train\/.+\.png/);
    assert.ok(images.length >= 1);

    const cocoRes = await fetch(`${base}/api/houses/${houseId}/photos/export?format=coco`, { headers: { cookie } });
    const cocoZip = await JSZip.loadAsync(Buffer.from(await cocoRes.arrayBuffer()));
    const cocoFile = cocoZip.file("svault-dataset/annotations.coco.json");
    assert.ok(cocoFile);
    const coco = JSON.parse(await cocoFile.async("string"));
    assert.equal(coco.categories[0].name, "milk");
    assert.equal(coco.annotations[0].bbox.length, 4);
  });
});

describe("dashboard", () => {
  it("summarises stock with batch counts", async () => {
    const res = await request(`/api/houses/${houseId}/dashboard`);
    assert.equal(res.status, 200);
    assert.ok(res.data.itemCount >= 1);
    assert.ok(res.data.batchCount >= 1);
    assert.ok(Array.isArray(res.data.lowStock));
  });
});

describe("web shell", () => {
  it("serves the SPA for client routes", async () => {
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-type") ?? "", /text\/html/);
    const deep = await fetch(`${base}/items/new`);
    assert.equal(deep.status, 200);
    assert.match(await deep.text(), /<div id="root">/);
  });
});

describe("multi-user membership", () => {
  it("invites and joins a house by link", async () => {
    const invite = await request(`/api/houses/${houseId}/members`, {
      method: "POST",
      body: { email: "stranger@example.com", role: "viewer" },
    });
    assert.equal(invite.status, 201);
    assert.ok(invite.data.member);

    const access = await request(`/api/houses/${houseId}`, { auth: secondUserCookie });
    assert.equal(access.status, 200);
    assert.equal(access.data.role, "viewer");

    const forbidden = await request(`/api/houses/${houseId}/items`, {
      method: "POST",
      auth: secondUserCookie,
      body: { name: "Sneaky item" },
    });
    assert.equal(forbidden.status, 403);
  });

  it("prevents the owner from being removed", async () => {
    const house = await request(`/api/houses/${houseId}`);
    const owner = house.data.members.find((member: any) => member.role === "owner");
    const res = await request(`/api/houses/${houseId}/members/${owner.id}`, { method: "DELETE" });
    assert.equal(res.status, 400);
  });
});
