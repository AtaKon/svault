import fs from "node:fs";
import path from "node:path";
import { all, get, newId, now, run } from "../db.js";
import { ROOT, CATALOG_URL } from "../config.js";
import type { CatalogExport, CatalogImportResult, CatalogMapping } from "../../shared/types.js";
import { normalizeVendorName } from "./vendors.js";
import { productAliasKey } from "./product-aliases.js";

/**
 * Shared receipt-text -> OpenFoodFacts catalogue.
 *
 * Seed rows ship in `assets/catalog/off-mappings.json`. Rows learned on this
 * instance are marked `local` and always win over seed/community data. An admin
 * can export the catalogue, import a file, or sync from `SV_CATALOG_URL`.
 *
 * Learned rows belong to the house whose receipt taught them (`house_id`), so
 * one household's purchases never show up as suggestions in another. Seed and
 * community rows, and rows learned without a house, are shared (`house_id` '').
 */

const SEED_FILE = path.join(ROOT, "assets", "catalog", "off-mappings.json");
const MAX_MAPPINGS = 20000;

interface MappingRow {
  id: string;
  house_id: string;
  country: string;
  vendor_key: string;
  vendor_label: string | null;
  raw_key: string;
  raw_text: string | null;
  off_code: string | null;
  name: string | null;
  brand: string | null;
  unit: string | null;
  category: string | null;
  source: string;
  confidence: number;
  uses: number;
  created_at: string;
  updated_at: string;
}

function sourceValue(value: unknown): CatalogMapping["source"] {
  return value === "seed" || value === "community" ? value : "local";
}

export function serializeCatalogMapping(row: MappingRow): CatalogMapping {
  return {
    id: row.id,
    country: row.country ?? "",
    vendor: row.vendor_label ?? null,
    rawText: row.raw_text ?? row.raw_key,
    offCode: row.off_code ?? null,
    name: row.name ?? null,
    brand: row.brand ?? null,
    unit: row.unit ?? null,
    category: row.category ?? null,
    source: sourceValue(row.source),
    confidence: Number(row.confidence ?? 0),
    uses: Number(row.uses ?? 0),
    updatedAt: row.updated_at,
  };
}

function countryKey(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .slice(0, 2);
}

/** Seed the bundled catalogue without touching rows learned on this instance. */
export async function seedProductCatalog() {
  if (!fs.existsSync(SEED_FILE)) return;
  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
  } catch (error) {
    console.warn(`Could not read ${SEED_FILE}:`, error instanceof Error ? error.message : error);
    return;
  }
  const entries = Array.isArray(data?.mappings) ? data.mappings : Array.isArray(data) ? data : [];
  if (!entries.length) return;
  let seeded = 0;
  for (const entry of entries.slice(0, MAX_MAPPINGS)) {
    const rawText = String(entry?.rawText ?? entry?.raw_text ?? "").trim();
    const rawKey = productAliasKey(rawText);
    if (!rawKey) continue;
    const vendorLabel = String(entry?.vendor ?? "").trim() || null;
    const vendorKey = vendorLabel ? normalizeVendorName(vendorLabel) : "";
    const country = countryKey(entry?.country);
    const offCode = String(entry?.offCode ?? entry?.off_code ?? "").replace(/\D/g, "").slice(0, 14) || null;
    const name = String(entry?.name ?? "").trim().slice(0, 200) || null;
    if (!offCode && !name) continue;
    const timestamp = now();
    const result = await run(
      `INSERT INTO catalog_mappings
         (id, country, vendor_key, vendor_label, raw_key, raw_text, off_code, name, brand, unit, category,
          source, confidence, uses, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed', ?, 0, ?, ?)
       ON CONFLICT(house_id, country, vendor_key, raw_key) DO UPDATE SET
         vendor_label = excluded.vendor_label,
         raw_text = excluded.raw_text,
         off_code = excluded.off_code,
         name = excluded.name,
         brand = excluded.brand,
         unit = excluded.unit,
         category = excluded.category,
         confidence = excluded.confidence,
         updated_at = excluded.updated_at
       WHERE catalog_mappings.source = 'seed'`,
      [
        newId("cmap"),
        country,
        vendorKey,
        vendorLabel,
        rawKey,
        rawText.slice(0, 200),
        offCode,
        name,
        String(entry?.brand ?? "").trim().slice(0, 80) || null,
        String(entry?.unit ?? "").trim().slice(0, 10) || null,
        String(entry?.category ?? "").trim().slice(0, 80) || null,
        Math.min(1, Math.max(0, Number(entry?.confidence ?? 0.7))),
        timestamp,
        timestamp,
      ],
    );
    if (result.changes) seeded++;
  }
  if (seeded) console.log(`Product catalogue: ${seeded} bundled mapping${seeded === 1 ? "" : "s"} loaded`);
}

/**
 * Resolve a raw receipt line through the shared catalogue. Shop-specific rows
 * win over generic ones; the requested country wins over the global bucket.
 */
