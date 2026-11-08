import { all, get, newId, now, parseJson, run } from "../db.js";
import { APP_VERSION, OFF_CACHE_DAYS, OFF_SEARCH_BASE, OFF_TIMEOUT_MS } from "../config.js";
import type { OffProduct, OffProjectId, OffProductType } from "../../shared/types.js";
import { normaliseNutrition, parseOffNutrition } from "./nutrition.js";
import { normalizeVendorName } from "./vendors.js";
import { ApiError } from "../http.js";
import {
  OFF_PROJECTS,
  isOffProjectId,
  offProductEndpoint,
  offProjectForDomain,
  offProjectForProductType,
  offUniversalEndpoint,
} from "./off/projects.js";

/**
 * Open Food Facts integration.
 *
 * All four product databases (food, beauty, pet food, general products) share
 * one cache in `catalog_products`, keyed by `(project, code)`. The universal
 * endpoint answers barcode lookups and tells us which project owns the product.
 *
 * Nothing is fetched when a fresh cached copy exists, so receipt imports and
 * scans stay fast. Writes live in a separate contribution service; this module
 * is deliberately read-only.
 */

const CONTACT = String(process.env.SV_OFF_CONTACT ?? "").trim();
const PRODUCT_HEADERS = {
  "user-agent": `SVault/${APP_VERSION} (self-hosted household inventory; https://github.com/AtaKon/svault${
    CONTACT ? `; ${CONTACT}` : ""
  })`,
};
const SEARCH_MIN_INTERVAL = 1500;
let lastSearchAt = 0;

const searchCache = new Map<string, { at: number; products: OffProduct[] }>();

function stripTag(tag: string): string {
  return String(tag ?? "")
    .replace(/^[a-z]{2}:/, "")
    .replace(/-/g, " ")
    .trim();
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const joined = value.filter((entry) => typeof entry === "string" && entry.trim()).join(", ");
      if (joined) return joined;
    }
  }
  return "";
}

function stringList(value: unknown, map: (entry: string) => string = (entry) => entry): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => map(String(entry))).filter(Boolean))];
}

export function offProductTypeFor(project: OffProjectId): OffProductType {
  return OFF_PROJECTS[project].productType;
}

export function offSummaryFromPayload(payload: any, project: OffProjectId = "off"): OffProduct {
  const resolved = offProjectForProductType(payload?.product_type) ?? project;
  const name =
    firstString(payload?.product_name, payload?.generic_name) ||
    Object.entries(payload ?? {})
      .filter(([key, value]) => key.startsWith("product_name_") && typeof value === "string" && value.trim())
      .map(([, value]) => String(value).trim())[0] ||
    "";
  const brands = firstString(payload?.brands);
  const categories = stringList(payload?.categories_tags, stripTag);
  if (!categories.length && typeof payload?.categories === "string") {
    categories.push(
      ...payload.categories
        .split(",")
        .map((entry: string) => entry.trim())
        .filter(Boolean),
    );
  }
  return {
    code: String(payload?.code ?? payload?._id ?? ""),
    project: resolved,
    productType: offProductTypeFor(resolved),
    name,
    brand: brands,
    genericName: firstString(payload?.generic_name),
    quantity: firstString(payload?.quantity),
    categories,
    image: firstString(payload?.image_front_small_url, payload?.image_front_url, payload?.image_url) || null,
    ingredients: firstString(payload?.ingredients_text) || null,
    allergens: stringList(payload?.allergens_tags, stripTag),
    labels: stringList(payload?.labels_tags, stripTag),
    nutriscore: firstString(payload?.nutriscore_grade, payload?.nutrition_grades) || null,
    novaGroup: payload?.nova_group != null && Number.isFinite(Number(payload.nova_group)) ? Number(payload.nova_group) : null,
    countries: stringList(payload?.countries_tags, stripTag),
    packaging: firstString(payload?.packaging) || null,
    servingSize: firstString(payload?.serving_size) || null,
    nutrition: parseOffNutrition(payload),
    source: "openfoodfacts",
    fetchedAt: now(),
  };
}

