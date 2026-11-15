import { all, get, now, newId, run, tx } from "../db.js";
import { ApiError } from "../http.js";
import { convert, pricePerUnit, round } from "../units.js";
import { syncItemLowStock } from "./notifications.js";

export interface StockOpts {
  itemId: string;
  houseId: string;
  userId: string;
  quantity: number;
  unit?: string;
  unitPrice?: number | null;
  currency?: string | null;
  locationId?: string | null;
  lotId?: string | null;
  expiresAt?: string | null;
  purchasedAt?: string | null;
  note?: string | null;
  reason?: string | null;
  vendorId?: string | null;
  receiptId?: string | null;
  portions?: number | null;
  cookedOn?: string | null;
  frozenOn?: string | null;
  thawedOn?: string | null;
  sourceRecipeId?: string | null;
}

async function itemRow(itemId: string, houseId: string) {
  const item = await get<any>("SELECT * FROM items WHERE id = ? AND house_id = ?", [itemId, houseId]);
  if (!item) throw new ApiError(404, "Item not found");
  return item;
}

async function validateLocation(houseId: string, locationId?: string | null) {
  if (locationId && !await get("SELECT id FROM locations WHERE id = ? AND house_id = ?", [locationId, houseId])) {
    throw new ApiError(400, "Location does not exist in this house");
  }
}

/** Units that are counted one by one, where a portion is one unit. */
function countedUnit(unit: string): boolean {
  return ["pcs", "pc", "piece", "pieces"].includes(unit.toLowerCase());
}

function baseQuantity(item: any, quantity: number, unit?: string): number {
  const from = (unit ?? item.unit).toLowerCase();
  const amount = convert(Math.abs(quantity), from, item.unit);
  if (amount == null) {
    throw new ApiError(400, `Cannot convert ${from} to ${item.unit}`);
  }
  return round(amount);
}

export async function itemQuantity(itemId: string): Promise<number> {
  const row = await get<{ q: number }>(
    "SELECT COALESCE(SUM(quantity), 0) AS q FROM stock_lots WHERE item_id = ?",
    [itemId],
  );
  return round(Number(row?.q ?? 0));
}

async function recordMovement(opts: {
  item: any;
  type: "in" | "out" | "adjust" | "waste" | "move";
  delta: number;
  unit: string;
  quantity: number;
  unitPrice?: number | null;
  normalizedPrice?: number | null;
  locationId?: string | null;
  userId: string;
  lotId?: string | null;
  vendorId?: string | null;
  receiptId?: string | null;
  reason?: string | null;
  note?: string | null;
}): Promise<string> {
  const id = newId("mov");
  const balance = await itemQuantity(opts.item.id);
  await run(
    `INSERT INTO stock_movements
      (id, item_id, lot_id, house_id, type, delta, unit, quantity, unit_price, normalized_price,
       location_id, user_id, vendor_id, receipt_id, reason, note, balance_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.item.id,
      opts.lotId ?? null,
      opts.item.house_id,
      opts.type,
      opts.delta,
      opts.unit,
      opts.quantity,
      opts.unitPrice ?? null,
      opts.normalizedPrice ?? null,
      opts.locationId ?? null,
      opts.userId,
      opts.vendorId ?? null,
      opts.receiptId ?? null,
      opts.reason ?? null,
      opts.note ?? null,
      balance,
      now(),
    ],
  );
  await run("UPDATE items SET updated_at = ? WHERE id = ?", [now(), opts.item.id]);
  return id;
}

export async function addStock(opts: StockOpts): Promise<string> {
  await validateLocation(opts.houseId, opts.locationId);
  if (!Number.isFinite(opts.quantity) || opts.quantity <= 0) {
    throw new ApiError(400, "Quantity must be greater than zero");
  }
  return await tx(async () => {
    const item = await itemRow(opts.itemId, opts.houseId);
    const qty = baseQuantity(item, opts.quantity, opts.unit);
    const price =
      opts.unitPrice != null && Number.isFinite(opts.unitPrice) && opts.unitPrice >= 0
        ? Number(opts.unitPrice)
        : null;
    const normalized = price == null ? null : pricePerUnit(price, opts.unit ?? item.unit, item.unit);
    const lotId = newId("lot");
    await run(
      `INSERT INTO stock_lots
        (id, item_id, house_id, location_id, quantity, unit, unit_price, currency, purchased_at, expires_at, note,
         vendor_id, receipt_id, portions, cooked_on, frozen_on, thawed_on, source_recipe_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        lotId,
        item.id,
        item.house_id,
        opts.locationId ?? null,
        qty,
        item.unit,
        normalized,
        opts.currency ?? null,
        opts.purchasedAt ?? now(),
        opts.expiresAt ?? null,
        opts.note ?? null,
        opts.vendorId ?? null,
        opts.receiptId ?? null,
        opts.portions ?? null,
        opts.cookedOn ?? null,
        opts.frozenOn ?? null,
        opts.thawedOn ?? null,
        opts.sourceRecipeId ?? null,
        opts.userId,
        now(),
      ],
    );
    const movementId = await recordMovement({
      item,
      type: "in",
      delta: qty,
      unit: opts.unit ?? item.unit,
      quantity: qty,
      unitPrice: price,
      normalizedPrice: normalized,
      locationId: opts.locationId ?? null,
      userId: opts.userId,
      lotId,
      vendorId: opts.vendorId ?? null,
      receiptId: opts.receiptId ?? null,
      reason: opts.reason ?? "Stock added",
      note: opts.note ?? null,
    });
    return movementId;
  });
}

