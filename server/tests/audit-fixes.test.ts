import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(tmpdir(), "svault-audit-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "";
process.env.SVAI_API_KEY = "";
process.env.SV_REGISTRATION = "open";

const { app } = await import("../index.js");
const { all, closeDb, run } = await import("../db.js");

let server: import("node:http").Server;
let base = "";

async function register(name: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}@audit.example.com`, password: "audit password" }),
  });
  assert.equal(res.status, 201, await res.text());
  return String(res.headers.get("set-cookie") ?? "").split(";")[0];
}

async function request(
  pathname: string,
  options: { method?: string; body?: unknown; auth?: string | null; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { connection: "close", ...(options.headers ?? {}) };
  const useCookie = options.auth === undefined ? "" : options.auth;
  if (useCookie) headers.cookie = useCookie;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const res = await fetch(base + pathname, { method: options.method ?? (body ? "POST" : "GET"), headers, body });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("cookie parsing", () => {
  it("keeps serving requests when another app set a malformed cookie", async () => {
    const cookie = await register("CookieUser");
    // A percent-encoded value that does not decode must not break the session.
    const health = await fetch(`${base}/api/health`, { headers: { connection: "close", cookie: "x=100%" } });
    assert.equal(health.status, 200);

    const me = await request("/api/auth/me", { auth: `x=100%; ${cookie}` });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.email, "cookieuser@audit.example.com");

    const list = await request("/api/houses", { headers: { cookie: `x=100%; ${cookie}` } });
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.data));
  });
});

describe("stock mutation idempotency", () => {
  let stockCookie = "";
  let stockHouseId = "";
  let raceItemId = "";

  before(async () => {
    stockCookie = await register("StockRace");
    const me = await request("/api/auth/me", { auth: stockCookie });
    stockHouseId = me.data.houses[0].id;
    const locations = await request(`/api/houses/${stockHouseId}/locations`, { auth: stockCookie });
    const fridgeId = locations.data.find((entry: any) => entry.name === "Fridge").id;
    const item = await request(`/api/houses/${stockHouseId}/items`, {
      auth: stockCookie,
      body: { name: "RaceWalnuts", unit: "pcs", initialStock: { quantity: 2, locationId: fridgeId } },
    });
    assert.equal(item.status, 201, JSON.stringify(item.data));
    raceItemId = item.data.id;
  });

  it("applies a retried removal once even when both requests run concurrently", async () => {
    const key = "audit-concurrent-retry-0001";
    const post = () =>
      request(`/api/items/${raceItemId}/stock`, {
        auth: stockCookie,
        body: { action: "remove", quantity: 1, idempotencyKey: key },
      });
    const [first, second] = await Promise.all([post(), post()]);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(second.status, 200, JSON.stringify(second.data));
    // The second response is the recorded one, so both agree on the outcome.
    assert.equal(first.data.quantity, second.data.quantity);

    const detail = await request(`/api/items/${raceItemId}`, { auth: stockCookie });
    assert.equal(detail.status, 200);
    assert.equal(Number(detail.data.quantity), 1);

    const movements = await request(`/api/items/${raceItemId}/movements`, { auth: stockCookie });
    assert.equal(movements.status, 200);
    const removals = movements.data.filter((movement: any) => movement.type === "out");
    assert.equal(removals.length, 1);
  });
});

describe("notifications expiry window", () => {
  // Created first so a broken value here would stop reminders for the good
  // house created after it if the scan did not isolate per-house failures.
  let badCookie = "";
  let badHouseId = "";
  let goodCookie = "";
  let goodHouseId = "";

  before(async () => {
    badCookie = await register("ExpiryBad");
    badHouseId = (await request("/api/auth/me", { auth: badCookie })).data.houses[0].id;
    goodCookie = await register("ExpiryGood");
    goodHouseId = (await request("/api/auth/me", { auth: goodCookie })).data.houses[0].id;

    const soon = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    const item = await request(`/api/houses/${goodHouseId}/items`, {
      auth: goodCookie,
      body: { name: "ExpiringYogurt", unit: "pcs", initialStock: { quantity: 1, expiresAt: soon } },
    });
    assert.equal(item.status, 201, JSON.stringify(item.data));
  });

  it("rejects a non-numeric expiryDays in the house settings", async () => {
    const bad = await request(`/api/houses/${goodHouseId}`, {
      method: "PATCH",
      auth: goodCookie,
      body: { settings: { notifications: { expiryDays: "abc" } } },
    });
    assert.equal(bad.status, 400);

    const alsoBad = await request(`/api/houses/${goodHouseId}`, {
      method: "PATCH",
      auth: goodCookie,
      body: { settings: { notifications: { expiryDays: 1e9 } } },
    });
    assert.equal(alsoBad.status, 400);
  });

  it("keeps the scan and item updates working when a stored value is invalid", async () => {
    // Simulate a row written before validation existed.
    await run("UPDATE houses SET settings = ? WHERE id = ?", [
      JSON.stringify({ notifications: { expiryDays: "abc" } }),
      badHouseId,
    ]);

    const item = await request(`/api/houses/${badHouseId}/items`, {
      auth: badCookie,
      body: { name: "BadSettingsRice", unit: "kg", initialStock: { quantity: 1 } },
    });
    assert.equal(item.status, 201, JSON.stringify(item.data));
    const patched = await request(`/api/items/${item.data.id}`, {
      method: "PATCH",
      auth: badCookie,
      body: { openedShelfLifeDays: 5 },
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.data));

    const { scanAllHouses } = await import("../services/notifications.js");
    await scanAllHouses();

    const reminders = await all<any>("SELECT * FROM notifications WHERE house_id = ? AND type = 'expiring'", [goodHouseId]);
    assert.ok(reminders.length >= 1, "the good house still gets its expiry reminder");
  });
});

describe("password check rate limit", () => {
  let limitCookie = "";

  before(async () => {
    // Limiters are off under NODE_ENV=test unless this is set.
    process.env.SV_RATE_LIMIT = "on";
    limitCookie = await register("LimiterUser");
  });

  after(() => {
    delete process.env.SV_RATE_LIMIT;
  });

  it("eventually answers 429 after repeated wrong current passwords", async () => {
    let sawRejected = false;
    let saw429 = false;
    for (let attempt = 0; attempt < 40 && !saw429; attempt += 1) {
      const res = await request("/api/auth/me/password", {
        auth: limitCookie,
        body: { currentPassword: "totally wrong password", newPassword: "another valid password" },
      });
      if (res.status === 400) sawRejected = true;
      if (res.status === 429) saw429 = true;
    }
    assert.ok(sawRejected, "a wrong password is rejected before the limit is reached");
    assert.ok(saw429, "repeated password checks are rate limited");
  });
});

describe("item list pagination", () => {
  let listCookie = "";
  let listHouseId = "";

  before(async () => {
    listCookie = await register("OffsetUser");
    const me = await request("/api/auth/me", { auth: listCookie });
    listHouseId = me.data.houses[0].id;
    const item = await request(`/api/houses/${listHouseId}/items`, {
      auth: listCookie,
      body: { name: "OffsetSalt", unit: "pcs" },
    });
    assert.equal(item.status, 201, JSON.stringify(item.data));
  });

  it("accepts a fractional and a huge offset without erroring", async () => {
    for (const offset of ["1.5", "1e300", "abc", "-3"]) {
      const res = await request(`/api/houses/${listHouseId}/items?offset=${offset}`, { auth: listCookie });
      assert.equal(res.status, 200, `offset=${offset}`);
      assert.ok(Array.isArray(res.data.items));
    }
  });
});

describe("recipe import network guard", () => {
  let recipeServer: import("node:http").Server;
  let recipeServerHits = 0;
  let recipePort = 0;
  let importCookie = "";
  let importHouseId = "";

  before(async () => {
    recipeServer = http.createServer((_req, res) => {
      recipeServerHits += 1;
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>Pancakes</body></html>");
    });
    await new Promise<void>((resolve) => recipeServer.listen(0, "127.0.0.1", () => resolve()));
    const address = recipeServer.address();
    if (!address || typeof address === "string") throw new Error("no recipe server address");
    recipePort = address.port;

    importCookie = await register("RecipeImport");
    const me = await request("/api/auth/me", { auth: importCookie });
    importHouseId = me.data.houses[0].id;
  });

  after(async () => {
    await new Promise<void>((resolve) => recipeServer.close(() => resolve()));
  });

  it("refuses a loopback recipe link without connecting to it", async () => {
    // SV_OUTBOUND_ALLOW_PRIVATE is unset, so admin-configured URLs may be
    // private; a member-supplied recipe link must still be refused.
    const res = await request(`/api/houses/${importHouseId}/recipes/import`, {
      auth: importCookie,
      body: { url: `http://127.0.0.1:${recipePort}/recipe` },
    });
    assert.equal(res.status, 400);
    assert.ok(res.data.error.length > 0);
    assert.equal(recipeServerHits, 0);
  });

  it("refuses the cloud metadata address", async () => {
    const res = await request(`/api/houses/${importHouseId}/recipes/import`, {
      auth: importCookie,
      body: { url: "http://169.254.169.254/latest/meta-data/" },
    });
    assert.equal(res.status, 400);
    assert.ok(res.data.error.length > 0);
  });
});
