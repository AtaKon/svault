import { Router } from "express";
import { z } from "zod";
import { all, get, newId, now, parseJson, run } from "../db.js";
import { requireAuth, roleAtLeast } from "../auth.js";
import { ApiError, handler, parseBody, requireHouse } from "../http.js";
import {
  cleanInventoryFilters,
  inventoryFilterSchema,
  inventorySortSchema,
  type InventoryFilters,
} from "../services/inventory-filters.js";
import type { InventorySort, Role, SavedView } from "../../shared/types.js";

export const savedViewRoutes = Router();
savedViewRoutes.use(requireAuth);

/** Per-user personal views and per-house shared views are both bounded. */
export const MAX_PERSONAL_VIEWS = 25;
export const MAX_SHARED_VIEWS = 25;

const viewBody = z.strictObject({
  name: z.string().trim().min(1).max(60),
  filters: inventoryFilterSchema.default({}),
  sort: inventorySortSchema.default("name"),
  position: z.number().int().min(0).max(9_999).optional(),
  shared: z.boolean().optional(),
});

const patchBody = z.strictObject({
  name: z.string().trim().min(1).max(60).optional(),
  filters: inventoryFilterSchema.optional(),
  sort: inventorySortSchema.optional(),
  position: z.number().int().min(0).max(9_999).optional(),
  shared: z.boolean().optional(),
});

async function validateFilterReferences(houseId: string, filters: InventoryFilters) {
  if (filters.categoryId) {
    const category = await get("SELECT id FROM categories WHERE id = ? AND house_id = ?", [
      filters.categoryId,
      houseId,
    ]);
    if (!category) throw new ApiError(400, "Category does not exist in this house");
  }
  if (filters.locationId) {
    const location = await get("SELECT id FROM locations WHERE id = ? AND house_id = ?", [
      filters.locationId,
      houseId,
    ]);
    if (!location) throw new ApiError(400, "Place does not exist in this house");
  }
}

function missingFilters(
  filters: InventoryFilters,
  categories: Set<string>,
  locations: Set<string>,
): SavedView["missingFilters"] {
  const missing: SavedView["missingFilters"] = [];
  if (filters.categoryId && !categories.has(filters.categoryId)) missing.push("category");
  if (filters.locationId && !locations.has(filters.locationId)) missing.push("location");
  return missing;
}

async function houseTaxonomy(houseId: string) {
  const [categories, locations] = await Promise.all([
    all<{ id: string }>("SELECT id FROM categories WHERE house_id = ?", [houseId]),
    all<{ id: string }>("SELECT id FROM locations WHERE house_id = ?", [houseId]),
  ]);
  return {
    categories: new Set(categories.map((row) => row.id)),
    locations: new Set(locations.map((row) => row.id)),
  };
}

function serializeView(
  row: any,
  userId: string,
  role: Role,
  taxonomy: { categories: Set<string>; locations: Set<string> },
): SavedView {
  const parsed = inventoryFilterSchema.safeParse(parseJson<unknown>(row.filters, {}));
  const filters = cleanInventoryFilters(parsed.success ? parsed.data : {});
  const shared = row.user_id == null;
  const sort = (inventorySortSchema.safeParse(row.sort).success ? row.sort : "name") as InventorySort;
  return {
    id: row.id,
    name: row.name,
    shared,
    filters,
    sort,
    position: Number(row.position ?? 0),
    canEdit: shared ? roleAtLeast(role, "admin") : row.user_id === userId,
    missingFilters: missingFilters(filters, taxonomy.categories, taxonomy.locations),
    createdAt: row.created_at,
  };
}

async function viewRow(houseId: string, viewId: string) {
  const row = await get<any>("SELECT * FROM saved_views WHERE id = ? AND house_id = ?", [viewId, houseId]);
  if (!row) throw new ApiError(404, "Saved view not found");
  return row;
}

/** Personal views belong to their owner. Shared views need a house admin. */
function assertCanEdit(row: any, userId: string, role: Role) {
  if (row.user_id == null) {
    if (!roleAtLeast(role, "admin")) throw new ApiError(403, "Only house admins can change a shared view");
    return;
  }
  // Do not reveal another member's personal view.
  if (row.user_id !== userId) throw new ApiError(404, "Saved view not found");
}

async function countViews(houseId: string, shared: boolean, userId: string) {
  const row = shared
    ? await get<{ n: number }>("SELECT COUNT(*) AS n FROM saved_views WHERE house_id = ? AND user_id IS NULL", [
        houseId,
      ])
    : await get<{ n: number }>("SELECT COUNT(*) AS n FROM saved_views WHERE house_id = ? AND user_id = ?", [
        houseId,
        userId,
      ]);
  return Number(row?.n ?? 0);
}

