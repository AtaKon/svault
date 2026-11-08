import { Router } from "express";
import { z } from "zod";
import { all, get, newId, now, parseJson, run, tx } from "../db.js";
import { memberRole, requireAuth, roleAtLeast } from "../auth.js";
import { ApiError, handler, intParam, parseBody, requireHouse } from "../http.js";
import {
  ITEM_SELECT,
  barcodesForHouse,
  barcodesForItem,
  emptyEspressoSummary,
  priceStats,
  serializeAttribute,
  serializeCategory,
  serializeEspressoShot,
  serializeEspressoSummary,
  serializeItem,
  serializeLocation,
  serializeLot,
  serializeMovement,
} from "../serialize.js";
import { addStock, afterStockChange, itemQuantity, moveStock, removeStock, setStock } from "../services/stock.js";
import { clearItemNotifications } from "../services/notifications.js";
import { normaliseNutrition } from "../services/nutrition.js";
import { learnProductAlias } from "../services/product-aliases.js";
import {
  fetchOffProduct,
  fillItemFromOff,
  linkItemToOff,
  unlinkItemFromOff,
} from "../services/openfoodfacts.js";
import { uploader } from "../upload.js";
import { removeUnreferencedUploads } from "../services/upload-cleanup.js";
import { RESERVED_ATTRIBUTE_KEYS, type Role } from "../../shared/types.js";

export const inventoryRoutes = Router();
inventoryRoutes.use(requireAuth);

const RESERVED_ATTRIBUTE_KEY_SET = new Set<string>(RESERVED_ATTRIBUTE_KEYS);

const nutritionBody = z
  .object({
    basis: z.enum(["100g", "100ml"]).optional(),
    energyKcal: z.number().min(0).max(1e6).nullish(),
    energyKj: z.number().min(0).max(1e6).nullish(),
    fat: z.number().min(0).max(1e6).nullish(),
    saturatedFat: z.number().min(0).max(1e6).nullish(),
    carbohydrates: z.number().min(0).max(1e6).nullish(),
    sugars: z.number().min(0).max(1e6).nullish(),
    fiber: z.number().min(0).max(1e6).nullish(),
    proteins: z.number().min(0).max(1e6).nullish(),
    salt: z.number().min(0).max(1e6).nullish(),
    sodium: z.number().min(0).max(1e6).nullish(),
    servingSize: z.string().trim().max(60).nullish(),
    servingQuantity: z.number().min(0).max(1e6).nullish(),
    source: z.enum(["openfoodfacts", "manual"]).optional(),
  })
  .nullish();

/* ------------------------------------------------------------------ helpers */

async function itemAccess(req: any, minRole: Role = "viewer") {
  const item = await get<any>("SELECT * FROM items WHERE id = ?", [req.params.itemId]);
  if (!item) throw new ApiError(404, "Item not found");
  const role = await memberRole(req.user!.id, item.house_id);
  if (!role) throw new ApiError(404, "Item not found");
  if (!roleAtLeast(role, minRole)) throw new ApiError(403, `Requires ${minRole} access`);
  return { item, houseId: item.house_id as string, role };
}

/**
 * Keep custom attributes free of keys that already have a first-class item
 * column. A legacy `brand` attribute is folded into the brand column instead of
 * being dropped.
 */
