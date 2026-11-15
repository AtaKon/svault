/**
 * What a recipe costs.
 *
 * Prices are recorded against inventory items, per the item's own unit. A
 * recipe line is written the way people cook ("200 g flour", "2 eggs"), so the
 * line has to be converted to the item's price unit before it can be costed.
 * This module owns that arithmetic and, just as important, the honesty of the
 * answer:
 *
 * - every line reports its own cost or the reason it has none;
 * - a total is only complete when every ingredient is linked, priced and
 *   convertible, otherwise `partial` is true and `unpriced` says what is
 *   missing;
 * - when the requested price basis has no data, the line falls back to the
 *   next basis (latest -> average -> stock) and says which one it used.
 *
 * Nothing here reads the database. The server resolves the three candidate
 * prices per item (latest recorded price, average of recent purchases, weighted
 * cost of batches in stock) and passes them in; the client reuses the same
 * shape to scale a cost for cook mode.
 */

export type RecipeCostBasis = "latest" | "average" | "stock";

/** Every basis, in fallback order. */
export const RECIPE_COST_BASES: RecipeCostBasis[] = ["latest", "average", "stock"];

/**
 * Why an ingredient line has no cost:
 * - `unlinked`: the line is not linked to a tracked item;
 * - `quantity`: the line has no usable quantity;
 * - `unpriced`: the item has no price for any basis;
 * - `unconverted`: the line's unit does not convert to the item's price unit.
 */
export type RecipeCostReason = "unlinked" | "quantity" | "unpriced" | "unconverted";

/** Candidate unit prices (house currency) per item unit, for one item. */
export interface RecipeCostPrices {
  latest?: number | null;
  average?: number | null;
  stock?: number | null;
}

export interface RecipeCostIngredient {
  /** Ingredient row id, when the line comes from a stored recipe. */
  id?: string | null;
  name: string;
  quantity: number | null;
  unit: string | null;
  /** Linked inventory item, or null when the ingredient is not tracked. */
  itemId: string | null;
  /** The item's base unit: its prices are stored per this unit. */
  itemUnit: string | null;
  prices?: RecipeCostPrices | null;
}

export interface RecipeCostLine {
  id: string | null;
  name: string;
  quantity: number | null;
  unit: string | null;
  itemId: string | null;
  /** Quantity converted to the item's price unit. */
  pricedQuantity: number | null;
  /** The item's price unit (prices are per this unit). */
  itemUnit: string | null;
  /** Unit price used (house currency per item unit). */
  unitPrice: number | null;
  /** Basis that supplied the price, after fallbacks. */
  basis: RecipeCostBasis | null;
  cost: number | null;
  /** Null when the line is priced; otherwise why it is not. */
  reason: RecipeCostReason | null;
}

export interface RecipeCostUnpriced {
  name: string;
  reason: RecipeCostReason;
}

export interface RecipeCost {
  /** Requested basis. A line may still carry another one after a fallback. */
  basis: RecipeCostBasis;
  /** Cost of the priced ingredients, or null when nothing is priced. */
  total: number | null;
  /** Total divided by the recipe's own servings, or null when unknown. */
  perPortion: number | null;
  servings: number | null;
  /** Ingredients that produced a cost. */
  priced: number;
  ingredients: number;
  /** priced / ingredients, rounded to two decimals. */
  coverage: number;
  /** True while any ingredient is unpriced or unconvertible. */
  partial: boolean;
  lines: RecipeCostLine[];
  /** The ingredients behind `partial`, in recipe order. */
  unpriced: RecipeCostUnpriced[];
}

