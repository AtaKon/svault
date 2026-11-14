import { effectiveExpiry } from "./services/effective-expiry.js";
import { all, parseJson, bool } from "./db.js";
import { round } from "./units.js";
import { normaliseNutrition } from "./services/nutrition.js";
import { channelsFromSettings, maskChannels } from "./services/channels.js";
import type {
  Item,
  Recipe,
  RecipeMatch,
  Notification,
  Photo,
  Location,
  Category,
  AttributeDef,
  StockLot,
  Movement,
  PriceStats,
  Vendor,
  Receipt,
  OffLink,
  OffProduct,
  EspressoShot,
  EspressoShotSummary,
  EspressoEquipment,
} from "../shared/types.js";

export const ITEM_SELECT = `
  SELECT i.*, c.name AS category_name, c.icon AS category_icon,
    cp.summary AS off_summary,
    COALESCE((SELECT SUM(l.quantity) FROM stock_lots l WHERE l.item_id = i.id), 0) AS quantity,
    COALESCE((SELECT SUM(l.quantity * COALESCE(l.unit_price, 0)) FROM stock_lots l WHERE l.item_id = i.id), 0) AS value,
    (SELECT sm.normalized_price FROM stock_movements sm
       WHERE sm.item_id = i.id AND sm.normalized_price IS NOT NULL AND sm.normalized_price > 0
       ORDER BY sm.created_at DESC LIMIT 1) AS latest_price
  FROM items i
  LEFT JOIN categories c ON c.id = i.category_id AND c.house_id = i.house_id
  LEFT JOIN catalog_products cp ON cp.code = i.off_code AND cp.project = i.off_project
`;

export function maskHouseSettings(settings: Record<string, any>): Record<string, any> {
  const ai = settings?.ai;
  const channels = channelsFromSettings(settings);
  const withChannels = channels.length
    ? { ...settings, notifications: { ...(settings?.notifications ?? {}), channels: maskChannels(channels) } }
    : settings;
  if (!ai || !ai.apiKey) return withChannels;
  return { ...withChannels, ai: { ...ai, apiKey: "***" } };
}

export function serializeHouse(row: any, role: string) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    address: row.address ?? null,
    currency: row.currency,
    settings: maskHouseSettings(parseJson<Record<string, any>>(row.settings, {})),
    role,
    createdAt: row.created_at,
    memberCount: row.member_count == null ? undefined : Number(row.member_count),
  };
}

export async function barcodesForHouse(houseId: string) {
  const rows = await all<any>("SELECT * FROM item_barcodes WHERE house_id = ?", [houseId]);
  const map = new Map<string, { id: string; code: string; format: string | null }[]>();
  for (const r of rows) {
    const list = map.get(r.item_id) ?? [];
    list.push({ id: r.id, code: r.code, format: r.format ?? null });
    map.set(r.item_id, list);
  }
  return map;
}

export async function barcodesForItem(itemId: string) {
  return await all<any>("SELECT id, code, format FROM item_barcodes WHERE item_id = ? ORDER BY created_at", [itemId]);
}