function normalizeItemAttributes(
  input: Record<string, unknown> | undefined,
  brand: string | null | undefined,
): { attributes: Record<string, unknown>; brand: string | null } {
  const attributes = { ...(input ?? {}) };
  const legacyBrand = attributes.brand;
  for (const key of RESERVED_ATTRIBUTE_KEYS) delete attributes[key];
  if (brand !== undefined) {
    return { attributes, brand: typeof brand === "string" ? brand.trim() || null : null };
  }
  const fallbackBrand =
    typeof legacyBrand === "string" ? legacyBrand.trim() : legacyBrand == null ? "" : String(legacyBrand).trim();
  return { attributes, brand: fallbackBrand || null };
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

/* --------------------------------------------------------------- espresso log */

const espressoShotBody = z.object({
  brewedAt: z.string().trim().min(1).max(40).nullish(),
  rating: z.number().int().min(1).max(5),
  roastLevel: z.enum(["light", "medium-light", "medium", "medium-dark", "dark"]).nullish(),
  grindSetting: z.string().trim().max(40).nullish(),
  grindSeconds: z.number().min(0).max(600).nullish(),
  doseGrams: z.number().min(0).max(200).nullish(),
  yieldGrams: z.number().min(0).max(500).nullish(),
  extractionSeconds: z.number().min(0).max(600).nullish(),
  waterTempC: z.number().min(0).max(120).nullish(),
  pressureBar: z.number().min(0).max(20).nullish(),
  tdsPercent: z.number().min(0).max(100).nullish(),
  grinder: z.string().trim().max(80).nullish(),
  machine: z.string().trim().max(80).nullish(),
  tastingNotes: z.string().trim().max(500).nullish(),
  tags: z.union([z.array(z.string().trim().max(40)).max(20), z.string().max(400)]).optional(),
  notes: z.string().trim().max(2000).nullish(),
});

export function espressoBrewedAt(value: string | null | undefined, nowMs = Date.now()): string {
  if (value === null) throw new ApiError(400, "Brew date cannot be cleared");
  if (value === undefined) return new Date(nowMs).toISOString();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new ApiError(400, "Invalid brew date");
  const earliest = Date.parse("2000-01-01T00:00:00.000Z");
  const latest = nowMs + 864e5;
  if (timestamp < earliest || timestamp > latest) {
    throw new ApiError(400, "Brew date is out of range");
  }
  return new Date(timestamp).toISOString();
}

/** Reject over-limit tags instead of silently truncating or dropping them. */
function parseEspressoTags(value: unknown): string[] {
  let tags: string[];
  if (Array.isArray(value)) {
    tags = value.map((tag) => String(tag).trim()).filter(Boolean);
  } else if (typeof value === "string") {
    tags = value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  } else {
    tags = [];
  }
  if (tags.length > 20) throw new ApiError(400, "Use at most 20 flavour tags");
  if (tags.some((tag) => tag.length > 40)) {
    throw new ApiError(400, "Each flavour tag must be 40 characters or fewer");
  }
  return tags;
}

async function espressoSummary(houseId: string, itemId?: string) {
  const params: unknown[] = [houseId];
  let sql = `SELECT COUNT(*) AS count, AVG(rating) AS average_rating, MAX(rating) AS best_rating,
      MAX(brewed_at) AS last_brewed_at, AVG(CASE WHEN dose_grams > 0 THEN dose_grams END) AS average_dose_grams,
      AVG(CASE WHEN yield_grams > 0 THEN yield_grams END) AS average_yield_grams,
      AVG(extraction_seconds) AS average_extraction_seconds,
      AVG(CASE WHEN dose_grams > 0 AND yield_grams IS NOT NULL
        THEN yield_grams / NULLIF(dose_grams, 0) END) AS average_ratio,
      AVG(CASE WHEN dose_grams > 0 AND yield_grams IS NOT NULL AND tds_percent IS NOT NULL
        THEN yield_grams * tds_percent / NULLIF(dose_grams, 0) END) AS average_extraction_yield_percent
    FROM espresso_shots WHERE house_id = ?`;
  if (itemId) {
    sql += " AND item_id = ?";
    params.push(itemId);
  }
  const row = await get<any>(sql, params);
  if (!row || Number(row.count ?? 0) === 0) return emptyEspressoSummary();
  return serializeEspressoSummary(row);
}

async function espressoShots(houseId: string, itemId: string | null, limit: number) {
  const params: unknown[] = [houseId];
  let sql = `SELECT s.*, i.name AS item_name, i.brand AS item_brand, u.name AS user_name
    FROM espresso_shots s
    JOIN items i ON i.id = s.item_id
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.house_id = ?`;
  if (itemId) {
    sql += " AND s.item_id = ?";
    params.push(itemId);
  }
  sql += " ORDER BY s.brewed_at DESC, s.created_at DESC LIMIT ?";
  params.push(limit);
  return (await all<any>(sql, params)).map(serializeEspressoShot);
}

async function shotAccess(req: any, minRole: Role = "member") {
  const { item, houseId, role } = await itemAccess(req, minRole);
  const shot = await get<any>("SELECT * FROM espresso_shots WHERE id = ? AND item_id = ? AND house_id = ?", [
    req.params.shotId,
    item.id,
    item.house_id,
  ]);
  if (!shot) throw new ApiError(404, "Shot not found");
  return { shot, item, houseId, role };
}

function canChangeShot(shot: any, userId: string, role: Role) {
  return shot.user_id === userId || roleAtLeast(role, "admin");
}

async function itemDetail(itemId: string, userId: string) {
  const row = await get<any>(`${ITEM_SELECT} WHERE i.id = ?`, [itemId]);
  if (!row) throw new ApiError(404, "Item not found");
  void userId;
  const item = serializeItem(row, await barcodesForItem(itemId));
  const lots = (await all<any>(
    `SELECT l.*, loc.name AS location_name, v.name AS vendor_name FROM stock_lots l
     LEFT JOIN locations loc ON loc.id = l.location_id
     LEFT JOIN vendors v ON v.id = l.vendor_id
     WHERE l.item_id = ?
     ORDER BY CASE WHEN l.quantity > 0 THEN 0 ELSE 1 END, CASE WHEN l.expires_at IS NULL THEN 1 ELSE 0 END,
       l.expires_at ASC, l.created_at ASC`,
    [itemId],
  )).map(serializeLot);
  const movements = (await all<any>(
    `SELECT m.*, loc.name AS location_name, u.name AS user_name, v.name AS vendor_name FROM stock_movements m
     LEFT JOIN locations loc ON loc.id = m.location_id
     LEFT JOIN users u ON u.id = m.user_id
     LEFT JOIN vendors v ON v.id = m.vendor_id
     WHERE m.item_id = ? ORDER BY m.created_at DESC LIMIT 80`,
    [itemId],
  )).map(serializeMovement);
  const priceHistory = (await all<any>(
    `SELECT m.normalized_price AS price, m.created_at AS at, m.unit, m.quantity, m.unit_price,
       m.vendor_id, v.name AS vendor_name, m.receipt_id, m.note
     FROM stock_movements m LEFT JOIN vendors v ON v.id = m.vendor_id
     WHERE m.item_id = ? AND m.normalized_price IS NOT NULL AND m.normalized_price > 0 AND m.type = 'in'
     ORDER BY m.created_at ASC LIMIT 300`,
    [itemId],
  )).map((r) => ({
    at: r.at,
    price: Number(r.price),
    unit: r.unit,
    quantity: Number(r.quantity ?? 0),
    unitPrice: r.unit_price == null ? null : Number(r.unit_price),
    vendorId: r.vendor_id ?? null,
    vendorName: r.vendor_name ?? null,
    receiptId: r.receipt_id ?? null,
    note: r.note ?? null,
  }));
  const recipes = await all<any>(
    `SELECT DISTINCT r.id, r.title FROM recipes r
     JOIN recipe_ingredients ri ON ri.recipe_id = r.id
     WHERE r.house_id = ? AND (ri.item_id = ? OR LOWER(ri.name) = LOWER(?))`,
    [row.house_id, itemId, row.name],
  );
  return { ...item, lots, movements, priceHistory, recipes, priceStats: await priceStats(itemId, item.unit) };
}

/* ---------------------------------------------------------------- locations */

inventoryRoutes.get(
  "/:houseId/locations",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    const rows = await all<any>(
      `SELECT l.*, (SELECT COUNT(DISTINCT item_id) FROM stock_lots WHERE location_id = l.id) AS item_count
       FROM locations l WHERE l.house_id = ? ORDER BY lower(l.name)`,
      [houseId],
    );
    res.json(rows.map(serializeLocation));
  }),
);

