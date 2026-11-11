/**
 * Turning recipe ingredient lines into grams.
 *
 * Recipes are written the way people cook: cups, spoons, cloves, slices,
 * "2 eggs". To show a portion weight and to let cook mode convert everything to
 * grams we estimate each line:
 *
 * - mass units convert exactly;
 * - volume units convert to millilitres and are multiplied by a rough density
 *   for the ingredient (a cup of flour is not a cup of water);
 * - countable units use a typical weight per piece for common ingredients.
 *
 * Everything here is deliberately approximate and honest about it. When a line
 * cannot be estimated the result is `null`, so the UI can show the original
 * amount instead of inventing a number.
 */

import type { RecipePortion } from "./types.js";

export type { RecipePortion };

const MASS: Record<string, number> = { mg: 0.001, g: 1, kg: 1000, oz: 28.349523, lb: 453.59237 };

const VOLUME: Record<string, number> = {
  ml: 1,
  cl: 10,
  dl: 100,
  l: 1000,
  tsp: 4.928922,
  tbsp: 14.786765,
  cup: 240,
  floz: 29.57353,
  pint: 473.176,
  qt: 946.353,
  gal: 3785.411784,
};

/** Typical weight of one piece for countable units. */
const UNIT_PIECE_GRAMS: Record<string, number> = {
  pcs: 100,
  pc: 100,
  piece: 100,
  pieces: 100,
  slice: 30,
  clove: 5,
  cloves: 5,
  sprig: 2,
  sprigs: 2,
  pinch: 0.5,
  pinches: 0.5,
  dash: 1,
  drop: 0.05,
  drops: 0.05,
  handful: 30,
  handfuls: 30,
  stick: 100,
  sticks: 100,
  head: 500,
  heads: 500,
  bunch: 100,
  bunches: 100,
  can: 400,
  cans: 400,
  jar: 350,
  jars: 350,
  pack: 250,
  packs: 250,
  packet: 250,
  packets: 250,
  box: 250,
  boxes: 250,
  bag: 250,
  bags: 250,
  pair: 100,
  set: 100,
};

/** A dozen is a count multiplier rather than a single piece. */
const COUNT_MULTIPLIER: Record<string, number> = { dozen: 12 };

/**
 * Units that already describe a whole container or bundle. Their weight must
 * beat an ingredient-specific piece weight, otherwise "1 head garlic" would be
 * costed as a single clove because garlic has a 5 g piece weight.
 */
const CONTAINER_UNITS = new Set([
  "head",
  "heads",
  "bunch",
  "bunches",
  "can",
  "cans",
  "jar",
  "jars",
  "pack",
  "packs",
  "packet",
  "packets",
  "box",
  "boxes",
  "bag",
  "bags",
  "pair",
  "set",
]);

/** Weight of a single piece, keyed by ingredient. First match wins. */
const INGREDIENT_PIECE_GRAMS: [RegExp, number][] = [
  [/cherry tomato/, 12],
  [/grape tomato/, 12],
  [/egg(s)?\b|αβγ(ό|ο)(?![\u0370-\u03ff])/i, 50],
  [/garlic|σκόρδ(ο|α)/i, 5],
  [/shallot/, 30],
  [/red onion|white onion|onion|κρεμμύδ(ι|ια)/i, 150],
  [/sweet potato|γλυκοπατάτα/i, 200],
  [/potato|πατάτ(α|ες)/i, 170],
  [/carrot|καρότ(ο|α)/i, 70],
  [/cucumber|αγγούρ(ι|ια)/i, 200],
  [/zucchini|courgette|κολοκυθάκ(ι|ια)/i, 180],
  [/eggplant|aubergine|μελιτζάν(α|ες)/i, 250],
  [/bell pepper|red pepper|green pepper|yellow pepper|πιπερι(ά|α)/i, 120],
  [/chilli|chili|chile|καυτερ(ή|η)/i, 15],
  [/tomato|τομάτ(α|ες)|ντάτ(α|ες)/i, 120],
  [/lemon|λεμόν(ι|ια)/i, 100],
  [/lime/, 70],
  [/orange|πορτοκάλ(ι|ια)/i, 180],
  [/apple|μήλ(ο|α)/i, 180],
  [/banana|μπανάν(α|ες)/i, 120],
  [/pear|αχλάδ(ι|ια)/i, 170],
  [/peach|ροδάκιν(ο|α)/i, 150],
  [/avocado|αβοκάντο/i, 150],
  [/mushroom|μανιτάρ(ι|ια)/i, 20],
  [/chicken breast|στήθος κοτόπουλο/i, 200],
  [/chicken thigh|μπούτι κοτόπουλο/i, 120],
  [/bacon|μπέικον/i, 15],
  [/sausage|λουκάνικ(ο|α)/i, 80],
  [/anchov|γαύρ(ος|οι)/i, 5],
  [/shrimp|prawn|γαρίδ(α|ες)/i, 10],
  [/strawberr|φράουλ(α|ες)/i, 12],
  [/grape|σταφύλ(ι|ια)/i, 5],
  [/cherry|κεράσ(ι|ια)/i, 8],
  [/pita|πίτα/i, 60],
  [/tortilla|τορτίγια/i, 40],
];

