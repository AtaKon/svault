import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(tmpdir(), "svault-merge-test-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "";
process.env.SVAI_API_KEY = "";
process.env.SV_REGISTRATION = "open";

const { app } = await import("../index.js");
const { all, closeDb, databaseKind, exec, get, run, tables } = await import("../db.js");
const { duplicateSignals, itemNameSimilarity, normalizeItemName } = await import("../services/item-duplicates.js");
const { ITEM_MERGE_TABLES } = await import("../services/item-merge.js");

let server: import("node:http").Server;
let base = "";
let cookie = "";
let ownerId = "";
let houseId = "";

async function request(
  pathname: string,
  options: { method?: string; body?: unknown; auth?: string } = {},
) {
  const headers: Record<string, string> = { connection: "close" };
  const useCookie = options.auth === undefined ? cookie : options.auth;
  if (useCookie) headers.cookie = useCookie;
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const res = await fetch(base + pathname, { method: options.method ?? (body ? "POST" : "GET"), headers, body });
  const setCookie = res.headers.get("set-cookie");
  const text = await res.text();
  return {
    status: res.status,
    data: text ? JSON.parse(text) : null,
    cookie: setCookie ? setCookie.split(";")[0] : null,
  };
}

async function createItem(body: Record<string, unknown>) {
  const created = await request(`/api/houses/${houseId}/items`, { method: "POST", body });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return created.data;
}

async function itemDetail(id: string) {
  const detail = await request(`/api/items/${id}`);
  assert.equal(detail.status, 200);
  return detail.data;
}

async function columnsFor(table: string): Promise<string[]> {
  const rows =
    databaseKind() === "sqlite"
      ? await all<{ name: string }>(`PRAGMA table_info(${table})`)
      : await all<{ column_name: string }>(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?",
          [table],
        );
  return rows.map((row: any) => row.name ?? row.column_name);
}

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;
  const reg = await request("/api/auth/register", {
    method: "POST",
    body: { name: "Merge Owner", email: "merge-owner@example.com", password: "test password" },
  });
  assert.equal(reg.status, 201);
  cookie = reg.cookie!;
  ownerId = reg.data.user.id;
  houseId = reg.data.houses[0].id;
});