inventoryRoutes.post(
  "/:houseId/locations",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
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
    await run("INSERT INTO locations (id, house_id, name, kind, icon, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      id,
      houseId,
      body.name,
      body.kind ?? "shelf",
      body.icon ?? null,
      body.parentId ?? null,
      now(),
    ]);
    res.status(201).json(serializeLocation(await get<any>("SELECT * FROM locations WHERE id = ?", [id])));
  }),
);

inventoryRoutes.patch(
  "/:houseId/locations/:locationId",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(60).optional(),
        kind: z.string().trim().max(30).optional(),
        icon: z.string().trim().max(8).nullish(),
        parentId: z.string().trim().max(60).nullish(),
      }),
      req.body,
    );
    const current = await get<any>("SELECT * FROM locations WHERE id = ? AND house_id = ?", [req.params.locationId, houseId]);
    if (!current) throw new ApiError(404, "Location not found");
    await run("UPDATE locations SET name = ?, kind = ?, icon = ?, parent_id = ? WHERE id = ?", [
      body.name ?? current.name,
      body.kind ?? current.kind,
      body.icon === undefined ? current.icon : body.icon,
      body.parentId === undefined ? current.parent_id : body.parentId,
      current.id,
    ]);
    res.json(serializeLocation(await get<any>("SELECT * FROM locations WHERE id = ?", [current.id])));
  }),
);

inventoryRoutes.delete(
  "/:houseId/locations/:locationId",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "admin");
    await run("DELETE FROM locations WHERE id = ? AND house_id = ?", [req.params.locationId, houseId]);
    res.json({ ok: true });
  }),
);

/* --------------------------------------------------------------- categories */

inventoryRoutes.get(
  "/:houseId/categories",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    const rows = await all<any>(
      `SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id AND i.archived = 0) AS item_count
       FROM categories c WHERE c.house_id = ? ORDER BY lower(c.name)`,
      [houseId],
    );
    res.json(rows.map(serializeCategory));
  }),
);

inventoryRoutes.post(
  "/:houseId/categories",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(60),
        icon: z.string().trim().max(8).nullish(),
        parentId: z.string().trim().max(60).nullish(),
      }),
      req.body,
    );
    const id = newId("cat");
    await run("INSERT INTO categories (id, house_id, name, icon, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
      id,
      houseId,
      body.name,
      body.icon ?? null,
      body.parentId ?? null,
      now(),
    ]);
    res.status(201).json(serializeCategory(await get<any>("SELECT * FROM categories WHERE id = ?", [id])));
  }),
);

inventoryRoutes.patch(
  "/:houseId/categories/:categoryId",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(60).optional(),
        icon: z.string().trim().max(8).nullish(),
        parentId: z.string().trim().max(60).nullish(),
      }),
      req.body,
    );
    const current = await get<any>("SELECT * FROM categories WHERE id = ? AND house_id = ?", [req.params.categoryId, houseId]);
    if (!current) throw new ApiError(404, "Category not found");
    await run("UPDATE categories SET name = ?, icon = ?, parent_id = ? WHERE id = ?", [
      body.name ?? current.name,
      body.icon === undefined ? current.icon : body.icon,
      body.parentId === undefined ? current.parent_id : body.parentId,
      current.id,
    ]);
    res.json(serializeCategory(await get<any>("SELECT * FROM categories WHERE id = ?", [current.id])));
  }),
);

inventoryRoutes.delete(
  "/:houseId/categories/:categoryId",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "admin");
    await run("DELETE FROM categories WHERE id = ? AND house_id = ?", [req.params.categoryId, houseId]);
    res.json({ ok: true });
  }),
);

/* -------------------------------------------------------------- attributes */

inventoryRoutes.get(
  "/:houseId/attributes",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    res.json(
      (await all<any>("SELECT * FROM attribute_defs WHERE house_id = ? ORDER BY sort, label", [houseId]))
        .filter((row) => !RESERVED_ATTRIBUTE_KEY_SET.has(String(row.key)))
        .map(serializeAttribute),
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
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "admin");
    const body = parseBody(attributeBody, req.body);
    if (RESERVED_ATTRIBUTE_KEY_SET.has(body.key)) {
      throw new ApiError(400, `"${body.key}" is a built-in item field and cannot be a custom attribute`);
    }
    if (await get("SELECT id FROM attribute_defs WHERE house_id = ? AND key = ?", [houseId, body.key])) {
      throw new ApiError(409, "An attribute with that key already exists");
    }
    const id = newId("att");
    await run(
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
    res.status(201).json(serializeAttribute(await get<any>("SELECT * FROM attribute_defs WHERE id = ?", [id])));
  }),
);