export function serializeItem(row: any, barcodes: { id: string; code: string; format: string | null }[] = []): Item {
  const quantity = round(Number(row.quantity ?? 0));
  const reorderPoint = Number(row.reorder_point ?? 0);
  const offProduct = parseJson<OffProduct | null>(row.off_summary, null);
  const offProject = ["off", "obf", "opff", "opf"].includes(row.off_project) ? row.off_project : "off";
  const off: OffLink | null = row.off_code
    ? {
        code: row.off_code,
        project: offProject,
        source: (["barcode", "receipt", "manual", "catalog"].includes(row.off_source)
          ? row.off_source
          : "manual") as OffLink["source"],
        linkedAt: row.off_linked_at ?? row.created_at,
        syncedAt: row.off_synced_at ?? null,
        filled: parseJson<string[]>(row.off_filled, []),
        product: offProduct
          ? {
              ...offProduct,
              project: offProduct.project ?? offProject,
              productType: offProduct.productType ?? (offProject === "obf" ? "beauty" : offProject === "opff" ? "petfood" : offProject === "opf" ? "product" : "food"),
            }
          : null,
      }
    : null;
  return {
    id: row.id,
    houseId: row.house_id,
    openedShelfLifeDays: row.opened_shelf_life_days == null ? null : Number(row.opened_shelf_life_days),
    name: row.name,
    description: row.description ?? null,
    brand: row.brand ?? null,
    categoryId: row.category_id ?? null,
    categoryName: row.category_name ?? null,
    categoryIcon: row.category_icon ?? null,
    unit: row.unit,
    reorderPoint,
    targetStock: row.target_stock == null ? null : Number(row.target_stock),
    attributes: parseJson<Record<string, unknown>>(row.attributes, {}),
    tags: parseJson<string[]>(row.tags, []),
    image: row.image ?? null,
    archived: bool(row.archived),
    espresso: bool(row.espresso),
    quantity,
    value: round(Number(row.value ?? 0), 2),
    latestPrice: row.latest_price == null ? null : Number(row.latest_price),
    isLow: reorderPoint > 0 && quantity <= reorderPoint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    barcodes,
    nutrition: normaliseNutrition(parseJson(row.nutrition, null)) ?? normaliseNutrition(offProduct?.nutrition) ?? null,
    off,
  };
}

export async function priceStats(itemId: string, unit: string): Promise<PriceStats> {
  const rows = await all<{ price: number; at: string }>(
    `SELECT normalized_price AS price, created_at AS at FROM stock_movements
     WHERE item_id = ? AND normalized_price IS NOT NULL AND normalized_price > 0
       AND type IN ('in', 'adjust')
     ORDER BY created_at ASC LIMIT 300`,
    [itemId],
  );
  if (!rows.length) {
    return { latest: null, average: null, min: null, max: null, changePct: null, observations: 0, unit };
  }
  const prices = rows.map((r) => Number(r.price));
  const latest = prices[prices.length - 1];
  const previous = prices.length > 1 ? prices[prices.length - 2] : null;
  const average = prices.reduce((a, b) => a + b, 0) / prices.length;
  return {
    latest: round(latest, 4),
    average: round(average, 4),
    min: round(Math.min(...prices), 4),
    max: round(Math.max(...prices), 4),
    changePct: previous ? round(((latest - previous) / previous) * 100, 1) : null,
    observations: prices.length,
    unit,
  };
}

export function serializeLot(row: any): StockLot {
  return {
    id: row.id,
    itemId: row.item_id,
    locationId: row.location_id ?? null,
    locationName: row.location_name ?? null,
    quantity: round(Number(row.quantity ?? 0)),
    unit: row.unit,
    unitPrice: row.unit_price == null ? null : Number(row.unit_price),
    currency: row.currency ?? null,
    purchasedAt: row.purchased_at ?? null,
    expiresAt: row.expires_at ?? null,
    openedAt: row.opened_at ?? null,
    effectiveExpiresAt: effectiveExpiry(row, row),
    note: row.note ?? null,
    vendorId: row.vendor_id ?? null,
    vendorName: row.vendor_name ?? null,
    receiptId: row.receipt_id ?? null,
    createdAt: row.created_at,
  };
}

export function serializeMovement(row: any): Movement {
  return {
    id: row.id,
    itemId: row.item_id,
    type: row.type,
    delta: round(Number(row.delta ?? 0)),
    unit: row.unit,
    unitPrice: row.unit_price == null ? null : Number(row.unit_price),
    normalizedPrice: row.normalized_price == null ? null : Number(row.normalized_price),
    reason: row.reason ?? null,
    note: row.note ?? null,
    locationId: row.location_id ?? null,
    locationName: row.location_name ?? null,
    userName: row.user_name ?? null,
    vendorId: row.vendor_id ?? null,
    vendorName: row.vendor_name ?? null,
    receiptId: row.receipt_id ?? null,
    balanceAfter: row.balance_after == null ? null : round(Number(row.balance_after ?? 0)),
    createdAt: row.created_at,
  };
}