after(async () => {
  server?.close();
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("duplicate name normalisation", () => {
  it("folds case, Greek accents, punctuation and unit spellings", () => {
    const accented = normalizeItemName("Γάλα Φρέσκο 1,5 Λίτρα");
    const plain = normalizeItemName("ΓΑΛΑ ΦΡΕΣΚΟ 1.5 l");
    assert.equal(accented.key, plain.key);
    assert.equal(accented.unit, "l");
    assert.equal(accented.amount, 1.5);
    assert.deepEqual(accented.tokens, ["γαλα", "φρεσκο"]);

    assert.equal(normalizeItemName("Milk 1L").key, normalizeItemName("MILK 1 l").key);
    assert.equal(normalizeItemName("Milk 1 lt").key, normalizeItemName("milk 1l").key);
    assert.equal(normalizeItemName("Flour 1 kilo").key, normalizeItemName("flour 1kg").key);
    assert.equal(normalizeItemName("Flour 1 κιλό").key, normalizeItemName("flour 1 kg").key);
  });

  it("treats a shorter name inside a longer one as a near match", () => {
    const similarity = itemNameSimilarity(normalizeItemName("Milk 1L"), normalizeItemName("Fresh milk 1 l"));
    assert.ok(similarity >= 0.66, `similarity was ${similarity}`);
  });

  it("does not pair different pack sizes, but pairs the same size in another unit", () => {
    const different = duplicateSignals(
      { name: "Milk 1L", brand: null, unit: "l", barcodes: [], offCode: null, offProject: null },
      { name: "Milk 2 l", brand: null, unit: "l", barcodes: [], offCode: null, offProject: null },
    );
    assert.equal(different, null);
    const same = duplicateSignals(
      { name: "Milk 1L", brand: null, unit: "l", barcodes: [], offCode: null, offProject: null },
      { name: "Milk 1000 ml", brand: null, unit: "ml", barcodes: [], offCode: null, offProject: null },
    );
    assert.ok(same);
    assert.ok(same!.reasons.includes("same_name") || same!.reasons.includes("similar_name"));
  });

  it("uses a shared barcode as the strongest signal", () => {
    const signals = duplicateSignals(
      { name: "Milk", brand: null, unit: "l", barcodes: ["5201000000001"], offCode: null, offProject: null },
      { name: "Something else", brand: null, unit: "l", barcodes: ["5201000000001"], offCode: null, offProject: null },
    );
    assert.ok(signals);
    assert.ok(signals!.reasons.includes("shared_barcode"));
    assert.ok(signals!.confidence >= 0.9);
  });

  it("requires a name signal before same-brand items are suggested", () => {    const unrelated = duplicateSignals(
      { name: "Coffee beans", brand: "Marata", unit: "g", barcodes: [], offCode: null, offProject: null },
      { name: "Olive oil", brand: "Marata", unit: "g", barcodes: [], offCode: null, offProject: null },
    );
    assert.equal(unrelated, null);
    const related = duplicateSignals(
      { name: "Coffee beans 250g", brand: "Marata", unit: "g", barcodes: [], offCode: null, offProject: null },
      { name: "Coffee beans ground 250 g", brand: "Marata", unit: "g", barcodes: [], offCode: null, offProject: null },
    );
    assert.ok(related);
    assert.ok(related!.reasons.includes("same_brand"));
  });
});

describe("duplicate suggestions", () => {
  it("groups similar names, reports the reason and can be dismissed", async () => {
    const milk = await createItem({ name: "Merge Milk 1L", unit: "l", initialStock: { quantity: 2 } });
    const fresh = await createItem({ name: "Merge Fresh milk 1 l", unit: "l", initialStock: { quantity: 3 } });

    const listed = await request(`/api/houses/${houseId}/items/duplicates?limit=200`);
    assert.equal(listed.status, 200);
    const group = listed.data.groups.find((entry: any) =>
      entry.items.some((item: any) => item.id === milk.id) && entry.items.some((item: any) => item.id === fresh.id),
    );
    assert.ok(group, "expected the two milk items to be grouped");
    assert.ok(group.reasons.includes("similar_name"));
    assert.ok(group.confidence >= 0.6);

    const dismissed = await request(`/api/houses/${houseId}/items/duplicates/dismiss`, {
      method: "POST",
      body: { pairs: [{ a: milk.id, b: fresh.id }] },
    });
    assert.equal(dismissed.status, 200);
    const afterDismiss = await request(`/api/houses/${houseId}/items/duplicates?limit=200`);
    assert.ok(
      !afterDismiss.data.groups.some((entry: any) =>
        entry.items.some((item: any) => item.id === milk.id) && entry.items.some((item: any) => item.id === fresh.id),
      ),
      "a dismissed pair must not be suggested again",
    );
  });

  it("matches a shared OpenFoodFacts link", async () => {
    const one = await createItem({ name: "Merge OFF yoghurt A", unit: "g" });
    const two = await createItem({ name: "Merge OFF yoghurt B", unit: "g" });
    await run("UPDATE items SET off_code = ?, off_project = ? WHERE id IN (?, ?)", [
      "5201234567890",
      "off",
      one.id,
      two.id,
    ]);
    const listed = await request(`/api/houses/${houseId}/items/duplicates?limit=200`);
    const group = listed.data.groups.find((entry: any) =>
      entry.items.some((item: any) => item.id === one.id) && entry.items.some((item: any) => item.id === two.id),
    );
    assert.ok(group);
    assert.ok(group.reasons.includes("same_product_link"));
  });

  it("lets viewers look but not dismiss", async () => {
    const viewer = await request("/api/auth/register", {
      method: "POST",
      body: { name: "Merge Viewer", email: "merge-viewer@example.com", password: "test password" },
    });
    await run("INSERT INTO house_members (house_id, user_id, role, created_at) VALUES (?, ?, ?, ?)", [
      houseId,
      viewer.data.user.id,
      "viewer",
      new Date().toISOString(),
    ]);
    const listed = await request(`/api/houses/${houseId}/items/duplicates`, { auth: viewer.cookie! });
    assert.equal(listed.status, 200);
    const dismissed = await request(`/api/houses/${houseId}/items/duplicates/dismiss`, {
      method: "POST",
      auth: viewer.cookie!,
      body: { pairs: [{ a: "itm_a", b: "itm_b" }] },
    });
    assert.equal(dismissed.status, 403);
  });
});

describe("item merge", () => {
  it("re-points every table with an item_id column", async () => {
    const source = await createItem({ name: "Merge source references", unit: "pcs", initialStock: { quantity: 4 } });
    const target = await createItem({ name: "Merge target references", unit: "pcs", initialStock: { quantity: 1 } });
    const stamp = new Date().toISOString();

    const receiptId = "rce_merge_test";
    await run("INSERT INTO receipts (id, house_id, created_at) VALUES (?, ?, ?)", [receiptId, houseId, stamp]);
    await run(
      "INSERT INTO receipt_lines (id, receipt_id, house_id, description, quantity, item_id, sort) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["rln_merge_test", receiptId, houseId, "Merge source references", 1, source.id, 0],
    );
    await run(
      "INSERT INTO product_aliases (id, house_id, vendor_key, raw_key, raw_text, item_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["als_merge_test", houseId, "", "merge-source-alias", "Merge source alias", source.id, stamp, stamp],
    );
    await run(
      "INSERT INTO shopping_list_items (id, house_id, item_id, name, source, checked, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
      ["shp_merge_test", houseId, source.id, "Merge source references", "manual", stamp, stamp],
    );
    await run(
      "INSERT INTO recipes (id, house_id, title, steps, tags, source, favorite, created_at, updated_at) VALUES (?, ?, ?, '[]', '[]', 'manual', 0, ?, ?)",
      ["rcp_merge_test", houseId, "Merge recipe", stamp, stamp],
    );
    await run(
      "INSERT INTO recipe_ingredients (id, recipe_id, name, quantity, item_id, optional, sort) VALUES (?, ?, ?, ?, ?, 0, 0)",
      ["rin_merge_test", "rcp_merge_test", "Merge source references", 1, source.id],
    );
    await run(
      "INSERT INTO photos (id, house_id, filename, original_name, mime, size, item_id, split, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'unassigned', ?)",
      ["pht_merge_test", houseId, "merge.jpg", "merge.jpg", "image/jpeg", 100, source.id, stamp],
    );
    await run(
      "INSERT INTO item_documents (id, house_id, item_id, filename, original_name, mime, size, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?)",
      ["doc_merge_test", houseId, source.id, "merge.pdf", "merge.pdf", "application/pdf", 100, stamp],
    );
    await run(
      "INSERT INTO item_barcodes (id, item_id, house_id, code, format, created_at) VALUES (?, ?, ?, ?, 'manual', ?)",
      ["bar_merge_test", source.id, houseId, "5209999999991", stamp],
    );
    await run(
      "INSERT INTO espresso_shots (id, house_id, item_id, brewed_at, rating, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '[]', ?, ?)",
      ["esp_merge_test", houseId, source.id, stamp, 4, stamp, stamp],
    );
    await run(
      "INSERT INTO off_contributions (id, idempotency_key, user_id, house_id, item_id, project, code, kind, payload, field_keys, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', '[]', 'queued', 0, ?, ?)",
      ["ofc_merge_test", "merge-test-key", ownerId, houseId, source.id, "off", "5209999999991", "product", stamp, stamp],
    );
    await run(
      "INSERT INTO notifications (id, house_id, type, title, body, data, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "ntf_merge_test",
        houseId,
        "low_stock",
        "Merge source low",
        "low",
        JSON.stringify({ itemId: source.id }),
        `low:${source.id}`,
        stamp,
      ],
    );

    // The enumeration guard: a future table with item_id must be handled here.
    const tableNames = await tables();
    const withItemId: string[] = [];
    for (const table of tableNames) {
      if (await columnsFor(table).then((columns) => columns.includes("item_id"))) withItemId.push(table);
    }
    assert.deepEqual(
      [...new Set(withItemId)].sort(),
      [...ITEM_MERGE_TABLES].sort(),
      "every table with an item_id column must be listed in ITEM_MERGE_TABLES and re-pointed by a merge",
    );

    const preview = await request(`/api/houses/${houseId}/items/${target.id}/merge`, {
      method: "POST",
      body: { sourceIds: [source.id], dryRun: true },
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.dryRun, true);
    assert.equal(preview.data.mergeable, true);
    assert.equal(preview.data.moves.lots, 1);
    assert.equal(preview.data.moves.lotQuantity, 4);

    const merged = await request(`/api/houses/${houseId}/items/${target.id}/merge`, {
      method: "POST",
      body: { sourceIds: [source.id] },
    });
    assert.equal(merged.status, 200, JSON.stringify(merged.data));
    assert.deepEqual(merged.data.archived, [source.id]);
    assert.equal(merged.data.target.quantity, 5);

    for (const table of ITEM_MERGE_TABLES) {
      const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE item_id = ?`, [source.id]);
      assert.equal(Number(row?.n ?? 0), 0, `${table} still points at the archived source`);
    }
    const recipeLink = await get<any>("SELECT item_id FROM recipe_ingredients WHERE id = ?", ["rin_merge_test"]);
    assert.equal(recipeLink.item_id, target.id);
    const receiptLink = await get<any>("SELECT item_id FROM receipt_lines WHERE id = ?", ["rln_merge_test"]);
    assert.equal(receiptLink.item_id, target.id);
    const notification = await get<any>("SELECT id FROM notifications WHERE id = ? AND resolved_at IS NULL", ["ntf_merge_test"]);
    assert.equal(notification, undefined, "source reminders must not survive the merge");

    const sourceDetail = await itemDetail(source.id);
    assert.equal(sourceDetail.archived, true);
    assert.equal(sourceDetail.mergedInto, target.id);

    // The merged source is hidden from suggestions and its history is resolvable.
    const suggestions = await request(`/api/houses/${houseId}/items/duplicates?limit=200`);
    assert.ok(!suggestions.data.groups.some((group: any) => group.items.some((item: any) => item.id === source.id)));
  });

  it("converts compatible units into the target's base unit", async () => {
    const target = await createItem({ name: "Merge conversion target", unit: "g", initialStock: { quantity: 500 } });
    const source = await createItem({
      name: "Merge conversion source",
      unit: "kg",
      initialStock: { quantity: 1, unit: "kg", unitPrice: 10 },
    });
    const preview = await request(`/api/houses/${houseId}/items/${target.id}/merge`, {
      method: "POST",
      body: { sourceIds: [source.id], dryRun: true },
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.moves.lotQuantity, 1000);
    const merged = await request(`/api/houses/${houseId}/items/${target.id}/merge`, {
      method: "POST",
      body: { sourceIds: [source.id] },
    });
    assert.equal(merged.status, 200);
    const detail = await itemDetail(target.id);
    assert.equal(detail.quantity, 1500);
    const movedLot = detail.lots.find((lot: any) => lot.quantity === 1000);
    assert.ok(movedLot);
    assert.equal(movedLot.unit, "g");
    // 10 per kg is 0.01 per g.
    assert.equal(movedLot.unitPrice, 0.01);
  });

  it("keeps the ledger balanced when a movement was entered in another unit", async () => {
    // Stock is stored in the item's own unit; the movement's unit is only the
    // unit the user typed. Adding 500 g to a kg item records delta 0.5 and unit
    // "g", so a merge must not scale that delta by the g -> kg factor again.
    const target = await createItem({ name: "Merge ledger target", unit: "kg", initialStock: { quantity: 2, unit: "kg" } });
    const source = await createItem({ name: "Merge ledger source", unit: "kg", initialStock: { quantity: 500, unit: "g" } });
    assert.equal((await itemDetail(source.id)).quantity, 0.5);

    const merged = await request(`/api/houses/${houseId}/items/${target.id}/merge`, {
      method: "POST",
      body: { sourceIds: [source.id] },
    });
    assert.equal(merged.status, 200, JSON.stringify(merged.data));

    const detail = await itemDetail(target.id);
    assert.equal(detail.quantity, 2.5);
    const movements = await request(`/api/items/${target.id}/movements`);
    assert.equal(movements.status, 200);
    const total = movements.data.reduce((sum: number, entry: any) => sum + Number(entry.delta ?? 0), 0);
    assert.equal(Math.round(total * 1000) / 1000, 2.5, "movement deltas must still add up to the stock on hand");
    assert.ok(movements.data.some((entry: any) => Math.abs(Number(entry.delta) - 0.5) < 1e-9));
  });

  it("fills empty target fields instead of overwriting set ones", async () => {
    const target = await createItem({ name: "Merge fields target", unit: "pcs", brand: "Keep me" });
    const source = await createItem({
      name: "Merge fields source",
      unit: "pcs",
      brand: "Other brand",
      description: "From the source",
      tags: ["kitchen"],
      attributes: { size: "large" },
      reorderPoint: 2,
    });
    const merged = await request(`/api/houses/${houseId}/items/${target.id}/merge`, {
      method: "POST",
      body: { sourceIds: [source.id] },
    });
    assert.equal(merged.status, 200);
    const detail = await itemDetail(target.id);
    assert.equal(detail.brand, "Keep me");
    assert.equal(detail.description, "From the source");
    assert.deepEqual(detail.tags, ["kitchen"]);
    assert.equal(detail.attributes.size, "large");
    assert.equal(detail.reorderPoint, 2);
  });

  it("merges several sources into one target", async () => {
    const target = await createItem({ name: "Merge multi target", unit: "pcs", initialStock: { quantity: 1 } });
    const first = await createItem({
      name: "Merge multi one",
      unit: "pcs",
      tags: ["kitchen"],
      initialStock: { quantity: 2 },
    });
    const second = await createItem({
      name: "Merge multi two",
      unit: "pcs",
      tags: ["pantry"],
      initialStock: { quantity: 3 },
    });
    const preview = await request(`/api/houses/${houseId}/items/${target.id}/merge`, {
      method: "POST",
      body: { sourceIds: [first.id, second.id], dryRun: true },
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.sources.length, 2);
    assert.equal(preview.data.moves.lotQuantity, 5);
    const merged = await request(`/api/houses/${houseId}/items/${target.id}/merge`, {
      method: "POST",
      body: { sourceIds: [first.id, second.id] },
    });
    assert.equal(merged.status, 200);
    assert.equal(merged.data.archived.length, 2);
    const detail = await itemDetail(target.id);
    assert.equal(detail.quantity, 6);
    assert.deepEqual([...detail.tags].sort(), ["kitchen", "pantry"]);
    assert.equal((await itemDetail(first.id)).archived, true);
    assert.equal((await itemDetail(second.id)).archived, true);
  });

  it("refuses incompatible units with a clear 409 and changes nothing", async () => {
    const target = await createItem({ name: "Merge pcs target", unit: "pcs", initialStock: { quantity: 1 } });
    const source = await createItem({ name: "Merge kg source", unit: "kg", initialStock: { quantity: 1 } });
    const preview = await request(`/api/houses/${houseId}/items/${target.id}/merge`, {
      method: "POST",
      body: { sourceIds: [source.id], dryRun: true },
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.mergeable, false);
    assert.ok(preview.data.conflicts.some((conflict: any) => conflict.kind === "incompatible_unit"));

    const refused = await request(`/api/houses/${houseId}/items/${target.id}/merge`, {
      method: "POST",
      body: { sourceIds: [source.id] },
    });
    assert.equal(refused.status, 409);
    assert.ok(refused.data.details.conflicts.some((conflict: any) => conflict.kind === "incompatible_unit"));
    assert.equal((await itemDetail(target.id)).quantity, 1);
    const sourceDetail = await itemDetail(source.id);
    assert.equal(sourceDetail.archived, false);
    assert.equal(sourceDetail.quantity, 1);
  });

  it("refuses an archived target", async () => {
    const target = await createItem({ name: "Merge archived target", unit: "pcs" });
    const source = await createItem({ name: "Merge archived target source", unit: "pcs" });
    await run("UPDATE items SET archived = 1 WHERE id = ?", [target.id]);
    const refused = await request(`/api/houses/${houseId}/items/${target.id}/merge`, {
      method: "POST",
      body: { sourceIds: [source.id] },
    });
    assert.equal(refused.status, 409);
    assert.ok(refused.data.details.conflicts.some((conflict: any) => conflict.kind === "target_archived"));
  });

  it("refuses sources from another house", async () => {
    const otherHouse = await request("/api/houses", {
      method: "POST",
      body: { name: "Merge other house", kind: "home", currency: "EUR" },
    });
    assert.equal(otherHouse.status, 201);
    const otherItem = await request(`/api/houses/${otherHouse.data.id}/items`, {
      method: "POST",
      body: { name: "Merge other house item", unit: "pcs" },
    });
    assert.equal(otherItem.status, 201);
    const target = await createItem({ name: "Merge cross house target", unit: "pcs" });
    const refused = await request(`/api/houses/${houseId}/items/${target.id}/merge`, {
      method: "POST",
      body: { sourceIds: [otherItem.data.id] },
    });
    assert.equal(refused.status, 409);
    assert.ok(refused.data.details.conflicts.some((conflict: any) => conflict.kind === "source_not_found"));
  });

  it("refuses viewers", async () => {
    const viewer = await request("/api/auth/register", {
      method: "POST",
      body: { name: "Merge Refused Viewer", email: "merge-refused-viewer@example.com", password: "test password" },
    });
    await run("INSERT INTO house_members (house_id, user_id, role, created_at) VALUES (?, ?, ?, ?)", [
      houseId,
      viewer.data.user.id,
      "viewer",
      new Date().toISOString(),
    ]);
    const target = await createItem({ name: "Merge viewer target", unit: "pcs" });
    const source = await createItem({ name: "Merge viewer source", unit: "pcs" });
    const refused = await request(`/api/houses/${houseId}/items/${target.id}/merge`, {
      method: "POST",
      auth: viewer.cookie!,
      body: { sourceIds: [source.id], dryRun: true },
    });
    assert.equal(refused.status, 403);
  });

  it("rolls the whole transaction back when a write fails", async () => {
    if (databaseKind() !== "sqlite") return;
    const target = await createItem({ name: "Merge rollback target", unit: "pcs", initialStock: { quantity: 2 } });
    const source = await createItem({ name: "Merge rollback source", unit: "pcs", initialStock: { quantity: 3 } });
    await exec(
      "CREATE TRIGGER merge_failure BEFORE UPDATE OF merged_into ON items WHEN NEW.merged_into IS NOT NULL BEGIN SELECT RAISE(ABORT, 'forced merge failure'); END;",
    );
    try {
      const failed = await request(`/api/houses/${houseId}/items/${target.id}/merge`, {
        method: "POST",
        body: { sourceIds: [source.id] },
      });
      assert.equal(failed.status, 500);
    } finally {
      await exec("DROP TRIGGER IF EXISTS merge_failure");
    }
    const targetDetail = await itemDetail(target.id);
    const sourceDetail = await itemDetail(source.id);
    assert.equal(targetDetail.quantity, 2, "moved batches must be rolled back");
    assert.equal(sourceDetail.quantity, 3, "the source keeps its batches");
    assert.equal(sourceDetail.archived, false);
    assert.equal(sourceDetail.mergedInto, null);
  });
});
