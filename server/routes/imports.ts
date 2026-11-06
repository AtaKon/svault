import { Router } from "express";
import { z } from "zod";
import { all, get, newId, now, run, tx } from "../db.js";
import { requireAuth } from "../auth.js";
import { ApiError, handler, parseBody, requireHouse } from "../http.js";
import { ITEM_SELECT, barcodesForItem, priceStats, serializeItem } from "../serialize.js";
import { addStock, afterStockChange } from "../services/stock.js";
import { guessColumnMap, parseCsv, parseCsvNumber } from "../services/csv.js";
import { UNITS, convert } from "../units.js";
import { RESERVED_ATTRIBUTE_KEYS, type CsvColumnMap, type CsvImportMode, type CsvImportRow } from "../../shared/types.js";

export const importRoutes = Router();
importRoutes.use(requireAuth);

const RESERVED = new Set<string>(RESERVED_ATTRIBUTE_KEYS);
const UNIT_SET = new Set(UNITS.map((unit) => unit.toLowerCase()));

const importBody = z.object({
  csv: z.string().min(1).max(8_000_000),
  mapping: z.record(z.string(), z.string().max(120)).optional(),
  mode: z.enum(["create", "update"]).optional(),
});

function field(row: Record<string, string>, map: CsvColumnMap, key: keyof CsvColumnMap): string {
  const column = map[key];
  return column ? (row[column] ?? "").trim() : "";
}

function parseAttributes(value: string): Record<string, unknown> {
  const text = value.trim();
  if (!text) return {};
  let raw: Record<string, unknown> = {};
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed;
    } catch {
      raw = {};
    }
  } else {
    for (const part of text.split(/[;|]/)) {
      const index = part.indexOf("=");
      if (index < 0) continue;
      const key = part.slice(0, index).trim();
      const val = part.slice(index + 1).trim();
      if (key) raw[key] = val;
    }
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!RESERVED.has(key)) cleaned[key] = value;
  }
  return cleaned;
}

async function findMatch(houseId: string, row: CsvImportRow) {
  for (const code of row.barcodes) {
    const item = await get<any>(
      `SELECT i.* FROM items i JOIN item_barcodes b ON b.item_id = i.id WHERE b.house_id = ? AND b.code = ? LIMIT 1`,
      [houseId, code],
    );
    if (item) return item;
  }
  const exact = await all<any>("SELECT * FROM items WHERE house_id = ? AND LOWER(name) = LOWER(?)", [houseId, row.name]);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return { ambiguous: true, count: exact.length };
  return null;
}

