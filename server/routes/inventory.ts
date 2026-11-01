import { Router } from "express";
import { z } from "zod";
import { all, get, newId, now, parseJson, run, tx } from "../db.js";
import { memberRole, requireAuth, roleAtLeast } from "../auth.js";
import { ApiError, handler, intParam, parseBody, requireHouse } from "../http.js";
import {
  ITEM_SELECT,
  barcodesForHouse,
  barcodesForItem,
  priceStats,
  serializeAttribute,
  serializeCategory,
  serializeItem,
  serializeLocation,
  serializeLot,
  serializeMovement,
} from "../serialize.js";
import { addStock, afterStockChange, moveStock, removeStock, setStock } from "../services/stock.js";
import { uploader } from "../upload.js";
import type { Role } from "../../shared/types.js";

export const inventoryRoutes = Router();
inventoryRoutes.use(requireAuth);

/* ------------------------------------------------------------------ helpers */

function itemAccess(req: any, minRole: Role = "viewer") {
  const item = get<any>("SELECT * FROM items WHERE id = ?", [req.params.itemId]);
  if (!item) throw new ApiError(404, "Item not found");
  const role = memberRole(req.user!.id, item.house_id);
  if (!role) throw new ApiError(404, "Item not found");
  if (!roleAtLeast(role, minRole)) throw new ApiError(403, `Requires ${minRole} access`);
  return { item, houseId: item.house_id as string, role };
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean).slice(0, 20);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  return [];
}

function itemDetail(itemId: string, userId: string) {
  const row = get<any>(`${ITEM_SELECT} WHERE i.id = ?`, [itemId]);
  if (!row) throw new ApiError(404, "Item not found");
  void userId;
  const item = serializeItem(row, barcodesForItem(itemId));
  const lots = all<any>(
    `SELECT l.*, loc.name AS location_name FROM stock_lots l
     LEFT JOIN locations loc ON loc.id = l.location_id
     WHERE l.item_id = ?
     ORDER BY CASE WHEN l.quantity > 0 THEN 0 ELSE 1 END, CASE WHEN l.expires_at IS NULL THEN 1 ELSE 0 END,
       l.expires_at ASC, l.created_at ASC`,
    [itemId],
  ).map(serializeLot);
  const movements = all<any>(
    `SELECT m.*, loc.name AS location_name, u.name AS user_name FROM stock_movements m
     LEFT JOIN locations loc ON loc.id = m.location_id
     LEFT JOIN users u ON u.id = m.user_id
     WHERE m.item_id = ? ORDER BY m.created_at DESC LIMIT 80`,
    [itemId],
  ).map(serializeMovement);
  const priceHistory = all<any>(
    `SELECT normalized_price AS price, created_at AS at, unit FROM stock_movements
     WHERE item_id = ? AND normalized_price IS NOT NULL AND normalized_price > 0 AND type IN ('in','adjust')
     ORDER BY created_at ASC LIMIT 120`,
    [itemId],
  ).map((r) => ({ at: r.at, price: Number(r.price), unit: r.unit }));
  const recipes = all<any>(
    `SELECT DISTINCT r.id, r.title FROM recipes r
     JOIN recipe_ingredients ri ON ri.recipe_id = r.id
     WHERE r.house_id = ? AND (ri.item_id = ? OR LOWER(ri.name) = LOWER(?))`,
    [row.house_id, itemId, row.name],
  );
  return { ...item, lots, movements, priceHistory, recipes, priceStats: priceStats(itemId, item.unit) };
}

/* ---------------------------------------------------------------- locations */

inventoryRoutes.get(
  "/:houseId/locations",
  handler((req, res) => {
    const { houseId } = requireHouse(req);
    const rows = all<any>(
      `SELECT l.*, (SELECT COUNT(DISTINCT item_id) FROM stock_lots WHERE location_id = l.id) AS item_count
       FROM locations l WHERE l.house_id = ? ORDER BY l.name COLLATE NOCASE`,
      [houseId],
    );
    res.json(rows.map(serializeLocation));
  }),
);

