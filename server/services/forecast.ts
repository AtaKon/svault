import { all } from "../db.js";
import type { Forecast } from "../../shared/types.js";

const WINDOW_DAYS = 60;
const DAY_MS = 86400000;

/** Outgoing consumption only: waste, corrections and transfers are excluded. */
export async function forecastsForHouse(houseId: string): Promise<Map<string, Forecast>> {
  const cutoff = new Date(Date.now() - WINDOW_DAYS * DAY_MS).toISOString();
  const rows = await all<{ item_id: string; consumed: number; events: number; first_at: string; last_at: string; quantity: number }>(
    `SELECT m.item_id, SUM(-m.delta) AS consumed, COUNT(*) AS events,
       MIN(m.created_at) AS first_at, MAX(m.created_at) AS last_at,
       (SELECT COALESCE(SUM(l.quantity), 0) FROM stock_lots l WHERE l.item_id = m.item_id) AS quantity
     FROM stock_movements m
     WHERE m.house_id = ? AND m.type = 'out' AND m.delta < 0 AND m.created_at >= ?
     GROUP BY m.item_id`, [houseId, cutoff],
  );
  const forecasts = new Map<string, Forecast>();
  for (const row of rows) {
    const span = Date.parse(row.last_at) - Date.parse(row.first_at);
    const rate = Number(row.consumed) / WINDOW_DAYS;
    if (Number(row.events) < 2 || span < 7 * DAY_MS || !Number.isFinite(span) || Number(row.quantity) <= 0 || rate <= 0) continue;
    forecasts.set(row.item_id, { dailyRate: rate, daysLeft: Number(row.quantity) / rate, windowDays: WINDOW_DAYS });
  }
  return forecasts;
}
