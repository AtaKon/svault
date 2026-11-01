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

dashboardRoutes.get(
  "/:houseId/dashboard",
  handler((req, res) => {
    const { houseId } = requireHouse(req);
    const barcodeMap = barcodesForHouse(houseId);

    const stats = get<any>(
      `SELECT
        (SELECT COUNT(*) FROM items WHERE house_id = ? AND archived = 0) AS item_count,
        (SELECT COALESCE(SUM(l.quantity), 0) FROM stock_lots l WHERE l.house_id = ?) AS unit_count,
        (SELECT COUNT(*) FROM stock_lots l WHERE l.house_id = ? AND l.quantity > 0) AS batch_count,
        (SELECT COALESCE(SUM(l.quantity * COALESCE(l.unit_price, 0)), 0) FROM stock_lots l WHERE l.house_id = ?) AS total_value`,
      [houseId, houseId, houseId, houseId],
    );

    const lowRows = all<any>(
      `${ITEM_SELECT} WHERE i.house_id = ? AND i.archived = 0 AND i.reorder_point > 0
        AND (SELECT COALESCE(SUM(l.quantity), 0) FROM stock_lots l WHERE l.item_id = i.id) <= i.reorder_point
       ORDER BY quantity ASC LIMIT 8`,
      [houseId],
    );

    const horizon = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    const expiring = all<any>(
      `SELECT l.*, i.name AS item_name, loc.name AS location_name FROM stock_lots l
       JOIN items i ON i.id = l.item_id
       LEFT JOIN locations loc ON loc.id = l.location_id
       WHERE l.house_id = ? AND l.quantity > 0 AND l.expires_at IS NOT NULL AND l.expires_at <= ?
       ORDER BY l.expires_at ASC LIMIT 12`,
      [houseId, horizon],
    ).map((row) => ({ ...serializeLot(row), itemName: row.item_name, itemId: row.item_id }));

    const recent = all<any>(
      `SELECT m.*, i.name AS item_name, i.unit AS item_unit, loc.name AS location_name, u.name AS user_name
       FROM stock_movements m
       JOIN items i ON i.id = m.item_id
       LEFT JOIN locations loc ON loc.id = m.location_id
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.house_id = ? ORDER BY m.created_at DESC LIMIT 10`,
      [houseId],
    ).map((row) => ({ ...serializeMovement(row), itemName: row.item_name }));

    const recentRecipeRow = get<any>(
      "SELECT * FROM recipes WHERE house_id = ? ORDER BY updated_at DESC LIMIT 1",
      [houseId],
    );
    let recentRecipe = null;
    if (recentRecipeRow) {
      const ingredients = all<any>("SELECT * FROM recipe_ingredients WHERE recipe_id = ? ORDER BY sort", [recentRecipeRow.id]);
      const serialized = serializeRecipe(recentRecipeRow, ingredients);
      const stock = new Map<string, number>();
      for (const item of all<any>(
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
      recipes: Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM recipes WHERE house_id = ?", [houseId])?.n ?? 0),
      photos: Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM photos WHERE house_id = ?", [houseId])?.n ?? 0),
      unlabeledPhotos: Number(
        get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM photos p WHERE p.house_id = ? AND NOT EXISTS (SELECT 1 FROM photo_labels l WHERE l.photo_id = p.id)",
          [houseId],
        )?.n ?? 0,
      ),
      unreadNotifications: all<any>(
        "SELECT read_by FROM notifications WHERE house_id = ? AND resolved_at IS NULL",
        [houseId],
      ).filter((r) => {
        try {
          return !(JSON.parse(r.read_by) as string[]).includes(req.user!.id);
        } catch {
          return true;
        }
      }).length,
    };

    res.json({
      itemCount: Number(stats?.item_count ?? 0),
      unitCount: Number(stats?.unit_count ?? 0),
      batchCount: Number(stats?.batch_count ?? 0),
      totalValue: Math.round(Number(stats?.total_value ?? 0) * 100) / 100,
      lowStock: lowRows.map((r) => serializeItem(r, barcodeMap.get(r.id) ?? [])),
      expiring,
      recent,
      recentRecipe,
      locations: all<any>(
        `SELECT l.*, (SELECT COUNT(DISTINCT item_id) FROM stock_lots WHERE location_id = l.id) AS item_count
         FROM locations l WHERE l.house_id = ? ORDER BY l.name COLLATE NOCASE`,
        [houseId],
      ).map(serializeLocation),
      counts,
      barcodes: { total: all<any>("SELECT 1 FROM item_barcodes WHERE house_id = ?", [houseId]).length },
    });
  }),
);
