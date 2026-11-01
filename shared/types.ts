// Shared domain types used by both the API and the web client.

export type Role = "owner" | "admin" | "member" | "viewer";

export interface User {
  id: string;
  email: string;
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

export interface Barcode {
  id: string;
  code: string;
  format: string | null;
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
  balanceAfter: number | null;
  createdAt: string;
}

export interface PricePoint {
  at: string;
  price: number;
  unit: string;
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
  type: "low_stock" | "expiring" | "system" | "invite";
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