inventoryRoutes.patch(
  "/:houseId/attributes/:attributeId",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "admin");
    const current = await get<any>("SELECT * FROM attribute_defs WHERE id = ? AND house_id = ?", [
      req.params.attributeId,
      houseId,
    ]);
    if (!current) throw new ApiError(404, "Attribute not found");
    const body = parseBody(attributeBody.partial(), req.body);
    if (body.key && RESERVED_ATTRIBUTE_KEY_SET.has(body.key)) {
      throw new ApiError(400, `"${body.key}" is a built-in item field and cannot be a custom attribute`);
    }
    await run(
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
    res.json(serializeAttribute(await get<any>("SELECT * FROM attribute_defs WHERE id = ?", [current.id])));
  }),
);

inventoryRoutes.delete(
  "/:houseId/attributes/:attributeId",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "admin");
    await run("DELETE FROM attribute_defs WHERE id = ? AND house_id = ?", [req.params.attributeId, houseId]);
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------- items */

inventoryRoutes.get(
  "/:houseId/items",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
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
      where.push("lower(i.tags) LIKE lower(?)");
      params.push(`%${tag}%`);
    }
    if (lowOnly) {
      where.push(
        `i.reorder_point > 0 AND (SELECT COALESCE(SUM(l.quantity),0) FROM stock_lots l WHERE l.item_id = i.id) <= i.reorder_point`,
      );
    }
    if (expiring) {
      const horizon = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
      where.push(
        `EXISTS (SELECT 1 FROM stock_lots l WHERE l.item_id = i.id AND l.quantity > 0 AND l.expires_at IS NOT NULL AND l.expires_at <= ?)`,
      );
      params.push(horizon);
    }
    if (q) {
      const like = `%${q}%`;
      where.push(
        `(lower(i.name) LIKE lower(?) OR lower(i.brand) LIKE lower(?) OR lower(i.description) LIKE lower(?) OR EXISTS (SELECT 1 FROM item_barcodes b WHERE b.item_id = i.id AND lower(b.code) LIKE lower(?)))`,
      );
      params.push(like, like, like, like);
    }
    const order =
      sort === "recent"
        ? "i.updated_at DESC"
        : sort === "quantity"
          ? "quantity ASC, lower(i.name)"
          : sort === "value"
            ? "value DESC, lower(i.name)"
            : "lower(i.name)";

    const rows = await all<any>(`${ITEM_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset,
    ]);
    const total = Number(
      (await get<{ n: number }>(`SELECT COUNT(*) AS n FROM items i WHERE ${where.join(" AND ")}`, params))?.n ?? 0,
    );
    const barcodeMap = await barcodesForHouse(houseId);
    res.json({ items: rows.map((r) => serializeItem(r, barcodeMap.get(r.id) ?? [])), total });
  }),
);

inventoryRoutes.post(
  "/:houseId/items",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
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
        nutrition: nutritionBody,
        /** Coffee item that keeps an espresso shot log. */
        espresso: z.boolean().optional(),
        barcodes: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
        offCode: z.string().trim().max(80).nullish(),
        initialStock: z
          .object({
            quantity: z.number().positive(),
            unit: z.string().max(10).optional(),
            unitPrice: z.number().min(0).nullish(),
            locationId: z.string().max(60).nullish(),
            expiresAt: z.string().max(10).nullish(),
            purchasedAt: z.string().max(10).nullish(),
            note: z.string().max(300).nullish(),
            vendorId: z.string().max(60).nullish(),
          })
          .optional(),
      }),
      req.body,
    );

    if (body.categoryId && !await get("SELECT id FROM categories WHERE id = ? AND house_id = ?", [body.categoryId, houseId])) {
      throw new ApiError(400, "Category does not exist in this house");
    }
    if (body.initialStock?.vendorId && !await get("SELECT id FROM vendors WHERE id = ? AND house_id = ?", [body.initialStock.vendorId, houseId])) {
      throw new ApiError(400, "Shop does not exist in this house");
    }

    const normalized = normalizeItemAttributes(body.attributes, body.brand);
    const nutrition = normaliseNutrition(body.nutrition);
    const id = newId("itm");
    await tx(async () => {
      await run(
        `INSERT INTO items (id, house_id, name, description, brand, category_id, unit, reorder_point, target_stock,
           attributes, tags, image, nutrition, espresso, archived, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [
          id,
          houseId,
          body.name,
          body.description ?? null,
          normalized.brand,
          body.categoryId ?? null,
          body.unit.toLowerCase(),
          body.reorderPoint ?? 0,
          body.targetStock ?? null,
          JSON.stringify(normalized.attributes),
          JSON.stringify(parseTags(body.tags)),
          body.image ?? null,
          nutrition ? JSON.stringify(nutrition) : null,
          body.espresso ? 1 : 0,
          req.user!.id,
          now(),
          now(),
        ],
      );
      for (const code of body.barcodes ?? []) {
        const trimmed = code.trim();
        if (!trimmed) continue;
        const conflict = await get<any>(
          `SELECT i.name FROM item_barcodes b JOIN items i ON i.id = b.item_id WHERE b.house_id = ? AND b.code = ?`,
          [houseId, trimmed],
        );
        if (conflict) throw new ApiError(409, `Barcode ${trimmed} is already linked to ${conflict.name}`);
        await run("INSERT INTO item_barcodes (id, item_id, house_id, code, format, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
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
      await addStock({
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
        vendorId: body.initialStock.vendorId ?? null,
        reason: "Initial stock",
      });
      await afterStockChange(id);
    }

    if (body.offCode) {
      const product = await fetchOffProduct(body.offCode);
      if (product) {
        const item = await get<any>("SELECT * FROM items WHERE id = ?", [id]);
        try {
          await linkItemToOff({ item, product, source: "manual" });
        } catch {
          // The product may already be linked to another item; the new item is
          // still valid, so creation must not fail after the insert.
        }
      }
    }

    res.status(201).json(await itemDetail(id, req.user!.id));
  }),
);