async function buildPreview(houseId: string, csv: string, mapping: CsvColumnMap | undefined, mode: CsvImportMode) {
  const parsed = parseCsv(csv);
  if (!parsed.headers.length) throw new ApiError(400, "The CSV file is empty");
  const map = (mapping && Object.keys(mapping).length ? mapping : guessColumnMap(parsed.headers)) as CsvColumnMap;

  const seenBarcodes = new Map<string, number>();
  const rows: CsvImportRow[] = await Promise.all(parsed.rows.map(async (row, index) => {
    const line = index + 2;
    const name = field(row, map, "name");
    const unit = field(row, map, "unit").toLowerCase() || null;
    const quantity = parseCsvNumber(field(row, map, "quantity"));
    const reorderPoint = parseCsvNumber(field(row, map, "reorderPoint"));
    const targetStock = parseCsvNumber(field(row, map, "targetStock"));
    const price = parseCsvNumber(field(row, map, "price"));
    const barcodes = field(row, map, "barcodes")
      .split(/[|,;\s]+/)
      .map((code) => code.trim())
      .filter(Boolean);
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!name) errors.push("Name is required");
    if (unit && !UNIT_SET.has(unit)) errors.push(`Unknown unit "${unit}"`);
    if (quantity != null && quantity < 0) errors.push("Quantity cannot be negative");
    if (reorderPoint != null && reorderPoint < 0) errors.push("Reorder point cannot be negative");
    if (targetStock != null && targetStock < 0) errors.push("Target stock cannot be negative");
    if (price != null && price < 0) errors.push("Price cannot be negative");

    for (const code of barcodes) {
      const previous = seenBarcodes.get(code);
      if (previous) errors.push(`Barcode ${code} already appears on line ${previous}`);
      else seenBarcodes.set(code, line);
    }

    const preview: CsvImportRow = {
      line,
      name,
      brand: field(row, map, "brand") || null,
      category: field(row, map, "category") || null,
      place: field(row, map, "place") || null,
      unit,
      quantity,
      reorderPoint,
      targetStock,
      price,
      barcodes,
      attributes: parseAttributes(field(row, map, "attributes")),
      matchId: null,
      matchName: null,
      action: "create",
      errors,
      warnings,
    };

    if (!name) {
      preview.action = "skip";
      return preview;
    }

    const match = await findMatch(houseId, preview);
    if (match && (match as any).ambiguous) {
      preview.action = "skip";
      preview.warnings.push(`Several items are named "${name}"; skipped as ambiguous`);
      return preview;
    }
    if (match) {
      preview.matchId = match.id;
      preview.matchName = match.name;
      if (unit && convert(1, unit, match.unit) == null) {
        errors.push(`Cannot convert ${unit} to this item's unit (${match.unit})`);
      }
      preview.action = mode === "update" ? "update" : "skip";
      if (mode === "create") {
        preview.warnings.push("An item with this name or barcode already exists; skipped in create-only mode");
      }
    } else {
      preview.action = "create";
    }

    // A barcode may not point at a different item than the one being updated.
    for (const code of barcodes) {
      const owner = await get<any>(
        `SELECT i.id, i.name FROM item_barcodes b JOIN items i ON i.id = b.item_id WHERE b.house_id = ? AND b.code = ?`,
        [houseId, code],
      );
      if (owner && owner.id !== preview.matchId) {
        errors.push(`Barcode ${code} is already linked to ${owner.name}`);
      }
    }

    if (errors.length) preview.action = "skip";
    return preview;
  }));

  const summary = {
    create: rows.filter((row) => row.action === "create" && !row.errors.length).length,
    update: rows.filter((row) => row.action === "update" && !row.errors.length).length,
    skip: rows.filter((row) => row.action === "skip").length,
    errors: rows.filter((row) => row.errors.length).length,
  };
  return { delimiter: parsed.delimiter, headers: parsed.headers, map, mode, rows, summary };
}

async function ensureLocation(houseId: string, name: string | null) {
  if (!name) return null;
  const existing = await get<any>("SELECT id FROM locations WHERE house_id = ? AND LOWER(name) = LOWER(?)", [houseId, name]);
  if (existing) return existing.id as string;
  const id = newId("loc");
  await run("INSERT INTO locations (id, house_id, name, kind, icon, parent_id, created_at) VALUES (?, ?, ?, 'shelf', NULL, NULL, ?)", [
    id,
    houseId,
    name.slice(0, 60),
    now(),
  ]);
  return id;
}

async function ensureCategory(houseId: string, name: string | null) {
  if (!name) return null;
  const existing = await get<any>("SELECT id FROM categories WHERE house_id = ? AND LOWER(name) = LOWER(?)", [houseId, name]);
  if (existing) return existing.id as string;
  const id = newId("cat");
  await run("INSERT INTO categories (id, house_id, name, icon, parent_id, created_at) VALUES (?, ?, ?, NULL, NULL, ?)", [
    id,
    houseId,
    name.slice(0, 60),
    now(),
  ]);
  return id;
}

async function insertBarcodes(houseId: string, itemId: string, codes: string[]) {
  for (const code of codes) {
    const conflict = await get<any>(
      `SELECT i.id, i.name FROM item_barcodes b JOIN items i ON i.id = b.item_id WHERE b.house_id = ? AND b.code = ?`,
      [houseId, code],
    );
    if (conflict?.id === itemId) continue;
    if (conflict) throw new ApiError(400, `Barcode ${code} is already linked to ${conflict.name}`);
    await run("INSERT INTO item_barcodes (id, item_id, house_id, code, format, created_at) VALUES (?, ?, ?, ?, 'csv', ?)", [
      newId("bar"),
      itemId,
      houseId,
      code,
      now(),
    ]);
  }
}

