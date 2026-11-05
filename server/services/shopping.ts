import { all, get, newId, now, run, tx } from "../db.js";
import { convert, round } from "../units.js";
import type { ShoppingItem, ShoppingSource } from "../../shared/types.js";

export function serializeShoppingItem(row: any): ShoppingItem {
  return {
    id: row.id,
    houseId: row.house_id,
    itemId: row.item_id ?? null,
    name: row.name,
    quantity: row.quantity == null ? null : round(Number(row.quantity)),
    unit: row.unit ?? null,
    categoryId: row.category_id ?? null,
    categoryName: row.category_name ?? null,
    categoryIcon: row.category_icon ?? null,
    note: row.note ?? null,
    source: (["manual", "recipe", "low_stock", "meal_plan"].includes(row.source) ? row.source : "manual") as ShoppingSource,
    checked: Boolean(row.checked),
    checkedAt: row.checked_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function shoppingRow(houseId: string, id: string) {
  return get<any>(
    `SELECT s.*, c.name AS category_name, c.icon AS category_icon
     FROM shopping_list_items s LEFT JOIN categories c ON c.id = s.category_id
     WHERE s.id = ? AND s.house_id = ?`,
    [id, houseId],
  );
}

export function listShopping(houseId: string, includeChecked = true): ShoppingItem[] {
  return all<any>(
    `SELECT s.*, c.name AS category_name, c.icon AS category_icon
     FROM shopping_list_items s LEFT JOIN categories c ON c.id = s.category_id
     WHERE s.house_id = ? ${includeChecked ? "" : "AND s.checked = 0"}
     ORDER BY s.checked ASC, COALESCE(c.name, '') COLLATE NOCASE, s.created_at`,
    [houseId],
  ).map(serializeShoppingItem);
}

export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function unitsCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return true;
  return convert(1, a, b) != null;
}

function mergedQuantity(existing: any, quantity: number | null | undefined, unit: string | null | undefined) {
  if (quantity == null) return existing.quantity;
  if (existing.quantity == null) return round(quantity);
  const existingUnit = existing.unit ?? null;
  if (!unit || !existingUnit || unit === existingUnit) return round(Number(existing.quantity) + quantity);
  const converted = convert(quantity, unit, existingUnit);
  if (converted == null) return round(Number(existing.quantity) + quantity);
  return round(Number(existing.quantity) + converted);
}

/** Find an open line this addition can merge into. Linked items win, then an
 * exact normalised name. Units must be compatible, otherwise the caller keeps
 * the line separate. */
export function findMergeTarget(
  houseId: string,
  input: { itemId?: string | null; name: string; unit?: string | null; excludeId?: string },
) {
  const rows = all<any>(
    `SELECT * FROM shopping_list_items WHERE house_id = ? AND checked = 0 ${input.excludeId ? "AND id <> ?" : ""}`,
    [houseId, ...(input.excludeId ? [input.excludeId] : [])],
  );
  if (input.itemId) {
    const linked = rows.find(
      (row) =>
        row.item_id === input.itemId &&
        unitsCompatible(row.unit, input.unit) &&
        (row.quantity == null || input.unit == null || row.unit == null || row.unit === input.unit || convert(1, row.unit, input.unit) != null),
    );
    if (linked) return linked;
  }
  const wanted = normalizeName(input.name);
  return (
    rows.find((row) => normalizeName(String(row.name)) === wanted && unitsCompatible(row.unit, input.unit)) ?? null
  );
}

export interface AddShoppingOpts {
  houseId: string;
  userId: string;
  name: string;
  quantity?: number | null;
  unit?: string | null;
  itemId?: string | null;
  categoryId?: string | null;
  note?: string | null;
  source?: ShoppingSource;
  sourceKey?: string | null;
}

export type AddShoppingStatus = "added" | "merged" | "skipped";

/** Add one line, merging by linked item and then by name. A source key makes
 * the operation idempotent: repeating the same recipe/week never duplicates
 * the lines it already produced. */
export function addShoppingLine(opts: AddShoppingOpts): { status: AddShoppingStatus; item: ShoppingItem } {
  return tx(() => {
    if (opts.sourceKey) {
      const source = get<any>("SELECT line_id FROM shopping_list_sources WHERE house_id = ? AND source_key = ?", [
        opts.houseId,
        opts.sourceKey,
      ]);
      if (source) {
        const existing = shoppingRow(opts.houseId, source.line_id);
        if (existing) return { status: "skipped" as const, item: serializeShoppingItem(existing) };
      }
    }

    const target = findMergeTarget(opts.houseId, {
      itemId: opts.itemId ?? null,
      name: opts.name,
      unit: opts.unit ?? null,
    });
    let lineId: string;
    let status: AddShoppingStatus;
    if (target) {
      const quantity = mergedQuantity(target, opts.quantity ?? null, opts.unit ?? null);
      run(
        `UPDATE shopping_list_items SET quantity = ?, unit = ?, item_id = COALESCE(item_id, ?),
           category_id = COALESCE(category_id, ?), updated_at = ? WHERE id = ?`,
        [
          quantity,
          target.unit ?? opts.unit ?? null,
          opts.itemId ?? null,
          opts.categoryId ?? null,
          now(),
          target.id,
        ],
      );
      lineId = target.id;
      status = "merged";
    } else {
      lineId = newId("shp");
      run(
        `INSERT INTO shopping_list_items
          (id, house_id, item_id, name, quantity, unit, category_id, note, source, checked, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [
          lineId,
          opts.houseId,
          opts.itemId ?? null,
          opts.name.trim().slice(0, 160),
          opts.quantity == null ? null : round(opts.quantity),
          opts.unit ?? null,
          opts.categoryId ?? null,
          opts.note ?? null,
          opts.source ?? "manual",
          opts.userId,
          now(),
          now(),
        ],
      );
      status = "added";
    }

    if (opts.sourceKey) {
      run(
        "INSERT OR IGNORE INTO shopping_list_sources (house_id, source_key, line_id, created_at) VALUES (?, ?, ?, ?)",
        [opts.houseId, opts.sourceKey, lineId, now()],
      );
    }

    return { status, item: serializeShoppingItem(shoppingRow(opts.houseId, lineId)) };
  });
}

export function deleteShoppingLine(houseId: string, id: string) {
  run("DELETE FROM shopping_list_items WHERE id = ? AND house_id = ?", [id, houseId]);
}