/** Consume stock FIFO (oldest expiry first, then oldest purchase). */
export async function removeStock(opts: StockOpts & { waste?: boolean }): Promise<string> {
  await validateLocation(opts.houseId, opts.locationId);
  const requested = baseQuantity(
    { unit: (await itemRow(opts.itemId, opts.houseId)).unit },
    opts.quantity,
    opts.unit,
  );
  if (requested <= 0) throw new ApiError(400, "Quantity must be greater than zero");

  return await tx(async () => {
    const item = await itemRow(opts.itemId, opts.houseId);
    const available = await itemQuantity(item.id);
    if (available < requested) {
      throw new ApiError(400, `Only ${available} ${item.unit} of ${item.name} in stock`);
    }
    let remaining = requested;
    const lots = await all<any>(
      `SELECT * FROM stock_lots WHERE item_id = ? AND quantity > 0
         ${opts.locationId ? "AND location_id = ?" : ""}
         ${opts.lotId ? "AND id = ?" : ""}
       ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at ASC, created_at ASC`,
      [opts.itemId, ...(opts.locationId ? [opts.locationId] : []), ...(opts.lotId ? [opts.lotId] : [])],
    );
    const scoped = lots.reduce((sum, l) => sum + Number(l.quantity), 0);
    if (scoped < requested) {
      throw new ApiError(
        400,
        opts.locationId
          ? `Only ${round(scoped)} ${item.unit} at that location. Try removing from another location.`
          : `Only ${round(scoped)} ${item.unit} available`,
      );
    }
    // Keep the value of what was consumed or wasted: the weighted average of
    // the lots it came from, expressed per item unit.
    let priced = 0;
    let value = 0;
    for (const lot of lots) {
      if (remaining <= 0) break;
      const take = Math.min(Number(lot.quantity), remaining);
      if (lot.unit_price != null && Number(lot.unit_price) >= 0) {
        priced += take;
        value += take * Number(lot.unit_price);
      }
      const before = Number(lot.quantity);
      const after = round(before - take);
      if (lot.portions == null) {
        await run("UPDATE stock_lots SET quantity = ? WHERE id = ?", [after, lot.id]);
      } else {
        // Portions are a serving count, not the item unit. Shrink them in the
        // same proportion as the quantity so a frozen batch never claims more
        // portions than it still holds.
        const portions = before > 0 ? round((Number(lot.portions) * after) / before) : 0;
        await run("UPDATE stock_lots SET quantity = ?, portions = ? WHERE id = ?", [after, portions, lot.id]);
      }
      remaining = round(remaining - take);
    }
    const normalizedPrice = priced > 0 ? round(value / priced, 4) : null;
    return await recordMovement({
      item,
      type: opts.waste ? "waste" : "out",
      delta: -requested,
      unit: opts.unit ?? item.unit,
      quantity: requested,
      unitPrice: normalizedPrice == null ? null : pricePerUnit(normalizedPrice, item.unit, opts.unit ?? item.unit),
      normalizedPrice,
      locationId: opts.locationId ?? null,
      userId: opts.userId,
      reason: opts.reason ?? (opts.waste ? "Wasted" : "Consumed"),
      note: opts.note ?? null,
    });
  });
}

