import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(tmpdir(), "svault-posokanei-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "";
process.env.SVAI_API_KEY = "";
process.env.SV_REGISTRATION = "open";

const { app } = await import("../index.js");
const { closeDb, databaseKind, exec, get, run, tx } = await import("../db.js");
const { createShoppingOffersHandler } = await import("../routes/insights.js");
const { rememberPosoKaneiRetailers } = await import("../services/posokanei-retailers.js");

let server: import("node:http").Server;
let base = "";
let ownerCookie = "";
let ownerId = "";
let houseId = "";
let lidlVendorId = "";
let sklavenitisVendorId = "";
let plainItemId = "";
let otherPlainItemId = "";
let barcodeItemId = "";
let offItemAId = "";
let offItemBId = "";
let barcodeLineId = "";
let plainLineId = "";
const barcode = "5201234500999";

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

function offer(retailer: string, price = 1, productId = "pk_product") {
  return {
    source: "PosoKanei" as const,
    productId,
    productName: "Test product",
    unit: "kg",
    retailer,
    price,
    unitPrice: price,
    currency: "EUR" as const,
    discount: false,
    discountPercent: null,
    updatedAt: null,
    fetchedAt: new Date().toISOString(),
  };
}

function callOffers(
  lineId: string,
  lookup: (barcode: string, userId: string) => Promise<any[]>,
  productLookup: (productId: string, userId: string) => Promise<any[]> = async () => {
    throw new Error("product lookup must not run");
  },
) {
  return new Promise<any>((resolve, reject) => {
    const response = {
      setHeader() { return this; },
      json(data: unknown) { resolve(data); return this; },
    };
    createShoppingOffersHandler(lookup, productLookup)(
      { params: { houseId, lineId }, user: { id: ownerId } } as any,
      response as any,
      (error: unknown) => { if (error) reject(error); },
    );
  });
}

async function createItem(name: string, extra: Record<string, unknown> = {}) {
  const created = await request(`/api/houses/${houseId}/items`, {
    method: "POST",
    body: { name, unit: "pcs", ...extra },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return String(created.data.id);
}

async function createLine(itemId: string, name: string) {
  const created = await request(`/api/houses/${houseId}/shopping`, {
    method: "POST",
    body: { name, itemId, quantity: 1, unit: "pcs" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return String(created.data.item.id);
}

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;

  const registered = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ name: "Owner", email: "posokanei.owner@example.com", password: "test password" }),
  });
  assert.equal(registered.status, 201, await registered.text());
  ownerCookie = String(registered.headers.get("set-cookie") ?? "").split(";")[0];
  const me = await request("/api/auth/me");
  ownerId = me.data.user.id;
  houseId = me.data.houses[0].id;

  const lidl = await request(`/api/houses/${houseId}/vendors`, { method: "POST", body: { name: "Lidl" } });
  assert.equal(lidl.status, 201, JSON.stringify(lidl.data));
  lidlVendorId = lidl.data.id;
  const sklavenitis = await request(`/api/houses/${houseId}/vendors`, { method: "POST", body: { name: "Σκλαβενίτης" } });
  assert.equal(sklavenitis.status, 201, JSON.stringify(sklavenitis.data));
  sklavenitisVendorId = sklavenitis.data.id;

  plainItemId = await createItem("Plain item");
  otherPlainItemId = await createItem("Other plain item");
  barcodeItemId = await createItem("Barcode item");
  offItemAId = await createItem("Off item A");
  offItemBId = await createItem("Off item B");
  await request(`/api/items/${barcodeItemId}/barcodes`, { method: "POST", body: { code: barcode } });
  await run("UPDATE items SET off_code = ?, off_project = 'off' WHERE id IN (?, ?)", [
    "5200000000001",
    offItemAId,
    offItemBId,
  ]);

  barcodeLineId = await createLine(barcodeItemId, "Barcode line");
  plainLineId = await createLine(plainItemId, "Plain line");

  const enabled = await request(`/api/houses/${houseId}`, {
    method: "PATCH",
    body: { settings: { priceLookup: { enabled: true } } },
  });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
});