async function nextPosition(houseId: string, shared: boolean, userId: string) {
  const row = shared
    ? await get<{ next: number }>(
        "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM saved_views WHERE house_id = ? AND user_id IS NULL",
        [houseId],
      )
    : await get<{ next: number }>(
        "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM saved_views WHERE house_id = ? AND user_id = ?",
        [houseId, userId],
      );
  return Number(row?.next ?? 0);
}

/* ------------------------------------------------------------------- routes */

savedViewRoutes.get(
  "/:houseId/saved-views",
  handler(async (req, res) => {
    const { houseId, role } = await requireHouse(req);
    const rows = await all<any>(
      `SELECT * FROM saved_views
       WHERE house_id = ? AND (user_id IS NULL OR user_id = ?)
       ORDER BY position ASC, created_at ASC`,
      [houseId, req.user!.id],
    );
    const taxonomy = await houseTaxonomy(houseId);
    res.json({ views: rows.map((row) => serializeView(row, req.user!.id, role, taxonomy)) });
  }),
);

savedViewRoutes.post(
  "/:houseId/saved-views",
  handler(async (req, res) => {
    // Viewers may keep personal views: they only save a query, never stock.
    const { houseId, role } = await requireHouse(req);
    const body = parseBody(viewBody, req.body);
    const shared = body.shared === true;
    if (shared && !roleAtLeast(role, "admin")) {
      throw new ApiError(403, "Only house admins can share a view");
    }
    await validateFilterReferences(houseId, body.filters);
    if (await countViews(houseId, shared, req.user!.id) >= (shared ? MAX_SHARED_VIEWS : MAX_PERSONAL_VIEWS)) {
      throw new ApiError(
        400,
        shared
          ? "This house can have up to 25 shared views"
          : "You can save up to 25 personal views in this house",
      );
    }
    const id = newId("svw");
    const position = body.position ?? (await nextPosition(houseId, shared, req.user!.id));
    await run(
      `INSERT INTO saved_views (id, house_id, user_id, name, filters, sort, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        houseId,
        shared ? null : req.user!.id,
        body.name,
        JSON.stringify(cleanInventoryFilters(body.filters)),
        body.sort,
        position,
        now(),
      ],
    );
    const taxonomy = await houseTaxonomy(houseId);
    res
      .status(201)
      .json(serializeView(await get<any>("SELECT * FROM saved_views WHERE id = ?", [id]), req.user!.id, role, taxonomy));
  }),
);

savedViewRoutes.patch(
  "/:houseId/saved-views/:viewId",
  handler(async (req, res) => {
    const { houseId, role } = await requireHouse(req);
    const current = await viewRow(houseId, String(req.params.viewId));
    assertCanEdit(current, req.user!.id, role);
    const body = parseBody(patchBody, req.body);
    if (Object.keys(body).length === 0) throw new ApiError(400, "Nothing to update");
    if (body.filters) await validateFilterReferences(houseId, body.filters);

    let userId = current.user_id;
    if (body.shared === true && current.user_id != null) {
      if (!roleAtLeast(role, "admin")) throw new ApiError(403, "Only house admins can share a view");
      if (await countViews(houseId, true, req.user!.id) >= MAX_SHARED_VIEWS) {
        throw new ApiError(400, "This house can have up to 25 shared views");
      }
      userId = null;
    } else if (body.shared === false && current.user_id == null) {
      // Un-sharing adopts the view as a personal one, so it is not orphaned.
      userId = req.user!.id;
    }

    await run(
      `UPDATE saved_views SET user_id = ?, name = ?, filters = ?, sort = ?, position = ? WHERE id = ?`,
      [
        userId,
        body.name ?? current.name,
        body.filters ? JSON.stringify(cleanInventoryFilters(body.filters)) : current.filters,
        body.sort ?? current.sort,
        body.position ?? current.position,
        current.id,
      ],
    );
    const taxonomy = await houseTaxonomy(houseId);
    res.json(
      serializeView(
        await get<any>("SELECT * FROM saved_views WHERE id = ?", [current.id]),
        req.user!.id,
        role,
        taxonomy,
      ),
    );
  }),
);

savedViewRoutes.delete(
  "/:houseId/saved-views/:viewId",
  handler(async (req, res) => {
    const { houseId, role } = await requireHouse(req);
    const current = await viewRow(houseId, String(req.params.viewId));
    assertCanEdit(current, req.user!.id, role);
    await run("DELETE FROM saved_views WHERE id = ? AND house_id = ?", [current.id, houseId]);
    res.json({ ok: true });
  }),
);