/** Set an absolute quantity (stock count correction). */
export async function setStock(opts: StockOpts & { target: number }): Promise<string> {
  await validateLocation(opts.houseId, opts.locationId);
  const item = await itemRow(opts.itemId, opts.houseId);
  const target = round(Number(opts.target));
  if (!Number.isFinite(target) || target < 0) throw new ApiError(400, "Target quantity must be zero or more");
  const current = await itemQuantity(item.id);
  const delta = round(target - current);
  if (delta === 0) {
    throw new ApiError(400, "Stock already matches that count");
  }
  return await tx(async () => {
    if (delta > 0) {
      const price =
        opts.unitPrice != null && Number.isFinite(opts.unitPrice) && opts.unitPrice > 0
          ? Number(opts.unitPrice)
          : null;
      const normalized = price == null ? null : pricePerUnit(price, opts.unit ?? item.unit, item.unit);
      const lotId = newId("lot");
      await run(
        `INSERT INTO stock_lots
          (id, item_id, house_id, location_id, quantity, unit, unit_price, currency, purchased_at, expires_at, note,
           vendor_id, receipt_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          lotId,
          item.id,
          item.house_id,
          opts.locationId ?? null,
          delta,
          item.unit,
          normalized,
          opts.currency ?? null,
          opts.purchasedAt ?? now(),
          opts.expiresAt ?? null,
          opts.note ?? "Count correction",
          opts.vendorId ?? null,
          opts.receiptId ?? null,
          opts.userId,
          now(),
        ],
      );
      return await recordMovement({
        item,
        type: "adjust",
        delta,
        unit: item.unit,
        quantity: Math.abs(delta),
        unitPrice: price,
        normalizedPrice: normalized,
        locationId: opts.locationId ?? null,
        userId: opts.userId,
        lotId,
        vendorId: opts.vendorId ?? null,
        receiptId: opts.receiptId ?? null,
        reason: opts.reason ?? "Count correction",
      });
    }
    let remaining = Math.abs(delta);
    const lots = await all<any>(
      "SELECT * FROM stock_lots WHERE item_id = ? AND quantity > 0 ORDER BY expires_at IS NULL, expires_at ASC, created_at ASC",
      [item.id],
    );
    for (const lot of lots) {
      if (remaining <= 0) break;
      const take = Math.min(Number(lot.quantity), remaining);
      const before = Number(lot.quantity);
      const after = round(before - take);
      if (lot.portions == null) {
        await run("UPDATE stock_lots SET quantity = ? WHERE id = ?", [after, lot.id]);
      } else {
        const portions = before > 0 ? round((Number(lot.portions) * after) / before) : 0;
        await run("UPDATE stock_lots SET quantity = ?, portions = ? WHERE id = ?", [after, portions, lot.id]);
      }
      remaining = round(remaining - take);
    }
    return await recordMovement({
      item,
      type: "adjust",
      delta: -Math.abs(delta),
      unit: item.unit,
      quantity: Math.abs(delta),
      userId: opts.userId,
      reason: opts.reason ?? "Count correction",
      note: opts.note ?? null,
    });
  });
}

/** Move stock between locations inside the same house. */
export async function moveStock(opts: { itemId: string; houseId: string; userId: string; quantity: number; unit?: string; fromLocationId: string; toLocationId: string; note?: string }): Promise<string> {
  if (!opts.fromLocationId || !opts.toLocationId || opts.fromLocationId === opts.toLocationId) {
    throw new ApiError(400, "Pick two different locations");
  }
  await validateLocation(opts.houseId, opts.fromLocationId);
  await validateLocation(opts.houseId, opts.toLocationId);
  return await tx(async () => {
    const item = await itemRow(opts.itemId, opts.houseId);
    const requested = baseQuantity(item, opts.quantity, opts.unit);
    if (requested <= 0) throw new ApiError(400, "Quantity must be greater than zero");
    const lots = await all<any>(
      "SELECT * FROM stock_lots WHERE item_id = ? AND location_id = ? AND quantity > 0 ORDER BY created_at ASC",
      [item.id, opts.fromLocationId],
    );
    const available = round(lots.reduce((sum, l) => sum + Number(l.quantity), 0));
    if (available < requested) throw new ApiError(400, `Only ${available} ${item.unit} at the source location`);
    let remaining = requested;
    for (const lot of lots) {
      if (remaining <= 0) break;
      const take = Math.min(Number(lot.quantity), remaining);
      await run("UPDATE stock_lots SET quantity = ? WHERE id = ?", [round(Number(lot.quantity) - take), lot.id]);
      await run(
        `INSERT INTO stock_lots
          (id, item_id, house_id, location_id, quantity, unit, unit_price, currency, purchased_at, expires_at, opened_at, note,
           vendor_id, receipt_id, portions, cooked_on, frozen_on, thawed_on, source_recipe_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId("lot"),
          item.id,
          item.house_id,
          opts.toLocationId,
          take,
          item.unit,
          lot.unit_price,
          lot.currency,
          lot.purchased_at,
          lot.expires_at,
          lot.opened_at,
          lot.note,
          lot.vendor_id ?? null,
          lot.receipt_id ?? null,
          lot.portions == null ? null : round((Number(lot.portions) * take) / Number(lot.quantity)),
          lot.cooked_on ?? null,
          lot.frozen_on ?? null,
          lot.thawed_on ?? null,
          lot.source_recipe_id ?? null,
          opts.userId,
          now(),
        ],
      );
      remaining = round(remaining - take);
    }
    return await recordMovement({
      item,
      type: "move",
      delta: 0,
      unit: item.unit,
      quantity: requested,
      locationId: opts.toLocationId,
      userId: opts.userId,
      reason: "Moved between locations",
      note: opts.note ?? null,
    });
  });
}

