import { all, get, lockHouseholdLedger, newId, now, run, tx } from "../db.js";
import { ApiError } from "../http.js";
import { round } from "../units.js";
import { applyStockCount, afterStockChange } from "./stock.js";
import { serializeStocktake, serializeStocktakeLine } from "../serialize.js";
import type { DatabaseSession } from "../database/types.js";
import type { StocktakeCommitResult } from "../../shared/types.js";

/**
 * Stocktake: a guided physical count.
 *
 * Starting a session snapshots the expected quantity per active item (batches
 * in the chosen place, or all batches). Counting writes one line at a time, so
 * a phone can drop offline and retry. Commit is one transaction: it compares
 * each line with the snapshot, applies the variance through the stock engine
 * and closes the session. The count is deliberately not a blind absolute set:
 * if stock moved while counting, the user confirms and the variance is applied
 * to the current quantity, not to the stale snapshot.
 */

export interface CreateStocktakeOpts {
  houseId: string;
  userId: string;
  locationId?: string | null;
  categoryId?: string | null;
  note?: string | null;
}

const STOCKTAKE_SELECT = `
  SELECT s.*,
    COALESCE(loc.name, s.location_name) AS resolved_location_name,
    COALESCE(cat.name, s.category_name) AS resolved_category_name,
    u.name AS started_by_name,
    cu.name AS committed_by_name,
    (SELECT COUNT(*) FROM stocktake_lines l WHERE l.stocktake_id = s.id) AS line_count,
    (SELECT COUNT(*) FROM stocktake_lines l WHERE l.stocktake_id = s.id AND l.counted_qty IS NOT NULL) AS counted_count,
    (SELECT COUNT(*) FROM stocktake_lines l
       WHERE l.stocktake_id = s.id AND l.counted_qty IS NOT NULL AND l.counted_qty <> l.expected_qty) AS variance_count
  FROM stocktakes s
  LEFT JOIN locations loc ON loc.id = s.location_id AND loc.house_id = s.house_id
  LEFT JOIN categories cat ON cat.id = s.category_id AND cat.house_id = s.house_id
  LEFT JOIN users u ON u.id = s.started_by
  LEFT JOIN users cu ON cu.id = s.committed_by
`;

const LINE_SELECT = `
  SELECT l.*, i.name AS item_name, i.unit AS item_unit, i.category_id AS item_category_id,
    u.name AS counted_by_name
  FROM stocktake_lines l
  JOIN items i ON i.id = l.item_id AND i.house_id = l.house_id
  LEFT JOIN users u ON u.id = l.counted_by
`;

/** Quantities for a set of items in the session scope (a place, or the house). */
async function rawScopedQuantities(houseId: string, itemIds: string[], locationId: string | null): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!itemIds.length) return result;
  const placeholders = itemIds.map(() => "?").join(", ");
  const rows = await all<{ item_id: string; q: number }>(
    `SELECT item_id, SUM(quantity) AS q FROM stock_lots
      WHERE house_id = ? AND item_id IN (${placeholders})
        ${locationId ? "AND location_id = ?" : ""}
      GROUP BY item_id`,
    [houseId, ...itemIds, ...(locationId ? [locationId] : [])],
  );
  for (const row of rows) result.set(String(row.item_id), round(Number(row.q ?? 0)));
  return result;
}

/**
 * What is physically on the shelf: the counted quantity minus what is lent out.
 * Lending does not move stock, so a lent unit is still on hand but not where the
 * counter is looking; expecting it would book a shortage and make it vanish from
 * the books. In a place count this only applies when all of the item's stock is
 * in that place, since otherwise there is no telling where the lent unit came from.
 */
async function adjustForLoans(houseId: string, locationId: string | null, scoped: Map<string, number>): Promise<Map<string, number>> {
  const ids = [...scoped.keys()];
  if (!ids.length) return scoped;
  const placeholders = ids.map(() => "?").join(", ");
  const loanRows = await all<{ item_id: string; q: number }>(
    `SELECT item_id, SUM(quantity - returned_quantity) AS q FROM item_loans
      WHERE house_id = ? AND returned_at IS NULL AND item_id IN (${placeholders}) GROUP BY item_id`,
    [houseId, ...ids],
  );
  if (!loanRows.length) return scoped;
  const total = locationId ? await rawScopedQuantities(houseId, ids, null) : scoped;
  const out = new Map(scoped);
  for (const row of loanRows) {
    const id = String(row.item_id);
    const loaned = round(Number(row.q ?? 0));
    const here = scoped.get(id) ?? 0;
    const allHere = !locationId || here >= (total.get(id) ?? 0) - 1e-9;
    if (loaned > 0 && allHere) out.set(id, round(Math.max(0, here - Math.min(loaned, here))));
  }
  return out;
}

