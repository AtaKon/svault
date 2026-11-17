import { get, now, run } from "../db.js";
import { ApiError } from "../http.js";

/**
 * PosoKanei product matches are stored at two scopes:
 *
 * - `item`: a direct match for one inventory item. This is the only option for
 *   items without an OpenFoodFacts link and always takes precedence.
 * - `off`: the original shared match, keyed by a house and OpenFoodFacts
 *   product. Every item linked to that product uses the same match.
 *
 * Keeping the shared table unchanged preserves mappings created before direct
 * item matches existed.
 */
export type PosoKaneiMappingScope = "item" | "off";

export interface PosoKaneiMapping {
  id: string;
  name: string;
  scope: PosoKaneiMappingScope;
}

export interface MappableItem {
  id: string;
  off_code?: string | null;
  off_project?: string | null;
}

export interface PosoKaneiProductLink {
  id: string;
  name: string;
}

async function itemMapping(houseId: string, itemId: string): Promise<PosoKaneiMapping | null> {
  const row = await get<any>(
    "SELECT product_id, product_name FROM posokanei_item_mappings WHERE house_id = ? AND item_id = ?",
    [houseId, itemId],
  );
  return row
    ? { id: String(row.product_id), name: String(row.product_name), scope: "item" }
    : null;
}

async function offMapping(
  houseId: string,
  offProject: string | null | undefined,
  offCode: string | null | undefined,
): Promise<PosoKaneiMapping | null> {
  if (!offCode) return null;
  const row = await get<any>(
    "SELECT product_id, product_name FROM posokanei_mappings WHERE house_id = ? AND off_project = ? AND off_code = ?",
    [houseId, offProject ?? "off", offCode],
  );
  return row
    ? { id: String(row.product_id), name: String(row.product_name), scope: "off" }
    : null;
}

/** The match a lookup should use: the item's own match, then the shared one. */
export async function effectivePosoKaneiMapping(
  houseId: string,
  item: MappableItem,
): Promise<PosoKaneiMapping | null> {
  return (await itemMapping(houseId, item.id)) ?? (await offMapping(houseId, item.off_project, item.off_code));
}

/**
 * Save a match. Omitting the scope keeps the old API behavior: an item linked
 * to OpenFoodFacts writes the shared match, anything else writes an item match.
 */
export async function savePosoKaneiMapping(
  houseId: string,
  item: MappableItem,
  product: PosoKaneiProductLink,
  scope?: PosoKaneiMappingScope,
): Promise<PosoKaneiMapping> {
  const target = scope ?? (item.off_code ? "off" : "item");
  if (target === "off") {
    if (!item.off_code) throw new ApiError(400, "Link an OpenFoodFacts product first");
    await run(
      `INSERT INTO posokanei_mappings (house_id, off_project, off_code, product_id, product_name)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (house_id, off_project, off_code)
       DO UPDATE SET product_id = excluded.product_id, product_name = excluded.product_name`,
      [houseId, item.off_project ?? "off", item.off_code, product.id, product.name],
    );
  } else {
    const timestamp = now();
    await run(
      `INSERT INTO posokanei_item_mappings (house_id, item_id, product_id, product_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (house_id, item_id)
       DO UPDATE SET product_id = excluded.product_id, product_name = excluded.product_name, updated_at = excluded.updated_at`,
      [houseId, item.id, product.id, product.name, timestamp, timestamp],
    );
  }
  return { id: product.id, name: product.name, scope: target };
}

/**
 * Remove the match the UI currently shows. A direct item match is removed
 * first so a shared OpenFoodFacts match stays available to other items; when
 * there is no item match, the old shared-mapping behavior still applies.
 */
export async function removePosoKaneiMapping(houseId: string, item: MappableItem): Promise<void> {
  const removed = await run(
    "DELETE FROM posokanei_item_mappings WHERE house_id = ? AND item_id = ?",
    [houseId, item.id],
  );
  if (removed.changes > 0 || !item.off_code) return;
  await run(
    "DELETE FROM posokanei_mappings WHERE house_id = ? AND off_project = ? AND off_code = ?",
    [houseId, item.off_project ?? "off", item.off_code],
  );
}
