import { effectiveExpiry } from "../services/effective-expiry.js";
import { forecastsForHouse } from "../services/forecast.js";
import { Router } from "express";
import { all, get } from "../db.js";
import { requireAuth } from "../auth.js";
import { handler, requireHouse } from "../http.js";
import {
  ITEM_SELECT,
  barcodesForHouse,
  serializeItem,
  serializeLocation,
  serializeLot,
  serializeMovement,
  serializeRecipe,
  recipeMatch,
} from "../serialize.js";

export const dashboardRoutes = Router();
dashboardRoutes.use(requireAuth);

/**
 * A compact, sensor-friendly snapshot of the house. The full dashboard is far
 * too large for a five-minute Home Assistant poll; this endpoint answers with
 * one query for the counters and one for the caller's unread reminders.
 */
dashboardRoutes.get(
  "/:houseId/summary",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    const today = new Date().toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);

    const row = await get<any>(
      `SELECT
        (SELECT name FROM houses WHERE id = ?) AS house_name,
        (SELECT created_at FROM houses WHERE id = ?) AS house_created_at,
        (SELECT COUNT(*) FROM items WHERE house_id = ? AND archived = 0) AS item_count,
        (SELECT COUNT(*) FROM items i WHERE i.house_id = ? AND i.archived = 0 AND i.reorder_point > 0
           AND (SELECT COALESCE(SUM(l.quantity), 0) FROM stock_lots l WHERE l.item_id = i.id) <= i.reorder_point
        ) AS low_stock_count,
        (SELECT COUNT(*) FROM shopping_list_items s WHERE s.house_id = ? AND s.checked = 0) AS shopping_open_count,
        (SELECT MAX(t) FROM (
           SELECT MAX(updated_at) AS t FROM items WHERE house_id = ?
           UNION ALL SELECT MAX(updated_at) FROM shopping_list_items WHERE house_id = ?
           UNION ALL SELECT MAX(created_at) FROM stock_lots WHERE house_id = ?
           UNION ALL SELECT MAX(created_at) FROM notifications WHERE house_id = ?
        ) AS stamps) AS updated_at`,
      [houseId, houseId, houseId, houseId, houseId, houseId, houseId, houseId, houseId],
    );

    // Count expiry the way the dashboard and reminders do: an opened batch with a
    // shelf life can expire before its printed date.
    const datedLots = await all<any>(
      `SELECT l.expires_at, l.opened_at, i.opened_shelf_life_days FROM stock_lots l JOIN items i ON i.id = l.item_id
       WHERE l.house_id = ? AND l.quantity > 0 AND (l.expires_at IS NOT NULL OR l.opened_at IS NOT NULL)`,
      [houseId],
    );
    let expiringSoonCount = 0;
    let expiredCount = 0;
    for (const lot of datedLots) {
      const expires = effectiveExpiry(lot, lot);
      if (!expires) continue;
      if (expires < today) expiredCount++;
      else if (expires <= soon) expiringSoonCount++;
    }

    const reminders = await all<{ read_by: string }>(
      `SELECT read_by FROM notifications WHERE house_id = ? AND resolved_at IS NULL
         AND (user_id IS NULL OR user_id = ?)`,
      [houseId, req.user!.id],
    );
    const unreadReminders = reminders.filter((reminder) => {
      try {
        return !(JSON.parse(reminder.read_by) as string[]).includes(req.user!.id);
      } catch {
        return true;
      }
    }).length;

    res.json({
      houseId,
      houseName: String(row?.house_name ?? ""),
      itemCount: Number(row?.item_count ?? 0),
      lowStockCount: Number(row?.low_stock_count ?? 0),
      expiringSoonCount,
      expiredCount,
      shoppingListOpenCount: Number(row?.shopping_open_count ?? 0),
      unreadReminders,
      updatedAt: row?.updated_at ?? row?.house_created_at ?? null,
    });
  }),
);