async function scopedQuantities(houseId: string, itemIds: string[], locationId: string | null): Promise<Map<string, number>> {
  return await adjustForLoans(houseId, locationId, await rawScopedQuantities(houseId, itemIds, locationId));
}

async function stocktakeRow(houseId: string, stocktakeId: string) {
  return await get<any>(`${STOCKTAKE_SELECT} WHERE s.id = ? AND s.house_id = ?`, [stocktakeId, houseId]);
}

export async function createStocktake(opts: CreateStocktakeOpts): Promise<string> {
  const locationId = opts.locationId ? String(opts.locationId) : null;
  const categoryId = opts.categoryId ? String(opts.categoryId) : null;
  if (locationId && categoryId) throw new ApiError(400, "Choose either a place or a category, not both");
  return await tx(async (session) => {
    if (locationId && !await session.get("SELECT id FROM locations WHERE id = ? AND house_id = ?", [locationId, opts.houseId])) {
      throw new ApiError(400, "Location does not exist in this house");
    }
    if (categoryId && !await session.get("SELECT id FROM categories WHERE id = ? AND house_id = ?", [categoryId, opts.houseId])) {
      throw new ApiError(400, "Category does not exist in this house");
    }
    const open = await session.get<{ id: string }>(
      "SELECT id FROM stocktakes WHERE house_id = ? AND status = 'draft' ORDER BY created_at LIMIT 1",
      [opts.houseId],
    );
    if (open) {
      throw new ApiError(409, "A stocktake is already open for this house", { stocktakeId: open.id });
    }

    // A place scope lists what is actually there; a category or house count
    // also lists zero-quantity items so a surprise find can be recorded.
    const items = await session.all<any>(
      `SELECT i.* FROM items i
        WHERE i.house_id = ? AND i.archived = 0
          ${categoryId ? "AND i.category_id = ?" : ""}
          ${locationId ? "AND EXISTS (SELECT 1 FROM stock_lots l WHERE l.item_id = i.id AND l.location_id = ? AND l.quantity > 0)" : ""}
        ORDER BY LOWER(i.name), i.name`,
      [opts.houseId, ...(categoryId ? [categoryId] : []), ...(locationId ? [locationId] : [])],
    );
    if (!items.length) throw new ApiError(400, "There is nothing to count in this selection");

    const quantityRows = await session.all<{ item_id: string; q: number; value: number; priced: number }>(
      `SELECT item_id, SUM(quantity) AS q,
         SUM(quantity * COALESCE(unit_price, 0)) AS value,
         SUM(CASE WHEN unit_price IS NOT NULL AND unit_price > 0 THEN quantity ELSE 0 END) AS priced
       FROM stock_lots WHERE house_id = ? ${locationId ? "AND location_id = ?" : ""} GROUP BY item_id`,
      [opts.houseId, ...(locationId ? [locationId] : [])],
    );
    const expected = new Map<string, { quantity: number; unitCost: number | null }>();
    for (const row of quantityRows) {
      const priced = Number(row.priced ?? 0);
      expected.set(String(row.item_id), {
        quantity: round(Number(row.q ?? 0)),
        unitCost: priced > 0 ? round(Number(row.value ?? 0) / priced, 4) : null,
      });
    }
    // Expect what is on the shelf, not what is lent out.
    const shelf = await adjustForLoans(
      opts.houseId,
      locationId,
      new Map([...expected].map(([id, value]) => [id, value.quantity])),
    );
    for (const [id, quantity] of shelf) {
      const entry = expected.get(id);
      if (entry) entry.quantity = quantity;
    }

    const id = newId("stk");
    const stamp = now();
    const locationName = locationId
      ? String((await session.get<{ name: string }>("SELECT name FROM locations WHERE id = ?", [locationId]))?.name ?? "")
      : null;
    const categoryName = categoryId
      ? String((await session.get<{ name: string }>("SELECT name FROM categories WHERE id = ?", [categoryId]))?.name ?? "")
      : null;
    await session.run(
      `INSERT INTO stocktakes (id, house_id, location_id, category_id, location_name, category_name, status, note,
         started_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      [id, opts.houseId, locationId, categoryId, locationName, categoryName, opts.note ?? null, opts.userId, stamp],
    );
    for (const item of items) {
      const snapshot = expected.get(String(item.id));
      await session.run(
        `INSERT INTO stocktake_lines (id, stocktake_id, house_id, item_id, expected_qty, unit_cost, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newId("stl"), id, opts.houseId, item.id, snapshot?.quantity ?? 0, snapshot?.unitCost ?? null, stamp],
      );
    }
    return id;
  });
}