inventoryRoutes.post(
  "/:houseId/locations",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "member");
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(60),
        kind: z.string().trim().max(30).optional(),
        icon: z.string().trim().max(8).nullish(),
        parentId: z.string().trim().max(60).nullish(),
      }),
      req.body,
    );
    const id = newId("loc");
    run("INSERT INTO locations (id, house_id, name, kind, icon, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      id,
      houseId,
      body.name,
      body.kind ?? "shelf",
      body.icon ?? null,
      body.parentId ?? null,
      now(),
    ]);
    res.status(201).json(serializeLocation(get<any>("SELECT * FROM locations WHERE id = ?", [id])));
  }),
);

inventoryRoutes.patch(
  "/:houseId/locations/:locationId",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "member");
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(60).optional(),
        kind: z.string().trim().max(30).optional(),
        icon: z.string().trim().max(8).nullish(),
        parentId: z.string().trim().max(60).nullish(),
      }),
      req.body,
    );
    const current = get<any>("SELECT * FROM locations WHERE id = ? AND house_id = ?", [req.params.locationId, houseId]);
    if (!current) throw new ApiError(404, "Location not found");
    run("UPDATE locations SET name = ?, kind = ?, icon = ?, parent_id = ? WHERE id = ?", [
      body.name ?? current.name,
      body.kind ?? current.kind,
      body.icon === undefined ? current.icon : body.icon,
      body.parentId === undefined ? current.parent_id : body.parentId,
      current.id,
    ]);
    res.json(serializeLocation(get<any>("SELECT * FROM locations WHERE id = ?", [current.id])));
  }),
);

inventoryRoutes.delete(
  "/:houseId/locations/:locationId",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "admin");
    run("DELETE FROM locations WHERE id = ? AND house_id = ?", [req.params.locationId, houseId]);
    res.json({ ok: true });
  }),
);

/* --------------------------------------------------------------- categories */

inventoryRoutes.get(
  "/:houseId/categories",
  handler((req, res) => {
    const { houseId } = requireHouse(req);
    const rows = all<any>(
      `SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id AND i.archived = 0) AS item_count
       FROM categories c WHERE c.house_id = ? ORDER BY c.name COLLATE NOCASE`,
      [houseId],
    );
    res.json(rows.map(serializeCategory));
  }),
);

inventoryRoutes.post(
  "/:houseId/categories",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "member");
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(60),
        icon: z.string().trim().max(8).nullish(),
        parentId: z.string().trim().max(60).nullish(),
      }),
      req.body,
    );
    const id = newId("cat");
    run("INSERT INTO categories (id, house_id, name, icon, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
      id,
      houseId,
      body.name,
      body.icon ?? null,
      body.parentId ?? null,
      now(),
    ]);
    res.status(201).json(serializeCategory(get<any>("SELECT * FROM categories WHERE id = ?", [id])));
  }),
);

inventoryRoutes.patch(
  "/:houseId/categories/:categoryId",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "member");
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(60).optional(),
        icon: z.string().trim().max(8).nullish(),
        parentId: z.string().trim().max(60).nullish(),
      }),
      req.body,
    );
    const current = get<any>("SELECT * FROM categories WHERE id = ? AND house_id = ?", [req.params.categoryId, houseId]);
    if (!current) throw new ApiError(404, "Category not found");
    run("UPDATE categories SET name = ?, icon = ?, parent_id = ? WHERE id = ?", [
      body.name ?? current.name,
      body.icon === undefined ? current.icon : body.icon,
      body.parentId === undefined ? current.parent_id : body.parentId,
      current.id,
    ]);
    res.json(serializeCategory(get<any>("SELECT * FROM categories WHERE id = ?", [current.id])));
  }),
);

inventoryRoutes.delete(
  "/:houseId/categories/:categoryId",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "admin");
    run("DELETE FROM categories WHERE id = ? AND house_id = ?", [req.params.categoryId, houseId]);
    res.json({ ok: true });
  }),
);

/* -------------------------------------------------------------- attributes */

inventoryRoutes.get(
  "/:houseId/attributes",
  handler((req, res) => {
    const { houseId } = requireHouse(req);
    res.json(
      all<any>("SELECT * FROM attribute_defs WHERE house_id = ? ORDER BY sort, label", [houseId]).map(serializeAttribute),
    );
  }),
);

