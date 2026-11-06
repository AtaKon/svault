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
}

async function itemRow(itemId: string, houseId: string) {
  const item = await get<any>("SELECT * FROM items WHERE id = ? AND house_id = ?", [itemId, houseId]);
  if (!item) throw new ApiError(404, "Item not found");
  return item;
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
         vendor_id, receipt_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    for (const lot of lots) {
      if (remaining <= 0) break;
      const take = Math.min(Number(lot.quantity), remaining);
      await run("UPDATE stock_lots SET quantity = ? WHERE id = ?", [round(Number(lot.quantity) - take), lot.id]);
      remaining = round(remaining - take);
    }
    return await recordMovement({
      item,
      type: opts.waste ? "waste" : "out",
      delta: -requested,
      unit: opts.unit ?? item.unit,
      quantity: requested,
      locationId: opts.locationId ?? null,
      userId: opts.userId,
      reason: opts.reason ?? (opts.waste ? "Wasted" : "Consumed"),
      note: opts.note ?? null,
    });
  });
}

/** Set an absolute quantity (stock count correction). */
export async function setStock(opts: StockOpts & { target: number }): Promise<string> {
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
      await run("UPDATE stock_lots SET quantity = ? WHERE id = ?", [round(Number(lot.quantity) - take), lot.id]);
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
          (id, item_id, house_id, location_id, quantity, unit, unit_price, currency, purchased_at, expires_at, note,
           vendor_id, receipt_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          lot.note,
          lot.vendor_id ?? null,
          lot.receipt_id ?? null,
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