export async function listStocktakes(houseId: string, limit = 50) {
  const rows = await all<any>(
    `${STOCKTAKE_SELECT} WHERE s.house_id = ? ORDER BY s.created_at DESC LIMIT ?`,
    [houseId, limit],
  );
  return rows.map((row) => serializeStocktake(row));
}

export async function stocktakeDetail(houseId: string, stocktakeId: string) {
  const row = await stocktakeRow(houseId, stocktakeId);
  if (!row) throw new ApiError(404, "Stocktake not found");
  const lineRows = await all<any>(
    `${LINE_SELECT} WHERE l.stocktake_id = ? AND l.house_id = ? ORDER BY LOWER(i.name), i.name`,
    [stocktakeId, houseId],
  );
  const current =
    row.status === "draft"
      ? await scopedQuantities(houseId, lineRows.map((line) => String(line.item_id)), row.location_id ?? null)
      : new Map<string, number>();
  const lines = lineRows.map((line) =>
    serializeStocktakeLine(line, row.status === "draft" ? (current.get(String(line.item_id)) ?? 0) : null),
  );
  return serializeStocktake(row, lines);
}

export async function updateStocktakeLine(opts: {
  houseId: string;
  stocktakeId: string;
  lineId: string;
  userId: string;
  countedQty?: number | null;
  note?: string | null;
}) {
  const session = await stocktakeRow(opts.houseId, opts.stocktakeId);
  if (!session) throw new ApiError(404, "Stocktake not found");
  if (session.status !== "draft") throw new ApiError(409, "This stocktake is no longer open");
  const line = await get<any>(
    `${LINE_SELECT} WHERE l.id = ? AND l.stocktake_id = ? AND l.house_id = ?`,
    [opts.lineId, opts.stocktakeId, opts.houseId],
  );
  if (!line) throw new ApiError(404, "Stocktake line not found");

  let counted = line.counted_qty == null ? null : Number(line.counted_qty);
  let countedBy = line.counted_by ?? null;
  let countedAt = line.counted_at ?? null;
  if (opts.countedQty !== undefined) {
    if (opts.countedQty == null) {
      counted = null;
      countedBy = null;
      countedAt = null;
    } else {
      counted = round(Number(opts.countedQty));
      if (!Number.isFinite(counted) || counted < 0) throw new ApiError(400, "Count must be zero or more");
      countedBy = opts.userId;
      countedAt = now();
    }
  }
  // Write only what this request carries. Rewriting every column from the row
  // read above would let a count save overwrite a note saved a moment earlier
  // by another request (and the other way round).
  const sets: string[] = [];
  const values: unknown[] = [];
  if (opts.countedQty !== undefined) {
    sets.push("counted_qty = ?", "counted_by = ?", "counted_at = ?");
    values.push(counted, countedBy, countedAt);
  }
  if (opts.note !== undefined) {
    sets.push("note = ?");
    values.push(opts.note);
  }
  if (!sets.length) throw new ApiError(400, "Nothing to update");
  const updated = await run(
    `UPDATE stocktake_lines SET ${sets.join(", ")}
      WHERE id = ? AND stocktake_id = ? AND house_id = ?
        AND EXISTS (SELECT 1 FROM stocktakes s WHERE s.id = ? AND s.status = 'draft')`,
    [...values, opts.lineId, opts.stocktakeId, opts.houseId, opts.stocktakeId],
  );
  if (!updated.changes) throw new ApiError(409, "This stocktake is no longer open");
  const quantities = await scopedQuantities(opts.houseId, [String(line.item_id)], session.location_id ?? null);
  const refreshed = await get<any>(
    `${LINE_SELECT} WHERE l.id = ? AND l.stocktake_id = ? AND l.house_id = ?`,
    [opts.lineId, opts.stocktakeId, opts.houseId],
  );
  return serializeStocktakeLine(refreshed, quantities.get(String(line.item_id)) ?? 0);
}

