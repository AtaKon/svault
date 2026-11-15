// Valuation / insurance export: a dated record of what a house owns.
//
// Read-only. The item aggregation lives here; the totals, filters and CSV
// formatting live in server/services/valuation.ts.

import { Router } from "express";
import { z } from "zod";
import { all, get, parseJson } from "../db.js";
import { requireAuth } from "../auth.js";
import { ApiError, handler, parseBody, requireHouse } from "../http.js";
import {
  MAX_VALUATION_ITEMS,
  buildValuationReport,
  valuationCsv,
  type ValuationFilters,
  type ValuationSourceItem,
  type ValuationSourcePlace,
} from "../services/valuation.js";
import type { ValuationBasis, ValuationDocumentRef } from "../../shared/types.js";

export const reportRoutes = Router();
reportRoutes.use(requireAuth);

const BASIS_VALUES = ["latest", "average", "stockCost"] as const;

const valuationQuerySchema = z.object({
  format: z.enum(["json", "csv"]).default("json"),
  basis: z.enum(BASIS_VALUES).default("latest"),
  categories: z.string().max(4000).optional(),
  places: z.string().max(4000).optional(),
  tags: z.string().max(2000).optional(),
  minValue: z.coerce.number().finite().min(0).max(1_000_000_000).optional(),
  warranty: z.string().max(10).optional(),
  archived: z.string().max(10).optional(),
  documents: z.string().max(10).optional(),
});

function listParam(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(",") : String(value ?? "");
  return [
    ...new Set(
      raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, 200),
    ),
  ];
}

/** Same truthiness convention as the inventory list filters. */
function flag(value: unknown): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

interface BatchRow {
  item_id: string;
  purchased_at: string | null;
  vendor_name: string | null;
}

/** The most recent purchased batch per item gives the purchase date and shop. */
function latestBatches(rows: BatchRow[]): Map<string, BatchRow> {
  const latest = new Map<string, BatchRow>();
  // The query orders newest first, so the first row per item wins.
  for (const row of rows) {
    if (!latest.has(row.item_id)) latest.set(row.item_id, row);
  }
  return latest;
}

async function loadValuationItems(
  houseId: string,
  filters: ValuationFilters,
  reportDate: string,
): Promise<{ rows: ValuationSourceItem[]; truncated: boolean }> {
  const where = ["i.house_id = ?"];
  const params: unknown[] = [houseId];
  if (!filters.includeArchived) where.push("i.archived = 0");
  if (filters.categoryIds.length) {
    where.push(`i.category_id IN (${filters.categoryIds.map(() => "?").join(", ")})`);
    params.push(...filters.categoryIds);
  }
  if (filters.locationIds.length) {
    where.push(
      `EXISTS (SELECT 1 FROM stock_lots pl WHERE pl.item_id = i.id AND pl.quantity <> 0
         AND pl.location_id IN (${filters.locationIds.map(() => "?").join(", ")}))`,
    );
    params.push(...filters.locationIds);
  }
  if (filters.warrantyOnly) {
    where.push("i.warranty_until IS NOT NULL AND i.warranty_until >= ?");
    params.push(reportDate);
  }

  const rows = await all<any>(
    `SELECT i.id, i.name, i.brand, i.category_id, i.unit, i.tags, i.attributes, i.image,
       i.warranty_until, i.warranty_note, i.archived,
       c.name AS category_name,
       COALESCE((SELECT SUM(l.quantity) FROM stock_lots l WHERE l.item_id = i.id), 0) AS quantity,
       (SELECT sm.normalized_price FROM stock_movements sm
          WHERE sm.item_id = i.id AND sm.type = 'in'
            AND sm.normalized_price IS NOT NULL AND sm.normalized_price > 0
          ORDER BY sm.created_at DESC LIMIT 1) AS latest_price,
       (SELECT AVG(sm.normalized_price) FROM stock_movements sm
          WHERE sm.item_id = i.id AND sm.type = 'in'
            AND sm.normalized_price IS NOT NULL AND sm.normalized_price > 0) AS average_price,
       COALESCE((SELECT SUM(l.quantity) FROM stock_lots l
          WHERE l.item_id = i.id AND l.unit_price IS NOT NULL), 0) AS priced_quantity,
       COALESCE((SELECT SUM(l.quantity * l.unit_price) FROM stock_lots l
          WHERE l.item_id = i.id AND l.unit_price IS NOT NULL), 0) AS stock_value,
       (SELECT COUNT(*) FROM item_documents d WHERE d.item_id = i.id AND d.house_id = i.house_id) AS document_count
     FROM items i
     LEFT JOIN categories c ON c.id = i.category_id AND c.house_id = i.house_id
     WHERE ${where.join(" AND ")}
     ORDER BY lower(i.name)
     LIMIT ?`,
    [...params, MAX_VALUATION_ITEMS + 1],
  );

  const truncated = rows.length > MAX_VALUATION_ITEMS;
  const limited = truncated ? rows.slice(0, MAX_VALUATION_ITEMS) : rows;
  const wanted = new Set(limited.map((row) => String(row.id)));
  if (!wanted.size) return { rows: [], truncated };

  const [placeRows, batchRows] = await Promise.all([
    all<any>(
      `SELECT l.item_id, l.location_id, loc.name AS location_name,
         SUM(l.quantity) AS quantity,
         SUM(l.quantity * COALESCE(l.unit_price, 0)) AS value
       FROM stock_lots l
       LEFT JOIN locations loc ON loc.id = l.location_id AND loc.house_id = l.house_id
       WHERE l.house_id = ?
       GROUP BY l.item_id, l.location_id, loc.name`,
      [houseId],
    ),
    all<BatchRow>(
      `SELECT l.item_id, l.purchased_at, v.name AS vendor_name
       FROM stock_lots l
       LEFT JOIN vendors v ON v.id = l.vendor_id AND v.house_id = l.house_id
       WHERE l.house_id = ? AND l.purchased_at IS NOT NULL
       ORDER BY l.purchased_at DESC, l.created_at DESC`,
      [houseId],
    ),
  ]);

  const places = new Map<string, ValuationSourcePlace[]>();
  for (const row of placeRows) {
    const itemId = String(row.item_id);
    if (!wanted.has(itemId)) continue;
    const entry = places.get(itemId) ?? [];
    entry.push({
      locationId: row.location_id ?? null,
      locationName: row.location_name ?? null,
      quantity: Number(row.quantity ?? 0),
      value: Number(row.value ?? 0),
    });
    places.set(itemId, entry);
  }
  const batches = latestBatches(batchRows);

  const documents = filters.includeDocuments ? await loadDocuments(houseId, wanted) : new Map();

  return {
    truncated,
    rows: limited.map((row): ValuationSourceItem => {
      const itemId = String(row.id);
      const batch = batches.get(itemId);
      return {
        id: itemId,
        name: String(row.name),
        brand: row.brand ?? null,
        categoryId: row.category_id ?? null,
        categoryName: row.category_name ?? null,
        unit: row.unit,
        quantity: Number(row.quantity ?? 0),
        latestPrice: numberOrNull(row.latest_price),
        averagePrice: numberOrNull(row.average_price),
        pricedQuantity: Number(row.priced_quantity ?? 0),
        stockValue: Number(row.stock_value ?? 0),
        purchasedAt: batch?.purchased_at ?? null,
        shop: batch?.vendor_name ?? null,
        warrantyUntil: row.warranty_until ?? null,
        warrantyNote: row.warranty_note ?? null,
        attributes: parseJson<Record<string, unknown>>(row.attributes, {}),
        tags: parseJson<string[]>(row.tags, []),
        image: row.image ?? null,
        archived: Boolean(Number(row.archived ?? 0)),
        documentCount: Number(row.document_count ?? 0),
        places: places.get(itemId) ?? [],
        documents: documents.get(itemId),
      };
    }),
  };
}