/** Rough density in g/ml for volume units, keyed by ingredient. First match wins. */
const DENSITY: [RegExp, number][] = [
  [/icing sugar|powdered sugar|ζάχαρη άχνη/i, 0.56],
  [/brown sugar|μαύρη ζάχαρη/i, 0.93],
  [/flour|αλεύρ(ι|ια)/i, 0.53],
  [/sugar|ζάχαρ(η|ες)/i, 0.85],
  [/rice|ρύζ(ι|ια)/i, 0.85],
  [/oats|βρώμ(η|ες)/i, 0.4],
  [/breadcrumb|φρυγανιά/i, 0.45],
  [/cocoa|κακάο/i, 0.52],
  [/baking powder|baking soda|μαγειρική σόδα/i, 0.9],
  [/salt|αλάτ(ι|ια)/i, 1.2],
  [/honey|syrup|molasses|μέλ(ι|ια)|σιρόπι/i, 1.4],
  [/peanut butter|φυστικοβούτυρο/i, 1.08],
  [/tomato paste|πελτές|τοματοπελτές/i, 1.1],
  [/soy sauce|σόγια/i, 1.15],
  [/oil|λάδ(ι|ια)/i, 0.92],
  [/butter|βούτυρ(ο|α)/i, 0.91],
  [/cream|κρέμα/i, 1.0],
  [/yogurt|yoghurt|γιαούρτ(ι|ια)/i, 1.03],
  [/milk|γάλ(α|ατα)/i, 1.03],
  [/almond|walnut|hazelnut|nuts|αμύγδαλ(ο|α)|καρύδ(ι|ια)/i, 0.6],
  [/water|stock|broth|wine|juice|vinegar|νερό|ζωμός|κρασί|χυμός|ξίδι/i, 1.0],
];

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else {
    const raw = String(value).trim();
    // "1,000" is a thousands separator while "1,5" is a decimal comma. Treat a
    // comma as a separator only when it groups exactly three digits.
    const compact = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw) ? raw.replace(/,/g, "") : raw.replace(",", ".");
    parsed = Number(compact);
  }
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function matchTable(table: [RegExp, number][], name: string): number | null {
  for (const [pattern, value] of table) {
    if (pattern.test(name)) return value;
  }
  return null;
}

export interface IngredientLike {
  name: string;
  quantity: number | null;
  unit: string | null;
}

export interface IngredientGrams {
  /** Estimated weight in grams, or null when the line cannot be estimated. */
  grams: number | null;
  /** False only for an exact mass-unit conversion. */
  estimated: boolean;
}

/**
 * Estimate the weight of one ingredient line in grams.
 * Returns `grams: null` when there is no defensible way to convert it.
 */
export function estimateIngredientGrams(ingredient: IngredientLike): IngredientGrams {
  const quantity = numberOrNull(ingredient.quantity);
  if (quantity == null || quantity <= 0) return { grams: null, estimated: true };
  const unit = String(ingredient.unit ?? "").trim().toLowerCase();
  const name = String(ingredient.name ?? "").trim();

  if (unit && unit in MASS) {
    return { grams: round(quantity * MASS[unit]), estimated: false };
  }

  if (unit && unit in VOLUME) {
    const millilitres = quantity * VOLUME[unit];
    const density = matchTable(DENSITY, name) ?? 1;
    return { grams: round(millilitres * density), estimated: true };
  }

  // No unit, or a countable unit: use a typical weight per piece. A container
  // unit ("head", "can") wins over the ingredient's own piece weight.
  const unitPiece = UNIT_PIECE_GRAMS[unit] ?? null;
  const ingredientPiece = matchTable(INGREDIENT_PIECE_GRAMS, name);
  const piece = CONTAINER_UNITS.has(unit)
    ? (unitPiece ?? ingredientPiece)
    : (ingredientPiece ?? unitPiece);
  if (piece == null) return { grams: null, estimated: true };
  const count = quantity * (COUNT_MULTIPLIER[unit] ?? 1);
  return { grams: round(count * piece), estimated: true };
}

/** Estimate the weight of a whole recipe and of one portion. */
export function recipePortion(ingredients: IngredientLike[], servings: number | null | undefined): RecipePortion {
  let total = 0;
  let covered = 0;
  for (const ingredient of ingredients) {
    const { grams } = estimateIngredientGrams(ingredient);
    if (grams != null) {
      total += grams;
      covered += 1;
    }
  }
  const count = servings != null && servings > 0 ? Math.round(servings) : null;
  const hasWeight = covered > 0;
  return {
    totalGrams: hasWeight ? round(total) : null,
    perServingGrams: hasWeight && count ? round(total / count) : null,
    servings: count,
    covered,
    ingredients: ingredients.length,
    coverage: round(covered / Math.max(1, ingredients.length), 2),
  };
}

/**
 * Scale an ingredient quantity for a different number of portions. When the
 * recipe does not say how many servings it makes there is nothing to scale
 * against, so the original quantity is kept instead of silently multiplying it.
 */
export function scaledQuantity(quantity: number | null, baseServings: number | null, portions: number): number | null {
  if (quantity == null) return null;
  if (baseServings == null || baseServings <= 0) return quantity;
  return quantity * (portions / baseServings);
}

/** Compact gram label used by cook mode and portion cards. */
export function gramsLabel(grams: number | null): string {
  if (grams == null) return "—";
  if (grams >= 1000) return `${round(grams / 1000, 2)} kg`;
  return `${grams >= 10 ? Math.round(grams) : round(grams)} g`;
}