/* --------------------------------------------------------------- espresso log */

inventoryRoutes.get(
  "/:houseId/espresso-shots",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    const itemId = req.query.itemId ? String(req.query.itemId) : null;
    if (itemId) {
      const item = await get<any>("SELECT id FROM items WHERE id = ? AND house_id = ?", [itemId, houseId]);
      if (!item) throw new ApiError(404, "Item not found");
    }
    const limit = intParam(req.query.limit, 200, 500);
    const [shots, summary, beanRows] = await Promise.all([
      espressoShots(houseId, itemId, limit),
      espressoSummary(houseId, itemId ?? undefined),
      all<any>(
        `SELECT i.id, i.name, i.brand, i.espresso,
           (SELECT COUNT(*) FROM espresso_shots s WHERE s.item_id = i.id AND s.house_id = i.house_id) AS shot_count,
           (SELECT AVG(s.rating) FROM espresso_shots s WHERE s.item_id = i.id AND s.house_id = i.house_id) AS average_rating,
           (SELECT MAX(s.brewed_at) FROM espresso_shots s WHERE s.item_id = i.id AND s.house_id = i.house_id) AS last_brewed_at
         FROM items i
         WHERE i.house_id = ? AND i.archived = 0
           AND (i.espresso = 1 OR EXISTS (SELECT 1 FROM espresso_shots s WHERE s.item_id = i.id AND s.house_id = i.house_id))
         ORDER BY lower(i.name)`,
        [houseId],
      ),
    ]);
    res.json({
      shots,
      summary,
      beans: beanRows.map((row) => ({
        id: row.id,
        name: row.name,
        brand: row.brand ?? null,
        espresso: Boolean(Number(row.espresso)),
        shotCount: Number(row.shot_count ?? 0),
        averageRating:
          row.average_rating == null ? null : Math.round(Number(row.average_rating) * 10) / 10,
        lastBrewedAt: row.last_brewed_at ?? null,
      })),
    });
  }),
);

/* ------------------------------------------------------------ single items */

export const itemRoutes = Router();
itemRoutes.use(requireAuth);

itemRoutes.get(
  "/:itemId",
  handler(async (req, res) => {
    const { item } = await itemAccess(req);
    res.json(await itemDetail(item.id, req.user!.id));
  }),
);

itemRoutes.patch(
  "/:itemId",
  handler(async (req, res) => {
    const { item } = await itemAccess(req, "member");
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
        nutrition: nutritionBody,
        archived: z.boolean().optional(),
        espresso: z.boolean().optional(),
        offCode: z.string().trim().max(80).nullish(),
      }),
      req.body,
    );
    const normalized = normalizeItemAttributes(
      body.attributes ?? parseJson<Record<string, unknown>>(item.attributes, {}),
      body.brand === undefined ? (item.brand ?? undefined) : body.brand,
    );
    const nutrition =
      body.nutrition === undefined
        ? item.nutrition
        : body.nutrition === null
          ? null
          : (() => {
              const normalizedNutrition = normaliseNutrition(body.nutrition);
              return normalizedNutrition ? JSON.stringify(normalizedNutrition) : null;
            })();
    await run(
      `UPDATE items SET name = ?, description = ?, brand = ?, category_id = ?, unit = ?, reorder_point = ?,
         target_stock = ?, attributes = ?, tags = ?, image = ?, nutrition = ?, espresso = ?, archived = ?, updated_at = ? WHERE id = ?`,
      [
        body.name ?? item.name,
        body.description === undefined ? item.description : body.description,
        normalized.brand,
        body.categoryId === undefined ? item.category_id : body.categoryId,
        (body.unit ?? item.unit).toLowerCase(),
        body.reorderPoint ?? item.reorder_point,
        body.targetStock === undefined ? item.target_stock : body.targetStock,
        JSON.stringify(normalized.attributes),
        JSON.stringify(body.tags === undefined ? parseJson(item.tags, []) : parseTags(body.tags)),
        body.image === undefined ? item.image : body.image,
        nutrition,
        body.espresso === undefined ? item.espresso : body.espresso ? 1 : 0,
        body.archived === undefined ? item.archived : body.archived ? 1 : 0,
        now(),
        item.id,
      ],
    );
    await afterStockChange(item.id);
    if (body.offCode !== undefined) {
      if (body.offCode === null || body.offCode === "") {
        await unlinkItemFromOff(item.id);
      } else {
        const product = await fetchOffProduct(body.offCode);
        if (product) {
          const current = await get<any>("SELECT * FROM items WHERE id = ?", [item.id]);
          await linkItemToOff({ item: current, product, source: "manual" });
        }
      }
    }
    res.json(await itemDetail(item.id, req.user!.id));
  }),
);

