import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(tmpdir(), "svault-stocktake-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "";
process.env.SVAI_API_KEY = "";
process.env.SV_REGISTRATION = "open";

const { app } = await import("../index.js");
const { closeDb } = await import("../db.js");

let server: import("node:http").Server;
let base = "";
let ownerCookie = "";
let memberCookie = "";
let viewerCookie = "";
let strangerCookie = "";
let houseId = "";
let fridgeId = "";
let pantryId = "";
let riceId = "";
let beansId = "";
let oilId = "";
let countingCategoryId = "";

async function request(
  pathname: string,
  options: { method?: string; body?: unknown; auth?: string } = {},
) {
  const headers: Record<string, string> = { connection: "close" };
  const useCookie = options.auth === undefined ? ownerCookie : options.auth;
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

async function itemQuantity(itemId: string): Promise<number> {
  const res = await request(`/api/items/${itemId}`);
  assert.equal(res.status, 200);
  return Number(res.data.quantity);
}

async function invite(cookie: string, role: "member" | "viewer") {
  const email = role === "member" ? "stocktake.member@example.com" : "stocktake.viewer@example.com";
  const created = await request(`/api/houses/${houseId}/members`, {
    method: "POST",
    body: { email, role },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const accepted = await request(`/api/auth/invites/${created.data.invite.code}/accept`, {
    method: "POST",
    auth: cookie,
  });
  assert.ok(accepted.status < 300, JSON.stringify(accepted.data));
}

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;

  const owner = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ name: "Owner", email: "stocktake.owner@example.com", password: "test password" }),
  });
  assert.equal(owner.status, 201, await owner.text());
  ownerCookie = String(owner.headers.get("set-cookie") ?? "").split(";")[0];
  const me = await request("/api/auth/me");
  houseId = me.data.houses[0].id;

  for (const [name, email] of [
    ["Member", "stocktake.member@example.com"],
    ["Viewer", "stocktake.viewer@example.com"],
    ["Stranger", "stocktake.stranger@example.com"],
  ] as const) {
    const created = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ name, email, password: "test password" }),
    });
    assert.equal(created.status, 201, await created.text());
    const cookie = String(created.headers.get("set-cookie") ?? "").split(";")[0];
    if (email === "stocktake.member@example.com") memberCookie = cookie;
    else if (email === "stocktake.viewer@example.com") viewerCookie = cookie;
    else strangerCookie = cookie;
  }
  await invite(viewerCookie, "viewer");
  await invite(memberCookie, "member");

  const locations = await request(`/api/houses/${houseId}/locations`);
  fridgeId = locations.data.find((entry: any) => entry.name === "Fridge").id;
  pantryId = locations.data.find((entry: any) => entry.name === "Pantry").id;

  const rice = await request(`/api/houses/${houseId}/items`, {
    method: "POST",
    body: {
      name: "Rice",
      unit: "kg",
      initialStock: { quantity: 4, unitPrice: 2, locationId: fridgeId, expiresAt: "2027-06-01" },
    },
  });
  assert.equal(rice.status, 201, JSON.stringify(rice.data));
  riceId = rice.data.id;
  const moreRice = await request(`/api/items/${riceId}/stock`, {
    method: "POST",
    body: { action: "add", quantity: 6, unitPrice: 3, locationId: fridgeId, expiresAt: "2026-12-01" },
  });
  assert.equal(moreRice.status, 200);

  const beans = await request(`/api/houses/${houseId}/items`, {
    method: "POST",
    body: { name: "Beans", unit: "pcs", initialStock: { quantity: 5, locationId: pantryId } },
  });
  assert.equal(beans.status, 201);
  beansId = beans.data.id;

  const oil = await request(`/api/houses/${houseId}/items`, {
    method: "POST",
    body: { name: "Olive oil", unit: "l", initialStock: { quantity: 2, unitPrice: 5, locationId: pantryId } },
  });
  assert.equal(oil.status, 201);
  oilId = oil.data.id;

  const category = await request(`/api/houses/${houseId}/categories`, {
    method: "POST",
    body: { name: "Counting test" },
  });
  assert.equal(category.status, 201);
  countingCategoryId = category.data.id;
  assert.equal(
    (await request(`/api/items/${oilId}`, { method: "PATCH", body: { categoryId: countingCategoryId } })).status,
    200,
  );
});

