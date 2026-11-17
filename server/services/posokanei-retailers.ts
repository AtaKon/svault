import { all, get, lockHouseholdLedger, now, run, tx } from "../db.js";
import { ApiError } from "../http.js";
import type { ExternalShoppingOffer } from "../../shared/types.js";
import {
  canonicalVendorFrom,
  catalogEntries,
  normalizeVendorName,
  type CatalogEntry,
} from "./vendors.js";

/**
 * PosoKanei offers name retailers in its own vocabulary ("LIDL HELLAS",
 * "ΣΚΛΑΒΕΝΙΤΗΣ"). A house already has its own receipt shops, so this module
 * maps those labels onto `vendors` rows and lets an admin choose which shops
 * are accessible to the house.
 *
 * Discovery never overwrites an explicit mapping. When no mapping exists, an
 * unambiguous name or catalogue match fills the suggestion; anything else is
 * kept as an unknown retailer so the admin can match it later.
 */

export interface PosoKaneiRetailerVendor {
  id: string;
  name: string;
  kind: string;
  purchaseCount?: number;
}

export interface PosoKaneiRetailerRow {
  key: string;
  name: string;
  vendorId: string | null;
  vendorName: string | null;
  suggestedVendorId: string | null;
  unknown: boolean;
}

export interface PosoKaneiRetailerSettings {
  vendors: PosoKaneiRetailerVendor[];
  retailers: PosoKaneiRetailerRow[];
  accessibleVendorIds: string[];
  filterActive: boolean;
}

export interface PosoKaneiOfferFilterSummary {
  active: boolean;
  hiddenOffers: number;
  unknownRetailers: string[];
}

export interface PosoKaneiOfferFilterContext {
  active: boolean;
  selectedVendorIds: Set<string>;
  mappings: Map<string, string | null>;
  vendors: { id: string; name: string }[];
  catalog: CatalogEntry[];
  resolved: Map<string, string | null>;
  unknown: Map<string, string>;
  hiddenOffers: number;
  vendorByName: Map<string, string>;
  vendorByCanonical: Map<string, string | null>;
}

interface VendorRow {
  id: string;
  name: string;
  kind?: string;
  purchase_count?: number;
}

/** Normalise a PosoKanei retailer label for stable per-house storage. */
export function posoKaneiRetailerKey(value: unknown): string {
  return normalizeVendorName(String(value ?? ""));
}

/** Selected accessible vendor IDs, tolerating old or malformed settings. */
export function accessibleRetailerVendorIds(settings: Record<string, any> | null | undefined): string[] {
  const raw = settings?.priceLookup?.accessibleVendorIds;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (id) seen.add(id);
  }
  return [...seen].slice(0, 100);
}

function vendorIndexes(vendors: VendorRow[], catalog: CatalogEntry[]) {
  const vendorByName = new Map<string, string>();
  const vendorByCanonical = new Map<string, string | null>();
  for (const vendor of vendors) {
    const key = normalizeVendorName(vendor.name);
    // Names are unique per house, but keep the first deterministically if data
    // predates that constraint.
    if (key && !vendorByName.has(key)) vendorByName.set(key, vendor.id);
    const entry = canonicalVendorFrom(vendor.name, catalog);
    if (!entry) continue;
    vendorByCanonical.set(entry.id, vendorByCanonical.has(entry.id) ? null : vendor.id);
  }
  return { vendorByName, vendorByCanonical };
}

function inferVendorId(
  retailer: string,
  indexes: ReturnType<typeof vendorIndexes>,
  catalog: CatalogEntry[],
): string | null {
  const key = posoKaneiRetailerKey(retailer);
  if (!key) return null;
  const direct = indexes.vendorByName.get(key);
  if (direct) return direct;
  const entry = canonicalVendorFrom(retailer, catalog);
  if (!entry) return null;
  return indexes.vendorByCanonical.get(entry.id) ?? null;
}

async function loadHouseVendors(houseId: string, withPurchaseCount = false): Promise<VendorRow[]> {
  return all<VendorRow>(
    `SELECT v.id, v.name, v.kind,
       ${withPurchaseCount ? "(SELECT COUNT(*) FROM stock_lots l WHERE l.vendor_id = v.id) AS purchase_count" : "0 AS purchase_count"}
     FROM vendors v WHERE v.house_id = ? ORDER BY lower(v.name)`,
    [houseId],
  );
}

/**
 * Build one filter per lookup. It reads the house vendors and retailer
 * mappings once and caches label resolution, so filtering several products in
 * one search does not repeat those reads.
 */