export async function findCatalogMapping(opts: {
  country?: string | null;
  vendorName?: string | null;
  rawDescription: string;
  /** The house asking. Its own learned rows are considered before shared ones. */
  houseId?: string | null;
}): Promise<CatalogMapping | null> {
  const rawKey = productAliasKey(opts.rawDescription);
  if (!rawKey) return null;
  const country = countryKey(opts.country);
  const vendorKey = opts.vendorName ? normalizeVendorName(opts.vendorName) : "";
  const attempts: { country: string; vendor: string }[] = [
    { country, vendor: vendorKey },
    { country, vendor: "" },
    { country: "", vendor: vendorKey },
    { country: "", vendor: "" },
  ];
  const seen = new Set<string>();
  for (const attempt of attempts) {
    const key = `${attempt.country}\u0000${attempt.vendor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = opts.houseId
      ? await get<MappingRow>(
          `SELECT * FROM catalog_mappings WHERE house_id IN (?, '') AND country = ? AND vendor_key = ? AND raw_key = ?
           ORDER BY CASE WHEN house_id = '' THEN 1 ELSE 0 END LIMIT 1`,
          [opts.houseId, attempt.country, attempt.vendor, rawKey],
        )
      : await get<MappingRow>(
          "SELECT * FROM catalog_mappings WHERE house_id = '' AND country = ? AND vendor_key = ? AND raw_key = ?",
          [attempt.country, attempt.vendor, rawKey],
        );
    if (row) return serializeCatalogMapping(row);
  }
  return null;
}

/**
 * Remember a receipt mapping locally. Local corrections beat seed rows. With
 * a houseId the row is private to that house; without one it is shared.
 */
export async function learnCatalogMapping(opts: {
  houseId?: string | null;
  country?: string | null;
  vendorName?: string | null;
  rawDescription: string;
  offCode?: string | null;
  name?: string | null;
  brand?: string | null;
  unit?: string | null;
  category?: string | null;
  confidence?: number;
}) {
  const rawText = String(opts.rawDescription ?? "").trim();
  const rawKey = productAliasKey(rawText);
  if (!rawKey || rawKey.length < 2) return;
  const offCode = String(opts.offCode ?? "").replace(/\D/g, "").slice(0, 14) || null;
  const name = String(opts.name ?? "").trim().slice(0, 200) || null;
  if (!offCode && !name) return;
  const vendorLabel = String(opts.vendorName ?? "").trim().slice(0, 80) || null;
  const vendorKey = vendorLabel ? normalizeVendorName(vendorLabel) : "";
  const country = countryKey(opts.country);
  const timestamp = now();
  await run(
    `INSERT INTO catalog_mappings
       (id, house_id, country, vendor_key, vendor_label, raw_key, raw_text, off_code, name, brand, unit, category,
        source, confidence, uses, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, 1, ?, ?)
     ON CONFLICT(house_id, country, vendor_key, raw_key) DO UPDATE SET
       vendor_label = excluded.vendor_label,
       raw_text = excluded.raw_text,
       off_code = COALESCE(excluded.off_code, catalog_mappings.off_code),
       name = COALESCE(excluded.name, catalog_mappings.name),
       brand = COALESCE(excluded.brand, catalog_mappings.brand),
       unit = COALESCE(excluded.unit, catalog_mappings.unit),
       category = COALESCE(excluded.category, catalog_mappings.category),
       source = 'local',
       confidence = CASE WHEN excluded.confidence > catalog_mappings.confidence THEN excluded.confidence ELSE catalog_mappings.confidence END,
       uses = catalog_mappings.uses + 1,
       updated_at = excluded.updated_at`,
    [
      newId("cmap"),
      String(opts.houseId ?? ""),
      country,
      vendorKey,
      vendorLabel,
      rawKey,
      rawText.slice(0, 200),
      offCode,
      name,
      String(opts.brand ?? "").trim().slice(0, 80) || null,
      String(opts.unit ?? "").trim().slice(0, 10) || null,
      String(opts.category ?? "").trim().slice(0, 80) || null,
      Math.min(1, Math.max(0, Number(opts.confidence ?? 0.8))),
      timestamp,
      timestamp,
    ],
  );
}

export async function listCatalogMappings(query: string, limit = 100): Promise<CatalogMapping[]> {
  const q = String(query ?? "").trim();
  const capped = Math.min(Math.max(limit, 1), 500);
  const rows = q
    ? await all<MappingRow>(
        `SELECT * FROM catalog_mappings
         WHERE lower(raw_text) LIKE lower(?) OR lower(name) LIKE lower(?) OR lower(off_code) LIKE lower(?) OR lower(vendor_label) LIKE lower(?)
         ORDER BY uses DESC, updated_at DESC LIMIT ?`,
        [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, capped],
      )
    : await all<MappingRow>("SELECT * FROM catalog_mappings ORDER BY uses DESC, updated_at DESC LIMIT ?", [capped]);
  return rows.map(serializeCatalogMapping);
}

export async function exportCatalogMappings(): Promise<CatalogExport> {
  const allRows = await all<MappingRow>(
    "SELECT * FROM catalog_mappings ORDER BY country, vendor_key, raw_key, uses DESC, updated_at DESC",
  );
  // House-scoped rows can repeat a key; the export has no house column, so keep the most used one.
  const seen = new Set<string>();
  const rows = allRows.filter((row) => {
    const key = `${row.country}\u0000${row.vendor_key}\u0000${row.raw_key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    version: 1,
    generatedAt: now(),
    mappings: rows.map((row) => {
      const mapping = serializeCatalogMapping(row);
      const { id: _id, uses: _uses, updatedAt: _updatedAt, ...entry } = mapping;
      void _id;
      void _uses;
      void _updatedAt;
      return entry;
    }),
  };
}

function normalizeImportEntry(entry: any): Omit<CatalogMapping, "id" | "uses" | "updatedAt"> | null {
  if (!entry || typeof entry !== "object") return null;
  const rawText = String(entry.rawText ?? entry.raw_text ?? "").trim();
  if (!rawText) return null;
  const offCode = String(entry.offCode ?? entry.off_code ?? "").replace(/\D/g, "").slice(0, 14) || null;
  const name = String(entry.name ?? "").trim().slice(0, 200) || null;
  if (!offCode && !name) return null;
  return {
    country: countryKey(entry.country),
    vendor: String(entry.vendor ?? "").trim().slice(0, 80) || null,
    rawText: rawText.slice(0, 200),
    offCode,
    name,
    brand: String(entry.brand ?? "").trim().slice(0, 80) || null,
    unit: String(entry.unit ?? "").trim().slice(0, 10) || null,
    category: String(entry.category ?? "").trim().slice(0, 80) || null,
    source: entry.source === "seed" ? "seed" : "community",
    confidence: Math.min(1, Math.max(0, Number(entry.confidence ?? 0.7))),
  };
}

/** Merge an exported catalogue. Local rows are never overwritten by an import. */
export async function importCatalogMappings(input: unknown): Promise<CatalogImportResult> {
  const entries = Array.isArray(input)
    ? input
    : Array.isArray((input as any)?.mappings)
      ? (input as any).mappings
      : [];
  if (!Array.isArray(entries)) return { imported: 0, updated: 0, skipped: 0, total: 0 };
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const timestamp = now();
  for (const entry of entries.slice(0, MAX_MAPPINGS)) {
    const mapping = normalizeImportEntry(entry);
    if (!mapping) {
      skipped++;
      continue;
    }
    const rawKey = productAliasKey(mapping.rawText);
    if (!rawKey) {
      skipped++;
      continue;
    }
    const vendorKey = mapping.vendor ? normalizeVendorName(mapping.vendor) : "";
    const existing = await get<{ id: string; source: string }>(
      "SELECT id, source FROM catalog_mappings WHERE house_id = '' AND country = ? AND vendor_key = ? AND raw_key = ?",
      [mapping.country, vendorKey, rawKey],
    );
    if (existing?.source === "local") {
      skipped++;
      continue;
    }
    await run(
      `INSERT INTO catalog_mappings
         (id, country, vendor_key, vendor_label, raw_key, raw_text, off_code, name, brand, unit, category,
          source, confidence, uses, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(house_id, country, vendor_key, raw_key) DO UPDATE SET
         vendor_label = excluded.vendor_label,
         raw_text = excluded.raw_text,
         off_code = excluded.off_code,
         name = excluded.name,
         brand = excluded.brand,
         unit = excluded.unit,
         category = excluded.category,
         source = excluded.source,
         confidence = excluded.confidence,
         updated_at = excluded.updated_at
       WHERE catalog_mappings.source <> 'local'`,
      [
        newId("cmap"),
        mapping.country,
        vendorKey,
        mapping.vendor,
        rawKey,
        mapping.rawText,
        mapping.offCode,
        mapping.name,
        mapping.brand,
        mapping.unit,
        mapping.category,
        mapping.source,
        mapping.confidence,
        timestamp,
        timestamp,
      ],
    );
    if (existing) updated++;
    else imported++;
  }
  return { imported, updated, skipped, total: entries.length };
}

export async function syncProductCatalog(url?: string): Promise<CatalogImportResult> {
  const endpoint = String(url ?? CATALOG_URL ?? "").trim();
  if (!endpoint) {
    throw new Error("No catalogue URL configured. Set SV_CATALOG_URL or paste a catalogue file.");
  }
  if (!/^https?:\/\//i.test(endpoint)) throw new Error("Catalogue URL must start with http:// or https://");
  const response = await fetch(endpoint, {
    signal: AbortSignal.timeout(15_000),
    headers: { "user-agent": "SVault/1.0 (catalogue sync)" },
  });
  if (!response.ok) throw new Error(`Catalogue download failed (${response.status})`);
  const data = await response.json();
  return await importCatalogMappings(data);
}

export async function catalogStats() {
  return {
    mappings: Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM catalog_mappings"))?.n ?? 0),
    seed: Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM catalog_mappings WHERE source = 'seed'"))?.n ?? 0),
    local: Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM catalog_mappings WHERE source = 'local'"))?.n ?? 0),
    community: Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM catalog_mappings WHERE source = 'community'"))?.n ?? 0),
    products: Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM catalog_products"))?.n ?? 0),
    syncUrl: CATALOG_URL || null,
  };
}