after(async () => {
  server?.close();
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("PosoKanei item mappings", () => {
  it("stores a direct match for an item without an OpenFoodFacts link", async () => {
    const saved = await request(`/api/items/${plainItemId}/posokanei`, {
      method: "PUT",
      body: { id: "pk_plain", name: "Plain PosoKanei product" },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.deepEqual(saved.data.mapping, { id: "pk_plain", name: "Plain PosoKanei product", scope: "item" });

    const loaded = await request(`/api/items/${plainItemId}/posokanei`);
    assert.deepEqual(loaded.data.mapping, { id: "pk_plain", name: "Plain PosoKanei product", scope: "item" });

    const other = await request(`/api/items/${otherPlainItemId}/posokanei`);
    assert.equal(other.data.mapping, null, "a direct match belongs to one item only");
    assert.equal(
      (await get("SELECT item_id FROM posokanei_item_mappings WHERE item_id = ?", [plainItemId]))?.item_id,
      plainItemId,
    );
    assert.equal(
      (await get("SELECT off_code FROM posokanei_mappings WHERE off_code = ?", ["5200000000001"])),
      undefined,
    );
  });

  it("keeps the shared OpenFoodFacts match and lets one item override it", async () => {
    const shared = await request(`/api/items/${offItemAId}/posokanei`, {
      method: "PUT",
      body: { id: "pk_shared", name: "Shared product" },
    });
    assert.equal(shared.status, 200, JSON.stringify(shared.data));
    assert.equal(shared.data.mapping.scope, "off");

    const sibling = await request(`/api/items/${offItemBId}/posokanei`);
    assert.deepEqual(sibling.data.mapping, { id: "pk_shared", name: "Shared product", scope: "off" });

    const direct = await request(`/api/items/${offItemAId}/posokanei`, {
      method: "PUT",
      body: { id: "pk_item", name: "Only item A", scope: "item" },
    });
    assert.equal(direct.status, 200, JSON.stringify(direct.data));
    assert.equal(direct.data.mapping.scope, "item");
    assert.equal((await request(`/api/items/${offItemAId}/posokanei`)).data.mapping.id, "pk_item");
    assert.equal((await request(`/api/items/${offItemBId}/posokanei`)).data.mapping.id, "pk_shared");

    const removedOverride = await request(`/api/items/${offItemAId}/posokanei`, { method: "DELETE" });
    assert.equal(removedOverride.status, 200);
    assert.deepEqual(removedOverride.data.mapping, { id: "pk_shared", name: "Shared product", scope: "off" });
    assert.deepEqual(
      (await request(`/api/items/${offItemAId}/posokanei`)).data.mapping,
      { id: "pk_shared", name: "Shared product", scope: "off" },
      "removing the item override reveals the shared match",
    );
    assert.equal((await request(`/api/items/${offItemAId}/posokanei`, { method: "DELETE" })).status, 200);
    assert.equal((await request(`/api/items/${offItemBId}/posokanei`)).data.mapping, null);
    assert.equal(
      (await get("SELECT off_code FROM posokanei_mappings WHERE off_code = ?", ["5200000000001"])),
      undefined,
    );

    const missingOff = await request(`/api/items/${otherPlainItemId}/posokanei`, {
      method: "PUT",
      body: { id: "pk_bad", name: "Bad scope", scope: "off" },
    });
    assert.equal(missingOff.status, 400);
  });

  it("checks offers through the shared OpenFoodFacts match", async () => {
    const linked = await request(`/api/items/${offItemAId}/posokanei`, {
      method: "PUT",
      body: { id: "pk_shared_offers", name: "Shared offers product" },
    });
    assert.equal(linked.status, 200, JSON.stringify(linked.data));
    const lineId = await createLine(offItemBId, "Shared offer line");

    const result = await callOffers(
      lineId,
      async () => { throw new Error("a shared match must not fall back to a barcode"); },
      async (productId) => {
        assert.equal(productId, "pk_shared_offers");
        return [offer("Lidl", 4)];
      },
    );
    assert.equal(result.barcode, null);
    assert.equal(result.productId, "pk_shared_offers");
    assert.deepEqual(result.offers.map((entry: any) => entry.retailer), ["Lidl"]);
  });
});

describe("PosoKanei retailer filters", () => {
  const unknownRetailer = "Παντοπωλείο Άγνωστο";

  it("keeps retailer settings available while price lookup is disabled", async () => {
    const disabled = await request(`/api/houses/${houseId}`, { method: "PATCH", body: { settings: { priceLookup: { enabled: false } } } });
    assert.equal(disabled.status, 200);
    try {
      assert.equal((await request(`/api/houses/${houseId}/posokanei/retailers`)).status, 200);
      assert.equal((await request(`/api/items/${plainItemId}/posokanei/search?q=test`)).status, 404);
    } finally {
      const enabled = await request(`/api/houses/${houseId}`, { method: "PATCH", body: { settings: { priceLookup: { enabled: true } } } });
      assert.equal(enabled.status, 200);
    }
  });

  it("rejects a retailer mapping to another house's vendor", async () => {
    const otherHouse = await request("/api/houses", { body: { name: "Other house" } });
    assert.equal(otherHouse.status, 201);
    const otherVendor = await request(`/api/houses/${otherHouse.data.id}/vendors`, { body: { name: "Other shop" } });
    assert.equal(otherVendor.status, 201);
    const result = await request(`/api/houses/${houseId}/posokanei/retailers`, { method: "PUT", body: { retailer: "Foreign mapping", vendorId: otherVendor.data.id } });
    assert.equal(result.status, 400);
    assert.equal(await get("SELECT vendor_id FROM posokanei_retailers WHERE house_id = ? AND vendor_id = ?", [houseId, otherVendor.data.id]), undefined);
  });

  it("caps automatic retailer discovery per house", async () => {
    const otherHouse = await request("/api/houses", { body: { name: "Discovery cap house" } });
    assert.equal(otherHouse.status, 201);
    const id = otherHouse.data.id;
    await tx(async (session) => {
      for (let i = 0; i < 499; i++) {
        await session.run("INSERT INTO posokanei_retailers (house_id, retailer_key, retailer_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [id, `shop ${i}`, `Shop ${i}`, "2026-01-01", "2026-01-01"]);
      }
    }, { writeLock: true });
    await rememberPosoKaneiRetailers(id, [offer("New retailer A"), offer("New retailer B")]);
    const count = await get<{ count: number }>("SELECT COUNT(*) AS count FROM posokanei_retailers WHERE house_id = ?", [id]);
    assert.equal(Number(count?.count), 500);
  });

  it("maps discovered retailers to receipt shops and reports unknown ones", async () => {
    const changed = await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { priceLookup: { enabled: true, accessibleVendorIds: [lidlVendorId] } } },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.data));

    const offers = [offer("Lidl", 1), offer("Σκλαβενίτης", 2), offer(unknownRetailer, 3)];
    const result = await callOffers(barcodeLineId, async (code) => {
      assert.equal(code, barcode);
      return offers;
    });
    assert.equal(result.barcode, barcode);
    assert.deepEqual(result.offers.map((entry: any) => entry.retailer), ["Lidl"]);
    assert.equal(result.retailerFilter.active, true);
    assert.equal(result.retailerFilter.hiddenOffers, 2);
    assert.deepEqual(result.retailerFilter.unknownRetailers, [unknownRetailer]);

    const settings = await request(`/api/houses/${houseId}/posokanei/retailers`);
    assert.equal(settings.status, 200, JSON.stringify(settings.data));
    const lidl = settings.data.retailers.find((entry: any) => entry.name === "Lidl");
    assert.equal(lidl.vendorId, lidlVendorId, "an exact receipt-shop name is matched automatically");
    const sklavenitis = settings.data.retailers.find((entry: any) => entry.name === "Σκλαβενίτης");
    assert.equal(sklavenitis.vendorId, sklavenitisVendorId);
    const unknown = settings.data.retailers.find((entry: any) => entry.name === unknownRetailer);
    assert.equal(unknown.unknown, true);
    assert.equal(unknown.vendorId, null);
    assert.deepEqual(settings.data.accessibleVendorIds, [lidlVendorId]);

    const matched = await request(`/api/houses/${houseId}/posokanei/retailers`, {
      method: "PUT",
      body: { retailer: unknownRetailer, vendorId: sklavenitisVendorId },
    });
    assert.equal(matched.status, 200, JSON.stringify(matched.data));
    assert.equal(matched.data.retailer.vendorId, sklavenitisVendorId);
    assert.equal(matched.data.retailer.unknown, false);

    const both = await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { priceLookup: { enabled: true, accessibleVendorIds: [lidlVendorId, sklavenitisVendorId] } } },
    });
    assert.equal(both.status, 200, JSON.stringify(both.data));
    const filtered = await callOffers(barcodeLineId, async () => offers);
    assert.deepEqual(
      filtered.offers.map((entry: any) => entry.retailer),
      ["Lidl", "Σκλαβενίτης", unknownRetailer],
      "the newly mapped retailer is now accessible",
    );
    assert.equal(filtered.retailerFilter.hiddenOffers, 0);
    assert.deepEqual(filtered.retailerFilter.unknownRetailers, []);

    const afterMapping = await request(`/api/houses/${houseId}/posokanei/retailers`);
    const mappedRow = afterMapping.data.retailers.find((entry: any) => entry.name === unknownRetailer);
    assert.equal(mappedRow.vendorId, sklavenitisVendorId);
    assert.equal(
      (await request(`/api/houses/${houseId}/posokanei/retailers/${encodeURIComponent(mappedRow.key)}`, { method: "DELETE" })).status,
      200,
    );
    const afterDelete = await request(`/api/houses/${houseId}/posokanei/retailers`);
    assert.equal(
      afterDelete.data.retailers.find((entry: any) => entry.name === unknownRetailer),
      undefined,
      "deleting a mapping removes the discovered row",
    );

    const hiddenUnknown = await callOffers(barcodeLineId, async () => offers);
    assert.deepEqual(hiddenUnknown.offers.map((entry: any) => entry.retailer), ["Lidl", "Σκλαβενίτης"]);
    assert.equal(hiddenUnknown.retailerFilter.hiddenOffers, 1);
    assert.deepEqual(hiddenUnknown.retailerFilter.unknownRetailers, [unknownRetailer]);

    const rediscovered = await request(`/api/houses/${houseId}/posokanei/retailers`);
    const unmappedRow = rediscovered.data.retailers.find((entry: any) => entry.name === unknownRetailer);
    assert.equal(unmappedRow.vendorId, null);
    assert.equal(unmappedRow.unknown, true);
  });

  it("matches a catalogue alias to an existing receipt shop", async () => {
    const selected = await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { priceLookup: { enabled: true, accessibleVendorIds: [lidlVendorId] } } },
    });
    assert.equal(selected.status, 200, JSON.stringify(selected.data));

    const unmatched = "Άγνωστο παντοπωλείο";
    const offers = [offer("LIDL HELLAS", 1), offer(unmatched, 2)];
    const result = await callOffers(barcodeLineId, async () => offers);
    assert.deepEqual(result.offers.map((entry: any) => entry.retailer), ["LIDL HELLAS"]);
    assert.equal(result.retailerFilter.hiddenOffers, 1);
    assert.deepEqual(result.retailerFilter.unknownRetailers, [unmatched]);

    const settings = await request(`/api/houses/${houseId}/posokanei/retailers`);
    const retailer = settings.data.retailers.find((entry: any) => entry.name === "LIDL HELLAS");
    assert.equal(retailer.vendorId, lidlVendorId, "the shared vendor catalogue resolves shop aliases");
    assert.equal(retailer.unknown, false);
  });

  it("respects an explicitly unmatched retailer even when its name matches a shop", async () => {
    const unmapped = await request(`/api/houses/${houseId}/posokanei/retailers`, {
      method: "PUT", body: { retailer: "Lidl", vendorId: null },
    });
    assert.equal(unmapped.status, 200);
    const result = await callOffers(barcodeLineId, async () => [offer("Lidl")]);
    assert.deepEqual(result.offers, []);
    assert.deepEqual(result.retailerFilter.unknownRetailers, ["Lidl"]);
    const restored = await request(`/api/houses/${houseId}/posokanei/retailers`, {
      method: "PUT", body: { retailer: "Lidl", vendorId: lidlVendorId },
    });
    assert.equal(restored.status, 200);
  });

  it("still returns offers if retailer discovery cannot write", async () => {
    if (databaseKind() !== "sqlite") return;
    await exec("CREATE TRIGGER fail_retailer_discovery BEFORE INSERT ON posokanei_retailers BEGIN SELECT RAISE(ABORT, 'discovery failure'); END;");
    try {
      const result = await callOffers(barcodeLineId, async () => [offer("A new retailer")]);
      assert.deepEqual(result.offers, []);
      assert.deepEqual(result.retailerFilter.unknownRetailers, ["A new retailer"]);
    } finally {
      await exec("DROP TRIGGER IF EXISTS fail_retailer_discovery");
    }
  });

  it("filters product-ID lookups through the item mapping", async () => {
    const offers = [offer("Lidl", 1, "pk_plain"), offer("Άλλο κατάστημα", 2, "pk_plain"), offer(unknownRetailer, 3, "pk_plain")];
    const result = await callOffers(
      plainLineId,
      async () => { throw new Error("a mapped item must not fall back to its barcode"); },
      async (productId) => {
        assert.equal(productId, "pk_plain");
        return offers;
      },
    );
    assert.equal(result.barcode, null);
    assert.equal(result.productId, "pk_plain");
    assert.deepEqual(result.offers.map((entry: any) => entry.retailer), ["Lidl"]);
    assert.equal(result.retailerFilter.hiddenOffers, 2);
    assert.deepEqual(result.retailerFilter.unknownRetailers, ["Άλλο κατάστημα", unknownRetailer]);
  });

  it("shows every retailer when no accessible shop is selected", async () => {
    const cleared = await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { priceLookup: { enabled: true, accessibleVendorIds: [] } } },
    });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.data));

    const offers = [offer("Lidl", 1), offer("Σκλαβενίτης", 2), offer(unknownRetailer, 3)];
    const result = await callOffers(barcodeLineId, async () => offers);
    assert.deepEqual(result.offers.map((entry: any) => entry.retailer), ["Lidl", "Σκλαβενίτης", unknownRetailer]);
    assert.equal("retailerFilter" in result, false, "the old response shape is preserved when filtering is off");
  });

  it("validates accessible shop IDs in house settings", async () => {
    const missing = await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { priceLookup: { enabled: true, accessibleVendorIds: ["vnd_not_in_house"] } } },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.data.error, "Shop does not exist in this house");

    const unexpected = await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { priceLookup: { enabled: true, accessibleVendorIds: [lidlVendorId], unexpected: true } } },
    });
    assert.equal(unexpected.status, 400);

    const duplicate = await request(`/api/houses/${houseId}`, {
      method: "PATCH",
      body: { settings: { priceLookup: { enabled: true, accessibleVendorIds: [lidlVendorId, lidlVendorId] } } },
    });
    assert.equal(duplicate.status, 200, JSON.stringify(duplicate.data));
    assert.deepEqual(duplicate.data.settings.priceLookup.accessibleVendorIds, [lidlVendorId]);
  });
});
