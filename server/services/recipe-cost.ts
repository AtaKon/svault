import { all, get, parseJson } from "../db.js";
import { ApiError } from "../http.js";
import { convert } from "../units.js";
import {
  RECIPE_COST_BASES,
  recipeCost,
  type RecipeCost,
  type RecipeCostBasis,
  type RecipeCostIngredient,
  type RecipeCostPrices,
} from "../../shared/recipe-cost.js";
import type { RecipeCostSummary } from "../../shared/types.js";

/**
 * How far back an average price looks, and how many purchases it uses at most.
 * An old price is not today's price, and a single unusual shop should not
 * dominate the average.
 */
export const RECIPE_COST_AVERAGE_DAYS = 90;
export const RECIPE_COST_AVERAGE_PURCHASES = 20;

/** Read the requested basis from a query value, or null when none was sent. */
export function requestedCostBasis(value: unknown): RecipeCostBasis | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw == null || raw === "") return null;
  const basis = String(raw).trim().toLowerCase();
  if (!(RECIPE_COST_BASES as string[]).includes(basis)) {
    throw new ApiError(400, "Unknown price basis. Use latest, average or stock.");
  }
  return basis as RecipeCostBasis;
}

/** The house default, unless the request asked for something else. */
export function houseCostBasis(settings: unknown, requested: RecipeCostBasis | null): RecipeCostBasis {
  if (requested) return requested;
  const saved = typeof settings === "object" && settings != null
    ? (settings as Record<string, unknown>).recipeCostBasis
    : null;
  const basis = typeof saved === "string" ? saved.trim().toLowerCase() : "";
  return (RECIPE_COST_BASES as string[]).includes(basis) ? (basis as RecipeCostBasis) : "latest";
}

/** Unit prices per item, one map per basis. */
export interface RecipeCostPricesByItem {
  latest: Map<string, number>;
  average: Map<string, number>;
  stock: Map<string, number>;
}

/**
 * Load every price basis for a house in three aggregate queries. The shapes are
 * plain SQL and use the indexes on `stock_movements` and `stock_lots`, and none
 * of them runs per item: cost is computed in memory afterwards, so a list of
 * fifty recipes costs the same number of queries as a list of one.
 */
