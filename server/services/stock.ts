import { all, get, now, newId, run, tx } from "../db.js";
import { ApiError } from "../http.js";
import { convert, pricePerUnit, round } from "../units.js";
import { syncItemLowStock } from "./notifications.js";
import { itemAvailableToUse } from "./loans.js";
import { publishLive } from "./live.js";

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

/** One batch changed by a movement, with the signed amount it changed by. */
export interface StockLotEffect {
  lotId: string;
  delta: number;
  /** True when this movement is what created the batch. */
  created?: boolean;
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
  type: "in" | "out" | "adjust" | "waste" | "move" | "count";
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
  /** Set on a compensating movement: the movement this one reverses. */
  reversesMovementId?: string | null;
  /** Which batches this movement changes, so an undo can reverse them exactly. */
  lots?: StockLotEffect[];
}): Promise<string> {
  const id = newId("mov");
  const balance = await itemQuantity(opts.item.id);
  await run(
    `INSERT INTO stock_movements
      (id, item_id, lot_id, house_id, type, delta, unit, quantity, unit_price, normalized_price,
       location_id, user_id, vendor_id, receipt_id, reason, note, balance_after, reverses_movement_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      opts.reversesMovementId ?? null,
      now(),
    ],
  );
  for (const effect of opts.lots ?? []) {
    if (!effect.lotId || !Number.isFinite(effect.delta) || effect.delta === 0) continue;
    await run(
      `INSERT INTO stock_movement_lots
        (id, movement_id, house_id, item_id, lot_id, created_lot, delta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId("mlot"),
        id,
        opts.item.house_id,
        opts.item.id,
        effect.lotId,
        effect.created ? 1 : 0,
        round(effect.delta),
        now(),
      ],
    );
  }
  await run("UPDATE items SET updated_at = ? WHERE id = ?", [now(), opts.item.id]);
  return id;
}

export async function addStock(opts: StockOpts): Promise<string> {
  await validateLocation(opts.houseId, opts.locationId);
  if (!Number.isFinite(opts.quantity) || opts.quantity <= 0) {
    throw new ApiError(400, "Quantity must be greater than zero");
  }
  const movementId = await tx(async () => {
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
      lots: [{ lotId, delta: qty, created: true }],
    });
    return movementId;
  });
  publishLive(opts.houseId, { type: "stock", id: opts.itemId, actorUserId: opts.userId });
  return movementId;
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

  const movementId = await tx(async () => {
    const item = await itemRow(opts.itemId, opts.houseId);
    const onHand = await itemQuantity(item.id);
    const available = Math.max(0, await itemAvailableToUse(item.id));
    // Lending does not move stock, so consuming beyond on-hand minus open loans
    // would silently take units that are promised to a borrower.
    const loaned = round(onHand - available);
    if (available < requested) {
      throw new ApiError(
        400,
        loaned > 0
          ? `Only ${available} ${item.unit} of ${item.name} can be taken — ${loaned} ${item.unit} is out on loan`
          : `Only ${available} ${item.unit} of ${item.name} in stock`,
      );
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
    const touched: StockLotEffect[] = [];
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
      touched.push({ lotId: lot.id, delta: -take });
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
      lots: touched,
    });
  });
  publishLive(opts.houseId, { type: "stock", id: opts.itemId, actorUserId: opts.userId });
  return movementId;
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
  if (delta < 0) {
    // A count correction lowers the on-hand quantity; it must not drop below
    // the units that are currently out on loan.
    const loaned = round(current - Math.max(0, await itemAvailableToUse(item.id)));
    if (loaned > 0 && target < loaned) {
      throw new ApiError(
        400,
        `Cannot count below ${loaned} ${item.unit} — ${loaned} of ${item.name} is out on loan`,
      );
    }
  }
  const movementId = await tx(async () => {
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
        lots: [{ lotId, delta, created: true }],
      });
    }
    let remaining = Math.abs(delta);
    const lots = await all<any>(
      "SELECT * FROM stock_lots WHERE item_id = ? AND quantity > 0 ORDER BY expires_at IS NULL, expires_at ASC, created_at ASC",
      [item.id],
    );
    const touched: StockLotEffect[] = [];
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
      touched.push({ lotId: lot.id, delta: -take });
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
      lots: touched,
    });
  });
  publishLive(opts.houseId, { type: "stock", id: opts.itemId, actorUserId: opts.userId });
  return movementId;
}

