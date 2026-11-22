import { all, get, parseJson } from "../db.js";
import { serializeLot } from "../serialize.js";
import { effectiveExpiry } from "./effective-expiry.js";
import type { FreezerBatch, FreezerView } from "../../shared/types.js";

const DAY = 864e5;

/** The house expiry reminder window, which the freezer "use soon" count shares. */
export async function freezerUseSoonDays(houseId: string): Promise<number> {
  const house = await get<{ settings: string }>("SELECT settings FROM houses WHERE id = ?", [houseId]);
  const settings = parseJson<any>(house?.settings, {});
  const days = Number(settings?.notifications?.expiryDays ?? 7);
  // Same clamp as syncHouseExpiry: a stored value that is not a finite
  // 0..3650 day count falls back to the default instead of poisoning the view.
  return Number.isFinite(days) ? Math.max(0, Math.min(3650, Math.trunc(days))) : 7;
}

/**
 * Every positive batch that has been frozen at least once, newest eat-by first.
 * Thawed batches stay visible until they are eaten, with `thawedOn` set.
 */
export async function freezerBatches(houseId: string): Promise<FreezerBatch[]> {
  const rows = await all<any>(
    `SELECT l.*, i.name AS item_name, i.unit AS item_unit, i.category_id,
            i.freezer_shelf_life_days, i.thaw_shelf_life_days,
            loc.name AS location_name, loc.is_freezer AS in_freezer_place,
            r.title AS source_recipe_title
       FROM stock_lots l
       JOIN items i ON i.id = l.item_id
       LEFT JOIN locations loc ON loc.id = l.location_id AND loc.house_id = ?
       LEFT JOIN recipes r ON r.id = l.source_recipe_id
      WHERE l.house_id = ? AND l.quantity > 0 AND l.frozen_on IS NOT NULL AND i.archived = 0`,
    [houseId, houseId],
  );
  return rows
    .map((row) => ({
      ...serializeLot(row),
      itemName: String(row.item_name),
      itemUnit: String(row.item_unit),
      categoryId: row.category_id ?? null,
      locationName: row.location_name ?? null,
      inFreezerPlace: Number(row.in_freezer_place ?? 0) === 1,
      sourceRecipeTitle: row.source_recipe_title ?? null,
    }))
    .sort((a, b) => {
      if (a.effectiveExpiresAt && b.effectiveExpiresAt) return a.effectiveExpiresAt.localeCompare(b.effectiveExpiresAt);
      if (a.effectiveExpiresAt) return -1;
      if (b.effectiveExpiresAt) return 1;
      return String(a.frozenOn).localeCompare(String(b.frozenOn));
    });
}

export function freezerPortions(batch: { quantity: number; portions: number | null }): number {
  return batch.portions ?? batch.quantity;
}

export async function freezerView(houseId: string): Promise<FreezerView> {
  const batches = await freezerBatches(houseId);
  const useSoonDays = await freezerUseSoonDays(houseId);
  const horizon = new Date(Date.now() + useSoonDays * DAY).toISOString().slice(0, 10);
  let portions = 0;
  let useSoon = 0;
  for (const batch of batches) {
    const count = freezerPortions(batch);
    portions += count;
    const expiry = batch.effectiveExpiresAt;
    if (expiry && expiry <= horizon) useSoon += count;
  }
  return {
    batches,
    totals: { batches: batches.length, portions: Math.round(portions * 1000) / 1000, useSoon: Math.round(useSoon * 1000) / 1000 },
    useSoonDays,
  };
}

/** Dashboard card data; null when there is nothing in the freezer. */
export async function freezerSummary(houseId: string): Promise<{ portions: number; useSoon: number } | null> {
  const rows = await all<any>(
    `SELECT l.quantity, l.portions, l.frozen_on, l.thawed_on, l.expires_at, l.opened_at,
            i.freezer_shelf_life_days, i.thaw_shelf_life_days
       FROM stock_lots l JOIN items i ON i.id = l.item_id
      WHERE l.house_id = ? AND l.quantity > 0 AND l.frozen_on IS NOT NULL AND l.thawed_on IS NULL AND i.archived = 0`,
    [houseId],
  );
  if (!rows.length) return null;
  const horizon = new Date(Date.now() + (await freezerUseSoonDays(houseId)) * DAY).toISOString().slice(0, 10);
  let portions = 0;
  let useSoon = 0;
  for (const row of rows) {
    const count = row.portions == null ? Number(row.quantity) : Number(row.portions);
    portions += count;
    const expiry = effectiveExpiry(row, row);
    if (expiry && expiry <= horizon) useSoon += count;
  }
  return { portions: Math.round(portions * 1000) / 1000, useSoon: Math.round(useSoon * 1000) / 1000 };
}