export async function loadRecipeCostPrices(houseId: string, today = new Date()): Promise<RecipeCostPricesByItem> {
  const cutoff = new Date(today.getTime() - RECIPE_COST_AVERAGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  // The latest movement per item (ties on the same timestamp are broken by id
  // in the ORDER BY, first row wins below).
  const latestRows = await all<{ item_id: string; price: number }>(
    `SELECT m.item_id, m.normalized_price AS price
       FROM stock_movements m
       JOIN (
         SELECT item_id, MAX(created_at) AS at
           FROM stock_movements
          WHERE house_id = ? AND type IN ('in', 'adjust')
            AND normalized_price IS NOT NULL AND normalized_price > 0
          GROUP BY item_id
       ) latest ON latest.item_id = m.item_id AND latest.at = m.created_at
      WHERE m.house_id = ? AND m.type IN ('in', 'adjust')
        AND m.normalized_price IS NOT NULL AND m.normalized_price > 0
      ORDER BY m.item_id, m.created_at DESC, m.id DESC`,
    [houseId, houseId],
  );
  // Purchases inside the averaging window, newest first.
  const recentRows = await all<{ item_id: string; price: number }>(
    `SELECT item_id, normalized_price AS price
       FROM stock_movements
      WHERE house_id = ? AND type IN ('in', 'adjust')
        AND normalized_price IS NOT NULL AND normalized_price > 0
        AND created_at >= ?
      ORDER BY item_id, created_at DESC, id DESC`,
    [houseId, cutoff],
  );
  // Weighted cost of what is on the shelf right now.
  const stockRows = await all<{ item_id: string; quantity: number; value: number }>(
    `SELECT item_id, SUM(quantity) AS quantity, SUM(quantity * unit_price) AS value
       FROM stock_lots
      WHERE house_id = ? AND quantity > 0 AND unit_price IS NOT NULL AND unit_price > 0
      GROUP BY item_id`,
    [houseId],
  );

  const latest = new Map<string, number>();
  for (const row of latestRows) {
    if (!latest.has(row.item_id)) latest.set(row.item_id, Number(row.price));
  }

  // Keep at most RECIPE_COST_AVERAGE_PURCHASES prices per item; the rows are
  // already newest first, so the first ones are the ones that count.
  const averages = new Map<string, { sum: number; count: number }>();
  for (const row of recentRows) {
    const entry = averages.get(row.item_id) ?? { sum: 0, count: 0 };
    if (entry.count >= RECIPE_COST_AVERAGE_PURCHASES) continue;
    entry.sum += Number(row.price);
    entry.count += 1;
    averages.set(row.item_id, entry);
  }
  const average = new Map<string, number>();
  for (const [itemId, entry] of averages) {
    if (entry.count > 0) average.set(itemId, entry.sum / entry.count);
  }

  const stock = new Map<string, number>();
  for (const row of stockRows) {
    const quantity = Number(row.quantity);
    const value = Number(row.value);
    if (quantity > 0 && Number.isFinite(value)) stock.set(row.item_id, value / quantity);
  }

  return { latest, average, stock };
}

export interface RecipeCostResult {
  basis: RecipeCostBasis;
  currency: string;
  /** Keyed by recipe id. A recipe with no ingredient lines is absent. */
  costs: Map<string, RecipeCost>;
}

/**
 * Cost the recipes of a house. A fixed handful of queries (house, ingredients,
 * servings and the three price aggregates) whatever the number of recipes; pass
 * `recipeIds` to narrow it.
 */
export async function recipeCosts(
  houseId: string,
  options: { requestedBasis?: unknown; recipeIds?: string[] } = {},
): Promise<RecipeCostResult> {
  const house = await get<{ settings: string | null; currency: string | null }>(
    "SELECT settings, currency FROM houses WHERE id = ?",
    [houseId],
  );
  if (!house) throw new ApiError(404, "House not found");
  const basis = houseCostBasis(parseJson(house.settings, {}), requestedCostBasis(options.requestedBasis));
  const recipeIds = options.recipeIds?.length ? options.recipeIds : null;

  const [ingredientRows, priceMaps] = await Promise.all([
    all<{
      id: string;
      recipe_id: string;
      name: string;
      quantity: number | null;
      unit: string | null;
      item_id: string | null;
      item_unit: string | null;
    }>(
      `SELECT ri.id, ri.recipe_id, ri.name, ri.quantity, ri.unit, ri.item_id, i.unit AS item_unit
         FROM recipe_ingredients ri
         JOIN recipes r ON r.id = ri.recipe_id
         LEFT JOIN items i ON i.id = ri.item_id AND i.house_id = r.house_id
        WHERE r.house_id = ?${recipeIds ? ` AND r.id IN (${recipeIds.map(() => "?").join(", ")})` : ""}
        ORDER BY ri.recipe_id, ri.sort, ri.id`,
      [houseId, ...(recipeIds ?? [])],
    ),
    loadRecipeCostPrices(houseId),
  ]);

  const byRecipe = new Map<string, RecipeCostIngredient[]>();
  for (const row of ingredientRows) {
    const candidates: RecipeCostPrices | null = row.item_id
      ? {
          latest: priceMaps.latest.get(row.item_id) ?? null,
          average: priceMaps.average.get(row.item_id) ?? null,
          stock: priceMaps.stock.get(row.item_id) ?? null,
        }
      : null;
    const line: RecipeCostIngredient = {
      id: row.id,
      name: row.name,
      quantity: row.quantity == null ? null : Number(row.quantity),
      unit: row.unit,
      itemId: row.item_id,
      itemUnit: row.item_unit,
      prices: candidates,
    };
    const list = byRecipe.get(row.recipe_id) ?? [];
    list.push(line);
    byRecipe.set(row.recipe_id, list);
  }

  // Servings live on the recipe row, so fetch the ones being costed alongside.
  const recipeRows = await all<{ id: string; servings: number | null }>(
    `SELECT id, servings FROM recipes WHERE house_id = ?${recipeIds ? ` AND id IN (${recipeIds.map(() => "?").join(", ")})` : ""}`,
    [houseId, ...(recipeIds ?? [])],
  );
  const servingsById = new Map(recipeRows.map((row) => [row.id, row.servings == null ? null : Number(row.servings)]));

  const costs = new Map<string, RecipeCost>();
  for (const [recipeId, ingredients] of byRecipe) {
    costs.set(
      recipeId,
      recipeCost(ingredients, { basis, servings: servingsById.get(recipeId) ?? null, convert }),
    );
  }

  return { basis, currency: house.currency ?? "EUR", costs };
}

function emptyCost(basis: RecipeCostBasis): RecipeCost {
  return {
    basis,
    total: null,
    perPortion: null,
    servings: null,
    priced: 0,
    ingredients: 0,
    coverage: 0,
    partial: false,
    lines: [],
    unpriced: [],
  };
}

/** Compact rows for the recipe list: enough to sort and filter, not the lines. */
export async function recipeCostSummaries(
  houseId: string,
  requestedBasis?: unknown,
): Promise<{ basis: RecipeCostBasis; currency: string; recipes: RecipeCostSummary[] }> {
  const result = await recipeCosts(houseId, { requestedBasis });
  const rows = await all<{ id: string; title: string; servings: number | null }>(
    "SELECT id, title, servings FROM recipes WHERE house_id = ? ORDER BY favorite DESC, updated_at DESC",
    [houseId],
  );
  return {
    basis: result.basis,
    currency: result.currency,
    recipes: rows.map((row) => {
      const cost = result.costs.get(row.id) ?? emptyCost(result.basis);
      return {
        recipeId: row.id,
        title: row.title,
        servings: row.servings == null ? null : Number(row.servings),
        total: cost.total,
        perPortion: cost.perPortion,
        priced: cost.priced,
        ingredients: cost.ingredients,
        coverage: cost.coverage,
        partial: cost.partial,
      };
    }),
  };
}