/**
 * Apply the difference found by a physical count (stocktake). Positive deltas
 * create a batch in the counted place; negative deltas consume FIFO in that
 * place. A shortage is capped at what is actually there, so a quantity that
 * changed during the session can never push stock below zero.
 */
async function applyStockCountInner(opts: {
  itemId: string;
  houseId: string;
  userId: string;
  delta: number;
  locationId?: string | null;
  note?: string | null;
  reason?: string | null;
}): Promise<{ movementId: string | null; applied: number }> {
  await validateLocation(opts.houseId, opts.locationId);
  const delta = round(Number(opts.delta));
  if (!Number.isFinite(delta)) throw new ApiError(400, "Count difference must be a number");
  if (delta === 0) return { movementId: null, applied: 0 };
  return await tx(async () => {
    const item = await itemRow(opts.itemId, opts.houseId);
    const reason = opts.reason ?? "Stocktake";
    if (delta > 0) {
      const lotId = newId("lot");
      await run(
        `INSERT INTO stock_lots
          (id, item_id, house_id, location_id, quantity, unit, unit_price, currency, purchased_at, expires_at, note,
           created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?)`,
        [
          lotId,
          item.id,
          item.house_id,
          opts.locationId ?? null,
          delta,
          item.unit,
          now(),
          opts.note ?? "Stocktake",
          opts.userId,
          now(),
        ],
      );
      const movementId = await recordMovement({
        item,
        type: "count",
        delta,
        unit: item.unit,
        quantity: delta,
        locationId: opts.locationId ?? null,
        userId: opts.userId,
        lotId,
        reason,
        note: opts.note ?? null,
      });
      return { movementId, applied: delta };
    }
    const lots = await all<any>(
      `SELECT * FROM stock_lots WHERE item_id = ? AND quantity > 0
         ${opts.locationId ? "AND location_id = ?" : ""}
       ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at ASC, created_at ASC`,
      [opts.itemId, ...(opts.locationId ? [opts.locationId] : [])],
    );
    const available = round(lots.reduce((sum, lot) => sum + Number(lot.quantity), 0));
    const requested = round(Math.min(Math.abs(delta), available));
    if (requested <= 0) return { movementId: null, applied: 0 };
    let remaining = requested;
    for (const lot of lots) {
      if (remaining <= 0) break;
      const take = Math.min(Number(lot.quantity), remaining);
      await run("UPDATE stock_lots SET quantity = ? WHERE id = ?", [round(Number(lot.quantity) - take), lot.id]);
      remaining = round(remaining - take);
    }
    const movementId = await recordMovement({
      item,
      type: "count",
      delta: -requested,
      unit: item.unit,
      quantity: requested,
      locationId: opts.locationId ?? null,
      userId: opts.userId,
      reason,
      note: opts.note ?? null,
    });
    return { movementId, applied: -requested };
  });
}