itemRoutes.delete(
  "/:itemId",
  handler(async (req, res) => {
    const { item } = await itemAccess(req, "member");
    await run("DELETE FROM items WHERE id = ?", [item.id]);
    await clearItemNotifications(item.id);
    await removeUnreferencedUploads([item.image]);
    res.json({ ok: true });
  }),
);

itemRoutes.post(
  "/:itemId/stock",
  handler(async (req, res) => {
    const { item } = await itemAccess(req, "member");
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
        vendorId: z.string().max(60).nullish(),
        idempotencyKey: z.string().min(8).max(120).optional(),
        baseUpdatedAt: z.string().max(40).optional(),
      }),
      req.body,
    );
    if (body.idempotencyKey) {
      const previous = await get<any>("SELECT response FROM stock_mutations WHERE house_id = ? AND idempotency_key = ?", [
        item.house_id,
        body.idempotencyKey,
      ]);
      if (previous) {
        res.json(parseJson(previous.response, {}));
        return;
      }
    }
    if (body.action === "set" && body.baseUpdatedAt && item.updated_at > body.baseUpdatedAt) {
      throw new ApiError(409, "This count is older than a newer server change", {
        conflict: true,
        currentUpdatedAt: item.updated_at,
        currentQuantity: await itemQuantity(item.id),
        baseUpdatedAt: body.baseUpdatedAt,
      });
    }
    if (body.vendorId && !await get("SELECT id FROM vendors WHERE id = ? AND house_id = ?", [body.vendorId, item.house_id])) {
      throw new ApiError(400, "Shop does not exist in this house");
    }
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
      vendorId: body.vendorId ?? null,
    };
    const detail = await tx(async () => {
      if (body.action === "add") await addStock(base);
      else if (body.action === "remove") await removeStock(base);
      else if (body.action === "waste") await removeStock({ ...base, waste: true });
      else if (body.action === "set") await setStock({ ...base, target: body.target ?? 0 });
      else
        await moveStock({
          itemId: item.id,
          houseId: item.house_id,
          userId: req.user!.id,
          quantity: body.quantity ?? 0,
          unit: body.unit,
          fromLocationId: body.fromLocationId ?? body.locationId ?? "",
          toLocationId: body.toLocationId ?? "",
          note: body.note ?? undefined,
        });
      const result = await itemDetail(item.id, req.user!.id);
      if (body.idempotencyKey) {
        await run(
          "INSERT INTO stock_mutations (id, house_id, idempotency_key, user_id, response, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
          [newId("mut"), item.house_id, body.idempotencyKey, req.user!.id, JSON.stringify(result), now()],
        );
      }
      return result;
    });
    await afterStockChange(item.id);
    res.json(detail);
  }),
);

itemRoutes.get(
  "/:itemId/movements",
  handler(async (req, res) => {
    const { item } = await itemAccess(req);
    const limit = intParam(req.query.limit, 50, 300);
    const rows = await all<any>(
      `SELECT m.*, loc.name AS location_name, u.name AS user_name, v.name AS vendor_name FROM stock_movements m
       LEFT JOIN locations loc ON loc.id = m.location_id
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN vendors v ON v.id = m.vendor_id
       WHERE m.item_id = ? ORDER BY m.created_at DESC LIMIT ?`,
      [item.id, limit],
    );
    res.json(rows.map(serializeMovement));
  }),
);

itemRoutes.post(
  "/:itemId/image",
  uploader("items", (req) => itemAccess(req, "member")).single("image"),
  handler(async (req, res) => {
    const { item } = await itemAccess(req, "member");
    if (!req.file) throw new ApiError(400, "No image uploaded");
    const url = `/uploads/items/${req.file.filename}`;
    await run("UPDATE items SET image = ?, updated_at = ? WHERE id = ?", [url, now(), item.id]);
    await removeUnreferencedUploads([item.image]);
    res.json({ image: url });
  }),
);

itemRoutes.post(
  "/:itemId/barcodes",
  handler(async (req, res) => {
    const { item } = await itemAccess(req, "member");
    const body = parseBody(z.object({ code: z.string().trim().min(1).max(80), format: z.string().max(30).optional() }), req.body);
    const conflict = await get<any>(
      `SELECT i.name FROM item_barcodes b JOIN items i ON i.id = b.item_id WHERE b.house_id = ? AND b.code = ?`,
      [item.house_id, body.code],
    );
    if (conflict) throw new ApiError(409, `Barcode is already linked to ${conflict.name}`);
    await run("INSERT INTO item_barcodes (id, item_id, house_id, code, format, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
      newId("bar"),
      item.id,
      item.house_id,
      body.code,
      body.format ?? "manual",
      now(),
    ]);
    res.status(201).json(await itemDetail(item.id, req.user!.id));
  }),
);

itemRoutes.delete(
  "/:itemId/barcodes/:barcodeId",
  handler(async (req, res) => {
    const { item } = await itemAccess(req, "member");
    await run("DELETE FROM item_barcodes WHERE id = ? AND item_id = ?", [req.params.barcodeId, item.id]);
    res.json({ ok: true });
  }),
);

/* ---------------------------------------------------------- espresso shots */

