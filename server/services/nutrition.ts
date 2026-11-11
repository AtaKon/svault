import { convert, round, unitKind } from "../units.js";
import { estimateIngredientGrams } from "../../shared/recipe-grams.js";
import { referenceNutrition } from "./food-reference.js";
import type {
  NutritionBasis,
  NutritionFacts,
  NutritionValues,
  RecipeNutrition,
} from "../../shared/types.js";

/**
 * Nutrition helpers.
 *
 * Items keep a normalised panel expressed per 100 g or 100 ml, regardless of
 * whether OpenFoodFacts reported the product per 100 g, per serving or in kJ.
 * Recipes then scale those panels by ingredient amounts so a total and a
 * per-portion estimate can be shown without storing duplicate recipe data.
 */

export const NUTRIENT_KEYS = [
  "energyKcal",
  "energyKj",
  "fat",
  "saturatedFat",
  "carbohydrates",
  "sugars",
  "fiber",
  "proteins",
  "salt",
  "sodium",
] as const;

type NutrientKey = (typeof NUTRIENT_KEYS)[number];

const NUTRIENT_FIELDS: { key: NutrientKey; bases: string[] }[] = [
  { key: "energyKcal", bases: ["energy-kcal"] },
  { key: "energyKj", bases: ["energy-kj", "energy"] },
  { key: "fat", bases: ["fat"] },
  { key: "saturatedFat", bases: ["saturated-fat"] },
  { key: "carbohydrates", bases: ["carbohydrates"] },
  { key: "sugars", bases: ["sugars"] },
  { key: "fiber", bases: ["fiber"] },
  { key: "proteins", bases: ["proteins"] },
  { key: "salt", bases: ["salt"] },
  { key: "sodium", bases: ["sodium"] },
];

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function positive(value: unknown): number | null {
  const n = numberOrNull(value);
  return n != null && n > 0 ? n : null;
}

export function emptyNutritionValues(): NutritionValues {
  return {
    energyKcal: null,
    energyKj: null,
    fat: null,
    saturatedFat: null,
    carbohydrates: null,
    sugars: null,
    fiber: null,
    proteins: null,
    salt: null,
    sodium: null,
  };
}

function isLiquidQuantity(quantity: unknown): boolean {
  return /(\d+(?:[.,]\d+)?)\s*(ml|cl|dl|l|lt|floz|fl oz)\b/i.test(String(quantity ?? ""));
}

function readNutriment(
  nutriments: Record<string, unknown>,
  bases: string[],
  servingQuantity: number | null,
  dataPerServing: boolean,
  basis: NutritionBasis,
): number | null {
  const per100Suffixes = basis === "100ml" ? ["_100ml", "_100g"] : ["_100g", "_100ml"];
  for (const suffix of per100Suffixes) {
    for (const base of bases) {
      const per100 = numberOrNull(nutriments[`${base}${suffix}`]);
      if (per100 != null) return per100;
    }
  }
  if (servingQuantity) {
    for (const base of bases) {
      const perServing = numberOrNull(nutriments[`${base}_serving`]);
      if (perServing != null) return (perServing * 100) / servingQuantity;
    }
  }
  for (const base of bases) {
    const value = numberOrNull(nutriments[`${base}_value`]);
    if (value == null) continue;
    if (dataPerServing && servingQuantity) return (value * 100) / servingQuantity;
    return value;
  }
  for (const base of bases) {
    const value = numberOrNull(nutriments[base]);
    if (value != null) return value;
  }
  return null;
}

/** Parse the `nutriments` object of an OpenFoodFacts product into a per-100 panel. */
export function parseOffNutrition(product: any): NutritionFacts | null {
  const nutriments = product?.nutriments;
  if (!nutriments || typeof nutriments !== "object") return null;

  const servingQuantity = positive(product?.serving_quantity) ?? positive(nutriments.serving_quantity);
  const dataPerServing = String(product?.nutrition_data_per ?? nutriments.nutrition_data_per ?? "")
    .trim()
    .toLowerCase()
    .startsWith("serving");
  const basis: NutritionBasis = isLiquidQuantity(product?.quantity) ? "100ml" : "100g";

  const values = emptyNutritionValues();
  for (const field of NUTRIENT_FIELDS) {
    values[field.key] = readNutriment(nutriments, field.bases, servingQuantity, dataPerServing, basis);
  }

  // OpenFoodFacts sometimes stores only kJ, and often only one of salt/sodium.
  if (values.energyKcal == null && values.energyKj != null) values.energyKcal = values.energyKj / 4.184;
  if (values.energyKj == null && values.energyKcal != null) values.energyKj = values.energyKcal * 4.184;
  if (values.salt == null && values.sodium != null) values.salt = values.sodium * 2.5;
  if (values.sodium == null && values.salt != null) values.sodium = values.salt / 2.5;

  const hasValues = NUTRIENT_KEYS.some((key) => values[key] != null);
  if (!hasValues) return null;

  return {
    ...roundValues(values),
    basis,
    servingSize: typeof product?.serving_size === "string" && product.serving_size.trim()
      ? product.serving_size.trim().slice(0, 60)
      : null,
    servingQuantity,
    source: "openfoodfacts",
  };
}

/**
 * Validate a panel coming from the API or from stored JSON. Returns null when
 * there is nothing usable to track.
 */
export function normaliseNutrition(value: unknown): NutritionFacts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const values = emptyNutritionValues();
  for (const key of NUTRIENT_KEYS) values[key] = numberOrNull(input[key]);
  const servingSize =
    typeof input.servingSize === "string" && input.servingSize.trim() ? input.servingSize.trim().slice(0, 60) : null;
  const servingQuantity = positive(input.servingQuantity);
  if (!NUTRIENT_KEYS.some((key) => values[key] != null) && !servingSize && !servingQuantity) return null;

  const basis: NutritionBasis = input.basis === "100ml" ? "100ml" : "100g";
  return {
    ...roundValues(values),
    basis,
    servingSize,
    servingQuantity,
    source: input.source === "openfoodfacts" ? "openfoodfacts" : "manual",
  };
}