export function offProductFromRow(row: any): OffProduct | null {
  if (!row) return null;
  const project: OffProjectId = isOffProjectId(row.project) ? row.project : "off";
  const summary = parseJson<OffProduct | null>(row.summary, null);
  if (summary && typeof summary === "object") {
    return {
      ...summary,
      code: summary.code || row.code,
      project: isOffProjectId(summary.project) ? summary.project : project,
      productType: summary.productType ?? offProductTypeFor(isOffProjectId(summary.project) ? summary.project : project),
      name: summary.name || row.name || "",
      brand: summary.brand || row.brand || "",
      quantity: summary.quantity || row.quantity || "",
      image: summary.image ?? row.image ?? null,
      nutrition: normaliseNutrition(summary.nutrition) ?? parseOffNutrition(parseJson(row.payload, {})),
      fetchedAt: summary.fetchedAt || row.fetched_at,
      source: row.source === "catalog" ? "catalog" : "openfoodfacts",
    };
  }
  return {
    code: row.code,
    project,
    productType: offProductTypeFor(project),
    name: row.name ?? "",
    brand: row.brand ?? "",
    genericName: "",
    quantity: row.quantity ?? "",
    categories: parseJson<string[]>(row.categories, []),
    image: row.image ?? null,
    ingredients: null,
    allergens: [],
    labels: [],
    nutriscore: null,
    novaGroup: null,
    countries: [],
    packaging: null,
    servingSize: null,
    nutrition: null,
    source: row.source === "catalog" ? "catalog" : "openfoodfacts",
    fetchedAt: row.fetched_at,
  };
}

/** All reasonable GTIN spellings for a scanned or printed code. */
export function barcodeCandidates(raw: string): string[] {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits || digits.length < 6 || digits.length > 14) return [];
  const candidates = new Set<string>([digits]);
  if (digits.length <= 13) candidates.add(digits.padStart(13, "0"));
  if (digits.length <= 14) candidates.add(digits.padStart(14, "0"));
  const stripped = digits.replace(/^0+/, "");
  if (stripped.length >= 6) {
    if (stripped.length <= 13) candidates.add(stripped.padStart(13, "0"));
    candidates.add(stripped);
  }
  return [...candidates].slice(0, 5);
}

function cacheIsFresh(row: any): boolean {
  const fetched = new Date(row?.fetched_at ?? 0).getTime();
  return Number.isFinite(fetched) && Date.now() - fetched < OFF_CACHE_DAYS * 864e5;
}

async function cachedRow(code: string, project: OffProjectId | "all" = "off"): Promise<any | null> {
  const candidates = barcodeCandidates(code);
  if (!candidates.length) return null;
  const placeholders = candidates.map(() => "?").join(", ");
  const params: unknown[] = [...candidates];
  let clause = `code IN (${placeholders})`;
  if (project !== "all") {
    clause += " AND project = ?";
    params.push(project);
  }
  return (
    (await get<any>(
      `SELECT * FROM catalog_products WHERE ${clause}
       ORDER BY CASE WHEN payload <> '{}' THEN 0 ELSE 1 END, fetched_at DESC LIMIT 1`,
      params,
    )) ?? null
  );
}

/** Cached product without touching the network. Used by receipt drafts. */
export async function getCachedOffProduct(code: string, project: OffProjectId | "all" = "off"): Promise<OffProduct | null> {
  return offProductFromRow(await cachedRow(code, project));
}

/** Full cached payload, when one has been stored. */
export async function getCachedOffPayload(
  code: string,
  project: OffProjectId | "all" = "off",
): Promise<Record<string, unknown> | null> {
  const row = await cachedRow(code, project);
  if (!row) return null;
  const payload = parseJson<Record<string, unknown> | null>(row.payload, null);
  return payload && Object.keys(payload).length ? payload : null;
}

