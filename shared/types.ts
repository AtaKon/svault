// Shared domain types used by both the API and the web client.

export type Role = "owner" | "admin" | "member" | "viewer";

export interface User {
  id: string;
  email: string;
  username: string;
  name: string;
  language?: "en" | "el";
  isAdmin: boolean;
  /** Reveals the developer page, including the AI call log. */
  developerMode: boolean;
  /** False for single sign-on accounts that never had a password of their own. */
  hasPassword?: boolean;
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

export type NotificationChannelType = "ntfy" | "apprise" | "webhook";

export interface NotificationChannelEvents {
  lowStock: boolean;
  expiring: boolean;
  weeklySummary: boolean;
}

/** A per-house delivery target for reminders. Secret fields are masked with
 * "***" by the API once stored, the same way AI keys are. */
export interface NotificationChannel {
  id: string;
  type: NotificationChannelType;
  name: string;
  enabled: boolean;
  /** ntfy server URL (e.g. https://ntfy.sh), Apprise endpoint or webhook URL. */
  url: string;
  /** ntfy topic. Empty for Apprise and webhooks. */
  topic?: string;
  /** ntfy access token (secret). */
  token?: string;
  /** Apprise API key (secret). */
  key?: string;
  /** Webhook HMAC secret (secret). */
  secret?: string;
  events: NotificationChannelEvents;
}

export interface HouseSettings {
  ai?: {
    enabled?: boolean;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    visionModel?: string;
    /** USD per 1M prompt tokens, used to estimate the cost of an AI call. */
    inputPrice?: number | null;
    /** USD per 1M completion tokens, used to estimate the cost of an AI call. */
    outputPrice?: number | null;
  };
  notifications?: {
    lowStock?: boolean;
    expiryDays?: number;
    channels?: NotificationChannel[];
  };
  units?: "metric" | "imperial";
  purchases?: { country?: string };
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

/** The unit a nutrition panel is expressed against. */
export type NutritionBasis = "100g" | "100ml";

/**
 * Nutrition values. Everything except the two energy fields is in grams per
 * `basis` (salt and sodium included, matching OpenFoodFacts).
 */
export interface NutritionValues {
  energyKcal: number | null;
  energyKj: number | null;
  fat: number | null;
  saturatedFat: number | null;
  carbohydrates: number | null;
  sugars: number | null;
  fiber: number | null;
  proteins: number | null;
  salt: number | null;
  sodium: number | null;
}

/** A nutrition panel for an item, imported from OpenFoodFacts or entered by hand. */
export interface NutritionFacts extends NutritionValues {
  basis: NutritionBasis;
  servingSize: string | null;
  /** Grams or millilitres in one serving, used to estimate count-based ingredients. */
  servingQuantity: number | null;
  source: "openfoodfacts" | "manual";
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
  /** Parsed nutrition panel from the OpenFoodFacts `nutriments` object. */
  nutrition?: NutritionFacts | null;
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
  warning: "NOTHING_FOUND" | null;
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
  nutrition: NutritionFacts | null;
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
  /** USD spent on AI for this recipe (scan cleanup, polish). */
  aiCost?: number | null;
  favorite: boolean;
  ingredients: RecipeIngredient[];
  createdAt: string;
  updatedAt: string;
  match?: RecipeMatch;
  /** Nutrition estimated from the ingredients that link to tracked items. */
  nutrition?: RecipeNutrition | null;
}

export interface RecipeNutrition {
  total: NutritionValues;
  perServing: NutritionValues | null;
  servings: number | null;
  /** Number of ingredients considered for the estimate. */
  ingredients: number;
  /** Ingredients whose item had usable nutrition data and a compatible amount. */
  matched: number;
  /** matched / ingredients, rounded to two decimals. */
  coverage: number;
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
  /** USD spent on the AI read of this receipt. */
  aiCost?: number | null;
  savings?: number | null;
  image: string | null;
  ocrText: string | null;
  source: "scan" | "manual";
  notes: string | null;
  /** Member who paid; the household split uses it together with `splitWith`. */
  paidBy: string | null;
  /** Members who share the cost. An empty list means the whole house. */
  splitWith: string[];
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
  aiCost?: number | null;
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

/**
 * How the product lines add up against the printed total. `difference` is
 * printed total minus what the lines (after savings) add up to: positive means
 * lines are probably missing, negative means something was read twice.
 */
export interface ReceiptReconciliation {
  linesTotal: number;
  savings: number;
  printedTotal: number | null;
  difference: number | null;
  ok: boolean;
}

export interface ReceiptScanResponse {
  provider: "ai" | "local" | "template";
  warning: string | null;
  aiCost: number | null;
  /** Short-lived server record holding the scan's provenance; pass it to the import. */
  scanId: string;
  /** True when the house has an AI provider configured (enables "Re-read with AI"). */
  aiAvailable: boolean;
  reconciliation: ReceiptReconciliation;
  draft: ReceiptDraft;
}

export interface ReceiptValidationLine {
  index: number;
  itemId: string | null;
  itemName: string | null;
  itemUnit: string | null;
  /** How the line was matched: chosen by the user, learned alias, barcode, exact name or fuzzy name. */
  match: "chosen" | "alias" | "barcode" | "name" | "fuzzy" | "new" | null;
  willCreate: boolean;
  error: string | null;
}

export interface ReceiptDuplicate {
  id: string;
  purchasedAt: string | null;
  total: number | null;
  vendorName: string | null;
}

export interface ReceiptValidation {
  ok: boolean;
  newItems: number;
  lines: ReceiptValidationLine[];
  duplicateOf: ReceiptDuplicate | null;
}

export interface ReceiptStockRevert {
  itemId: string;
  itemName: string;
  unit: string;
  /** Quantity the receipt originally added (item unit). */
  added: number;
  /** Quantity removed now. */
  reverted: number;
  /** Quantity already used or moved out before the receipt was deleted. */
  consumed: number;
}

export interface ReceiptDeleteResult {
  ok: true;
  imageRemoved: boolean;
  reverted: ReceiptStockRevert[];
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
  plan?: { today: number; week: number; weekStart: string };
  locations: Location[];
  counts: {
    recipes: number;
    photos: number;
    unlabeledPhotos: number;
    unreadNotifications: number;
  };
}

/* --------------------------------------------------------------- shopping list */

export type ShoppingSource = "manual" | "recipe" | "low_stock" | "meal_plan";

export interface ShoppingItem {
  id: string;
  houseId: string;
  itemId: string | null;
  name: string;
  quantity: number | null;
  unit: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryIcon: string | null;
  note: string | null;
  source: ShoppingSource;
  checked: boolean;
  checkedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ShoppingListResult {
  added: number;
  merged: number;
  skipped: number;
  items: ShoppingItem[];
}

/* ----------------------------------------------------------------- meal planner */

export type MealSlot = "breakfast" | "lunch" | "dinner" | "snack";

export const MEAL_SLOTS: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];

export interface MealPlanEntry {
  id: string;
  houseId: string;
  day: string;
  slot: MealSlot;
  recipeId: string | null;
  ideaId: string | null;
  ideaIndex: number | null;
  title: string;
  servings: number | null;
  sort: number;
  recipe: { id: string; title: string; servings: number | null; image: string | null } | null;
  idea: { id: string; title: string; servings: number | null } | null;
  createdAt: string;
}

export interface MealPlanWeek {
  weekStart: string;
  weekEnd: string;
  entries: MealPlanEntry[];
}

/* ------------------------------------------------------------------ bulk intake */

export interface IntakeCandidate {
  itemId: string;
  name: string;
  unit: string;
  score: number;
  source: "alias" | "name" | "vector" | null;
}

export interface IntakeRow {
  description: string;
  rawDescription: string | null;
  quantity: number;
  unit: string | null;
  unitPrice: number | null;
  lineTotal: number | null;
  barcode: string | null;
  itemId: string | null;
  itemName: string | null;
  itemUnit: string | null;
  candidates: IntakeCandidate[];
  offCode: string | null;
  offName: string | null;
  offBrand: string | null;
  offImage: string | null;
  action: "create" | "update" | "skip";
}

export interface IntakeParseResult {
  provider: "ai" | "local" | "template" | "barcode";
  warning: string | null;
  vendorName: string | null;
  purchasedAt: string | null;
  currency: string | null;
  rows: IntakeRow[];
}

export interface IntakeCommitResult {
  created: Item[];
  updated: Item[];
  skipped: number;
}

/* -------------------------------------------------------------------- CSV import */

export interface CsvColumnMap {
  name?: string;
  brand?: string;
  category?: string;
  place?: string;
  unit?: string;
  quantity?: string;
  reorderPoint?: string;
  targetStock?: string;
  price?: string;
  barcodes?: string;
  attributes?: string;
}

export type CsvImportMode = "create" | "update";

export interface CsvImportRow {
  line: number;
  name: string;
  brand: string | null;
  category: string | null;
  place: string | null;
  unit: string | null;
  quantity: number | null;
  reorderPoint: number | null;
  targetStock: number | null;
  price: number | null;
  barcodes: string[];
  attributes: Record<string, unknown>;
  matchId: string | null;
  matchName: string | null;
  action: "create" | "update" | "skip";
  errors: string[];
  warnings: string[];
}

export interface CsvImportPreview {
  delimiter: string;
  headers: string[];
  map: CsvColumnMap;
  mode: CsvImportMode;
  rows: CsvImportRow[];
  summary: { create: number; update: number; skip: number; errors: number };
}

export interface CsvImportResult extends CsvImportPreview {
  created: number;
  updated: number;
  skipped: number;
}

/** One request SVault made to an OpenAI-compatible provider. */
export interface AiCallLog {
  id: string;
  houseId: string | null;
  userId: string | null;
  userName: string | null;
  /** Logical operation, e.g. `receipt.scan`, `recipe.complete` or `ai.test`. */
  operation: string;
  provider: string | null;
  model: string | null;
  status: "ok" | "error";
  httpStatus: number | null;
  attempts: number;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number | null;
  imageCount: number;
  requestBytes: number;
  responseBytes: number;
  requestPreview: string | null;
  responsePreview: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AiCallLogSummary {
  calls: number;
  errors: number;
  cost: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AiCallLogPage {
  scope: "mine" | "all";
  logs: AiCallLog[];
  total: number;
  summary: AiCallLogSummary;
}

/* --------------------------------------------------------------- insights */

export interface HouseBudgetSettings {
  /** Monthly grocery budget in the house currency; 0 disables it. */
  monthlyBudget: number;
  /** A purchase this many percent above the item's average raises an alert. */
  priceAlertPercent: number;
  /** How many days ahead the "use it up" view looks; 1–60. */
  useItUpDays: number;
}

export interface SpendInsight {
  currency: string;
  month: string;
  monthTotal: number;
  monthReceipts: number;
  budget: number;
  budgetRemaining: number | null;
  budgetPercent: number | null;
  averagePerMonth: number;
  byMonth: { month: string; total: number; receipts: number }[];
  byShop: { vendorName: string; total: number; receipts: number }[];
  byCategory: { name: string; total: number; lines: number }[];
  settings: HouseBudgetSettings;
}

export interface WasteInsight {
  currency: string;
  months: number;
  currentMonth: string;
  currentMonthCost: number;
  totalCost: number;
  byMonth: { month: string; cost: number; events: number }[];
  topItems: {
    itemId: string | null;
    itemName: string;
    unit: string | null;
    category: string | null;
    cost: number;
    quantity: number;
    events: number;
  }[];
}

export interface PriceAlert {
  itemId: string;
  itemName: string;
  unit: string | null;
  vendorName: string | null;
  receiptId: string;
  purchasedAt: string;
  price: number;
  averagePrice: number;
  percent: number;
  sampleSize: number;
  currency: string;
}

export interface HouseholdBalance {
  userId: string;
  name: string;
  role: string;
  paid: number;
  share: number;
  /** Positive means the house owes this person money. */
  balance: number;
}

export interface HouseholdSettlement {
  fromUserId: string;
  fromName: string;
  toUserId: string;
  toName: string;
  amount: number;
}

export interface HouseholdReceipt {
  id: string;
  purchasedAt: string | null;
  vendorName: string | null;
  total: number | null;
  paidBy: string | null;
  payerName: string | null;
  splitWith: string[];
  participantNames: string[];
}

export interface UseItUpLot {
  id: string;
  quantity: number;
  expiresAt: string;
  locationName: string | null;
}

export interface UseItUpItem {
  itemId: string;
  name: string;
  unit: string | null;
  quantity: number;
  expiresAt: string;
  daysLeft: number;
  locationName: string | null;
  lots: UseItUpLot[];
}

export interface UseItUpRecipe {
  recipeId: string;
  title: string;
  image: string | null;
  servings: number | null;
  matched: string[];
  missing: string[];
  score: number;
}

export interface ShoppingPriceHint {
  lineId: string;
  itemId: string | null;
  name: string;
  unit: string | null;
  currency: string;
  cheapest: { vendorName: string; price: number; purchasedAt: string; unit: string | null };
  vendors: { vendorName: string; price: number; purchasedAt: string; unit: string | null }[];
}

export interface ApiToken {
  id: string;
  name: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface ApiTokenCreated extends ApiToken {
  /** Shown once; only its hash is stored. */
  token: string;
}

export interface AdminOverview {
  users: number;
  houses: number;
  sessions: number;
  pendingInvites: number;
  uploads: { count: number; bytes: number };
  ai: { calls: number; cost: number; errors: number; days: number; budget: number; monthSpend: number };
  registration: { mode: "open" | "invite" | "closed"; source: string };
  database: string;
}

export interface AdminUser {
  id: string;
  email: string;
  username: string | null;
  name: string;
  isAdmin: boolean;
  developerMode: boolean;
  houses: number;
  sessions: number;
  lastSessionAt: string | null;
  createdAt: string;
}

export interface AdminSession {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface OrphanFile {
  key: string;
  size: number;
  modifiedAt: string;
}