function roundValues(values: NutritionValues): NutritionValues {
  return {
    energyKcal: values.energyKcal == null ? null : Math.round(values.energyKcal),
    energyKj: values.energyKj == null ? null : Math.round(values.energyKj),
    fat: values.fat == null ? null : round(values.fat, 1),
    saturatedFat: values.saturatedFat == null ? null : round(values.saturatedFat, 1),
    carbohydrates: values.carbohydrates == null ? null : round(values.carbohydrates, 1),
    sugars: values.sugars == null ? null : round(values.sugars, 1),
    fiber: values.fiber == null ? null : round(values.fiber, 1),
    proteins: values.proteins == null ? null : round(values.proteins, 1),
    salt: values.salt == null ? null : round(values.salt, 3),
    sodium: values.sodium == null ? null : round(values.sodium, 3),
  };
}

export interface NutritionSourceItem {
  id: string;
  name: string;
  unit: string;
  nutrition: NutritionFacts | null;
}

export interface NutritionIngredient {
  name: string;
  quantity: number | null;
  unit: string | null;
  itemId?: string | null;
}

function normaliseName(value: string): string {
  return String(value ?? "").toLowerCase().trim();
}

function findItem(
  ingredient: NutritionIngredient,
  byId: Map<string, NutritionSourceItem>,
  byName: Map<string, NutritionSourceItem>,
  items: NutritionSourceItem[],
): NutritionSourceItem | null {
  if (ingredient.itemId) {
    const exact = byId.get(ingredient.itemId);
    if (exact) return exact;
  }
  const key = normaliseName(ingredient.name);
  if (!key) return null;
  const exact = byName.get(key);
  if (exact) return exact;
  if (key.length < 3) return null;
  for (const item of items) {
    const name = normaliseName(item.name);
    if (name.length < 3) continue;
    if (name.includes(key) || key.includes(name)) return item;
  }
  return null;
}

/** How many grams or millilitres an ingredient contributes to a per-100 panel. */
function amountForNutrition(ingredient: NutritionIngredient, item: NutritionSourceItem): number | null {
  const nutrition = item.nutrition;
  const quantity = ingredient.quantity;
  if (!nutrition || quantity == null || !(quantity > 0)) return null;
  const sourceUnit = String(ingredient.unit || item.unit || "").trim().toLowerCase();
  if (!sourceUnit) return null;
  const basisUnit = nutrition.basis === "100ml" ? "ml" : "g";
  const basisKind = nutrition.basis === "100ml" ? "volume" : "mass";
  const sourceKind = unitKind(sourceUnit);

  if (sourceKind === basisKind) return convert(quantity, sourceUnit, basisUnit);
  if (sourceKind === "count" && nutrition.servingQuantity) return quantity * nutrition.servingQuantity;
  return null;
}

function scaleValues(values: NutritionValues, factor: number): NutritionValues {
  const scaled = emptyNutritionValues();
  for (const key of NUTRIENT_KEYS) {
    const value = values[key];
    scaled[key] = value == null ? null : value * factor;
  }
  return roundValues(scaled);
}

/**
 * Estimate nutrition for a recipe from the items its ingredients resolve to,
 * falling back to the built-in per-100 g food reference for ingredients that
 * are not tracked in the inventory.
 * Returns null when no ingredient could contribute.
 */
export function recipeNutrition(
  ingredients: NutritionIngredient[],
  items: NutritionSourceItem[],
  servings: number | null,
): RecipeNutrition | null {
  const byId = new Map(items.map((item) => [item.id, item]));
  const byName = new Map(items.map((item) => [normaliseName(item.name), item]));
  const totals = emptyNutritionValues();
  const seen = new Set<NutrientKey>();
  let matched = 0;
  let referenceMatched = 0;

  for (const ingredient of ingredients) {
    const item = findItem(ingredient, byId, byName, items);
    const amount = item?.nutrition ? amountForNutrition(ingredient, item) : null;

    if (item?.nutrition && amount != null) {
      matched += 1;
      for (const key of NUTRIENT_KEYS) {
        const per100 = item.nutrition[key];
        if (per100 == null) continue;
        totals[key] = (totals[key] ?? 0) + (per100 * amount) / 100;
        seen.add(key);
      }
      continue;
    }

    // No usable label data: fall back to the reference table using the best
    // gram estimate for the line (mass, volume with density, or count units).
    const grams = estimateIngredientGrams(ingredient).grams;
    const reference = grams != null ? referenceNutrition(ingredient.name) : null;
    if (!reference || grams == null) continue;
    matched += 1;
    referenceMatched += 1;
    const referenceValues = reference as Partial<Record<NutrientKey, number>>;
    for (const key of NUTRIENT_KEYS) {
      const per100 = referenceValues[key];
      if (per100 == null) continue;
      totals[key] = (totals[key] ?? 0) + (per100 * grams) / 100;
      seen.add(key);
    }
  }

  if (!matched) return null;
  for (const key of NUTRIENT_KEYS) {
    if (!seen.has(key)) totals[key] = null;
  }

  const rounded = roundValues(totals);
  const portionCount = servings != null && servings > 0 ? servings : null;
  const perServing = portionCount ? scaleValues(rounded, 1 / portionCount) : null;
  return {
    total: rounded,
    perServing,
    servings: portionCount,
    ingredients: ingredients.length,
    matched,
    referenceMatched,
    coverage: round(matched / Math.max(1, ingredients.length), 2),
  };
}