/**
 * Document names and types only. No file contents and no download links: the
 * report must not leak a way to open a warranty PDF.
 */
async function loadDocuments(houseId: string, wanted: Set<string>) {
  const rows = await all<any>(
    `SELECT item_id, original_name, kind, mime, size FROM item_documents
     WHERE house_id = ? ORDER BY item_id, created_at`,
    [houseId],
  );
  const byItem = new Map<string, ValuationDocumentRef[]>();
  for (const row of rows) {
    const itemId = String(row.item_id);
    if (!wanted.has(itemId)) continue;
    const entry = byItem.get(itemId) ?? [];
    entry.push({
      name: String(row.original_name),
      kind: String(row.kind),
      mime: String(row.mime),
      size: Number(row.size ?? 0),
    });
    byItem.set(itemId, entry);
  }
  return byItem;
}

function csvFilename(houseName: string, reportDate: string): string {
  const slug = houseName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `svault-valuation-${slug || "house"}-${reportDate}.csv`;
}

reportRoutes.get(
  "/:houseId/reports/valuation",
  handler(async (req, res) => {
    // Viewer+, mirroring the existing inventory CSV export, which is built from
    // the viewer-readable item list. No extra role is invented here.
    // The report lists prices and purchase history for the whole house, so it is
    // for members and above; viewers can browse stock but not its value.
    const { houseId } = await requireHouse(req, "member");
    const query = parseBody(valuationQuerySchema, req.query ?? {});
    const filters: ValuationFilters = {
      basis: query.basis as ValuationBasis,
      categoryIds: listParam(query.categories),
      locationIds: listParam(query.places),
      tags: listParam(query.tags),
      minValue: query.minValue ?? null,
      warrantyOnly: flag(query.warranty),
      includeArchived: flag(query.archived),
      includeDocuments: flag(query.documents),
    };
    const house = await get<{ name: string; currency: string }>(
      "SELECT name, currency FROM houses WHERE id = ?",
      [houseId],
    );
    if (!house) throw new ApiError(404, "House not found");

    const reportDate = new Date().toISOString().slice(0, 10);
    const loaded = await loadValuationItems(houseId, filters, reportDate);
    const report = buildValuationReport({
      house: { id: houseId, name: house.name, currency: house.currency },
      reportDate,
      filters,
      items: loaded.rows,
      truncated: loaded.truncated,
    });

    if (query.format === "csv") {
      const csv = valuationCsv(report);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${csvFilename(report.houseName, report.reportDate)}"`,
      );
      res.setHeader("Cache-Control", "no-store");
      // The UTF-8 BOM keeps Greek names readable in Excel.
      res.send(`\uFEFF${csv}`);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(report);
  }),
);