importRoutes.post(
  "/:houseId/import/csv/preview",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(importBody, req.body);
    res.json(await buildPreview(houseId, body.csv, body.mapping as CsvColumnMap | undefined, body.mode ?? "create"));
  }),
);

importRoutes.post(
  "/:houseId/import/csv/commit",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(importBody, req.body);
    const preview = await buildPreview(houseId, body.csv, body.mapping as CsvColumnMap | undefined, body.mode ?? "create");
    if (preview.summary.errors > 0) {
      throw new ApiError(400, "Fix the highlighted rows before importing", {
        rows: preview.rows.filter((row) => row.errors.length),
        summary: preview.summary,
      });
    }

    const touched = new Set<string>();
    const createdIds: string[] = [];
    const updatedIds: string[] = [];
    let skipped = 0;

    await tx(async () => {
      for (const row of preview.rows) {
        if (row.action === "skip" || row.errors.length) {
          skipped++;
          continue;
        }
        const categoryId = await ensureCategory(houseId, row.category);
        const locationId = await ensureLocation(houseId, row.place);
        const unit = (row.unit ?? "pcs").toLowerCase();

        if (row.action === "update" && row.matchId) {
          const item = await get<any>("SELECT * FROM items WHERE id = ? AND house_id = ?", [row.matchId, houseId]);
          if (!item) {
            skipped++;
            continue;
          }
          await run(
            `UPDATE items SET name = ?, brand = COALESCE(?, brand), category_id = COALESCE(?, category_id),
               reorder_point = COALESCE(?, reorder_point), target_stock = COALESCE(?, target_stock),
               attributes = ?, updated_at = ? WHERE id = ?`,
            [
              row.name.slice(0, 120),
              row.brand,
              categoryId,
              row.reorderPoint,
              row.targetStock,
              JSON.stringify({ ...JSON.parse(item.attributes || "{}"), ...row.attributes }),
              now(),
              item.id,
            ],
          );
          await insertBarcodes(houseId, item.id, row.barcodes);
          if (row.quantity != null && row.quantity > 0) {
            await addStock({
              itemId: item.id,
              houseId,
              userId: req.user!.id,
              quantity: row.quantity,
              unit,
              unitPrice: row.price,
              locationId,
              reason: "CSV import",
              note: "Imported from CSV",
            });
            touched.add(item.id);
          }
          updatedIds.push(item.id);
          continue;
        }

        const itemId = newId("itm");
        await run(
          `INSERT INTO items (id, house_id, name, description, brand, category_id, unit, reorder_point, target_stock,
             attributes, tags, image, archived, created_by, created_at, updated_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, '[]', NULL, 0, ?, ?, ?)`,
          [
            itemId,
            houseId,
            row.name.slice(0, 120),
            row.brand,
            categoryId,
            unit.slice(0, 10),
            row.reorderPoint ?? 0,
            row.targetStock,
            JSON.stringify(row.attributes),
            req.user!.id,
            now(),
            now(),
          ],
        );
        await insertBarcodes(houseId, itemId, row.barcodes);
        if (row.quantity != null && row.quantity > 0) {
          await addStock({
            itemId,
            houseId,
            userId: req.user!.id,
            quantity: row.quantity,
            unit,
            unitPrice: row.price,
            locationId,
            reason: "CSV import",
            note: "Imported from CSV",
          });
          touched.add(itemId);
        }
        createdIds.push(itemId);
      }
    });

    for (const itemId of touched) await afterStockChange(itemId);
    const ids = [...createdIds, ...updatedIds];
    const items = await Promise.all(
      (await Promise.all(ids.map((id) => get<any>(`${ITEM_SELECT} WHERE i.id = ?`, [id]))))
        .filter(Boolean)
        .map(async (item) => ({
          ...serializeItem(item, await barcodesForItem(item.id)),
          priceStats: await priceStats(item.id, item.unit),
        })),
    );
    res.json({
      ...preview,
      created: createdIds.length,
      updated: updatedIds.length,
      skipped,
      items,
    });
  }),
);
