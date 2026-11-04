// Shared domain types used by both the API and the web client.

export type Role = "owner" | "admin" | "member" | "viewer";

export interface User {
  id: string;
  email: string;
  username: string;
  name: string;
  isAdmin: boolean;
  createdAt: string;
}

export interface House {
  id: string;
  name: string;
  kind: string;
  address: string | null;
  currency: string;
  settings: HouseSettings;
  role: Role;
  createdAt: string;
}

export interface HouseSettings {
  ai?: {
    enabled?: boolean;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    visionModel?: string;
  };
  notifications?: {
    lowStock?: boolean;
    expiryDays?: number;
  };
  units?: "metric" | "imperial";
}

export interface Location {
  id: string;
  houseId: string;
  name: string;
  kind: string;
  icon: string | null;
  parentId: string | null;
  itemCount?: number;
}

export interface Category {
  id: string;
  houseId: string;
  name: string;
  icon: string | null;
  parentId: string | null;
  itemCount?: number;
}

export type AttributeType =
  | "text"
  | "number"
  | "select"
  | "date"
  | "boolean"
  | "url";

export interface AttributeDef {
  id: string;
  houseId: string;
  key: string;
  label: string;
  type: AttributeType;
  unit: string | null;
  options: string[];
  required: boolean;
  categoryId: string | null;
  sort: number;
}

/**
 * Item fields that already have first-class columns. Custom attributes must not
 * reuse these keys, otherwise the same value would appear twice on an item.
 */
export const RESERVED_ATTRIBUTE_KEYS = [
  "name",
  "description",
  "brand",
  "category",
  "category_id",
  "unit",
  "reorder_point",
  "target_stock",
  "tags",
  "barcode",
  "barcodes",
  "image",
  "archived",
  "quantity",
  "value",
] as const;

export interface Barcode {
  id: string;
  code: string;
  format: string | null;
}

/** A product as stored in the shared OpenFoodFacts cache. */
export interface OffProduct {
  code: string;
  name: string;
  brand: string;
  genericName: string;
  quantity: string;
  categories: string[];
  image: string | null;
  ingredients: string | null;
  allergens: string[];
  labels: string[];
  nutriscore: string | null;
  novaGroup: number | null;
  countries: string[];
  packaging: string | null;
  servingSize: string | null;
  source: "openfoodfacts" | "catalog";
  fetchedAt: string;
  /** Present only when a full product payload was requested. */
  payload?: Record<string, unknown> | null;
}

/** An item's link to an OpenFoodFacts product. */
export interface OffLink {
  code: string;
  source: "barcode" | "receipt" | "manual" | "catalog";
  linkedAt: string;
  syncedAt: string | null;
  /** First-class item fields that OpenFoodFacts filled when the item was linked. */
  filled: string[];
  product: OffProduct | null;
}

export interface OffLinkResult {
  item: Item;
  product: OffProduct | null;
  filled: string[];
  skipped: { field: string; reason: string }[];
}

export interface OffSearchResult {
  products: OffProduct[];
  online: boolean;
  warning: string | null;
}

export interface CatalogMapping {
  id: string;
  country: string;
  vendor: string | null;
  rawText: string;
  offCode: string | null;
  name: string | null;
  brand: string | null;
  unit: string | null;
  category: string | null;
  source: "seed" | "local" | "community";
  confidence: number;
  uses: number;
  updatedAt: string;
}

export interface CatalogExport {
  version: 1;
  generatedAt: string;
  mappings: Omit<CatalogMapping, "id" | "uses" | "updatedAt">[];
}

export interface CatalogImportResult {
  imported: number;
  updated: number;
  skipped: number;
  total: number;
}

export interface StockLot {
  id: string;
  itemId: string;
  locationId: string | null;
  locationName?: string | null;
  quantity: number;
  unit: string;
  unitPrice: number | null;
  currency: string | null;
  purchasedAt: string | null;
  expiresAt: string | null;
  note: string | null;
  vendorId: string | null;
  vendorName?: string | null;
  receiptId: string | null;
  createdAt: string;
}