/** Move stock between locations inside the same house. */
export async function moveStock(opts: { itemId: string; houseId: string; userId: string; quantity: number; unit?: string; fromLocationId: string; toLocationId: string; note?: string }): Promise<string> {
  if (!opts.fromLocationId || !opts.toLocationId || opts.fromLocationId === opts.toLocationId) {
    throw new ApiError(400, "Pick two different locations");
  }
  await validateLocation(opts.houseId, opts.fromLocationId);
  await validateLocation(opts.houseId, opts.toLocationId);
  const movementId = await tx(async () => {
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
    const touched: StockLotEffect[] = [];
    for (const lot of lots) {
      if (remaining <= 0) break;
      const take = Math.min(Number(lot.quantity), remaining);
      await run("UPDATE stock_lots SET quantity = ? WHERE id = ?", [round(Number(lot.quantity) - take), lot.id]);
      touched.push({ lotId: lot.id, delta: -take });
      const nextLotId = newId("lot");
      await run(
        `INSERT INTO stock_lots
          (id, item_id, house_id, location_id, quantity, unit, unit_price, currency, purchased_at, expires_at, opened_at, note,
           vendor_id, receipt_id, portions, cooked_on, frozen_on, thawed_on, source_recipe_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          nextLotId,
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
      touched.push({ lotId: nextLotId, delta: take, created: true });
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
      lots: touched,
    });
  });
  publishLive(opts.houseId, { type: "stock", id: opts.itemId, actorUserId: opts.userId });
  return movementId;
}

/**
 * Freeze all or part of a batch. A partial freeze splits the lot, keeping the
 * price, vendor and receipt provenance on both halves, and records one `move`
 * movement. Freezing is refused on a thawed batch: refreezing is not offered.
 */
async function freezeStockInner(opts: {
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
async function thawStockInner(opts: {
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
  const results = await tx(async () => {
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
  for (const entry of results) {
    publishLive(opts.houseId, { type: "stock", id: entry.itemId, actorUserId: opts.userId });
  }
  return results;
}

export async function afterStockChange(itemId: string) {
  await syncItemLowStock(itemId);
}

/* ------------------------------------------------------------------- undo */

const MOVEMENT_TYPES = ["in", "out", "adjust", "waste", "move"] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export interface UndoStockResult {
  /** The compensating movement that was appended. */
  movementId: string;
  /** The movement it reverses. */
  reversesMovementId: string;
  itemId: string;
  itemName: string;
  type: MovementType;
  delta: number;
  /** Item quantity after the undo. */
  quantity: number;
}

/**
 * Movements of one item that can still be undone: it has recorded batch
 * effects, it is not itself an undo, it has not been undone, and no later
 * movement touched one of the batches it left behind. The history screen uses
 * this to decide where to offer Undo; the API re-checks every condition.
 */
export async function undoableMovements(itemId: string): Promise<Set<string>> {
  const rows = await all<{ id: string }>(
    `SELECT m.id AS id FROM stock_movements m
      WHERE m.item_id = ? AND m.reverses_movement_id IS NULL
        AND EXISTS (SELECT 1 FROM stock_movement_lots ml WHERE ml.movement_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = m.id)
        AND NOT EXISTS (
          SELECT 1 FROM stock_movement_lots ml
            JOIN stock_movement_lots later ON later.lot_id = ml.lot_id AND later.movement_id <> ml.movement_id
            JOIN stock_movements lm ON lm.id = later.movement_id
           WHERE ml.movement_id = m.id AND lm.created_at >= m.created_at
        )`,
    [itemId],
  );
  return new Set(rows.map((row) => String(row.id)));
}

/**
 * Reverse one stock movement by appending a compensating movement.
 *
 * The ledger stays append-only: the original row is never updated or deleted,
 * the compensating row carries `reverses_movement_id`, and a unique index makes
 * a second undo of the same movement impossible. Batch quantities are restored
 * from the recorded per-batch effects, so a FIFO consume across several batches
 * or a move is reversed exactly and atomically.
 *
 * Undo is refused (409) when it can no longer be safe: another change touched
 * one of the same batches, the batch created by the movement is no longer
 * untouched, the item is archived, or the movement is itself an undo.
 */
async function undoStockMovementInner(opts: { houseId: string; movementId: string; userId: string }): Promise<UndoStockResult> {
  return await tx(async () => {
    const original = await get<any>("SELECT * FROM stock_movements WHERE id = ? AND house_id = ?", [
      opts.movementId,
      opts.houseId,
    ]);
    if (!original) throw new ApiError(404, "Stock change not found");
    if (!MOVEMENT_TYPES.includes(original.type)) throw new ApiError(409, "This stock change cannot be undone");
    if (original.reverses_movement_id) throw new ApiError(409, "An undo cannot itself be undone");
    if (await get("SELECT id FROM stock_movements WHERE reverses_movement_id = ?", [original.id])) {
      throw new ApiError(409, "This stock change has already been undone");
    }
    const item = await itemRow(original.item_id, opts.houseId);
    if (Number(item.archived) === 1) {
      throw new ApiError(409, "This item is archived, so its stock changes cannot be undone");
    }
    const effects = await all<any>(
      "SELECT * FROM stock_movement_lots WHERE movement_id = ? ORDER BY created_at ASC",
      [original.id],
    );
    // Movements recorded before batch effects existed cannot be reversed safely.
    if (!effects.length) throw new ApiError(409, "This stock change is too old to undo");

    const lotIds = effects.map((effect) => String(effect.lot_id)).filter(Boolean);
    if (lotIds.length) {
      const placeholders = lotIds.map(() => "?").join(", ");
      const later = await get<any>(
        `SELECT ml.movement_id AS id FROM stock_movement_lots ml
           JOIN stock_movements m ON m.id = ml.movement_id
          WHERE ml.lot_id IN (${placeholders}) AND ml.movement_id <> ? AND m.item_id = ? AND m.created_at >= ?
          LIMIT 1`,
        [...lotIds, original.id, item.id, original.created_at],
      );
      if (later) throw new ApiError(409, "Those batches changed after this stock change, so undo is no longer safe");
    }

    for (const effect of effects) {
      const lot = await get<any>("SELECT id, quantity, location_id FROM stock_lots WHERE id = ? AND item_id = ?", [
        effect.lot_id,
        item.id,
      ]);
      if (!lot) throw new ApiError(409, "The batch for this stock change is gone");
      const delta = round(Number(effect.delta));
      const current = round(Number(lot.quantity));
      if (Number(effect.created_lot) === 1) {
        // The batch this change created may only be removed while it is untouched.
        if (current !== delta) throw new ApiError(409, "That batch has been used since, so undo is no longer safe");
        await run("UPDATE stock_lots SET quantity = 0 WHERE id = ?", [lot.id]);
        continue;
      }
      const restored = round(current - delta);
      if (restored < 0) throw new ApiError(409, "Undo would make stock negative");
      await run("UPDATE stock_lots SET quantity = ? WHERE id = ?", [restored, lot.id]);
    }

    const originalType = original.type as MovementType;
    // Consume and waste come back as an add, an add is taken out again, and a
    // count or move stays a count or move so the ledger reads naturally.
    const type: MovementType = originalType === "in" ? "out" : originalType === "adjust" || originalType === "move" ? originalType : "in";
    let locationId: string | null = original.location_id ?? null;
    if (originalType === "move") {
      const source = effects.find((effect) => Number(effect.delta) < 0);
      locationId = source
        ? (await get<{ location_id: string | null }>("SELECT location_id FROM stock_lots WHERE id = ?", [source.lot_id]))?.location_id ?? null
        : null;
    }
    const delta = originalType === "move" ? 0 : round(-Number(original.delta));
    const movementId = await recordMovement({
      item,
      type,
      delta,
      unit: original.unit,
      quantity: round(Number(original.quantity)),
      // Nothing was bought or spent by an undo, so it adds no price point. The
      // batches keep their original cost and expiry because they are restored.
      locationId,
      userId: opts.userId,
      reason: "Undone",
      reversesMovementId: original.id,
      lots: effects.map((effect) => ({ lotId: String(effect.lot_id), delta: -round(Number(effect.delta)) })),
    });
    return {
      movementId,
      reversesMovementId: String(original.id),
      itemId: String(item.id),
      itemName: String(item.name),
      type,
      delta,
      quantity: await itemQuantity(item.id),
    };
  });
}

/** applyStockCount, announced to open pages once the change has committed. */
export async function applyStockCount(opts: Parameters<typeof applyStockCountInner>[0]): ReturnType<typeof applyStockCountInner> {
  const result = await applyStockCountInner(opts);
  publishLive(opts.houseId, { type: "stock", id: opts.itemId, actorUserId: opts.userId });
  return result;
}

/** freezeStock, announced to open pages once the change has committed. */
export async function freezeStock(opts: Parameters<typeof freezeStockInner>[0]): ReturnType<typeof freezeStockInner> {
  const result = await freezeStockInner(opts);
  publishLive(opts.houseId, { type: "stock", id: opts.itemId, actorUserId: opts.userId });
  return result;
}

/** thawStock, announced to open pages once the change has committed. */
export async function thawStock(opts: Parameters<typeof thawStockInner>[0]): ReturnType<typeof thawStockInner> {
  const result = await thawStockInner(opts);
  publishLive(opts.houseId, { type: "stock", id: opts.itemId, actorUserId: opts.userId });
  return result;
}

/** undoStockMovement, announced to open pages once the change has committed. */
export async function undoStockMovement(opts: Parameters<typeof undoStockMovementInner>[0]): ReturnType<typeof undoStockMovementInner> {
  const result = await undoStockMovementInner(opts);
  publishLive(opts.houseId, { type: "stock", id: result.itemId, actorUserId: opts.userId });
  return result;
}
