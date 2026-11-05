import { Router } from "express";
import { z } from "zod";
import { all, get, now, run } from "../db.js";
import { requireAuth } from "../auth.js";
import { ApiError, handler, parseBody, requireHouse } from "../http.js";
import { addStock, afterStockChange } from "../services/stock.js";
import {
  addShoppingLine,
  deleteShoppingLine,
  listShopping,
  normalizeName,
  serializeShoppingItem,
  shoppingRow,
} from "../services/shopping.js";
import { convert } from "../units.js";

export const shoppingRoutes = Router();
shoppingRoutes.use(requireAuth);

const lineBody = z.object({
  name: z.string().trim().min(1).max(160),
  quantity: z.number().min(0).max(1e9).nullish(),
  unit: z.string().trim().max(10).nullish(),
  itemId: z.string().max(60).nullish(),
  categoryId: z.string().max(60).nullish(),
  note: z.string().trim().max(300).nullish(),
});

function itemRow(houseId: string, itemId: string) {
  return get<any>("SELECT * FROM items WHERE id = ? AND house_id = ?", [itemId, houseId]);
}

function categoryForItem(item: any) {
  return item?.category_id ?? null;
}

/** How much of an ingredient is already in stock, expressed in its unit. */
function stockInIngredientUnit(houseId: string, ingredient: any): number {
  let item = ingredient.item_id ? itemRow(houseId, ingredient.item_id) : null;
  if (!item) {
    item = get<any>("SELECT * FROM items WHERE house_id = ? AND archived = 0 AND LOWER(name) = LOWER(?)", [
      houseId,
      ingredient.name,
    ]);
  }
  if (!item) {
    const wanted = normalizeName(String(ingredient.name));
    const candidates = all<any>("SELECT * FROM items WHERE house_id = ? AND archived = 0", [houseId]);
    item =
      candidates.find((row) => {
        const name = normalizeName(String(row.name));
        return name === wanted || name.includes(wanted) || wanted.includes(name);
      }) ?? null;
  }
  if (!item) return 0;
  const quantity = Number(
    get<{ q: number }>("SELECT COALESCE(SUM(quantity), 0) AS q FROM stock_lots WHERE item_id = ?", [item.id])?.q ?? 0,
  );
  if (!ingredient.unit) return quantity > 0 ? quantity : 0;
  const converted = convert(quantity, item.unit, ingredient.unit);
  return converted ?? 0;
}

shoppingRoutes.get(
  "/:houseId/shopping",
  handler((req, res) => {
    const { houseId } = requireHouse(req);
    const includeChecked = req.query.checked !== "0";
    res.json({ items: listShopping(houseId, includeChecked) });
  }),
);

shoppingRoutes.post(
  "/:houseId/shopping",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "member");
    const body = parseBody(lineBody, req.body);
    let item: any = null;
    if (body.itemId) {
      item = itemRow(houseId, body.itemId);
      if (!item) throw new ApiError(400, "Item does not exist in this house");
    }
    const result = addShoppingLine({
      houseId,
      userId: req.user!.id,
      name: body.name,
      quantity: body.quantity ?? null,
      unit: body.unit ?? null,
      itemId: item?.id ?? null,
      categoryId: body.categoryId ?? categoryForItem(item),
      note: body.note ?? null,
      source: "manual",
    });
    res.status(result.status === "added" ? 201 : 200).json(result);
  }),
);

shoppingRoutes.patch(
  "/:houseId/shopping/:entryId",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "member");
    const current = shoppingRow(houseId, String(req.params.entryId));
    if (!current) throw new ApiError(404, "Shopping list item not found");
    const body = parseBody(lineBody.partial().extend({ checked: z.boolean().optional() }), req.body);
    let itemId = current.item_id;
    if (body.itemId !== undefined) {
      if (body.itemId) {
        const item = itemRow(houseId, body.itemId);
        if (!item) throw new ApiError(400, "Item does not exist in this house");
        itemId = item.id;
      } else {
        itemId = null;
      }
    }
    const checked = body.checked === undefined ? Boolean(current.checked) : body.checked;
    run(
      `UPDATE shopping_list_items SET name = ?, quantity = ?, unit = ?, item_id = ?, category_id = ?, note = ?,
         checked = ?, checked_at = ?, updated_at = ? WHERE id = ? AND house_id = ?`,
      [
        body.name ?? current.name,
        body.quantity === undefined ? current.quantity : body.quantity,
        body.unit === undefined ? current.unit : body.unit,
        itemId,
        body.categoryId === undefined ? current.category_id : body.categoryId,
        body.note === undefined ? current.note : body.note,
        checked ? 1 : 0,
        checked ? current.checked_at ?? now() : null,
        now(),
        current.id,
        houseId,
      ],
    );
    res.json({ item: serializeShoppingItem(shoppingRow(houseId, current.id)) });
  }),
);

shoppingRoutes.delete(
  "/:houseId/shopping/:entryId",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "member");
    deleteShoppingLine(houseId, String(req.params.entryId));
    res.json({ ok: true });
  }),
);

shoppingRoutes.delete(
  "/:houseId/shopping",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "member");
    if (req.query.checked === "1") {
      run("DELETE FROM shopping_list_items WHERE house_id = ? AND checked = 1", [houseId]);
    } else {
      run("DELETE FROM shopping_list_items WHERE house_id = ?", [houseId]);
    }
    res.json({ ok: true });
  }),
);