export interface RecipeCostOptions {
  basis?: RecipeCostBasis;
  servings?: number | null;
  /**
   * Unit converter, normally `convert` from `server/units.ts`. The default only
   * accepts identical units so a caller that forgets one never invents a
   * conversion.
   */
  convert?: (amount: number, from: string, to: string) => number | null;
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function sameUnits(amount: number, from: string, to: string): number | null {
  return from.trim().toLowerCase() === to.trim().toLowerCase() ? amount : null;
}

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Pick the price to use for one item: the requested basis first, then the other
 * bases in their fixed order. Returns null when the item has no price at all.
 */
export function resolveRecipeCostPrice(
  prices: RecipeCostPrices | null | undefined,
  basis: RecipeCostBasis,
): { price: number; basis: RecipeCostBasis } | null {
  if (!prices) return null;
  const candidates = [basis, ...RECIPE_COST_BASES.filter((entry) => entry !== basis)];
  for (const candidate of candidates) {
    const price = positive(prices[candidate]);
    if (price != null) return { price, basis: candidate };
  }
  return null;
}

/**
 * Cost a recipe from its ingredient lines.
 *
 * A line without a unit is treated as already written in the item's own unit,
 * which is how a recipe that says "2 eggs" against a `pcs` item reads. A line
 * with no linked item, no quantity, no price or an unconvertible unit keeps its
 * cost as null and is listed in `unpriced`.
 */
export function recipeCost(ingredients: RecipeCostIngredient[], options: RecipeCostOptions = {}): RecipeCost {
  const basis = options.basis ?? "latest";
  const convert = options.convert ?? sameUnits;
  const lines: RecipeCostLine[] = [];
  const unpriced: RecipeCostUnpriced[] = [];
  let total = 0;
  let priced = 0;

  for (const ingredient of ingredients) {
    const name = String(ingredient.name ?? "").trim();
    const quantity = ingredient.quantity == null ? null : Number(ingredient.quantity);
    const unit = ingredient.unit == null ? null : String(ingredient.unit).trim() || null;
    const itemUnit = ingredient.itemUnit == null ? null : String(ingredient.itemUnit).trim() || null;
    const line: RecipeCostLine = {
      id: ingredient.id ?? null,
      name,
      quantity: quantity != null && Number.isFinite(quantity) ? quantity : null,
      unit,
      itemId: ingredient.itemId ?? null,
      pricedQuantity: null,
      itemUnit,
      unitPrice: null,
      basis: null,
      cost: null,
      reason: null,
    };

    if (!ingredient.itemId || !itemUnit) {
      line.reason = "unlinked";
    } else if (line.quantity == null || line.quantity <= 0) {
      line.reason = "quantity";
    } else {
      const picked = resolveRecipeCostPrice(ingredient.prices, basis);
      // A line without a unit is already counted in the item's own unit.
      const amount = picked == null ? null : unit ? convert(line.quantity, unit, itemUnit) : line.quantity;
      if (picked == null) line.reason = "unpriced";
      else if (amount == null || !Number.isFinite(amount) || amount < 0) line.reason = "unconverted";
      else {
        line.pricedQuantity = round(amount, 3);
        line.unitPrice = round(picked.price, 4);
        line.basis = picked.basis;
        line.cost = round(amount * picked.price, 4);
        total += amount * picked.price;
        priced += 1;
      }
    }

    if (line.reason) unpriced.push({ name, reason: line.reason });
    lines.push(line);
  }

  const servings =
    options.servings != null && Number.isFinite(options.servings) && options.servings > 0
      ? Math.round(options.servings)
      : null;
  const known = priced > 0;
  return {
    basis,
    total: known ? round(total, 4) : null,
    perPortion: known && servings ? round(total / servings, 4) : null,
    servings,
    priced,
    ingredients: ingredients.length,
    coverage: round(priced / Math.max(1, ingredients.length), 2),
    partial: ingredients.length > 0 && priced < ingredients.length,
    lines,
    unpriced,
  };
}

/**
 * Cost for a different number of portions. A recipe that does not say how many
 * servings it makes cannot be scaled, so its total is shown unchanged and the
 * portions only divide it, mirroring `scaledCalories`.
 */
export function scaledRecipeCost(
  cost: Pick<RecipeCost, "total" | "perPortion"> | null | undefined,
  baseServings: number | null,
  portions: number,
): { total: number | null; perPortion: number | null } {
  const count = Math.max(1, portions);
  const base = baseServings != null && baseServings > 0 ? baseServings : null;
  let total: number | null = null;
  if (cost?.total != null) {
    total = base ? cost.total * (count / base) : cost.total;
  } else if (cost?.perPortion != null) {
    total = cost.perPortion * count;
  }
  return {
    total: total == null ? null : round(total, 4),
    perPortion: total == null ? null : round(total / count, 4),
  };
}