async function saveOffProduct(
  payload: any,
  requestedCode: string,
  fallbackProject: OffProjectId,
  aliasProject: OffProjectId = fallbackProject,
): Promise<OffProduct> {
  const summary = offSummaryFromPayload(payload, fallbackProject);
  const code = String(summary.code || requestedCode).trim();
  if (!code) return summary;
  summary.code = code;
  const timestamp = now();
  await run(
    `INSERT INTO catalog_products
       (project, code, name, brand, quantity, image, categories, summary, payload, source, fetched_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'openfoodfacts', ?, ?)
     ON CONFLICT(project, code) DO UPDATE SET
       name = excluded.name,
       brand = excluded.brand,
       quantity = excluded.quantity,
       image = excluded.image,
       categories = excluded.categories,
       summary = excluded.summary,
       payload = excluded.payload,
       source = excluded.source,
       fetched_at = excluded.fetched_at,
       updated_at = excluded.updated_at`,
    [
      summary.project,
      code,
      summary.name,
      summary.brand,
      summary.quantity,
      summary.image,
      JSON.stringify(summary.categories),
      JSON.stringify(summary),
      JSON.stringify(payload ?? {}),
      timestamp,
      timestamp,
    ],
  );
  // Keep the scanned spelling as an alias so a future scan hits the cache even
  // when OpenFoodFacts canonicalises the code (for example by adding a zero).
  if (code !== requestedCode && aliasProject === summary.project) {
    await run(
      `INSERT INTO catalog_products
         (project, code, name, brand, quantity, image, categories, summary, payload, source, fetched_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 'catalog', ?, ?)
       ON CONFLICT(project, code) DO NOTHING`,
      [
        aliasProject,
        requestedCode,
        summary.name,
        summary.brand,
        summary.quantity,
        summary.image,
        JSON.stringify(summary.categories),
        JSON.stringify({ ...summary, code }),
        timestamp,
        timestamp,
      ],
    );
  }
  return summary;
}

async function fetchProductPayload(
  code: string,
  project: OffProjectId | "all" = "off",
): Promise<{ payload: any; project: OffProjectId } | null> {
  const url = project === "all" ? offUniversalEndpoint(code) : offProductEndpoint(project, code);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(OFF_TIMEOUT_MS), headers: PRODUCT_HEADERS });
    if (!res.ok) return null;
    const data: any = await res.json();
    if (data?.status !== "success" && Number(data?.status) !== 1) return null;
    const payload = data?.product;
    if (!payload || typeof payload !== "object" || !payload.code) return null;
    const resolved =
      offProjectForProductType(payload?.product_type) ??
      offProjectForDomain(res.url) ??
      (project === "all" ? "off" : project);
    return { payload, project: resolved };
  } catch {
    return null;
  }
}

/**
 * Resolve a product by code. Fresh caches win; otherwise the product endpoint
 * is tried for each GTIN spelling. Use `project: "all"` for an unknown barcode
 * so the universal endpoint can route to the owning database.
 */
export async function fetchOffProduct(
  rawCode: string,
  options: { force?: boolean; project?: OffProjectId | "all" } = {},
): Promise<OffProduct | null> {
  const candidates = barcodeCandidates(rawCode);
  if (!candidates.length) return null;
  const project = options.project ?? "off";

  const cached = await cachedRow(rawCode, project);
  if (cached && !options.force && cacheIsFresh(cached)) return offProductFromRow(cached);

  for (const candidate of candidates) {
    const result = await fetchProductPayload(candidate, project);
    if (result) return await saveOffProduct(result.payload, candidate, result.project, project === "all" ? result.project : project);
  }
  return cached ? offProductFromRow(cached) : null;
}