export interface Movement {
  id: string;
  itemId: string;
  type: "in" | "out" | "adjust" | "waste" | "move";
  delta: number;
  unit: string;
  unitPrice: number | null;
  normalizedPrice: number | null;
  reason: string | null;
  note: string | null;
  locationId: string | null;
  locationName?: string | null;
  userName?: string | null;
  vendorId: string | null;
  vendorName?: string | null;
  receiptId: string | null;
  balanceAfter: number | null;
  createdAt: string;
}

export interface PricePoint {
  at: string;
  price: number;
  unit: string;
  quantity: number;
  unitPrice: number | null;
  vendorId: string | null;
  vendorName: string | null;
  receiptId: string | null;
  note: string | null;
}

export interface PriceStats {
  latest: number | null;
  average: number | null;
  min: number | null;
  max: number | null;
  changePct: number | null;
  observations: number;
  unit: string;
}

export interface Item {
  id: string;
  houseId: string;
  name: string;
  description: string | null;
  brand: string | null;
  categoryId: string | null;
  categoryName?: string | null;
  categoryIcon?: string | null;
  unit: string;
  reorderPoint: number;
  targetStock: number | null;
  attributes: Record<string, unknown>;
  tags: string[];
  image: string | null;
  archived: boolean;
  quantity: number;
  value: number;
  latestPrice?: number | null;
  isLow: boolean;
  createdAt: string;
  updatedAt: string;
  barcodes: Barcode[];
  off?: OffLink | null;
  lots?: StockLot[];
  priceStats?: PriceStats;
}

export interface ItemDetail extends Item {
  lots: StockLot[];
  movements: Movement[];
  priceHistory: PricePoint[];
  recipes: { id: string; title: string }[];
}

export interface RecipeIngredient {
  id?: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  itemId: string | null;
  optional: boolean;
  note: string | null;
  sort?: number;
  available?: boolean;
}

export interface RecipeStep {
  text: string;
  timerSeconds?: number | null;
}

export interface Recipe {
  id: string;
  houseId: string;
  title: string;
  description: string | null;
  servings: number | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  steps: RecipeStep[];
  tags: string[];
  image: string | null;
  sourceImage: string | null;
  ocrText: string | null;
  source: "manual" | "scan" | "ai";
  aiNotes: string | null;
  favorite: boolean;
  ingredients: RecipeIngredient[];
  createdAt: string;
  updatedAt: string;
  match?: RecipeMatch;
}

export interface RecipeMatch {
  available: number;
  total: number;
  coverage: number;
  missing: { name: string; quantity: number | null; unit: string | null }[];
}

export interface Vendor {
  id: string;
  houseId: string;
  name: string;
  kind: string;
  note: string | null;
  createdAt: string;
  purchaseCount?: number;
}

export interface VendorSuggestion {
  id: string;
  country: string;
  name: string;
  kind: string;
  added: boolean;
}

export interface VendorSuggestions {
  country: string;
  countries: { code: string; name: string }[];
  entries: VendorSuggestion[];
}

export interface ReceiptLine {
  id?: string;
  description: string;
  rawDescription?: string | null;
  quantity: number;
  unit: string | null;
  unitPrice: number | null;
  lineTotal: number | null;
  taxRate?: number | null;
  discount?: number | null;
  itemId: string | null;
  itemName?: string | null;
  itemUnit?: string | null;
  locationId?: string | null;
  barcode?: string | null;
  offCode?: string | null;
  sort?: number;
}

export interface TaxBreakdownEntry {
  rate: number | null;
  net: number;
  tax: number;
  gross: number;
}

export interface Receipt {
  id: string;
  houseId: string;
  vendorId: string | null;
  vendorName: string | null;
  purchasedAt: string | null;
  currency: string | null;
  total: number | null;
  subtotal: number | null;
  tax: number | null;
  taxBreakdown: TaxBreakdownEntry[];
  templateId?: string | null;
  templateConfidence?: number | null;
  provider?: "ai" | "local" | "template" | null;
  savings?: number | null;
  image: string | null;
  ocrText: string | null;
  source: "scan" | "manual";
  notes: string | null;
  lineCount?: number;
  lines?: ReceiptLine[];
  createdAt: string;
}

