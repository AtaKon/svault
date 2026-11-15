import { all, get, now, parseJson, run, tx, lockHouseholdLedger } from "../db.js";
import { ApiError } from "../http.js";
import { convert, round } from "../units.js";
import { afterStockChange } from "./stock.js";
import { syncHouseExpiry, syncHouseWarranties } from "./notifications.js";
import type {
  ItemMergeConflict,
  ItemMergeMoves,
  ItemMergePreview,
  ItemMergeResult,
  ItemMergeTarget,
} from "../../shared/types.js";

/**
 * Merge duplicate items into one. The target keeps its own values; empty
 * fields and unioned tags/attributes are filled from the sources; every
 * reference that points at a source is re-pointed; the source is archived with
 * `merged_into` set instead of being deleted, so history stays readable.
 */

/** Every table with an `item_id` column that the merge must re-point. */
export const ITEM_MERGE_TABLES = [
  "item_documents",
  "item_barcodes",
  "espresso_shots",
  "stock_lots",
  "stock_movements",
  "receipt_lines",
  "product_aliases",
  "off_contributions",
  "shopping_list_items",
  "recipe_ingredients",
  "photos",
] as const;

const PLACEHOLDERS = (count: number) => Array.from({ length: count }, () => "?").join(", ");

function targetShape(row: any, quantity: number): ItemMergeTarget {
  return {
    id: row.id,
    name: row.name,
    unit: row.unit,
    quantity: round(quantity),
    archived: Boolean(Number(row.archived ?? 0)),
  };
}

async function sourceQuantity(itemId: string): Promise<number> {
  const row = await get<{ q: number }>("SELECT COALESCE(SUM(quantity), 0) AS q FROM stock_lots WHERE item_id = ?", [itemId]);
  return Number(row?.q ?? 0);
}