itemRoutes.get(
  "/:itemId/espresso-shots",
  handler(async (req, res) => {
    const { item } = await itemAccess(req);
    const limit = intParam(req.query.limit, 200, 500);
    const [shots, summary] = await Promise.all([
      espressoShots(item.house_id, item.id, limit),
      espressoSummary(item.house_id, item.id),
    ]);
    res.json({ shots, summary });
  }),
);

itemRoutes.post(
  "/:itemId/espresso-shots",
  handler(async (req, res) => {
    const { item } = await itemAccess(req, "member");
    if (!item.espresso) {
      throw new ApiError(400, "Turn on espresso logging for this item first");
    }
    const body = parseBody(espressoShotBody, req.body);
    const id = newId("esp");
    const stamp = now();
    await run(
      `INSERT INTO espresso_shots (id, house_id, item_id, user_id, brewed_at, rating, roast_level, grind_setting,
         grind_seconds, dose_grams, yield_grams, extraction_seconds, water_temp_c, pressure_bar, tds_percent,
         grinder, machine, tasting_notes, tags, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        item.house_id,
        item.id,
        req.user!.id,
        espressoBrewedAt(body.brewedAt),
        body.rating,
        body.roastLevel ?? null,
        body.grindSetting ?? null,
        body.grindSeconds ?? null,
        body.doseGrams ?? null,
        body.yieldGrams ?? null,
        body.extractionSeconds ?? null,
        body.waterTempC ?? null,
        body.pressureBar ?? null,
        body.tdsPercent ?? null,
        body.grinder ?? null,
        body.machine ?? null,
        body.tastingNotes ?? null,
        JSON.stringify(parseEspressoTags(body.tags)),
        body.notes ?? null,
        stamp,
        stamp,
      ],
    );
    const created = await get<any>(
      `SELECT s.*, i.name AS item_name, i.brand AS item_brand, u.name AS user_name
       FROM espresso_shots s
       JOIN items i ON i.id = s.item_id
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
      [id],
    );
    res.status(201).json(serializeEspressoShot(created));
  }),
);