export interface ReceiptDraft {
  vendorName: string | null;
  purchasedAt: string | null;
  currency: string | null;
  total: number | null;
  subtotal: number | null;
  tax: number | null;
  taxBreakdown: TaxBreakdownEntry[];
  templateId?: string | null;
  templateConfidence?: number | null;
  savings?: number | null;
  notes: string | null;
  lines: {
    description: string;
    rawDescription?: string | null;
    quantity: number;
    unit: string | null;
    unitPrice: number | null;
    lineTotal: number | null;
    taxRate?: number | null;
    discount?: number | null;
    barcode: string | null;
    offCode?: string | null;
    offName?: string | null;
    offBrand?: string | null;
    offImage?: string | null;
    offQuantity?: string | null;
    offScore?: number | null;
    suggestedItemId?: string | null;
    suggestedItemName?: string | null;
    suggestedItemUnit?: string | null;
    suggestedItemScore?: number | null;
    suggestedItemSource?: "alias" | "name" | "vector" | null;
  }[];
}

export interface ReceiptAlias {
  id: string;
  rawName: string;
  vendorId: string | null;
  vendorName: string | null;
  uses: number;
  updatedAt: string;
}

export interface ReceiptTemplateRules {
  keywords: string[];
  threshold?: number;
  sections?: { start?: string[]; end?: string[] };
  product: { pattern: string; ignore?: string[] };
  quantity?: string[];
  weight?: string[];
  discount?: { patterns?: string[] };
  tax?: { start?: string[]; rowPattern?: string; summaryPattern?: string | null };
  savings?: { patterns?: string[] };
  total?: { pattern?: string | null };
}

export interface ReceiptTemplate {
  id: string;
  name: string;
  country: string;
  vendorName: string | null;
  active: boolean;
  builtIn: boolean;
  version: number;
  rules: ReceiptTemplateRules;
  updatedAt: string;
}

export interface ReceiptTemplateTest {
  draft: ReceiptDraft;
  template: { id: string; name: string; confidence: number };
  errors: string[];
}

export interface PurchaseAnalytics {
  range: { from: string | null; to: string | null };
  totals: { receipts: number; total: number; net: number; tax: number; savings: number; average: number };
  byVendor: {
    vendorId: string | null;
    vendorName: string;
    receipts: number;
    total: number;
    net: number;
    tax: number;
  }[];
  monthly: { month: string; receipts: number; total: number; net: number; tax: number }[];
  taxRates: { rate: number | null; net: number; tax: number; gross: number }[];
  byCategory: { categoryId: string | null; categoryName: string; total: number }[];
}

export interface FoodIdea {
  title: string;
  rationale: string;
  timeMinutes: number | null;
  servings: number | null;
  uses: { name: string; quantity: number | null; unit: string | null }[];
  missing: { name: string; quantity: number | null; unit: string | null }[];
  steps: string[];
  source?: "ai" | "inventory" | "recipe";
  recipeId?: string | null;
}

export interface IdeaResponse {
  provider: "ai" | "local";
  summary: string;
  ideas: FoodIdea[];
}

export interface Notification {
  id: string;
  houseId: string;
  houseName?: string;
  type: "low_stock" | "expiring" | "system" | "invite" | "house";
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
  resolvedAt: string | null;
  createdAt: string;
}

export interface PhotoCollection {
  id: string;
  houseId: string;
  name: string;
  description: string | null;
  photoCount: number;
  labeledCount: number;
  createdAt: string;
}

export interface PhotoLabel {
  id: string;
  label: string;
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
}

export interface Photo {
  id: string;
  houseId: string;
  collectionId: string | null;
  url: string;
  originalName: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  notes: string | null;
  itemId: string | null;
  split: "unassigned" | "train" | "val" | "test";
  capturedAt: string | null;
  createdAt: string;
  labels: PhotoLabel[];
}

export interface Dashboard {
  itemCount: number;
  unitCount: number;
  batchCount: number;
  totalValue: number;
  lowStock: Item[];
  expiring: (StockLot & { itemName: string; itemId: string })[];
  recent: Movement[];
  recentRecipe: Recipe | null;
  locations: Location[];
  counts: {
    recipes: number;
    photos: number;
    unlabeledPhotos: number;
    unreadNotifications: number;
  };
}
