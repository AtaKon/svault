// End-to-end smoke test against a running SVault instance.
// Usage: node scripts/smoke.mjs [baseUrl]
const base = process.argv[2] ?? "http://localhost:4100";
let cookie = "";
let failures = 0;

function log(ok, label, extra = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
}

async function call(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  let body = options.body;
  if (body && !(body instanceof FormData)) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(body);
  }
  const res = await fetch(base + path, { ...options, headers, body });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("json") ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data, headers: res.headers };
}

const email = `smoke${Date.now()}@example.com`;

const register = await call("/api/auth/register", {
  method: "POST",
  body: { name: "Smoke Tester", email, password: "correct horse battery" },
});
log(register.status === 201, "register", `${register.status} ${register.data?.error ?? ""}`);
const house = register.data?.houses?.[0];
log(Boolean(house?.id), "default house created", house?.name);

const cats = await call(`/api/houses/${house.id}/categories`);
const locs = await call(`/api/houses/${house.id}/locations`);
log(cats.status === 200 && cats.data.length > 0, "default categories", String(cats.data?.length));
log(locs.status === 200 && locs.data.length > 0, "default locations", String(locs.data?.length));

const item = await call(`/api/houses/${house.id}/items`, {
  method: "POST",
  body: {
    name: "Whole milk",
    brand: "Farmhouse",
    categoryId: cats.data.find((c) => c.name === "Dairy")?.id,
    unit: "l",
    reorderPoint: 2,
    tags: ["breakfast"],
    barcodes: ["4006381333931"],
    attributes: { brand: "Farmhouse", size: "2 l" },
    initialStock: {
      quantity: 2,
      unitPrice: 1.49,
      locationId: locs.data.find((l) => l.name === "Fridge")?.id,
      expiresAt: new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10),
    },
  },
});
log(item.status === 201, "create item with stock", `${item.status} ${item.data?.error ?? ""}`);
log(item.data?.quantity === 2, "stock quantity", String(item.data?.quantity));
log(Number(item.data?.priceStats?.latest) === 1.49, "price recorded", String(item.data?.priceStats?.latest));

const add = await call(`/api/items/${item.data.id}/stock`, {
  method: "POST",
  body: { action: "add", quantity: 1, unitPrice: 1.75 },
});
log(add.status === 200 && add.data.quantity === 3, "add stock", String(add.data?.quantity));
log(add.data?.priceHistory?.length === 2, "price history grows", String(add.data?.priceHistory?.length));

const use = await call(`/api/items/${item.data.id}/stock`, {
  method: "POST",
  body: { action: "remove", quantity: 2 },
});
log(use.status === 200 && use.data.quantity === 1, "consume stock", String(use.data?.quantity));

const scan = await call(`/api/houses/${house.id}/scan?code=4006381333931`);
log(scan.status === 200 && scan.status === 200 && scan.data.match === "local", "barcode scans to item", scan.data.item?.name);

const dashboard = await call(`/api/houses/${house.id}/dashboard`);
log(dashboard.status === 200 && dashboard.data.itemCount === 1, "dashboard", `low=${dashboard.data.lowStock?.length}`);
log(dashboard.data.lowStock?.length === 1, "low stock detected");

const notifications = await call(`/api/houses/${house.id}/notifications`);
log(notifications.data.notifications?.length >= 1, "low stock reminder", notifications.data.notifications?.[0]?.title);

const readAll = await call(`/api/houses/${house.id}/notifications/read`, { method: "POST", body: {} });
log(readAll.status === 200, "mark reminders read");

const recipe = await call(`/api/houses/${house.id}/recipes`, {
  method: "POST",
  body: {
    title: "Grandma's pancakes",
    description: "Sunday breakfast",
    servings: 4,
    prepMinutes: 10,
    cookMinutes: 15,
    steps: [{ text: "Whisk the eggs with the milk." }, { text: "Fold in the flour and fry." }],
    tags: ["breakfast", "family"],
    ingredients: [
      { name: "Whole milk", quantity: 0.5, unit: "l" },
      { name: "Eggs", quantity: 3, unit: "pcs" },
      { name: "Flour", quantity: 250, unit: "g" },
    ],
  },
});
log(recipe.status === 201, "create recipe", `${recipe.status} ${recipe.data?.error ?? ""}`);
log(recipe.data?.match?.available === 1, "recipe stock match", JSON.stringify(recipe.data?.match));