async function countFor(table: (typeof ITEM_MERGE_TABLES)[number], itemIds: string[]): Promise<number> {
  if (!itemIds.length) return 0;
  const row = await get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE item_id IN (${PLACEHOLDERS(itemIds.length)})`,
    itemIds,
  );
  return Number(row?.n ?? 0);
}

async function notificationCount(itemIds: string[]): Promise<number> {
  if (!itemIds.length) return 0;
  const rows = await all<{ data: string }>("SELECT data FROM notifications WHERE resolved_at IS NULL");
  const wanted = new Set(itemIds);
  let count = 0;
  for (const row of rows) {
    const data = parseJson<Record<string, unknown>>(row.data, {});
    if (typeof data.itemId === "string" && wanted.has(data.itemId)) count += 1;
  }
  return count;
}

function empty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

interface MergePlan {
  target: any;
  sources: any[];
  conflicts: ItemMergeConflict[];
  moves: ItemMergeMoves;
}

/**
 * Read-only plan shared by the dry run and the real merge. It reports every
 * conflict instead of stopping at the first one, so the UI can explain why a
 * group cannot be merged.
 */
export async function planItemMerge(
  houseId: string,
  targetId: string,
  sourceIds: string[],
): Promise<MergePlan> {
  const conflicts: ItemMergeConflict[] = [];
  const uniqueSourceIds = [...new Set(sourceIds)].filter((id) => id && id !== targetId);
  if (sourceIds.includes(targetId)) {
    conflicts.push({ kind: "same_item", message: "An item cannot be merged into itself", itemId: targetId });
  }

  const target = await get<any>("SELECT * FROM items WHERE id = ? AND house_id = ?", [targetId, houseId]);
  if (!target) throw new ApiError(404, "Item not found");
  if (Number(target.archived) === 1) {
    conflicts.push({ kind: "target_archived", message: "The item to keep is archived", itemId: targetId });
  }
  if (target.merged_into) {
    conflicts.push({ kind: "already_merged", message: "The item to keep was already merged away", itemId: targetId });
  }

  const sourceRows = uniqueSourceIds.length
    ? await all<any>(
        `SELECT * FROM items WHERE house_id = ? AND id IN (${PLACEHOLDERS(uniqueSourceIds.length)})`,
        [houseId, ...uniqueSourceIds],
      )
    : [];
  const found = new Map(sourceRows.map((row) => [row.id as string, row]));
  for (const id of uniqueSourceIds) {
    if (!found.has(id)) {
      conflicts.push({ kind: "source_not_found", message: "An item to merge is not in this house", itemId: id });
    }
  }
  const sources = uniqueSourceIds
    .map((id) => found.get(id))
    .filter((row): row is any => Boolean(row));
  for (const source of sources) {
    if (source.merged_into) {
      conflicts.push({
        kind: "already_merged",
        message: "This item was already merged into another one",
        itemId: source.id,
      });
    }
  }

  const sourceIdsFound = sources.map((source) => source.id as string);

  // Unit compatibility: stock lots decide, because they carry quantities that
  // must be converted. History-only sources with no lots may still move.
  const lotRows = sourceIdsFound.length
    ? await all<any>(
        `SELECT item_id, quantity, unit, unit_price FROM stock_lots WHERE item_id IN (${PLACEHOLDERS(sourceIdsFound.length)})`,
        sourceIdsFound,
      )
    : [];
  let lotQuantity = 0;
  const seenUnitConflicts = new Set<string>();
  for (const lot of lotRows) {
    const factor = convert(1, lot.unit, target.unit);
    if (factor === null) {
      const quantity = Number(lot.quantity ?? 0);
      if (quantity !== 0 && !seenUnitConflicts.has(`${lot.item_id}:${lot.unit}`)) {
        seenUnitConflicts.add(`${lot.item_id}:${lot.unit}`);
        conflicts.push({
          kind: "incompatible_unit",
          message: `Cannot convert ${lot.unit} to ${target.unit}`,
          itemId: lot.item_id,
          unit: lot.unit,
        });
      }
      continue;
    }
    lotQuantity += Number(lot.quantity ?? 0) * factor;
  }
  // A source with history but no batches can still hide an incompatible unit
  // in its recorded item unit. Refuse rather than silently mixing ledgers.
  for (const source of sources) {
    if (source.unit === target.unit) continue;
    if (convert(1, source.unit, target.unit) !== null) continue;
    if (seenUnitConflicts.has(`${source.id}:${source.unit}`)) continue;
    const [lots, movements] = await Promise.all([
      get<{ n: number }>("SELECT COUNT(*) AS n FROM stock_lots WHERE item_id = ?", [source.id]),
      get<{ n: number }>("SELECT COUNT(*) AS n FROM stock_movements WHERE item_id = ?", [source.id]),
    ]);
    if (Number(lots?.n ?? 0) > 0 || Number(movements?.n ?? 0) > 0) {
      conflicts.push({
        kind: "incompatible_unit",
        message: `Cannot convert ${source.unit} to ${target.unit}`,
        itemId: source.id,
        unit: source.unit,
      });
    }
  }

  const targetAttributes = parseJson<Record<string, unknown>>(target.attributes, {});
  const targetTags = parseJson<string[]>(target.tags, []);
  const unionTags = uniqueStrings([...targetTags, ...sources.flatMap((source) => parseJson<string[]>(source.tags, []))]);
  const filledAttributes = new Set<string>();
  const filledFields = new Set<string>();
  for (const source of sources) {
    for (const [key, value] of Object.entries(parseJson<Record<string, unknown>>(source.attributes, {}))) {
      if (targetAttributes[key] === undefined || targetAttributes[key] === null || targetAttributes[key] === "") {
        filledAttributes.add(key);
        void value;
      }
    }
    if (empty(target.description) && !empty(source.description)) filledFields.add("description");
    if (empty(target.brand) && !empty(source.brand)) filledFields.add("brand");
    if (empty(target.category_id) && !empty(source.category_id)) filledFields.add("category");
    if (empty(target.image) && !empty(source.image)) filledFields.add("image");
    if (empty(target.nutrition) && !empty(source.nutrition)) filledFields.add("nutrition");
    if (empty(target.warranty_until) && !empty(source.warranty_until)) filledFields.add("warrantyUntil");
    if (empty(target.warranty_note) && !empty(source.warranty_note)) filledFields.add("warrantyNote");
    if (target.target_stock == null && source.target_stock != null) filledFields.add("targetStock");
    if (target.opened_shelf_life_days == null && source.opened_shelf_life_days != null) filledFields.add("openedShelfLifeDays");
    if (Number(target.reorder_point ?? 0) === 0 && Number(source.reorder_point ?? 0) > 0) filledFields.add("reorderPoint");
    if (Number(target.espresso ?? 0) === 0 && Number(source.espresso ?? 0) === 1) filledFields.add("espresso");
  }
  const targetOff = target.off_code
    ? { code: target.off_code as string, project: (target.off_project as string) ?? "off" }
    : null;
  const sourceOff = sources.find((source) => source.off_code);
  const effectiveOff = targetOff ?? (sourceOff ? { code: sourceOff.off_code as string, project: (sourceOff.off_project as string) ?? "off" } : null);
  if (!targetOff && sourceOff) filledFields.add("offLink");

  const counts = await Promise.all(
    ITEM_MERGE_TABLES.map((table) => countFor(table, sourceIdsFound)),
  );
  const byTable = Object.fromEntries(ITEM_MERGE_TABLES.map((table, index) => [table, counts[index]]));

  const moves: ItemMergeMoves = {
    lots: byTable.stock_lots ?? 0,
    lotQuantity: round(lotQuantity, 3),
    movements: byTable.stock_movements ?? 0,
    receiptLines: byTable.receipt_lines ?? 0,
    aliases: byTable.product_aliases ?? 0,
    barcodes: byTable.item_barcodes ?? 0,
    documents: byTable.item_documents ?? 0,
    photos: byTable.photos ?? 0,
    shoppingLines: byTable.shopping_list_items ?? 0,
    recipeIngredients: byTable.recipe_ingredients ?? 0,
    espressoShots: byTable.espresso_shots ?? 0,
    notifications: await notificationCount(sourceIdsFound),
    offContributions: byTable.off_contributions ?? 0,
    tags: unionTags.filter((tag) => !targetTags.includes(tag)),
    filledFields: [...filledFields],
    filledAttributes: [...filledAttributes],
    offCode: effectiveOff?.code ?? null,
    offProject: effectiveOff?.project ?? null,
  };

  return {
    target,
    sources,
    conflicts,
    moves,
  };
}

export async function previewItemMerge(
  houseId: string,
  targetId: string,
  sourceIds: string[],
): Promise<ItemMergePreview> {
  const plan = await planItemMerge(houseId, targetId, sourceIds);
  return {
    dryRun: true,
    mergeable: plan.conflicts.length === 0,
    target: targetShape(plan.target, await sourceQuantity(targetId)),
    sources: await Promise.all(
      plan.sources.map(async (source) => targetShape(source, await sourceQuantity(source.id))),
    ),
    conflicts: plan.conflicts,
    moves: plan.moves,
  };
}

/** Re-point one source inside the merge transaction. */
async function moveSource(
  houseId: string,
  target: any,
  source: any,
  targetBarcodes: Set<string>,
): Promise<void> {
  // Batches: convert quantity and unit price to the target base unit.
  const lots = await all<any>("SELECT * FROM stock_lots WHERE item_id = ? AND house_id = ?", [source.id, houseId]);
  for (const lot of lots) {
    const factor = convert(1, lot.unit, target.unit);
    const quantity = Number(lot.quantity ?? 0);
    const converted = factor === null ? 0 : quantity * factor;
    const unitPrice =
      lot.unit_price == null || factor === null ? lot.unit_price ?? null : round(Number(lot.unit_price) / factor, 6);
    await run("UPDATE stock_lots SET item_id = ?, quantity = ?, unit = ?, unit_price = ? WHERE id = ?", [
      target.id,
      round(converted, 6),
      target.unit,
      unitPrice,
      lot.id,
    ]);
  }

  // Movement ledger: keep the order and provenance, translate the units.
  const movements = await all<any>("SELECT * FROM stock_movements WHERE item_id = ? AND house_id = ?", [
    source.id,
    houseId,
  ]);
  const baseFactor = convert(1, source.unit, target.unit);
  for (const movement of movements) {
    const unit = movement.unit || source.unit;
    const factor = convert(1, unit, target.unit);
    if (factor === null) {
      // An old or unknown unit is kept as recorded, but the movement must
      // still belong to the item that now holds the history.
      await run("UPDATE stock_movements SET item_id = ? WHERE id = ?", [target.id, movement.id]);
      continue;
    }
    await run(
      `UPDATE stock_movements SET item_id = ?, delta = ?, unit = ?, quantity = ?, unit_price = ?,
         normalized_price = ?, balance_after = ? WHERE id = ?`,
      [
        target.id,
        round(Number(movement.delta ?? 0) * factor, 6),
        target.unit,
        round(Number(movement.quantity ?? 0) * factor, 6),
        movement.unit_price == null ? null : round(Number(movement.unit_price) / factor, 6),
        movement.normalized_price == null || baseFactor === null
          ? movement.normalized_price ?? null
          : round(Number(movement.normalized_price) / baseFactor, 6),
        movement.balance_after == null || baseFactor === null
          ? movement.balance_after ?? null
          : round(Number(movement.balance_after) * baseFactor, 6),
        movement.id,
      ],
    );
  }

  // Barcodes are unique per house; drop a source copy when the target has it.
  const barcodes = await all<any>("SELECT id, code FROM item_barcodes WHERE item_id = ?", [source.id]);
  for (const barcode of barcodes) {
    if (targetBarcodes.has(barcode.code)) {
      await run("DELETE FROM item_barcodes WHERE id = ?", [barcode.id]);
      continue;
    }
    await run("UPDATE item_barcodes SET item_id = ? WHERE id = ?", [target.id, barcode.id]);
    targetBarcodes.add(barcode.code);
  }

  await run("UPDATE item_documents SET item_id = ? WHERE item_id = ?", [target.id, source.id]);
  await run("UPDATE espresso_shots SET item_id = ? WHERE item_id = ?", [target.id, source.id]);
  await run("UPDATE receipt_lines SET item_id = ? WHERE item_id = ?", [target.id, source.id]);
  await run("UPDATE product_aliases SET item_id = ? WHERE item_id = ?", [target.id, source.id]);
  await run("UPDATE off_contributions SET item_id = ? WHERE item_id = ?", [target.id, source.id]);
  await run("UPDATE shopping_list_items SET item_id = ? WHERE item_id = ?", [target.id, source.id]);
  await run("UPDATE recipe_ingredients SET item_id = ? WHERE item_id = ?", [target.id, source.id]);
  await run("UPDATE photos SET item_id = ? WHERE item_id = ?", [target.id, source.id]);

  // Reminders are derived: drop the source's rows and let the sync after the
  // merge rebuild them for the moved batches and the target item.
  const notifications = await all<{ id: string; data: string; dedupe_key: string | null }>(
    "SELECT id, data, dedupe_key FROM notifications WHERE resolved_at IS NULL",
  );
  for (const notification of notifications) {
    const data = parseJson<Record<string, unknown>>(notification.data, {});
    if (data.itemId === source.id || notification.dedupe_key === `low:${source.id}`) {
      await run("DELETE FROM notifications WHERE id = ?", [notification.id]);
    }
  }
}

/** Compute the target's final field values without overwriting anything set. */
function mergedFields(target: any, sources: any[]) {
  const targetAttributes = parseJson<Record<string, unknown>>(target.attributes, {});
  const attributes: Record<string, unknown> = { ...targetAttributes };
  for (const source of sources) {
    for (const [key, value] of Object.entries(parseJson<Record<string, unknown>>(source.attributes, {}))) {
      if (attributes[key] === undefined || attributes[key] === null || attributes[key] === "") {
        attributes[key] = value;
      }
    }
  }

  const firstFilled = (column: string) => {
    if (!empty(target[column])) return target[column];
    for (const source of sources) if (!empty(source[column])) return source[column];
    return target[column];
  };
  const tags = uniqueStrings([
    ...parseJson<string[]>(target.tags, []),
    ...sources.flatMap((source) => parseJson<string[]>(source.tags, [])),
  ]);

  const offSource = target.off_code ? null : sources.find((source) => source.off_code) ?? null;
  const espresso = Number(target.espresso ?? 0) === 1 || sources.some((source) => Number(source.espresso ?? 0) === 1);
  const reorderSource = sources.find((source) => Number(source.reorder_point ?? 0) > Number(target.reorder_point ?? 0));

  return {
    description: firstFilled("description"),
    brand: firstFilled("brand"),
    categoryId: firstFilled("category_id"),
    image: firstFilled("image"),
    nutrition: firstFilled("nutrition"),
    warrantyUntil: firstFilled("warranty_until"),
    warrantyNote: firstFilled("warranty_note"),
    targetStock: firstFilled("target_stock"),
    openedShelfLifeDays: firstFilled("opened_shelf_life_days"),
    reorderPoint: Number(target.reorder_point ?? 0) === 0 && reorderSource ? Number(reorderSource.reorder_point) : Number(target.reorder_point ?? 0),
    attributes,
    tags,
    espresso: espresso ? 1 : 0,
    off: target.off_code
      ? {
          code: target.off_code,
          project: target.off_project ?? "off",
          source: target.off_source,
          linkedAt: target.off_linked_at,
          syncedAt: target.off_synced_at,
          filled: target.off_filled,
        }
      : offSource
        ? {
            code: offSource.off_code,
            project: offSource.off_project ?? "off",
            source: offSource.off_source,
            linkedAt: offSource.off_linked_at,
            syncedAt: offSource.off_synced_at,
            filled: offSource.off_filled,
          }
        : { code: null, project: target.off_project ?? "off", source: null, linkedAt: null, syncedAt: null, filled: "[]" },
  };
}

/**
 * Merge one or more source items into the target in a single transaction.
 * Conflicting units or an archived target refuse the whole merge with 409.
 */
export async function mergeItems(opts: {
  houseId: string;
  targetId: string;
  sourceIds: string[];
  userId: string;
}): Promise<ItemMergeResult> {
  if (!opts.sourceIds.length) throw new ApiError(400, "Pick at least one item to merge");
  const plan = await planItemMerge(opts.houseId, opts.targetId, opts.sourceIds);
  if (plan.conflicts.length) {
    throw new ApiError(409, "This merge cannot be done", { conflicts: plan.conflicts });
  }
  if (!plan.sources.length) throw new ApiError(400, "Pick at least one item to merge");

  const mergedAt = now();
  let targetQuantity = 0;
  await tx(async (session) => {
    await lockHouseholdLedger(session, opts.houseId);
    // Re-read inside the transaction so a concurrent archive/merge is caught.
    const target = await session.get<any>("SELECT * FROM items WHERE id = ? AND house_id = ?", [
      opts.targetId,
      opts.houseId,
    ]);
    if (!target || Number(target.archived) === 1 || target.merged_into) {
      throw new ApiError(409, "The item to keep changed while the merge was being prepared", { conflict: true });
    }
    const sources = await session.all<any>(
      `SELECT * FROM items WHERE house_id = ? AND id IN (${PLACEHOLDERS(plan.sources.length)})`,
      [opts.houseId, ...plan.sources.map((source) => source.id)],
    );
    if (sources.length !== plan.sources.length) {
      throw new ApiError(409, "An item to merge changed while the merge was being prepared", { conflict: true });
    }

    const fields = mergedFields(target, sources);
    const targetBarcodes = new Set(
      (await session.all<any>("SELECT code FROM item_barcodes WHERE item_id = ?", [target.id])).map((row) => String(row.code)),
    );
    for (const source of sources) {
      await moveSource(opts.houseId, target, source, targetBarcodes);
      await session.run(
        "UPDATE items SET archived = 1, merged_into = ?, merged_at = ?, updated_at = ? WHERE id = ? AND house_id = ?",
        [target.id, mergedAt, mergedAt, source.id, opts.houseId],
      );
    }

    await session.run(
      `UPDATE items SET description = ?, brand = ?, category_id = ?, image = ?, nutrition = ?,
         warranty_until = ?, warranty_note = ?, target_stock = ?, opened_shelf_life_days = ?, reorder_point = ?,
         attributes = ?, tags = ?, espresso = ?, off_code = ?, off_project = ?, off_source = ?,
         off_linked_at = ?, off_synced_at = ?, off_filled = ?, updated_at = ? WHERE id = ?`,
      [
        fields.description ?? null,
        fields.brand ?? null,
        fields.categoryId ?? null,
        fields.image ?? null,
        fields.nutrition ?? null,
        fields.warrantyUntil ?? null,
        fields.warrantyNote ?? null,
        fields.targetStock ?? null,
        fields.openedShelfLifeDays ?? null,
        fields.reorderPoint,
        JSON.stringify(fields.attributes),
        JSON.stringify(fields.tags),
        fields.espresso,
        fields.off.code ?? null,
        fields.off.project ?? "off",
        fields.off.source ?? null,
        fields.off.linkedAt ?? null,
        fields.off.syncedAt ?? null,
        fields.off.filled ?? "[]",
        mergedAt,
        target.id,
      ],
    );
    targetQuantity = await sourceQuantity(target.id);
  });

  await afterStockChange(opts.targetId);
  await syncHouseExpiry(opts.houseId);
  await syncHouseWarranties(opts.houseId);

  return {
    dryRun: false,
    mergedAt,
    target: targetShape(
      await get<any>("SELECT * FROM items WHERE id = ?", [opts.targetId]),
      targetQuantity || (await sourceQuantity(opts.targetId)),
    ),
    archived: plan.sources.map((source) => source.id as string),
  };
}