export async function createPosoKaneiOfferFilter(
  houseId: string,
  settings: Record<string, any> | null | undefined,
): Promise<PosoKaneiOfferFilterContext> {
  const requested = accessibleRetailerVendorIds(settings);
  const context: PosoKaneiOfferFilterContext = {
    active: false,
    selectedVendorIds: new Set(),
    mappings: new Map(),
    vendors: [],
    catalog: [],
    resolved: new Map(),
    unknown: new Map(),
    hiddenOffers: 0,
    vendorByName: new Map(),
    vendorByCanonical: new Map(),
  };
  if (!requested.length) return context;

  const [vendors, mappings, catalog] = await Promise.all([
    loadHouseVendors(houseId),
    all<{ retailer_key: string; vendor_id: string | null }>(
      "SELECT retailer_key, vendor_id FROM posokanei_retailers WHERE house_id = ?",
      [houseId],
    ),
    catalogEntries("GR"),
  ]);
  const existing = new Set(vendors.map((vendor) => vendor.id));
  const selected = requested.filter((id) => existing.has(id));
  // A deleted shop in old settings must not silently hide every offer.
  if (!selected.length) return context;

  const indexes = vendorIndexes(vendors, catalog);
  context.active = true;
  context.selectedVendorIds = new Set(selected);
  context.vendors = vendors.map((vendor) => ({ id: vendor.id, name: vendor.name }));
  context.catalog = catalog;
  context.vendorByName = indexes.vendorByName;
  context.vendorByCanonical = indexes.vendorByCanonical;
  for (const row of mappings) {
    context.mappings.set(String(row.retailer_key), row.vendor_id ? String(row.vendor_id) : null);
  }
  return context;
}

async function resolvedVendorId(context: PosoKaneiOfferFilterContext, retailer: string): Promise<string | null> {
  const key = posoKaneiRetailerKey(retailer);
  if (!key) return null;
  if (context.resolved.has(key)) return context.resolved.get(key) ?? null;
  if (context.mappings.has(key)) {
    const mapped = context.mappings.get(key) ?? null;
    context.resolved.set(key, mapped);
    return mapped;
  }
  const inferred = inferVendorId(retailer, {
    vendorByName: context.vendorByName,
    vendorByCanonical: context.vendorByCanonical,
  }, context.catalog);
  context.resolved.set(key, inferred);
  return inferred;
}

/**
 * Keep only offers whose retailer resolves to a shop the house selected.
 * Unknown labels are counted and returned so the UI can say why an offer is
 * missing; they are never guessed into an accessible shop.
 */
export async function filterPosoKaneiOffers(
  context: PosoKaneiOfferFilterContext,
  offers: ExternalShoppingOffer[],
): Promise<ExternalShoppingOffer[]> {
  if (!context.active) return offers;
  const kept: ExternalShoppingOffer[] = [];
  for (const offer of offers) {
    const vendorId = await resolvedVendorId(context, offer.retailer);
    if (vendorId && context.selectedVendorIds.has(vendorId)) {
      kept.push(offer);
      continue;
    }
    context.hiddenOffers += 1;
    if (!vendorId) {
      const key = posoKaneiRetailerKey(offer.retailer);
      if (key && !context.unknown.has(key)) context.unknown.set(key, offer.retailer);
    }
  }
  return kept;
}

export function posoKaneiOfferFilterSummary(
  context: PosoKaneiOfferFilterContext,
): PosoKaneiOfferFilterSummary {
  return {
    active: context.active,
    hiddenOffers: context.hiddenOffers,
    unknownRetailers: [...context.unknown.values()],
  };
}

/**
 * Record retailer labels seen in an offer response. New rows get an
 * unambiguous house-shop match when one exists; existing rows (including
 * explicit mappings and deliberate "not matched" rows) are left alone.
 * Automatic discovery stops at 500 rows per house; manual mappings remain possible.
 */