const scanText = await call(`/api/houses/${house.id}/recipes/scan`, {
  method: "POST",
  body: {
    text: "GRANDMA'S LEMON CAKE\n\nIngredients\n1 1/2 cups flour\n2 eggs\n1/2 cup sugar\n\nInstructions\n1. Whisk the eggs and sugar.\n2. Fold in the flour.\n3. Bake for 40 minutes.\n\nServes 8",
  },
});
log(scanText.status === 200, "recipe scan", `${scanText.status} ${scanText.data?.error ?? ""}`);
log(scanText.data?.draft?.ingredients?.length >= 3, "scan parsed ingredients", String(scanText.data?.draft?.ingredients?.length));
log(scanText.data?.draft?.steps?.length >= 3, "scan parsed steps", String(scanText.data?.draft?.steps?.length));
log(scanText.data?.draft?.servings === 8, "scan parsed servings", String(scanText.data?.draft?.servings));

const saved = await call(`/api/houses/${house.id}/recipes`, {
  method: "POST",
  body: scanText.data.draft,
});
log(saved.status === 201, "save scanned recipe");

const ideas = await call(`/api/houses/${house.id}/ideas`, { method: "POST", body: { prompt: "something quick" } });
log(ideas.status === 200 && ideas.data.ideas?.length > 0, "food ideas", `${ideas.data.ideas?.length} ideas, provider=${ideas.data.provider}`);
log(ideas.data.ideas?.[0]?.missing !== undefined, "ideas include missing ingredients");

const png = await (await fetch(base + "/icon-192.png")).arrayBuffer();
const form = new FormData();
form.append("photos", new Blob([png], { type: "image/png" }), "shelf.png");
form.append("meta", JSON.stringify([{ width: 192, height: 192, originalName: "shelf.png" }]));
const upload = await call(`/api/houses/${house.id}/photos`, { method: "POST", body: form });
log(upload.status === 201 && upload.data.photos?.length === 1, "photo upload", `${upload.status} ${upload.data?.error ?? ""}`);
const photoId = upload.data?.photos?.[0]?.id;

const label = await call(`/api/photos/${photoId}/labels`, {
  method: "POST",
  body: { label: "milk", x: 0.1, y: 0.1, w: 0.4, h: 0.3 },
});
log(label.status === 201, "bounding box label");

const split = await call(`/api/photos/${photoId}`, { method: "PATCH", body: { split: "train" } });
log(split.status === 200 && split.data.split === "train", "dataset split");

const exportRes = await call(`/api/houses/${house.id}/photos/export?format=yolo`);
log(exportRes.status === 200 && exportRes.data.byteLength > 1000, "YOLO export zip", `${exportRes.data.byteLength} bytes`);

const importRes = await import("node:fs");
void importRes;

const houseUpdate = await call(`/api/houses/${house.id}`, {
  method: "PATCH",
  body: { settings: { ai: { enabled: false, model: "gpt-4o-mini" }, notifications: { expiryDays: 5 } } },
});
log(houseUpdate.status === 200 && houseUpdate.data.settings?.ai?.model === "gpt-4o-mini", "house settings", JSON.stringify(houseUpdate.data.settings?.notifications));

const invite = await call(`/api/houses/${house.id}/members`, {
  method: "POST",
  body: { email: `friend${Date.now()}@example.com`, role: "member" },
});
log(invite.status === 201 && Boolean(invite.data.invite?.url), "invite by email");

const logout = await call("/api/auth/logout", { method: "POST", body: {} });
log(logout.status === 200, "logout");
const me = await call("/api/auth/me");
log(me.status === 401, "session cleared");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