dashboardRoutes.get(
  "/:houseId/dashboard",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    const barcodeMap = await barcodesForHouse(houseId);

    const stats = await get<any>(
      `SELECT
        (SELECT COUNT(*) FROM items WHERE house_id = ? AND archived = 0) AS item_count,
        (SELECT COALESCE(SUM(l.quantity), 0) FROM stock_lots l WHERE l.house_id = ?) AS unit_count,
        (SELECT COUNT(*) FROM stock_lots l WHERE l.house_id = ? AND l.quantity > 0) AS batch_count,
        (SELECT COALESCE(SUM(l.quantity * COALESCE(l.unit_price, 0)), 0) FROM stock_lots l WHERE l.house_id = ?) AS total_value`,
      [houseId, houseId, houseId, houseId],
    );

    const lowRows = await all<any>(
      `${ITEM_SELECT} WHERE i.house_id = ? AND i.archived = 0 AND i.reorder_point > 0
        AND (SELECT COALESCE(SUM(l.quantity), 0) FROM stock_lots l WHERE l.item_id = i.id) <= i.reorder_point
       ORDER BY quantity ASC LIMIT 8`,
      [houseId],
    );

    const horizon = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    const expiring = (await all<any>(
      `SELECT l.*, i.name AS item_name, i.opened_shelf_life_days, loc.name AS location_name FROM stock_lots l
       JOIN items i ON i.id = l.item_id
       LEFT JOIN locations loc ON loc.id = l.location_id AND loc.house_id = ?
       WHERE l.house_id = ? AND l.quantity > 0`,
      [houseId, houseId],
    )).filter((row) => { const expiry = effectiveExpiry(row, row); return expiry && expiry <= horizon; }).sort((a, b) => effectiveExpiry(a, a)!.localeCompare(effectiveExpiry(b, b)!)).slice(0, 12).map((row) => ({ ...serializeLot(row), itemName: row.item_name, itemId: row.item_id }));

    const recent = (await all<any>(
      `SELECT m.*, i.name AS item_name, i.unit AS item_unit, loc.name AS location_name, u.name AS user_name
       FROM stock_movements m
       JOIN items i ON i.id = m.item_id
       LEFT JOIN locations loc ON loc.id = m.location_id AND loc.house_id = ?
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.house_id = ? ORDER BY m.created_at DESC LIMIT 10`,
      [houseId, houseId],
    )).map((row) => ({ ...serializeMovement(row), itemName: row.item_name }));

    const recentRecipeRow = await get<any>(
      "SELECT * FROM recipes WHERE house_id = ? ORDER BY updated_at DESC LIMIT 1",
      [houseId],
    );
    let recentRecipe = null;
    if (recentRecipeRow) {
      const ingredients = await all<any>("SELECT * FROM recipe_ingredients WHERE recipe_id = ? ORDER BY sort", [recentRecipeRow.id]);
      const serialized = serializeRecipe(recentRecipeRow, ingredients);
      const stock = new Map<string, number>();
      for (const item of await all<any>(
        `SELECT i.name, COALESCE((SELECT SUM(l.quantity) FROM stock_lots l WHERE l.item_id = i.id), 0) AS quantity
         FROM items i WHERE i.house_id = ? AND i.archived = 0`,
        [houseId],
      )) {
        stock.set(String(item.name).toLowerCase().trim(), Number(item.quantity));
      }
      recentRecipe = {
        ...serialized,
        match: recipeMatch(
          serialized.ingredients.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit, optional: i.optional })),
          stock,
        ),
      };
    }

    const counts = {
      recipes: Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM recipes WHERE house_id = ?", [houseId]))?.n ?? 0),
      photos: Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM photos WHERE house_id = ?", [houseId]))?.n ?? 0),
      unlabeledPhotos: Number(
        (await get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM photos p WHERE p.house_id = ? AND NOT EXISTS (SELECT 1 FROM photo_labels l WHERE l.photo_id = p.id)",
          [houseId],
        ))?.n ?? 0,
      ),
      unreadNotifications: (await all<any>(
        "SELECT read_by FROM notifications WHERE house_id = ? AND resolved_at IS NULL AND (user_id IS NULL OR user_id = ?)",
        [houseId, req.user!.id],
      )).filter((r) => {
        try {
          return !(JSON.parse(r.read_by) as string[]).includes(req.user!.id);
        } catch {
          return true;
        }
      }).length,
    };

    const forecasts = await forecastsForHouse(houseId);
    // Load only the few items forecast to run out within a week, not the whole catalogue.
    const soonIds = [...forecasts].filter(([, forecast]) => forecast.daysLeft <= 7).map(([id]) => id);
    const forecastRows = soonIds.length
      ? await all<any>(`${ITEM_SELECT} WHERE i.house_id = ? AND i.archived = 0 AND i.id IN (${soonIds.map(() => "?").join(", ")})`, [houseId, ...soonIds])
      : [];
    const runningOutSoon = forecastRows
      .map((row) => ({ ...serializeItem(row, barcodeMap.get(row.id) ?? []), forecast: forecasts.get(row.id) ?? null }))
      .sort((a, b) => a.forecast!.daysLeft - b.forecast!.daysLeft);
    res.json({
      runningOutSoon,
      itemCount: Number(stats?.item_count ?? 0),
      unitCount: Number(stats?.unit_count ?? 0),
      batchCount: Number(stats?.batch_count ?? 0),
      totalValue: Math.round(Number(stats?.total_value ?? 0) * 100) / 100,
      lowStock: lowRows.map((r) => serializeItem(r, barcodeMap.get(r.id) ?? [])),
      expiring,
      recent,
      recentRecipe,
      plan: await (async () => {
        const now = new Date();
        const weekday = (now.getUTCDay() + 6) % 7;
        const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - weekday));
        const weekStart = monday.toISOString().slice(0, 10);
        const weekEnd = new Date(monday.getTime() + 6 * 864e5).toISOString().slice(0, 10);
        const today = now.toISOString().slice(0, 10);
        return {
          today: Number(
            (await get<{ n: number }>("SELECT COUNT(*) AS n FROM meal_plan_entries WHERE house_id = ? AND day = ?", [
              houseId,
              today,
            ]))?.n ?? 0,
          ),
          week: Number(
            (await get<{ n: number }>(
              "SELECT COUNT(*) AS n FROM meal_plan_entries WHERE house_id = ? AND day >= ? AND day <= ?",
              [houseId, weekStart, weekEnd],
            ))?.n ?? 0,
          ),
          weekStart,
        };
      })(),
      locations: (await all<any>(
        `SELECT l.*, (SELECT COUNT(DISTINCT item_id) FROM stock_lots WHERE location_id = l.id) AS item_count
         FROM locations l WHERE l.house_id = ? ORDER BY lower(l.name)`,
        [houseId],
      )).map(serializeLocation),
      counts,
      barcodes: { total: (await all<any>("SELECT 1 FROM item_barcodes WHERE house_id = ?", [houseId])).length },
    });
  }),
);