const attributeBody = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, "Use lowercase letters, numbers and underscores"),
  label: z.string().trim().min(1).max(60),
  type: z.enum(["text", "number", "select", "date", "boolean", "url"]),
  unit: z.string().trim().max(20).nullish(),
  options: z.array(z.string().trim().max(40)).max(30).optional(),
  required: z.boolean().optional(),
  categoryId: z.string().trim().max(60).nullish(),
  sort: z.number().int().min(0).max(999).optional(),
});

inventoryRoutes.post(
  "/:houseId/attributes",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "admin");
    const body = parseBody(attributeBody, req.body);
    if (get("SELECT id FROM attribute_defs WHERE house_id = ? AND key = ?", [houseId, body.key])) {
      throw new ApiError(409, "An attribute with that key already exists");
    }
    const id = newId("att");
    run(
      `INSERT INTO attribute_defs (id, house_id, key, label, type, unit, options, required, category_id, sort, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        houseId,
        body.key,
        body.label,
        body.type,
        body.unit ?? null,
        JSON.stringify(body.options ?? []),
        body.required ? 1 : 0,
        body.categoryId ?? null,
        body.sort ?? 100,
        now(),
      ],
    );
    res.status(201).json(serializeAttribute(get<any>("SELECT * FROM attribute_defs WHERE id = ?", [id])));
  }),
);

inventoryRoutes.patch(
  "/:houseId/attributes/:attributeId",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "admin");
    const current = get<any>("SELECT * FROM attribute_defs WHERE id = ? AND house_id = ?", [
      req.params.attributeId,
      houseId,
    ]);
    if (!current) throw new ApiError(404, "Attribute not found");
    const body = parseBody(attributeBody.partial(), req.body);
    run(
      `UPDATE attribute_defs SET key = ?, label = ?, type = ?, unit = ?, options = ?, required = ?, category_id = ?, sort = ?
       WHERE id = ?`,
      [
        body.key ?? current.key,
        body.label ?? current.label,
        body.type ?? current.type,
        body.unit === undefined ? current.unit : body.unit,
        JSON.stringify(body.options ?? parseJson(current.options, [])),
        body.required === undefined ? current.required : body.required ? 1 : 0,
        body.categoryId === undefined ? current.category_id : body.categoryId,
        body.sort ?? current.sort,
        current.id,
      ],
    );
    res.json(serializeAttribute(get<any>("SELECT * FROM attribute_defs WHERE id = ?", [current.id])));
  }),
);

inventoryRoutes.delete(
  "/:houseId/attributes/:attributeId",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "admin");
    run("DELETE FROM attribute_defs WHERE id = ? AND house_id = ?", [req.params.attributeId, houseId]);
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------- items */

inventoryRoutes.get(
  "/:houseId/items",
  handler((req, res) => {
    const { houseId } = requireHouse(req);
    const q = String(req.query.q ?? "").trim();
    const categoryId = req.query.categoryId ? String(req.query.categoryId) : null;
    const locationId = req.query.locationId ? String(req.query.locationId) : null;
    const tag = req.query.tag ? String(req.query.tag) : null;
    const lowOnly = req.query.low === "1" || req.query.low === "true";
    const expiring = req.query.expiring === "1" || req.query.expiring === "true";
    const includeArchived = req.query.archived === "1";
    const sort = String(req.query.sort ?? "name");
    const limit = intParam(req.query.limit, 300, 1000);
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);

    const where: string[] = ["i.house_id = ?"];
    const params: unknown[] = [houseId];
    if (!includeArchived) where.push("i.archived = 0");
    if (categoryId) {
      where.push("i.category_id = ?");
      params.push(categoryId);
    }
    if (locationId) {
      where.push("EXISTS (SELECT 1 FROM stock_lots l WHERE l.item_id = i.id AND l.location_id = ? AND l.quantity > 0)");
      params.push(locationId);
    }
    if (tag) {
      where.push("i.tags LIKE ?");
      params.push(`%${tag}%`);
    }
    if (lowOnly) {
      where.push(
        `i.reorder_point > 0 AND (SELECT COALESCE(SUM(l.quantity),0) FROM stock_lots l WHERE l.item_id = i.id) <= i.reorder_point`,
      );
    }
    if (expiring) {
      where.push(
        `EXISTS (SELECT 1 FROM stock_lots l WHERE l.item_id = i.id AND l.quantity > 0 AND l.expires_at IS NOT NULL AND l.expires_at <= date('now', '+14 day'))`,
      );
    }
    if (q) {
      const like = `%${q}%`;
      where.push(
        `(i.name LIKE ? OR i.brand LIKE ? OR i.description LIKE ? OR EXISTS (SELECT 1 FROM item_barcodes b WHERE b.item_id = i.id AND b.code LIKE ?))`,
      );
      params.push(like, like, like, like);
    }
    const order =
      sort === "recent"
        ? "i.updated_at DESC"
        : sort === "quantity"
          ? "quantity ASC, i.name COLLATE NOCASE"
          : sort === "value"
            ? "value DESC, i.name COLLATE NOCASE"
            : "i.name COLLATE NOCASE";

    const rows = all<any>(`${ITEM_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset,
    ]);
    const total = Number(
      get<{ n: number }>(`SELECT COUNT(*) AS n FROM items i WHERE ${where.join(" AND ")}`, params)?.n ?? 0,
    );
    const barcodeMap = barcodesForHouse(houseId);
    res.json({ items: rows.map((r) => serializeItem(r, barcodeMap.get(r.id) ?? [])), total });
  }),
);

