import { all } from "../db.js";
import type { Forecast } from "../../shared/types.js";

const WINDOW_DAYS = 60;
const DAY_MS = 86400000;

/** Outgoing consumption only: waste, corrections and transfers are excluded. */
export async function forecastsForHouse(houseId: string, itemId?: string): Promise<Map<string, Forecast>> {
  const end = new Date();
  const cutoff = new Date(end.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
  const rows = await all<{ item_id: string; consumed: number; events: number; first_at: string; last_at: string; quantity: number }>(
    `SELECT m.item_id, SUM(-m.delta) AS consumed, COUNT(*) AS events,
       MIN(m.created_at) AS first_at, MAX(m.created_at) AS last_at,
       (SELECT COALESCE(SUM(l.quantity), 0) FROM stock_lots l WHERE l.item_id = m.item_id AND l.house_id = m.house_id) AS quantity
     FROM stock_movements m
     WHERE m.house_id = ? AND m.type = 'out' AND m.delta < 0 AND m.created_at >= ? AND m.created_at <= ?${itemId ? " AND m.item_id = ?" : ""}
     GROUP BY m.item_id`, itemId ? [houseId, cutoff, end.toISOString(), itemId] : [houseId, cutoff, end.toISOString()],
  );
  const forecasts = new Map<string, Forecast>();
  for (const row of rows) {
    const span = Date.parse(row.last_at) - Date.parse(row.first_at);
    // Measure over the history the item actually has: dividing a fortnight of use
    // by 60 days would understate the rate and push the run-out date far out.
    const windowDays = Math.max(7, Math.min(WINDOW_DAYS, Math.round((end.getTime() - Date.parse(row.first_at)) / DAY_MS)));
    const rate = Number(row.consumed) / windowDays;
    if (Number(row.events) < 2 || span < 7 * DAY_MS || !Number.isFinite(span) || Number(row.quantity) <= 0 || rate <= 0) continue;
    forecasts.set(row.item_id, { dailyRate: rate, daysLeft: Number(row.quantity) / rate, windowDays });
  }
  return forecasts;
}