export function serializeEspressoShot(row: any): EspressoShot {
  const number = (value: unknown) => (value == null ? null : Number(value));
  const dose = number(row.dose_grams);
  const yieldGrams = number(row.yield_grams);
  const tds = number(row.tds_percent);
  return {
    id: row.id,
    houseId: row.house_id,
    itemId: row.item_id,
    itemName: row.item_name ?? null,
    itemBrand: row.item_brand ?? null,
    userId: row.user_id ?? null,
    userName: row.user_name ?? null,
    brewedAt: row.brewed_at,
    rating: Number(row.rating ?? 0),
    roastLevel: row.roast_level ?? null,
    grindSetting: row.grind_setting ?? null,
    grindSeconds: number(row.grind_seconds),
    doseGrams: dose,
    yieldGrams,
    extractionSeconds: number(row.extraction_seconds),
    waterTempC: number(row.water_temp_c),
    pressureBar: number(row.pressure_bar),
    tdsPercent: tds,
    ratio: dose != null && dose > 0 && yieldGrams != null ? round(yieldGrams / dose, 2) : null,
    extractionYieldPercent:
      dose != null && dose > 0 && yieldGrams != null && tds != null
        ? round((yieldGrams * tds) / dose, 1)
        : null,
    grinderId: row.grinder_id ?? null,
    machineId: row.machine_id ?? null,
    grinder: row.grinder ?? null,
    machine: row.machine ?? null,
    tastingNotes: row.tasting_notes ?? null,
    tags: parseJson<string[]>(row.tags, []),
    notes: row.notes ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializeEspressoEquipment(row: any): EspressoEquipment {
  return {
    id: row.id,
    houseId: row.house_id,
    kind: row.kind,
    name: row.name,
    brand: row.brand ?? null,
    notes: row.notes ?? null,
    shotCount: row.shot_count == null ? undefined : Number(row.shot_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function emptyEspressoSummary(): EspressoShotSummary {
  return {
    count: 0,
    averageRating: null,
    bestRating: null,
    lastBrewedAt: null,
    averageDoseGrams: null,
    averageYieldGrams: null,
    averageExtractionSeconds: null,
    averageRatio: null,
    averageExtractionYieldPercent: null,
  };
}

export function serializeEspressoSummary(row: any): EspressoShotSummary {
  if (!row) return emptyEspressoSummary();
  const number = (value: unknown, decimals = 1) =>
    value == null || !Number.isFinite(Number(value)) ? null : round(Number(value), decimals);
  return {
    count: Number(row.count ?? 0),
    averageRating: number(row.average_rating),
    bestRating: row.best_rating == null ? null : Number(row.best_rating),
    lastBrewedAt: row.last_brewed_at ?? null,
    averageDoseGrams: number(row.average_dose_grams),
    averageYieldGrams: number(row.average_yield_grams),
    averageExtractionSeconds: number(row.average_extraction_seconds),
    averageRatio: number(row.average_ratio, 2),
    averageExtractionYieldPercent: number(row.average_extraction_yield_percent),
  };
}

export function serializeVendor(row: any): Vendor {
  return {
    id: row.id,
    houseId: row.house_id,
    name: row.name,
    kind: row.kind,
    note: row.note ?? null,
    createdAt: row.created_at,
    purchaseCount: row.purchase_count == null ? undefined : Number(row.purchase_count),
  };
}

export async function receiptLinesFor(receiptId: string) {
  return (await all<any>(
    `SELECT rl.*, i.name AS item_name, i.unit AS item_unit
     FROM receipt_lines rl LEFT JOIN items i ON i.id = rl.item_id
     WHERE rl.receipt_id = ? ORDER BY rl.sort, rl.id`,
    [receiptId],
  )).map((row) => ({
    id: row.id,
    description: row.description,
    rawDescription: row.raw_description ?? null,
    quantity: round(Number(row.quantity ?? 0)),
    unit: row.unit ?? null,
    unitPrice: row.unit_price == null ? null : Number(row.unit_price),
    lineTotal: row.line_total == null ? null : Number(row.line_total),
    taxRate: row.tax_rate == null ? null : Number(row.tax_rate),
    discount: row.discount == null ? null : Number(row.discount),
    itemId: row.item_id ?? null,
    itemName: row.item_name ?? null,
    itemUnit: row.item_unit ?? null,
    locationId: row.location_id ?? null,
    barcode: row.barcode ?? null,
    offCode: row.off_code ?? null,
    offProject: ["off", "obf", "opff", "opf"].includes(row.off_project) ? row.off_project : "off",
    sort: Number(row.sort ?? 0),
  }));
}

export function serializeReceipt(row: any, lines?: any[]): Receipt {
  return {
    id: row.id,
    houseId: row.house_id,
    vendorId: row.vendor_id ?? null,
    vendorName: row.vendor_name ?? null,
    purchasedAt: row.purchased_at ?? null,
    currency: row.currency ?? null,
    total: row.total == null ? null : Number(row.total),
    subtotal: row.subtotal == null ? null : Number(row.subtotal),
    tax: row.tax == null ? null : Number(row.tax),
    taxBreakdown: parseJson<any[]>(row.tax_breakdown, []).map((entry) => ({
      rate: entry?.rate == null ? null : Number(entry.rate),
      net: Number(entry?.net ?? 0),
      tax: Number(entry?.tax ?? 0),
      gross: Number(entry?.gross ?? 0),
    })),
    templateId: row.template_id ?? null,
    templateConfidence: row.template_confidence == null ? null : Number(row.template_confidence),
    provider: row.provider === "ai" || row.provider === "local" || row.provider === "template" ? row.provider : null,
    aiCost: row.ai_cost == null ? null : Number(row.ai_cost),
    savings: row.savings == null ? null : Number(row.savings),
    image: row.image ?? null,
    ocrText: row.ocr_text ?? null,
    source: row.source === "manual" ? "manual" : "scan",
    notes: row.notes ?? null,
    paidBy: row.paid_by ?? null,
    splitWith: parseJson<string[]>(row.split_with, []),
    lineCount: row.line_count == null ? undefined : Number(row.line_count),
    lines,
    createdAt: row.created_at,
  };
}

export function serializeLocation(row: any): Location {
  return {
    id: row.id,
    houseId: row.house_id,
    name: row.name,
    kind: row.kind,
    icon: row.icon ?? null,
    parentId: row.parent_id ?? null,
    itemCount: row.item_count == null ? undefined : Number(row.item_count),
  };
}

export function serializeCategory(row: any): Category {
  return {
    id: row.id,
    houseId: row.house_id,
    name: row.name,
    icon: row.icon ?? null,
    parentId: row.parent_id ?? null,
    itemCount: row.item_count == null ? undefined : Number(row.item_count),
  };
}

export function serializeAttribute(row: any): AttributeDef {
  return {
    id: row.id,
    houseId: row.house_id,
    key: row.key,
    label: row.label,
    type: row.type,
    unit: row.unit ?? null,
    options: parseJson<string[]>(row.options, []),
    required: bool(row.required),
    categoryId: row.category_id ?? null,
    sort: Number(row.sort ?? 0),
  };
}

/** Find how much stock an ingredient name has, allowing loose name matching
 * ("eggs" matches "Free-range eggs", "butter" matches "Salted butter"). */
export function stockQuantity(stock: Map<string, number>, name: string): number {
  const key = name.toLowerCase().trim();
  if (stock.has(key)) return stock.get(key) ?? 0;
  if (key.length < 3) return 0;
  for (const [itemName, qty] of stock) {
    if (!qty || itemName.length < 3) continue;
    if (itemName.includes(key) || key.includes(itemName)) return qty;
  }
  return 0;
}

export function recipeMatch(ingredients: { name: string; quantity: number | null; unit: string | null; optional: boolean }[], stock: Map<string, number>): RecipeMatch {
  let available = 0;
  const missing: RecipeMatch["missing"] = [];
  for (const ing of ingredients) {
    const qty = stockQuantity(stock, ing.name);
    const has = qty > 0;
    if (has && !ing.optional) available++;
    if (!has && !ing.optional) missing.push({ name: ing.name, quantity: ing.quantity, unit: ing.unit });
  }
  const total = ingredients.filter((i) => !i.optional).length;
  const coverage = total === 0 ? 1 : Math.min(1, available / total);
  return { available, total, coverage: round(coverage, 2), missing };
}

export function serializeRecipe(row: any, ingredients: any[] = [], match?: RecipeMatch): Recipe {
  return {
    id: row.id,
    houseId: row.house_id,
    title: row.title,
    description: row.description ?? null,
    servings: row.servings == null ? null : Number(row.servings),
    prepMinutes: row.prep_minutes == null ? null : Number(row.prep_minutes),
    cookMinutes: row.cook_minutes == null ? null : Number(row.cook_minutes),
    steps: parseJson<{ text: string; timerSeconds?: number | null }[]>(row.steps, []),
    tags: parseJson<string[]>(row.tags, []),
    image: row.image ?? null,
    sourceImage: row.source_image ?? null,
    ocrText: row.ocr_text ?? null,
    sourceUrl: row.source_url ?? null,
    source: row.source,
    aiNotes: row.ai_notes ?? null,
    aiCost: row.ai_cost == null ? null : Number(row.ai_cost),
    favorite: bool(row.favorite),
    ingredients: ingredients.map((i) => ({
      id: i.id,
      name: i.name,
      quantity: i.quantity == null ? null : Number(i.quantity),
      unit: i.unit ?? null,
      itemId: i.item_id ?? null,
      optional: bool(i.optional),
      note: i.note ?? null,
      sort: Number(i.sort ?? 0),
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    match,
  };
}

export function serializePhoto(row: any, labels: any[] = []): Photo {
  return {
    id: row.id,
    houseId: row.house_id,
    collectionId: row.collection_id ?? null,
    url: `/uploads/photos/${row.filename}`,
    originalName: row.original_name,
    mime: row.mime,
    size: Number(row.size ?? 0),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    notes: row.notes ?? null,
    itemId: row.item_id ?? null,
    split: row.split,
    capturedAt: row.captured_at ?? null,
    createdAt: row.created_at,
    labels: labels.map((l) => ({
      id: l.id,
      label: l.label,
      x: l.x == null ? null : Number(l.x),
      y: l.y == null ? null : Number(l.y),
      w: l.w == null ? null : Number(l.w),
      h: l.h == null ? null : Number(l.h),
    })),
  };
}

export async function serializeNotification(row: any, userId: string): Promise<Notification> {
  const readBy = parseJson<string[]>(row.read_by, []);
  const data = parseJson<Record<string, unknown>>(row.data, {});
  if (data.itemName === undefined && data.itemId) {
    const item = (await all<any>("SELECT name FROM items WHERE id = ?", [data.itemId]))[0];
    if (item) data.itemName = item.name;
  }
  return {
    id: row.id,
    houseId: row.house_id,
    houseName: row.house_name ?? undefined,
    type: row.type,
    title: row.title,
    body: row.body,
    data,
    read: readBy.includes(userId),
    resolvedAt: row.resolved_at ?? null,
    createdAt: row.created_at,
  };
}