export async function rememberPosoKaneiRetailers(
  houseId: string,
  offers: ExternalShoppingOffer[],
): Promise<void> {
  const names = new Map<string, string>();
  for (const offer of offers) {
    const name = offer.retailer.trim().slice(0, 120);
    const key = posoKaneiRetailerKey(name);
    if (key && !names.has(key)) names.set(key, name);
  }
  if (!names.size) return;

  const existing = new Set(
    (await all<{ retailer_key: string }>(
      "SELECT retailer_key FROM posokanei_retailers WHERE house_id = ?",
      [houseId],
    )).map((row) => String(row.retailer_key)),
  );
  const missing = [...names].filter(([key]) => !existing.has(key));
  if (!missing.length) return;

  const [vendors, catalog] = await Promise.all([loadHouseVendors(houseId), catalogEntries("GR")]);
  const indexes = vendorIndexes(vendors, catalog);
  const timestamp = now();
  await tx(async (session) => {
    // Serialize discovery per house so concurrent requests cannot exceed the cap.
    if (!await lockHouseholdLedger(session, houseId)) return;
    const count = await session.get<{ count: number }>("SELECT COUNT(*) AS count FROM posokanei_retailers WHERE house_id = ?", [houseId]);
    let remaining = Math.max(0, 500 - Number(count?.count ?? 0));
    for (const [key, name] of missing) {
      if (!remaining) break;
      const vendorId = inferVendorId(name, indexes, catalog);
      const inserted = await session.run(
        `INSERT INTO posokanei_retailers (house_id, retailer_key, retailer_name, vendor_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (house_id, retailer_key) DO NOTHING`,
        [houseId, key, name, vendorId, timestamp, timestamp],
      );
      remaining -= inserted.changes;
    }
  }, { writeLock: true });
}

export async function listPosoKaneiRetailerSettings(
  houseId: string,
  settings: Record<string, any> | null | undefined,
): Promise<PosoKaneiRetailerSettings> {
  const [vendors, rows, catalog] = await Promise.all([
    loadHouseVendors(houseId, true),
    all<any>(
      `SELECT r.retailer_key, r.retailer_name, r.vendor_id, v.name AS vendor_name
       FROM posokanei_retailers r
       LEFT JOIN vendors v ON v.id = r.vendor_id AND v.house_id = r.house_id
       WHERE r.house_id = ? ORDER BY lower(r.retailer_name)`,
      [houseId],
    ),
    catalogEntries("GR"),
  ]);
  const indexes = vendorIndexes(vendors, catalog);
  const vendorIds = new Set(vendors.map((vendor) => vendor.id));
  const accessibleVendorIds = accessibleRetailerVendorIds(settings).filter((id) => vendorIds.has(id));

  return {
    vendors: vendors.map((vendor) => ({
      id: vendor.id,
      name: vendor.name,
      kind: vendor.kind ?? "shop",
      purchaseCount: Number(vendor.purchase_count ?? 0),
    })),
    retailers: rows.map((row) => {
      const vendorId = row.vendor_id ? String(row.vendor_id) : null;
      return {
        key: String(row.retailer_key),
        name: String(row.retailer_name),
        vendorId,
        vendorName: vendorId ? String(row.vendor_name ?? "") : null,
        suggestedVendorId: vendorId ? null : inferVendorId(String(row.retailer_name), indexes, catalog),
        unknown: !vendorId,
      };
    }),
    accessibleVendorIds,
    filterActive: accessibleVendorIds.length > 0,
  };
}

export async function upsertPosoKaneiRetailer(
  houseId: string,
  retailerName: string,
  vendorId: string | null,
): Promise<PosoKaneiRetailerRow> {
  const key = posoKaneiRetailerKey(retailerName);
  if (!key) throw new ApiError(400, "Invalid request");
  let vendorName: string | null = null;
  if (vendorId) {
    const vendor = await get<{ id: string; name: string }>(
      "SELECT id, name FROM vendors WHERE id = ? AND house_id = ?",
      [vendorId, houseId],
    );
    if (!vendor) throw new ApiError(400, "Shop does not exist in this house");
    vendorName = String(vendor.name);
  }
  const timestamp = now();
  await run(
    `INSERT INTO posokanei_retailers (house_id, retailer_key, retailer_name, vendor_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (house_id, retailer_key)
     DO UPDATE SET retailer_name = excluded.retailer_name, vendor_id = excluded.vendor_id, updated_at = excluded.updated_at`,
    [houseId, key, retailerName.trim().slice(0, 120), vendorId, timestamp, timestamp],
  );

  let suggestedVendorId: string | null = null;
  if (!vendorId) {
    const [vendors, catalog] = await Promise.all([loadHouseVendors(houseId), catalogEntries("GR")]);
    suggestedVendorId = inferVendorId(retailerName, vendorIndexes(vendors, catalog), catalog);
  }
  return {
    key,
    name: retailerName.trim().slice(0, 120),
    vendorId,
    vendorName,
    suggestedVendorId,
    unknown: !vendorId,
  };
}

export async function deletePosoKaneiRetailer(houseId: string, retailerKey: string): Promise<void> {
  const key = posoKaneiRetailerKey(retailerKey);
  if (!key) return;
  await run("DELETE FROM posokanei_retailers WHERE house_id = ? AND retailer_key = ?", [houseId, key]);
}