after(async () => {
  server?.close();
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("stocktake", () => {
  it("snapshots a place or category with expected quantities and batch cost", async () => {
    const created = await request(`/api/houses/${houseId}/stocktakes`, {
      method: "POST",
      body: { locationId: fridgeId, note: "Fridge check" },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const stocktake = created.data.stocktake;
    assert.equal(stocktake.status, "draft");
    assert.equal(stocktake.locationId, fridgeId);
    assert.equal(stocktake.locationName, "Fridge");
    assert.equal(stocktake.note, "Fridge check");
    assert.equal(stocktake.lineCount, 1);
    const line = stocktake.lines[0];
    assert.equal(line.itemId, riceId);
    assert.equal(line.expectedQty, 10);
    assert.equal(line.unitCost, 2.6);
    assert.equal(line.countedQty, null);
    assert.equal(line.currentQty, 10);
    assert.equal(line.changed, false);

    // A draft is unique per house, so a second start points at the open one.
    const second = await request(`/api/houses/${houseId}/stocktakes`, {
      method: "POST",
      body: { categoryId: countingCategoryId },
    });
    assert.equal(second.status, 409);
    assert.equal(second.data.details.stocktakeId, stocktake.id);

    const cancelled = await request(`/api/houses/${houseId}/stocktakes/${stocktake.id}/cancel`, {
      method: "POST",
      body: {},
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.data.stocktake.status, "cancelled");
    assert.ok(cancelled.data.stocktake.cancelledAt);

    const byCategory = await request(`/api/houses/${houseId}/stocktakes`, {
      method: "POST",
      body: { categoryId: countingCategoryId },
    });
    assert.equal(byCategory.status, 201);
    assert.equal(byCategory.data.stocktake.categoryName, "Counting test");
    assert.deepEqual(byCategory.data.stocktake.lines.map((entry: any) => entry.itemId), [oilId]);
    assert.equal(byCategory.data.stocktake.lines[0].expectedQty, 2);

    // While another draft is open, starting a second session is refused even
    // for an empty place (the open-session check wins).
    const emptyPlace = await request(`/api/houses/${houseId}/locations`, {
      method: "POST",
      body: { name: "Empty shelf" },
    });
    const empty = await request(`/api/houses/${houseId}/stocktakes`, {
      method: "POST",
      body: { locationId: emptyPlace.data.id },
    });
    assert.equal(empty.status, 409);
    assert.equal(empty.data.error, "A stocktake is already open for this house");

    await request(`/api/houses/${houseId}/stocktakes/${byCategory.data.stocktake.id}/cancel`, {
      method: "POST",
      body: {},
    });

    // Now the place is empty, so the same selection has nothing to count.
    const emptyAfter = await request(`/api/houses/${houseId}/stocktakes`, {
      method: "POST",
      body: { locationId: emptyPlace.data.id },
    });
    assert.equal(emptyAfter.status, 400);
    assert.equal(emptyAfter.data.error, "There is nothing to count in this selection");
  });

  it("autosaves a count and commits a FIFO shortage once", async () => {
    const created = await request(`/api/houses/${houseId}/stocktakes`, {
      method: "POST",
      body: { locationId: fridgeId },
    });
    assert.equal(created.status, 201);
    const stocktakeId = created.data.stocktake.id;
    const line = created.data.stocktake.lines[0];

    const saved = await request(`/api/houses/${houseId}/stocktakes/${stocktakeId}/lines/${line.id}`, {
      method: "PATCH",
      body: { countedQty: 8, note: "One bag open" },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.line.countedQty, 8);
    assert.equal(saved.data.line.note, "One bag open");
    assert.equal(saved.data.line.countedByName, "Owner");
    assert.ok(saved.data.line.countedAt);

    // A save writes only the fields it carries: a count-only autosave must not
    // wipe the note, and a note-only edit must not touch the count.
    const countOnly = await request(`/api/houses/${houseId}/stocktakes/${stocktakeId}/lines/${line.id}`, {
      method: "PATCH",
      body: { countedQty: 8 },
    });
    assert.equal(countOnly.status, 200);
    assert.equal(countOnly.data.line.note, "One bag open");
    const noteOnly = await request(`/api/houses/${houseId}/stocktakes/${stocktakeId}/lines/${line.id}`, {
      method: "PATCH",
      body: { note: "Two bags open" },
    });
    assert.equal(noteOnly.status, 200);
    assert.equal(noteOnly.data.line.countedQty, 8);
    assert.equal(noteOnly.data.line.note, "Two bags open");
    assert.equal(noteOnly.data.line.countedByName, "Owner");

    const detail = await request(`/api/houses/${houseId}/stocktakes/${stocktakeId}`);
    assert.equal(detail.data.stocktake.countedCount, 1);

    const committed = await request(`/api/houses/${houseId}/stocktakes/${stocktakeId}/commit`, {
      method: "POST",
      body: { lineIds: [line.id] },
    });
    assert.equal(committed.status, 200, JSON.stringify(committed.data));
    assert.equal(committed.data.stocktake.status, "committed");
    assert.equal(committed.data.stocktake.committedByName, "Owner");
    assert.equal(committed.data.appliedDelta, -2);
    assert.equal(await itemQuantity(riceId), 8);

    const movements = await request(`/api/items/${riceId}/movements`);
    const countMovement = movements.data.find((entry: any) => entry.type === "count");
    assert.ok(countMovement);
    assert.equal(countMovement.delta, -2);
    assert.equal(countMovement.note, `stocktake ${stocktakeId}`);

    // FIFO: the earliest expiry batch (6 kg ending 2026-12-01) loses the two.
    const after = await request(`/api/items/${riceId}`);
    const early = after.data.lots.find((lot: any) => lot.expiresAt === "2026-12-01");
    const late = after.data.lots.find((lot: any) => lot.expiresAt === "2027-06-01");
    assert.equal(early.quantity, 4);
    assert.equal(late.quantity, 4);

    const again = await request(`/api/houses/${houseId}/stocktakes/${stocktakeId}/commit`, {
      method: "POST",
      body: { lineIds: [line.id] },
    });
    assert.equal(again.status, 409);
    assert.equal(again.data.error, "This stocktake is already committed");
    assert.equal(await itemQuantity(riceId), 8);

    const lateCount = await request(`/api/houses/${houseId}/stocktakes/${stocktakeId}/lines/${line.id}`, {
      method: "PATCH",
      body: { countedQty: 3 },
    });
    assert.equal(lateCount.status, 409);
  });

  it("creates a batch for a surplus and records the place", async () => {
    const created = await request(`/api/houses/${houseId}/stocktakes`, {
      method: "POST",
      body: { locationId: pantryId },
    });
    assert.equal(created.status, 201);
    const stocktakeId = created.data.stocktake.id;
    const beans = created.data.stocktake.lines.find((entry: any) => entry.itemId === beansId);
    assert.equal(beans.expectedQty, 5);

    await request(`/api/houses/${houseId}/stocktakes/${stocktakeId}/lines/${beans.id}`, {
      method: "PATCH",
      body: { countedQty: 8 },
    });
    const committed = await request(`/api/houses/${houseId}/stocktakes/${stocktakeId}/commit`, {
      method: "POST",
      body: { lineIds: [beans.id] },
    });
    assert.equal(committed.status, 200, JSON.stringify(committed.data));
    assert.equal(committed.data.appliedDelta, 3);
    assert.equal(await itemQuantity(beansId), 8);

    const detail = await request(`/api/items/${beansId}`);
    const atPantry = detail.data.lots
      .filter((lot: any) => lot.locationId === pantryId)
      .reduce((sum: number, lot: any) => sum + lot.quantity, 0);
    assert.equal(atPantry, 8);
    const movements = await request(`/api/items/${beansId}/movements`);
    const countMovement = movements.data.find((entry: any) => entry.type === "count");
    assert.equal(countMovement.delta, 3);
    assert.equal(countMovement.locationId, pantryId);
  });

  it("flags stock that changed since the snapshot and applies the delta to current stock", async () => {
    const created = await request(`/api/houses/${houseId}/stocktakes`, {
      method: "POST",
      body: { locationId: pantryId },
    });
    const stocktakeId = created.data.stocktake.id;
    const beans = created.data.stocktake.lines.find((entry: any) => entry.itemId === beansId);
    assert.equal(beans.expectedQty, 8);

    // Someone used two packs while the count was open.
    const used = await request(`/api/items/${beansId}/stock`, {
      method: "POST",
      body: { action: "remove", quantity: 2, locationId: pantryId },
    });
    assert.equal(used.status, 200);
    assert.equal(await itemQuantity(beansId), 6);

    await request(`/api/houses/${houseId}/stocktakes/${stocktakeId}/lines/${beans.id}`, {
      method: "PATCH",
      body: { countedQty: 7 },
    });
    const detail = await request(`/api/houses/${houseId}/stocktakes/${stocktakeId}`);
    const line = detail.data.stocktake.lines.find((entry: any) => entry.id === beans.id);
    assert.equal(line.changed, true);
    assert.equal(line.currentQty, 6);
    assert.equal(detail.data.stocktake.changedCount, 1);

    const refused = await request(`/api/houses/${houseId}/stocktakes/${stocktakeId}/commit`, {
      method: "POST",
      body: { lineIds: [beans.id] },
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.data.details.code, "changed-since-snapshot");
    assert.deepEqual(refused.data.details.changedLineIds, [beans.id]);
    assert.equal(await itemQuantity(beansId), 6, "a refused commit changes nothing");

    const committed = await request(`/api/houses/${houseId}/stocktakes/${stocktakeId}/commit`, {
      method: "POST",
      body: { lineIds: [beans.id], confirmChangedLineIds: [beans.id] },
    });
    assert.equal(committed.status, 200, JSON.stringify(committed.data));
    // Counted 7 against a snapshot of 8 is a -1 variance, applied to the
    // current 6 rather than overwriting it with the stale count.
    assert.equal(committed.data.appliedDelta, -1);
    assert.equal(await itemQuantity(beansId), 5);
  });

  it("enforces member counting and member+ commit, while viewers can read", async () => {
    const viewerStart = await request(`/api/houses/${houseId}/stocktakes`, {
      method: "POST",
      auth: viewerCookie,
      body: { locationId: pantryId },
    });
    assert.equal(viewerStart.status, 403);
    assert.equal((await request(`/api/houses/${houseId}/stocktakes`, { auth: strangerCookie })).status, 404);

    const created = await request(`/api/houses/${houseId}/stocktakes`, {
      method: "POST",
      body: { locationId: pantryId },
    });
    const stocktakeId = created.data.stocktake.id;
    const line = created.data.stocktake.lines.find((entry: any) => entry.itemId === beansId);
    assert.equal((await request(`/api/houses/${houseId}/stocktakes`, { auth: viewerCookie })).status, 200);

    const viewerCount = await request(`/api/houses/${houseId}/stocktakes/${stocktakeId}/lines/${line.id}`, {
      method: "PATCH",
      auth: viewerCookie,
      body: { countedQty: 4 },
    });
    assert.equal(viewerCount.status, 403);
    const viewerCommit = await request(`/api/houses/${houseId}/stocktakes/${stocktakeId}/commit`, {
      method: "POST",
      auth: viewerCookie,
      body: { lineIds: [line.id] },
    });
    assert.equal(viewerCommit.status, 403);

    const memberCount = await request(`/api/houses/${houseId}/stocktakes/${stocktakeId}/lines/${line.id}`, {
      method: "PATCH",
      auth: memberCookie,
      body: { countedQty: 5 },
    });
    assert.equal(memberCount.status, 200, JSON.stringify(memberCount.data));
    assert.equal(memberCount.data.line.countedByName, "Member");
    const memberCommit = await request(`/api/houses/${houseId}/stocktakes/${stocktakeId}/commit`, {
      method: "POST",
      auth: memberCookie,
      body: { lineIds: [line.id] },
    });
    assert.equal(memberCommit.status, 200, JSON.stringify(memberCommit.data));
    assert.equal(memberCommit.data.stocktake.committedByName, "Member");
  });

  it("lists history with counts of lines and variances", async () => {
    const listed = await request(`/api/houses/${houseId}/stocktakes`);
    assert.equal(listed.status, 200);
    assert.ok(listed.data.stocktakes.length >= 4);
    const committed = listed.data.stocktakes.filter((entry: any) => entry.status === "committed");
    assert.ok(committed.every((entry: any) => entry.lineCount > 0));
    assert.ok(committed.some((entry: any) => entry.varianceCount > 0));
    assert.ok(committed.every((entry: any) => entry.lines === undefined));
    const cancelled = listed.data.stocktakes.filter((entry: any) => entry.status === "cancelled");
    assert.ok(cancelled.length >= 1);
  });

  it("expects the shelf quantity, so a lent unit is not booked as a shortage", async () => {
    const house = await request("/api/houses", { method: "POST", body: { name: "Count with loans" } });
    assert.equal(house.status, 201);
    const hid = house.data.id;
    const drill = await request(`/api/houses/${hid}/items`, {
      method: "POST",
      body: { name: "Cordless drill", unit: "pcs", initialStock: { quantity: 3 } },
    });
    assert.equal(drill.status, 201);
    const drillId = drill.data.id;
    // One of the three is lent out, so two are on the shelf.
    const loan = await request(`/api/houses/${hid}/loans`, {
      method: "POST",
      body: { itemId: drillId, borrowerName: "Neighbour", quantity: 1 },
    });
    assert.equal(loan.status, 201, JSON.stringify(loan.data));

    const created = await request(`/api/houses/${hid}/stocktakes`, { method: "POST", body: {} });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const stocktakeId = created.data.stocktake.id;
    const line = created.data.stocktake.lines.find((entry: any) => entry.itemId === drillId);
    assert.equal(line.expectedQty, 2, "expected is on-hand minus what is lent out");

    // Counting the two on the shelf is no variance: stock and the loan are untouched.
    const saved = await request(`/api/houses/${hid}/stocktakes/${stocktakeId}/lines/${line.id}`, {
      method: "PATCH",
      body: { countedQty: 2 },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.line.variance, 0);
    const committed = await request(`/api/houses/${hid}/stocktakes/${stocktakeId}/commit`, {
      method: "POST",
      body: { lineIds: [line.id] },
    });
    assert.equal(committed.status, 200, JSON.stringify(committed.data));
    assert.equal(committed.data.appliedDelta, 0);
    const detail = await request(`/api/items/${drillId}`);
    assert.equal(detail.data.quantity, 3);
    assert.equal(detail.data.onLoan, 1);
  });
});