inventoryRoutes.post(
  "/:houseId/items",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "member");
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(120),
        description: z.string().trim().max(2000).nullish(),
        brand: z.string().trim().max(80).nullish(),
        categoryId: z.string().trim().max(60).nullish(),
        unit: z.string().trim().min(1).max(10).default("pcs"),
        reorderPoint: z.number().min(0).max(1e9).optional(),
        targetStock: z.number().min(0).max(1e9).nullish(),
        attributes: z.record(z.string(), z.any()).optional(),
        tags: z.union([z.array(z.string()), z.string()]).optional(),
        image: z.string().max(300).nullish(),
        barcodes: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
        initialStock: z
          .object({
            quantity: z.number().positive(),
            unit: z.string().max(10).optional(),
            unitPrice: z.number().min(0).nullish(),
            locationId: z.string().max(60).nullish(),
            expiresAt: z.string().max(10).nullish(),
            purchasedAt: z.string().max(10).nullish(),
            note: z.string().max(300).nullish(),
          })
          .optional(),
      }),
      req.body,
    );

    if (body.categoryId && !get("SELECT id FROM categories WHERE id = ? AND house_id = ?", [body.categoryId, houseId])) {
      throw new ApiError(400, "Category does not exist in this house");
    }

    const id = newId("itm");
    tx(() => {
      run(
        `INSERT INTO items (id, house_id, name, description, brand, category_id, unit, reorder_point, target_stock,
           attributes, tags, image, archived, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [
          id,
          houseId,
          body.name,
          body.description ?? null,
          body.brand ?? null,
          body.categoryId ?? null,
          body.unit.toLowerCase(),
          body.reorderPoint ?? 0,
          body.targetStock ?? null,
          JSON.stringify(body.attributes ?? {}),
          JSON.stringify(parseTags(body.tags)),
          body.image ?? null,
          req.user!.id,
          now(),
          now(),
        ],
      );
      for (const code of body.barcodes ?? []) {
        const trimmed = code.trim();
        if (!trimmed) continue;
        const conflict = get<any>(
          `SELECT i.name FROM item_barcodes b JOIN items i ON i.id = b.item_id WHERE b.house_id = ? AND b.code = ?`,
          [houseId, trimmed],
        );
        if (conflict) throw new ApiError(409, `Barcode ${trimmed} is already linked to ${conflict.name}`);
        run("INSERT INTO item_barcodes (id, item_id, house_id, code, format, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
          newId("bar"),
          id,
          houseId,
          trimmed,
          "manual",
          now(),
        ]);
      }
    });

    if (body.initialStock) {
      addStock({
        itemId: id,
        houseId,
        userId: req.user!.id,
        quantity: body.initialStock.quantity,
        unit: body.initialStock.unit ?? body.unit,
        unitPrice: body.initialStock.unitPrice ?? null,
        locationId: body.initialStock.locationId ?? null,
        expiresAt: body.initialStock.expiresAt ?? null,
        purchasedAt: body.initialStock.purchasedAt ?? null,
        note: body.initialStock.note ?? null,
        reason: "Initial stock",
      });
      afterStockChange(id);
    }

    res.status(201).json(itemDetail(id, req.user!.id));
  }),
);

/* ------------------------------------------------------------ single items */

export const itemRoutes = Router();
itemRoutes.use(requireAuth);

itemRoutes.get(
  "/:itemId",
  handler((req, res) => {
    const { item } = itemAccess(req);
    res.json(itemDetail(item.id, req.user!.id));
  }),
);

itemRoutes.patch(
  "/:itemId",
  handler((req, res) => {
    const { item } = itemAccess(req, "member");
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().trim().max(2000).nullish(),
        brand: z.string().trim().max(80).nullish(),
        categoryId: z.string().trim().max(60).nullish(),
        unit: z.string().trim().min(1).max(10).optional(),
        reorderPoint: z.number().min(0).max(1e9).optional(),
        targetStock: z.number().min(0).max(1e9).nullish(),
        attributes: z.record(z.string(), z.any()).optional(),
        tags: z.union([z.array(z.string()), z.string()]).optional(),
        image: z.string().max(300).nullish(),
        archived: z.boolean().optional(),
      }),
      req.body,
    );
    run(
      `UPDATE items SET name = ?, description = ?, brand = ?, category_id = ?, unit = ?, reorder_point = ?,
         target_stock = ?, attributes = ?, tags = ?, image = ?, archived = ?, updated_at = ? WHERE id = ?`,
      [
        body.name ?? item.name,
        body.description === undefined ? item.description : body.description,
        body.brand === undefined ? item.brand : body.brand,
        body.categoryId === undefined ? item.category_id : body.categoryId,
        (body.unit ?? item.unit).toLowerCase(),
        body.reorderPoint ?? item.reorder_point,
        body.targetStock === undefined ? item.target_stock : body.targetStock,
        JSON.stringify(body.attributes ?? parseJson(item.attributes, {})),
        JSON.stringify(body.tags === undefined ? parseJson(item.tags, []) : parseTags(body.tags)),
        body.image === undefined ? item.image : body.image,
        body.archived === undefined ? item.archived : body.archived ? 1 : 0,
        now(),
        item.id,
      ],
    );
    afterStockChange(item.id);
    res.json(itemDetail(item.id, req.user!.id));
  }),
);

itemRoutes.delete(
  "/:itemId",
  handler((req, res) => {
    const { item } = itemAccess(req, "member");
    run("DELETE FROM items WHERE id = ?", [item.id]);
    res.json({ ok: true });
  }),
);

itemRoutes.post(
  "/:itemId/stock",
  handler((req, res) => {
    const { item } = itemAccess(req, "member");
    const body = parseBody(
      z.object({
        action: z.enum(["add", "remove", "set", "waste", "move"]),
        quantity: z.number().min(0).max(1e9).optional(),
        target: z.number().min(0).max(1e9).optional(),
        unit: z.string().max(10).optional(),
        unitPrice: z.number().min(0).max(1e9).nullish(),
        currency: z.string().max(3).nullish(),
        locationId: z.string().max(60).nullish(),
        lotId: z.string().max(60).nullish(),
        expiresAt: z.string().max(10).nullish(),
        purchasedAt: z.string().max(10).nullish(),
        note: z.string().max(300).nullish(),
        reason: z.string().max(120).nullish(),
        fromLocationId: z.string().max(60).optional(),
        toLocationId: z.string().max(60).optional(),
      }),
      req.body,
    );
    const base = {
      itemId: item.id,
      houseId: item.house_id,
      userId: req.user!.id,
      quantity: body.quantity ?? 0,
      unit: body.unit,
      unitPrice: body.unitPrice ?? null,
      currency: body.currency ?? null,
      locationId: body.locationId ?? null,
      lotId: body.lotId ?? null,
      expiresAt: body.expiresAt ?? null,
      purchasedAt: body.purchasedAt ?? null,
      note: body.note ?? null,
      reason: body.reason ?? null,
    };
    if (body.action === "add") addStock(base);
    else if (body.action === "remove") removeStock(base);
    else if (body.action === "waste") removeStock({ ...base, waste: true });
    else if (body.action === "set") setStock({ ...base, target: body.target ?? 0 });
    else
      moveStock({
        itemId: item.id,
        houseId: item.house_id,
        userId: req.user!.id,
        quantity: body.quantity ?? 0,
        unit: body.unit,
        fromLocationId: body.fromLocationId ?? body.locationId ?? "",
        toLocationId: body.toLocationId ?? "",
        note: body.note ?? undefined,
      });
    afterStockChange(item.id);
    res.json(itemDetail(item.id, req.user!.id));
  }),
);

itemRoutes.get(
  "/:itemId/movements",
  handler((req, res) => {
    const { item } = itemAccess(req);
    const limit = intParam(req.query.limit, 50, 300);
    const rows = all<any>(
      `SELECT m.*, loc.name AS location_name, u.name AS user_name FROM stock_movements m
       LEFT JOIN locations loc ON loc.id = m.location_id
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.item_id = ? ORDER BY m.created_at DESC LIMIT ?`,
      [item.id, limit],
    );
    res.json(rows.map(serializeMovement));
  }),
);

itemRoutes.post(
  "/:itemId/image",
  uploader("items").single("image"),
  handler((req, res) => {
    const { item } = itemAccess(req, "member");
    if (!req.file) throw new ApiError(400, "No image uploaded");
    const url = `/uploads/items/${req.file.filename}`;
    run("UPDATE items SET image = ?, updated_at = ? WHERE id = ?", [url, now(), item.id]);
    res.json({ image: url });
  }),
);

itemRoutes.post(
  "/:itemId/barcodes",
  handler((req, res) => {
    const { item } = itemAccess(req, "member");
    const body = parseBody(z.object({ code: z.string().trim().min(1).max(80), format: z.string().max(30).optional() }), req.body);
    const conflict = get<any>(
      `SELECT i.name FROM item_barcodes b JOIN items i ON i.id = b.item_id WHERE b.house_id = ? AND b.code = ?`,
      [item.house_id, body.code],
    );
    if (conflict) throw new ApiError(409, `Barcode is already linked to ${conflict.name}`);
    run("INSERT INTO item_barcodes (id, item_id, house_id, code, format, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
      newId("bar"),
      item.id,
      item.house_id,
      body.code,
      body.format ?? "manual",
      now(),
    ]);
    res.status(201).json(itemDetail(item.id, req.user!.id));
  }),
);

itemRoutes.delete(
  "/:itemId/barcodes/:barcodeId",
  handler((req, res) => {
    const { item } = itemAccess(req, "member");
    run("DELETE FROM item_barcodes WHERE id = ? AND item_id = ?", [req.params.barcodeId, item.id]);
    res.json({ ok: true });
  }),
);

/* ----------------------------------------------------------- barcode scan */

const OFF_TIMEOUT = 6000;

async function openFoodFacts(code: string) {
  try {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,brands,quantity,image_front_small_url,categories,code,generic_name`,
      { signal: AbortSignal.timeout(OFF_TIMEOUT), headers: { "user-agent": "SVault/1.0 (home inventory)" } },
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    if (data?.status !== 1 || !data.product) return null;
    const p = data.product;
    return {
      name: p.product_name || p.generic_name || "",
      brand: p.brands || "",
      quantity: p.quantity || "",
      image: p.image_front_small_url || null,
      categories: p.categories || "",
      code: p.code || code,
    };
  } catch {
    return null;
  }
}

inventoryRoutes.get(
  "/:houseId/scan",
  handler(async (req, res) => {
    const { houseId } = requireHouse(req);
    const code = String(req.query.code ?? "").trim();
    if (!code) throw new ApiError(400, "Missing barcode");
    const row = get<any>(
      `${ITEM_SELECT} WHERE i.house_id = ? AND EXISTS (SELECT 1 FROM item_barcodes b WHERE b.item_id = i.id AND b.code = ?)`,
      [houseId, code],
    );
    if (row) {
      res.json({ code, match: "local", item: serializeItem(row, barcodesForItem(row.id)) });
      return;
    }
    const product = await openFoodFacts(code);
    res.json({ code, match: product ? "external" : "none", item: null, product });
  }),
);