shoppingRoutes.post(
  "/:houseId/shopping/from-recipe",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "member");
    const body = parseBody(
      z.object({
        recipeId: z.string().min(1).max(60),
        includeOptional: z.boolean().optional(),
        missingOnly: z.boolean().optional(),
      }),
      req.body,
    );
    const recipe = get<any>("SELECT * FROM recipes WHERE id = ? AND house_id = ?", [body.recipeId, houseId]);
    if (!recipe) throw new ApiError(404, "Recipe not found");
    const ingredients = all<any>(
      "SELECT * FROM recipe_ingredients WHERE recipe_id = ? ORDER BY sort, rowid",
      [recipe.id],
    );
    let added = 0;
    let merged = 0;
    let skipped = 0;
    for (const ingredient of ingredients) {
      if (ingredient.optional && !body.includeOptional) continue;
      let quantity = ingredient.quantity == null ? null : Number(ingredient.quantity);
      const unit = ingredient.unit ?? null;
      if (body.missingOnly !== false) {
        const inStock = stockInIngredientUnit(houseId, ingredient);
        if (quantity != null && inStock > 0) {
          quantity = Math.max(0, quantity - inStock);
        }
        if (quantity === 0 || (quantity == null && inStock > 0)) continue;
      }
      const linkedItem = ingredient.item_id ? itemRow(houseId, ingredient.item_id) : null;
      const result = addShoppingLine({
        houseId,
        userId: req.user!.id,
        name: ingredient.name,
        quantity,
        unit,
        itemId: linkedItem?.id ?? null,
        categoryId: categoryForItem(linkedItem),
        note: ingredient.note ?? null,
        source: "recipe",
        sourceKey: `recipe:${recipe.id}:${ingredient.id}`,
      });
      if (result.status === "added") added++;
      else if (result.status === "merged") merged++;
      else skipped++;
    }
    res.json({ added, merged, skipped, items: listShopping(houseId) });
  }),
);

shoppingRoutes.post(
  "/:houseId/shopping/from-low-stock",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "member");
    const rows = all<any>(
      `SELECT i.*, COALESCE((SELECT SUM(l.quantity) FROM stock_lots l WHERE l.item_id = i.id), 0) AS quantity
       FROM items i WHERE i.house_id = ? AND i.archived = 0 AND i.reorder_point > 0
         AND (SELECT COALESCE(SUM(l.quantity), 0) FROM stock_lots l WHERE l.item_id = i.id) <= i.reorder_point
       ORDER BY i.name COLLATE NOCASE`,
      [houseId],
    );
    let added = 0;
    let merged = 0;
    let skipped = 0;
    for (const item of rows) {
      const quantity = Number(item.quantity);
      const target = Number(item.target_stock ?? Math.max(Number(item.reorder_point) * 2, 1));
      const needed = Math.max(target - quantity, 1);
      const result = addShoppingLine({
        houseId,
        userId: req.user!.id,
        name: item.name,
        quantity: Number(needed.toFixed(3)),
        unit: item.unit,
        itemId: item.id,
        categoryId: item.category_id,
        source: "low_stock",
        sourceKey: `low:${item.id}`,
      });
      if (result.status === "added") added++;
      else if (result.status === "merged") merged++;
      else skipped++;
    }
    res.json({ added, merged, skipped, items: listShopping(houseId) });
  }),
);

shoppingRoutes.post(
  "/:houseId/shopping/:entryId/check",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "member");
    const entry = shoppingRow(houseId, String(req.params.entryId));
    if (!entry) throw new ApiError(404, "Shopping list item not found");
    const body = parseBody(
      z.object({
        quantity: z.number().positive().max(1e9).optional(),
        unit: z.string().max(10).optional(),
        itemId: z.string().max(60).nullish(),
        unitPrice: z.number().min(0).max(1e9).nullish(),
        locationId: z.string().max(60).nullish(),
        expiresAt: z.string().max(10).nullish(),
        purchasedAt: z.string().max(10).nullish(),
        note: z.string().max(300).nullish(),
        addStock: z.boolean().optional(),
      }),
      req.body ?? {},
    );

    let item: any = null;
    if (body.itemId) {
      item = itemRow(houseId, body.itemId);
      if (!item) throw new ApiError(400, "Item does not exist in this house");
      run("UPDATE shopping_list_items SET item_id = ?, updated_at = ? WHERE id = ? AND house_id = ?", [
        item.id,
        now(),
        entry.id,
        houseId,
      ]);
    } else if (entry.item_id) {
      item = itemRow(houseId, entry.item_id);
    }
    if (!item) {
      item = get<any>("SELECT * FROM items WHERE house_id = ? AND archived = 0 AND LOWER(name) = LOWER(?)", [
        houseId,
        entry.name,
      ]);
    }
    if (!item && body.addStock !== false) {
      throw new ApiError(400, "Link this line to an item before adding it to stock");
    }

    let stockMovementId: string | null = null;
    if (item && body.addStock !== false) {
      if (body.locationId && !get("SELECT id FROM locations WHERE id = ? AND house_id = ?", [body.locationId, houseId])) {
        throw new ApiError(400, "Place does not exist in this house");
      }
      stockMovementId = addStock({
        itemId: item.id,
        houseId,
        userId: req.user!.id,
        quantity: body.quantity ?? entry.quantity ?? 1,
        unit: body.unit ?? entry.unit ?? item.unit,
        unitPrice: body.unitPrice ?? null,
        locationId: body.locationId ?? null,
        expiresAt: body.expiresAt ?? null,
        purchasedAt: body.purchasedAt ?? null,
        note: body.note ?? entry.note ?? null,
        reason: "Shopping list",
      });
      afterStockChange(item.id);
    }

    run("UPDATE shopping_list_items SET checked = 1, checked_at = ?, updated_at = ? WHERE id = ? AND house_id = ?", [
      now(),
      now(),
      entry.id,
      houseId,
    ]);
    res.json({
      item: serializeShoppingItem(shoppingRow(houseId, entry.id)),
      stockMovementId,
      stockItemId: item?.id ?? null,
    });
  }),
);