itemRoutes.patch(
  "/:itemId/espresso-shots/:shotId",
  handler(async (req, res) => {
    const { shot, role } = await shotAccess(req, "member");
    if (!canChangeShot(shot, req.user!.id, role)) {
      throw new ApiError(403, "You can only edit your own shots");
    }
    const body = parseBody(espressoShotBody.partial(), req.body);
    await run(
      `UPDATE espresso_shots SET brewed_at = ?, rating = ?, roast_level = ?, grind_setting = ?, grind_seconds = ?,
         dose_grams = ?, yield_grams = ?, extraction_seconds = ?, water_temp_c = ?, pressure_bar = ?, tds_percent = ?,
         grinder = ?, machine = ?, tasting_notes = ?, tags = ?, notes = ?, updated_at = ? WHERE id = ? AND item_id = ? AND house_id = ?`,
      [
        body.brewedAt === undefined ? shot.brewed_at : espressoBrewedAt(body.brewedAt),
        body.rating === undefined ? shot.rating : body.rating,
        body.roastLevel === undefined ? shot.roast_level : body.roastLevel,
        body.grindSetting === undefined ? shot.grind_setting : body.grindSetting,
        body.grindSeconds === undefined ? shot.grind_seconds : body.grindSeconds,
        body.doseGrams === undefined ? shot.dose_grams : body.doseGrams,
        body.yieldGrams === undefined ? shot.yield_grams : body.yieldGrams,
        body.extractionSeconds === undefined ? shot.extraction_seconds : body.extractionSeconds,
        body.waterTempC === undefined ? shot.water_temp_c : body.waterTempC,
        body.pressureBar === undefined ? shot.pressure_bar : body.pressureBar,
        body.tdsPercent === undefined ? shot.tds_percent : body.tdsPercent,
        body.grinder === undefined ? shot.grinder : body.grinder,
        body.machine === undefined ? shot.machine : body.machine,
        body.tastingNotes === undefined ? shot.tasting_notes : body.tastingNotes,
        JSON.stringify(body.tags === undefined ? parseJson(shot.tags, []) : parseEspressoTags(body.tags)),
        body.notes === undefined ? shot.notes : body.notes,
        now(),
        shot.id,
        shot.item_id,
        shot.house_id,
      ],
    );
    const updated = await get<any>(
      `SELECT s.*, i.name AS item_name, i.brand AS item_brand, u.name AS user_name
       FROM espresso_shots s
       JOIN items i ON i.id = s.item_id
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
      [shot.id],
    );
    res.json(serializeEspressoShot(updated));
  }),
);

itemRoutes.delete(
  "/:itemId/espresso-shots/:shotId",
  handler(async (req, res) => {
    const { shot, role } = await shotAccess(req, "member");
    if (!canChangeShot(shot, req.user!.id, role)) {
      throw new ApiError(403, "You can only delete your own shots");
    }
    await run("DELETE FROM espresso_shots WHERE id = ? AND item_id = ? AND house_id = ?", [
      shot.id,
      shot.item_id,
      shot.house_id,
    ]);
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------ OpenFoodFacts links */

itemRoutes.get(
  "/:itemId/off",
  handler(async (req, res) => {
    const { item } = await itemAccess(req);
    if (!item.off_code) {
      res.json({ off: null, product: null });
      return;
    }
    const product = await fetchOffProduct(item.off_code);
    const row = await get<any>(`${ITEM_SELECT} WHERE i.id = ?`, [item.id]);
    res.json({
      off: row ? serializeItem(row, await barcodesForItem(item.id)).off : null,
      product,
    });
  }),
);

itemRoutes.post(
  "/:itemId/off/link",
  handler(async (req, res) => {
    const { item } = await itemAccess(req, "member");
    const body = parseBody(
      z.object({
        code: z.string().trim().min(1).max(80),
        fill: z.boolean().optional(),
      }),
      req.body,
    );
    const product = await fetchOffProduct(body.code);
    if (!product) throw new ApiError(404, "Could not load this product from OpenFoodFacts");

    if (body.fill === false) {
      const other = await get<any>(
        "SELECT id, name FROM items WHERE house_id = ? AND off_code = ? AND id <> ?",
        [item.house_id, product.code, item.id],
      );
      if (other) throw new ApiError(409, `OpenFoodFacts product ${product.code} is already linked to ${other.name}`);
      await run(
        "UPDATE items SET off_code = ?, off_source = 'manual', off_linked_at = ?, off_synced_at = NULL, off_filled = '[]', updated_at = ? WHERE id = ?",
        [product.code, now(), now(), item.id],
      );
      res.json({
        item: await itemDetail(item.id, req.user!.id),
        product,
        filled: [],
        skipped: [],
      });
      return;
    }

    const result = await linkItemToOff({ item, product, source: "manual" });
    res.json({
      item: await itemDetail(item.id, req.user!.id),
      product,
      filled: result.filled,
      skipped: result.skipped,
    });
  }),
);

itemRoutes.post(
  "/:itemId/off/fill",
  handler(async (req, res) => {
    const { item } = await itemAccess(req, "member");
    if (!item.off_code) throw new ApiError(400, "This item is not linked to OpenFoodFacts");
    const force = String(req.query.force ?? "") === "1";
    const product = await fetchOffProduct(item.off_code, { force });
    if (!product) throw new ApiError(404, "Product not found on OpenFoodFacts");
    const result = await fillItemFromOff({ item, product, source: "manual" });
    const previous = parseJson<string[]>(item.off_filled, []);
    const filled = [...new Set([...previous, ...result.filled])];
    await run("UPDATE items SET off_filled = ?, off_synced_at = ?, updated_at = ? WHERE id = ?", [
      JSON.stringify(filled),
      now(),
      now(),
      item.id,
    ]);
    res.json({
      item: await itemDetail(item.id, req.user!.id),
      product,
      filled: result.filled,
      skipped: result.skipped,
    });
  }),
);

itemRoutes.delete(
  "/:itemId/off",
  handler(async (req, res) => {
    const { item } = await itemAccess(req, "member");
    await unlinkItemFromOff(item.id);
    res.json({ ok: true, item: await itemDetail(item.id, req.user!.id) });
  }),
);

itemRoutes.get(
  "/:itemId/aliases",
  handler(async (req, res) => {
    const { item } = await itemAccess(req);
    const rows = await all<any>(
      `SELECT pa.*, v.name AS vendor_name FROM product_aliases pa
       LEFT JOIN vendors v ON v.id = pa.vendor_key
       WHERE pa.house_id = ? AND pa.item_id = ?
       ORDER BY pa.uses DESC, pa.updated_at DESC`,
      [item.house_id, item.id],
    );
    res.json(
      rows.map((row) => ({
        id: row.id,
        rawName: row.raw_text ?? row.raw_key,
        vendorId: row.vendor_key || null,
        vendorName: row.vendor_name ?? null,
        uses: Number(row.uses ?? 0),
        updatedAt: row.updated_at,
      })),
    );
  }),
);

itemRoutes.post(
  "/:itemId/aliases",
  handler(async (req, res) => {
    const { item } = await itemAccess(req, "member");
    const body = parseBody(
      z.object({
        rawName: z.string().trim().min(2).max(200),
        vendorId: z.string().max(60).nullish(),
      }),
      req.body,
    );
    if (body.vendorId && !await get("SELECT id FROM vendors WHERE id = ? AND house_id = ?", [body.vendorId, item.house_id])) {
      throw new ApiError(400, "Shop does not exist in this house");
    }
    await learnProductAlias({
      houseId: item.house_id,
      vendorId: body.vendorId ?? null,
      rawDescription: body.rawName,
      item,
    });
    res.status(201).json({ ok: true });
  }),
);

itemRoutes.delete(
  "/:itemId/aliases/:aliasId",
  handler(async (req, res) => {
    const { item } = await itemAccess(req, "member");
    await run("DELETE FROM product_aliases WHERE id = ? AND item_id = ? AND house_id = ?", [
      req.params.aliasId,
      item.id,
      item.house_id,
    ]);
    res.json({ ok: true });
  }),
);

/* ----------------------------------------------------------- barcode scan */

inventoryRoutes.get(
  "/:houseId/scan",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    const code = String(req.query.code ?? "").trim();
    if (!code) throw new ApiError(400, "Missing barcode");
    const row = await get<any>(
      `${ITEM_SELECT} WHERE i.house_id = ? AND EXISTS (SELECT 1 FROM item_barcodes b WHERE b.item_id = i.id AND b.code = ?)`,
      [houseId, code],
    );
    if (row) {
      res.json({ code, match: "local", item: serializeItem(row, await barcodesForItem(row.id)) });
      return;
    }
    const product = await fetchOffProduct(code);
    res.json({ code, match: product ? "external" : "none", item: null, product });
  }),
);
