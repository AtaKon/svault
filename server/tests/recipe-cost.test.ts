import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { convert } from "../units.js";
import {
  RECIPE_COST_BASES,
  recipeCost,
  resolveRecipeCostPrice,
  scaledRecipeCost,
  type RecipeCostIngredient,
} from "../../shared/recipe-cost.js";

/** An ingredient line linked to a priced item. */
function line(overrides: Partial<RecipeCostIngredient> = {}): RecipeCostIngredient {
  return {
    name: "Flour",
    quantity: 0.5,
    unit: "kg",
    itemId: "itm_flour",
    itemUnit: "kg",
    prices: { latest: 2, average: 1.5, stock: 1.8 },
    ...overrides,
  };
}

describe("recipe cost", () => {
  it("converts ingredient quantities to the item's price unit", () => {
    // mass: 500 g of an item priced per kg
    const mass = recipeCost([line({ quantity: 500, unit: "g", prices: { latest: 2 } })], { convert });
    assert.equal(mass.lines[0].pricedQuantity, 0.5);
    assert.equal(mass.lines[0].unitPrice, 2);
    assert.equal(mass.lines[0].cost, 1);
    assert.equal(mass.lines[0].reason, null);

    // volume: 250 ml of an item priced per litre
    const volume = recipeCost(
      [line({ name: "Milk", quantity: 250, unit: "ml", itemUnit: "l", prices: { latest: 1.2 } })],
      { convert },
    );
    assert.equal(volume.lines[0].pricedQuantity, 0.25);
    assert.equal(volume.lines[0].cost, 0.3);

    // countable units use the item unit
    const count = recipeCost(
      [line({ name: "Eggs", quantity: 2, unit: "pcs", itemUnit: "pcs", prices: { latest: 0.35 } })],
      { convert },
    );
    assert.equal(count.lines[0].pricedQuantity, 2);
    assert.equal(count.lines[0].cost, 0.7);

    // a line without a unit is already in the item's own unit
    const bare = recipeCost([line({ quantity: 3, unit: null, prices: { latest: 1 } })], { convert });
    assert.equal(bare.lines[0].cost, 3);

    // an incompatible unit never invents a number
    const wrong = recipeCost([line({ quantity: 1, unit: "cup", itemUnit: "kg" })], { convert });
    assert.equal(wrong.lines[0].cost, null);
    assert.equal(wrong.lines[0].reason, "unconverted");
  });

  it("selects the requested basis and reports one price per line", () => {
    for (const basis of RECIPE_COST_BASES) {
      const result = recipeCost([line()], { basis, convert });
      assert.equal(result.basis, basis);
      assert.equal(result.lines[0].basis, basis);
      assert.equal(result.lines[0].unitPrice, { latest: 2, average: 1.5, stock: 1.8 }[basis]);
    }
    // The default is the latest recorded price.
    assert.equal(recipeCost([line()], { convert }).lines[0].unitPrice, 2);
  });

  it("falls back latest -> average -> stock and then reports no price", () => {
    assert.deepEqual(resolveRecipeCostPrice({ latest: 3, average: 2, stock: 1 }, "latest"), { price: 3, basis: "latest" });
    assert.deepEqual(resolveRecipeCostPrice({ average: 2, stock: 1 }, "latest"), { price: 2, basis: "average" });
    assert.deepEqual(resolveRecipeCostPrice({ stock: 1 }, "latest"), { price: 1, basis: "stock" });
    assert.equal(resolveRecipeCostPrice({}, "latest"), null);
    assert.equal(resolveRecipeCostPrice(null, "stock"), null);

    // A requested basis with data wins over the chain.
    assert.deepEqual(resolveRecipeCostPrice({ latest: 3, average: 2, stock: 1 }, "stock"), { price: 1, basis: "stock" });

    const fallback = recipeCost([line({ prices: { stock: 1.8 } })], { basis: "latest", convert });
    assert.equal(fallback.lines[0].basis, "stock");
    assert.equal(fallback.lines[0].cost, 0.9);

    const none = recipeCost([line({ prices: { latest: 0 } })], { convert });
    assert.equal(none.total, null);
    assert.equal(none.partial, true);
    assert.deepEqual(none.unpriced, [{ name: "Flour", reason: "unpriced" }]);
  });

  it("never presents a partial total as complete", () => {
    const result = recipeCost(
      [
        line(), // priced
        line({ id: "rin_salt", name: "Salt", quantity: 5, unit: "g", itemId: null, itemUnit: null, prices: null }),
        line({ id: "rin_pepper", name: "Pepper", quantity: 5, unit: "g", itemUnit: "g", prices: { latest: 0.02 } }),
      ],
      { servings: 2, convert },
    );
    assert.equal(result.ingredients, 3);
    assert.equal(result.priced, 2);
    assert.equal(result.coverage, 0.67);
    assert.equal(result.partial, true);
    assert.equal(result.total, 1.1);
    assert.equal(result.perPortion, 0.55);
    assert.deepEqual(result.unpriced, [{ name: "Salt", reason: "unlinked" }]);
    assert.deepEqual(
      result.lines.map((entry) => entry.reason),
      [null, "unlinked", null],
    );
  });

  it("keeps an unlinked or unquantified line out of the total", () => {
    const unlinked = recipeCost([line({ itemId: null, itemUnit: null, prices: null })], { convert });
    assert.equal(unlinked.total, null);
    assert.equal(unlinked.coverage, 0);
    assert.deepEqual(unlinked.unpriced, [{ name: "Flour", reason: "unlinked" }]);

    const noQuantity = recipeCost([line({ quantity: null })], { convert });
    assert.equal(noQuantity.total, null);
    assert.deepEqual(noQuantity.unpriced, [{ name: "Flour", reason: "quantity" }]);

    // A recipe with no ingredients has no cost and is not "partial".
    const empty = recipeCost([], { servings: 4, convert });
    assert.equal(empty.total, null);
    assert.equal(empty.perPortion, null);
    assert.equal(empty.partial, false);
    assert.equal(empty.ingredients, 0);
  });

  it("has no per-portion figure without a serving count", () => {
    const unknownServings = recipeCost([line()], { convert });
    assert.equal(unknownServings.total, 1);
    assert.equal(unknownServings.perPortion, null);
    assert.equal(unknownServings.servings, null);
  });

  it("scales a cost for cook mode and stays consistent", () => {
    const doubled = scaledRecipeCost({ total: 4, perPortion: 1 }, 4, 8);
    assert.equal(doubled.total, 8);
    assert.equal(doubled.perPortion, 1);
    assert.equal((doubled.perPortion ?? 0) * 8, doubled.total);

    // Without a serving count the total is kept and divided by the portions.
    const noBase = scaledRecipeCost({ total: 4, perPortion: null }, null, 2);
    assert.equal(noBase.total, 4);
    assert.equal(noBase.perPortion, 2);

    assert.deepEqual(scaledRecipeCost(null, 4, 2), { total: null, perPortion: null });
    assert.deepEqual(scaledRecipeCost({ total: null, perPortion: null }, 4, 2), { total: null, perPortion: null });
  });
});