async function fetchSearchHits(query: string, limit: number): Promise<OffProduct[]> {
  const url = `${OFF_SEARCH_BASE}/search?q=${encodeURIComponent(query)}&page_size=${Math.min(Math.max(limit, 1), 20)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(OFF_TIMEOUT_MS), headers: PRODUCT_HEADERS });
    if (!res.ok) return [];
    const data: any = await res.json();
    const hits = Array.isArray(data?.hits) ? data.hits : [];
    return hits
      .map((hit: any) =>
        offSummaryFromPayload({
          ...hit,
          brands: Array.isArray(hit.brands) ? hit.brands.join(", ") : hit.brands,
        }),
      )
      .filter((product: OffProduct) => product.code && product.name);
  } catch {
    return [];
  }
}

/**
 * Full-text search is only available for Open Food Facts through
 * Search-a-licious. The other projects fall back to the local cache; callers
 * should surface the limited-search warning instead of pretending otherwise.
 */
export async function searchOffProducts(query: string, limit = 8, project: OffProjectId = "off"): Promise<OffProduct[]> {
  if (project !== "off") return [];
  const q = String(query ?? "").trim();
  if (q.length < 3) return [];
  const key = q.toLowerCase();
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.products;
  if (Date.now() - lastSearchAt < SEARCH_MIN_INTERVAL) return cached?.products ?? [];
  lastSearchAt = Date.now();
  const products = await fetchSearchHits(q, limit);
  searchCache.set(key, { at: Date.now(), products });
  return products;
}

function firstBrand(value: string | null | undefined): string | null {
  const brand = String(value ?? "")
    .split(",")[0]
    .trim();
  return brand ? brand.slice(0, 80) : null;
}

/** Unit printed on the package: "500 g" -> "g", "1.5 l" -> "l". */
export function offQuantityUnit(quantity: string | null | undefined): string | null {
  const match = /(\d+(?:[.,]\d+)?)\s*(kg|gr|g|mg|lt|l|ml|cl|dl|oz|lb)\b/i.exec(String(quantity ?? ""));
  if (!match) return null;
  const unit = match[2].toLowerCase();
  if (unit === "gr") return "g";
  if (unit === "lt") return "l";
  return unit;
}

function blank(value: unknown): boolean {
  return value == null || String(value).trim() === "";
}

async function matchHouseCategory(houseId: string, product: OffProduct): Promise<string | null> {
  const categories = await all<{ id: string; name: string }>(
    "SELECT id, name FROM categories WHERE house_id = ? ORDER BY created_at",
    [houseId],
  );
  if (!categories.length) return null;
  const wanted = new Set(
    [product.categories.join(" "), product.name, product.genericName]
      .flatMap((entry) => String(entry ?? "").split(/[,·/]/))
      .map((entry) => normalizeVendorName(entry))
      .filter((entry) => entry.length >= 3),
  );
  for (const category of categories) {
    const name = normalizeVendorName(category.name);
    if (!name) continue;
    if (wanted.has(name)) return category.id;
    for (const wantedName of wanted) {
      if (wantedName.includes(name) || name.includes(wantedName)) {
        const score = Math.min(name.length, wantedName.length) / Math.max(name.length, wantedName.length);
        if (score >= 0.7) return category.id;
      }
    }
  }
  return null;
}

export interface OffFillResult {
  filled: string[];
  skipped: { field: string; reason: string }[];
  item: any;
}

/**
 * Fill empty first-class item fields from an OFF product. Existing values are
 * never overwritten: only blank columns (and, when explicitly allowed, the
 * default `pcs` unit of a brand-new receipt item) are updated.
 */
export async function fillItemFromOff(opts: {
  item: any;
  product: OffProduct;
  source: "barcode" | "receipt" | "manual" | "catalog";
  allowDefaultUnit?: boolean;
}): Promise<OffFillResult> {
  const { item, product } = opts;
  const filled: string[] = [];
  const skipped: { field: string; reason: string }[] = [];
  const patch: Record<string, unknown> = {};

  if (blank(item.name) && product.name) {
    patch.name = product.name.slice(0, 120);
    filled.push("name");
  }
  const description = product.genericName || "";
  if (blank(item.description) && description && normalizeVendorName(description) !== normalizeVendorName(item.name)) {
    patch.description = description.slice(0, 2000);
    filled.push("description");
  }
  const brand = firstBrand(product.brand);
  if (blank(item.brand) && brand) {
    patch.brand = brand;
    filled.push("brand");
  }
  if (blank(item.image) && product.image) {
    patch.image = product.image;
    filled.push("image");
  }
  if (blank(item.category_id)) {
    const categoryId = await matchHouseCategory(item.house_id, product);
    if (categoryId) {
      patch.category_id = categoryId;
      filled.push("category");
    }
  }
  const currentNutrition = normaliseNutrition(parseJson(item.nutrition, null));
  if (!currentNutrition && product.nutrition) {
    patch.nutrition = JSON.stringify(product.nutrition);
    filled.push("nutrition");
  } else if (currentNutrition && product.nutrition) {
    skipped.push({ field: "nutrition", reason: "kept local nutrition" });
  }
  const offUnit = offQuantityUnit(product.quantity);
  if (offUnit && (blank(item.unit) || (opts.allowDefaultUnit && item.unit === "pcs"))) {
    patch.unit = offUnit;
    filled.push("unit");
  } else if (offUnit && !blank(item.unit)) {
    skipped.push({ field: "unit", reason: `kept local unit ${item.unit}` });
  }
  if (!Object.keys(patch).length) {
    // Still record the link timestamp so the UI can show a successful sync.
    await run("UPDATE items SET off_synced_at = ? WHERE id = ?", [now(), item.id]);
    return { filled, skipped, item };
  }

  const columns = Object.keys(patch);
  const assignments = columns.map((column) => `${column} = ?`).join(", ");
  await run(`UPDATE items SET ${assignments}, off_synced_at = ? WHERE id = ?`, [
    ...columns.map((column) => patch[column]),
    now(),
    item.id,
  ]);
  return {
    filled,
    skipped,
    item: (await get<any>("SELECT * FROM items WHERE id = ?", [item.id])) ?? item,
  };
}

/**
 * Link an item to an OFF product, attach the product code as a barcode when it
 * does not collide, and fill empty fields. A different existing link is replaced
 * only by an explicit user action; callers should not do this implicitly.
 */
export async function linkItemToOff(opts: {
  item: any;
  product: OffProduct;
  source: "barcode" | "receipt" | "manual" | "catalog";
  allowDefaultUnit?: boolean;
}): Promise<OffFillResult> {
  const { item, product, source } = opts;
  const other = await get<any>(
    "SELECT id, name FROM items WHERE house_id = ? AND off_code = ? AND off_project = ? AND id <> ?",
    [item.house_id, product.code, product.project, item.id],
  );
  if (other) {
    throw new ApiError(409, `${OFF_PROJECTS[product.project].label} product ${product.code} is already linked to ${other.name}`);
  }

  const skipped: { field: string; reason: string }[] = [];
  const conflict = await get<any>(
    `SELECT i.name FROM item_barcodes b JOIN items i ON i.id = b.item_id
     WHERE b.house_id = ? AND b.code = ? AND b.item_id <> ?`,
    [item.house_id, product.code, item.id],
  );
  const already = await get<any>("SELECT id FROM item_barcodes WHERE item_id = ? AND code = ?", [item.id, product.code]);
  if (conflict) {
    skipped.push({ field: "barcode", reason: `code already belongs to ${conflict.name}` });
  } else if (!already) {
    await run(
      "INSERT INTO item_barcodes (id, item_id, house_id, code, format, created_at) VALUES (?, ?, ?, ?, 'openfoodfacts', ?)",
      [newId("bar"), item.id, item.house_id, product.code, now()],
    );
  }

  const result = await fillItemFromOff({ item, product, source, allowDefaultUnit: opts.allowDefaultUnit });
  await run(
    `UPDATE items SET off_code = ?, off_project = ?, off_source = ?, off_linked_at = ?, off_synced_at = ?,
       off_filled = ?, updated_at = ? WHERE id = ?`,
    [
      product.code,
      product.project,
      source,
      now(),
      now(),
      JSON.stringify(result.filled),
      now(),
      item.id,
    ],
  );
  return {
    filled: result.filled,
    skipped: [...skipped, ...result.skipped],
    item: (await get<any>("SELECT * FROM items WHERE id = ?", [item.id])) ?? item,
  };
}

export async function unlinkItemFromOff(itemId: string) {
  await run(
    `UPDATE items SET off_code = NULL, off_project = 'off', off_source = NULL, off_linked_at = NULL,
       off_synced_at = NULL, off_filled = '[]', updated_at = ? WHERE id = ?`,
    [now(), itemId],
  );
}

export function offProductIsFresh(product: OffProduct | null): boolean {
  if (!product?.fetchedAt) return false;
  return Date.now() - new Date(product.fetchedAt).getTime() < OFF_CACHE_DAYS * 864e5;
}

/** Drop stale cache rows that no item still links to. */
export async function pruneOffProductCache() {
  const cutoff = new Date(Date.now() - OFF_CACHE_DAYS * 4 * 864e5).toISOString();
  await run(
    `DELETE FROM catalog_products
     WHERE fetched_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM items i
         WHERE i.off_code = catalog_products.code AND i.off_project = catalog_products.project
       )`,
    [cutoff],
  );
}
