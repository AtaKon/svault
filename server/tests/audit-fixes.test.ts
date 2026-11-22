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
const { closeDb } = await import("../db.js");

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