/**
 * Freeze all or part of a batch. A partial freeze splits the lot, keeping the
 * price, vendor and receipt provenance on both halves, and records one `move`
 * movement. Freezing is refused on a thawed batch: refreezing is not offered.
 */
export async function freezeStock(opts: {
  itemId: string;
  houseId: string;
  userId: string;
  lotId: string;
  portions?: number | null;
  locationId?: string | null;
  frozenOn?: string | null;
  cookedOn?: string | null;
  sourceRecipeId?: string | null;
  note?: string | null;
}): Promise<string> {
  await validateLocation(opts.houseId, opts.locationId);
  return await tx(async () => {
    const item = await itemRow(opts.itemId, opts.houseId);
    const lot = await get<any>("SELECT * FROM stock_lots WHERE id = ? AND item_id = ? AND house_id = ?", [opts.lotId, item.id, item.house_id]);
    if (!lot) throw new ApiError(404, "Batch not found");
    if (Number(lot.quantity) <= 0) throw new ApiError(400, "This batch is empty");
    if (lot.thawed_on) throw new ApiError(400, "A thawed batch cannot be frozen again");
    if (lot.frozen_on) throw new ApiError(400, "This batch is already frozen");
    const available = Number(lot.quantity);
    const portions = round(opts.portions ?? (countedUnit(item.unit) ? available : 1));
    if (!Number.isFinite(portions) || portions <= 0) throw new ApiError(400, "Portions must be greater than zero");
    // A count batch is frozen piece by piece, so the portion count is also the
    // quantity moved. A weighed batch is frozen whole and the count only labels
    // how many equal portions it holds.
    const counted = countedUnit(item.unit);
    if (counted && portions > available + 1e-9) throw new ApiError(400, `Only ${round(available)} ${item.unit} in this batch`);
    const quantityToFreeze = counted ? portions : available;
    const frozenOn = opts.frozenOn ?? new Date().toISOString().slice(0, 10);
    const locationId = opts.locationId === undefined ? lot.location_id : opts.locationId;
    const cookedOn = opts.cookedOn ?? lot.cooked_on ?? null;
    const sourceRecipeId = opts.sourceRecipeId ?? lot.source_recipe_id ?? null;
    const note = opts.note ?? lot.note ?? null;
    const remaining = round(available - quantityToFreeze);

    let frozenLotId = lot.id;
    if (remaining <= 0) {
      await run(
        `UPDATE stock_lots SET location_id = ?, frozen_on = ?, thawed_on = NULL, portions = ?, cooked_on = ?,
           source_recipe_id = ?, note = ? WHERE id = ?`,
        [locationId ?? null, frozenOn, portions, cookedOn, sourceRecipeId, note, lot.id],
      );
    } else {
      const leftPortions = lot.portions == null
        ? (counted ? remaining : null)
        : round((Number(lot.portions) * remaining) / available);
      await run("UPDATE stock_lots SET quantity = ?, portions = ? WHERE id = ?", [remaining, leftPortions, lot.id]);
      frozenLotId = newId("lot");
      await run(
        `INSERT INTO stock_lots
          (id, item_id, house_id, location_id, quantity, unit, unit_price, currency, purchased_at, expires_at,
           opened_at, note, vendor_id, receipt_id, portions, cooked_on, frozen_on, thawed_on, source_recipe_id,
           created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        [
          frozenLotId,
          item.id,
          item.house_id,
          locationId ?? null,
          quantityToFreeze,
          item.unit,
          lot.unit_price,
          lot.currency,
          lot.purchased_at,
          lot.expires_at,
          lot.opened_at,
          note,
          lot.vendor_id ?? null,
          lot.receipt_id ?? null,
          portions,
          cookedOn,
          frozenOn,
          sourceRecipeId,
          opts.userId,
          now(),
        ],
      );
    }
    await recordMovement({
      item,
      type: "move",
      delta: 0,
      unit: item.unit,
      quantity: quantityToFreeze,
      locationId: locationId ?? null,
      userId: opts.userId,
      lotId: frozenLotId,
      reason: "Frozen",
      note: note ?? null,
    });
    return frozenLotId;
  });
}

/** Mark a frozen batch thawed so the short thaw window drives expiry. */
export async function thawStock(opts: {
  itemId: string;
  houseId: string;
  userId: string;
  lotId: string;
  thawedOn?: string | null;
  locationId?: string | null;
}): Promise<void> {
  await validateLocation(opts.houseId, opts.locationId);
  await tx(async () => {
    const item = await itemRow(opts.itemId, opts.houseId);
    const lot = await get<any>("SELECT * FROM stock_lots WHERE id = ? AND item_id = ? AND house_id = ?", [opts.lotId, item.id, item.house_id]);
    if (!lot) throw new ApiError(404, "Batch not found");
    if (!lot.frozen_on) throw new ApiError(400, "This batch is not frozen");
    if (lot.thawed_on) throw new ApiError(400, "This batch is already thawed");
    if (Number(lot.quantity) <= 0) throw new ApiError(400, "This batch is empty");
    const thawedOn = opts.thawedOn ?? new Date().toISOString().slice(0, 10);
    await run(
      "UPDATE stock_lots SET thawed_on = ?, location_id = ? WHERE id = ?",
      [thawedOn, opts.locationId === undefined ? lot.location_id : opts.locationId, lot.id],
    );
    await recordMovement({
      item,
      type: "move",
      delta: 0,
      unit: item.unit,
      quantity: Number(lot.quantity),
      locationId: opts.locationId === undefined ? lot.location_id : opts.locationId,
      userId: opts.userId,
      lotId: lot.id,
      reason: "Thawed",
      note: "Thawed",
    });
  });
}

/**
 * Take portions out of a frozen batch. Consumption goes through removeStock so
 * the ledger and value stay consistent. `thaw` also marks what is left in the
 * batch thawed, for the common "take the whole box out to defrost" case.
 */
export async function takeOutPortions(opts: {
  itemId: string;
  houseId: string;
  userId: string;
  lotId: string;
  portions?: number;
  thaw?: boolean;
}): Promise<void> {
  await tx(async () => {
    const item = await itemRow(opts.itemId, opts.houseId);
    const lot = await get<any>("SELECT * FROM stock_lots WHERE id = ? AND item_id = ? AND house_id = ?", [opts.lotId, item.id, item.house_id]);
    if (!lot) throw new ApiError(404, "Batch not found");
    if (!lot.frozen_on) throw new ApiError(400, "This batch is not frozen");
    const portions = round(opts.portions ?? 1);
    if (!Number.isFinite(portions) || portions <= 0) throw new ApiError(400, "Portions must be greater than zero");
    const available = Number(lot.quantity);
    if (available <= 0) throw new ApiError(400, "This batch is empty");
    const totalPortions = lot.portions == null ? available : Number(lot.portions);
    if (portions > totalPortions + 1e-9) throw new ApiError(400, `Only ${round(totalPortions)} portions in this batch`);
    // One portion is an equal share of the batch, so a 500 g batch frozen as
    // five portions takes out 100 g rather than one gram.
    const quantity = round(Math.min(available, (available / totalPortions) * portions));
    await removeStock({
      itemId: item.id,
      houseId: item.house_id,
      userId: opts.userId,
      quantity,
      unit: item.unit,
      lotId: lot.id,
      reason: "Taken out of the freezer",
    });
    if (opts.thaw) {
      const after = await get<any>("SELECT quantity, thawed_on FROM stock_lots WHERE id = ?", [lot.id]);
      if (!after || Number(after.quantity) <= 0 || after.thawed_on) return;
      await run("UPDATE stock_lots SET thawed_on = ? WHERE id = ?", [new Date().toISOString().slice(0, 10), lot.id]);
      await recordMovement({
        item,
        type: "move",
        delta: 0,
        unit: item.unit,
        quantity: Number(after.quantity),
        locationId: lot.location_id ?? null,
        userId: opts.userId,
        lotId: lot.id,
        reason: "Thawed",
        note: "Taken out of the freezer to thaw",
      });
    }
  });
}

/**
 * Take back what a receipt added: every lot created by the receipt (including
 * parts moved to another place, which keep their receipt link) is emptied and
 * one adjustment movement per item is recorded. Quantity that was already
 * used is left alone and reported as consumed. Call inside the transaction
 * that deletes the receipt, and run `afterStockChange` for the items after.
 */
export async function revertReceiptStock(opts: {
  receiptId: string;
  houseId: string;
  userId: string;
  reason?: string;
}): Promise<{ itemId: string; itemName: string; unit: string; added: number; reverted: number; consumed: number }[]> {
  return await tx(async () => {
    const lots = await all<any>(
      "SELECT * FROM stock_lots WHERE receipt_id = ? AND house_id = ? ORDER BY created_at ASC",
      [opts.receiptId, opts.houseId],
    );
    const addedRows = await all<{ item_id: string; added: number }>(
      `SELECT item_id, SUM(delta) AS added FROM stock_movements
       WHERE receipt_id = ? AND house_id = ? AND type = 'in' GROUP BY item_id`,
      [opts.receiptId, opts.houseId],
    );
    const added = new Map(addedRows.map((row) => [row.item_id, round(Number(row.added ?? 0))]));
    const itemIds = [...new Set([...lots.map((lot) => String(lot.item_id)), ...added.keys()])];

    const results: { itemId: string; itemName: string; unit: string; added: number; reverted: number; consumed: number }[] = [];
    for (const itemId of itemIds) {
      const item = await get<any>("SELECT * FROM items WHERE id = ? AND house_id = ?", [itemId, opts.houseId]);
      if (!item) continue;
      let remaining = 0;
      for (const lot of lots) {
        if (lot.item_id !== itemId) continue;
        const quantity = Number(lot.quantity);
        if (quantity <= 0) continue;
        remaining += quantity;
        await run("UPDATE stock_lots SET quantity = 0 WHERE id = ?", [lot.id]);
      }
      remaining = round(remaining);
      const originally = added.get(itemId) ?? remaining;
      if (remaining > 0) {
        await recordMovement({
          item,
          type: "adjust",
          delta: -remaining,
          unit: item.unit,
          quantity: remaining,
          userId: opts.userId,
          receiptId: opts.receiptId,
          reason: opts.reason ?? "Receipt deleted",
        });
      }
      results.push({
        itemId,
        itemName: String(item.name),
        unit: String(item.unit),
        added: originally,
        reverted: remaining,
        consumed: round(Math.max(0, originally - remaining)),
      });
    }
    return results;
  });
}

export async function afterStockChange(itemId: string) {
  await syncItemLowStock(itemId);
}