export async function commitStocktake(opts: {
  houseId: string;
  stocktakeId: string;
  userId: string;
  lineIds?: string[];
  confirmChangedLineIds?: string[];
}): Promise<StocktakeCommitResult> {
  const outcome = await tx(async (session: DatabaseSession) => {
    await lockHouseholdLedger(session, opts.houseId);
    const row = await session.get<any>(
      "SELECT * FROM stocktakes WHERE id = ? AND house_id = ?",
      [opts.stocktakeId, opts.houseId],
    );
    if (!row) throw new ApiError(404, "Stocktake not found");
    if (row.status === "committed") {
      throw new ApiError(409, "This stocktake is already committed", { status: row.status });
    }
    if (row.status !== "draft") {
      throw new ApiError(409, "This stocktake was cancelled", { status: row.status });
    }
    if (!row.location_id && row.location_name) {
      throw new ApiError(409, "The place for this stocktake was deleted");
    }
    const lines = await session.all<any>(
      "SELECT * FROM stocktake_lines WHERE stocktake_id = ? AND house_id = ? ORDER BY created_at",
      [opts.stocktakeId, opts.houseId],
    );
    const wanted = opts.lineIds ? new Set(opts.lineIds) : null;
    const selected = lines.filter(
      (line) => line.counted_qty != null && (!wanted || wanted.has(String(line.id))),
    );
    if (!selected.length) throw new ApiError(400, "Count at least one line before committing");

    const itemIds = [...new Set(selected.map((line) => String(line.item_id)))];
    const placeholders = itemIds.map(() => "?").join(", ");
    const currentRows = await session.all<{ item_id: string; q: number }>(
      `SELECT item_id, SUM(quantity) AS q FROM stock_lots
        WHERE house_id = ? AND item_id IN (${placeholders}) ${row.location_id ? "AND location_id = ?" : ""}
        GROUP BY item_id`,
      [opts.houseId, ...itemIds, ...(row.location_id ? [row.location_id] : [])],
    );
    const current = await adjustForLoans(
      opts.houseId,
      row.location_id ?? null,
      new Map(currentRows.map((entry) => [String(entry.item_id), round(Number(entry.q ?? 0))])),
    );
    const changed = selected.filter(
      (line) => round(Number(current.get(String(line.item_id)) ?? 0)) !== round(Number(line.expected_qty ?? 0)),
    );
    const confirmed = new Set(opts.confirmChangedLineIds ?? []);
    const unconfirmed = changed.filter((line) => !confirmed.has(String(line.id)));
    if (unconfirmed.length) {
      throw new ApiError(
        409,
        "Some stock changed since this count started. Confirm the changed lines to commit.",
        { code: "changed-since-snapshot", changedLineIds: unconfirmed.map((line) => String(line.id)) },
      );
    }

    let appliedDelta = 0;
    for (const line of selected) {
      const delta = round(Number(line.counted_qty) - Number(line.expected_qty ?? 0));
      const result = await applyStockCount({
        itemId: String(line.item_id),
        houseId: opts.houseId,
        userId: opts.userId,
        delta,
        locationId: row.location_id ?? null,
        note: `stocktake ${opts.stocktakeId}`,
      });
      appliedDelta = round(appliedDelta + result.applied);
      await session.run("UPDATE stocktake_lines SET committed_delta = ? WHERE id = ?", [result.applied, line.id]);
    }
    const stamp = now();
    await session.run(
      "UPDATE stocktakes SET status = 'committed', committed_by = ?, committed_at = ? WHERE id = ? AND house_id = ?",
      [opts.userId, stamp, opts.stocktakeId, opts.houseId],
    );
    return { itemIds: [...new Set(selected.map((line) => String(line.item_id)))], appliedLines: selected.length, appliedDelta };
  });

  for (const itemId of outcome.itemIds) await afterStockChange(itemId);
  return {
    stocktake: await stocktakeDetail(opts.houseId, opts.stocktakeId),
    appliedLines: outcome.appliedLines,
    appliedDelta: outcome.appliedDelta,
  };
}

export async function cancelStocktake(opts: { houseId: string; stocktakeId: string }): Promise<void> {
  const row = await stocktakeRow(opts.houseId, opts.stocktakeId);
  if (!row) throw new ApiError(404, "Stocktake not found");
  if (row.status !== "draft") throw new ApiError(409, "This stocktake is no longer open");
  const result = await run(
    "UPDATE stocktakes SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND house_id = ? AND status = 'draft'",
    [now(), opts.stocktakeId, opts.houseId],
  );
  if (!result.changes) throw new ApiError(409, "This stocktake is no longer open");
}
