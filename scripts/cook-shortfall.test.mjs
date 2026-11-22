import assert from "node:assert/strict";
import { test } from "node:test";
import { shortfallShoppingLines } from "../client/cook-shortfall.js";

const line = (over = {}) => ({
  name: "Flour",
  shortfall: 250,
  unit: "g",
  itemId: "itm_flour",
  ...over,
});

test("positive shortfalls on tracked items become shopping lines", () => {
  const result = [line(), line({ name: "Milk", itemId: "itm_milk", shortfall: 1, unit: "l" })];
  assert.deepEqual(shortfallShoppingLines(result, []), result);
});

test("lines without a shortfall or an item link are skipped", () => {
  assert.deepEqual(
    shortfallShoppingLines(
      [
        line({ shortfall: 0 }),
        line({ shortfall: -3 }),
        line({ itemId: null }),
        line({ itemId: undefined }),
        line({ shortfall: null }),
      ],
      [],
    ),
    [],
  );
});

test("items already on the open shopping list are not added twice", () => {
  const shopping = [{ itemId: "itm_flour", checked: false }];
  const milk = line({ name: "Milk", itemId: "itm_milk", shortfall: 1, unit: "l" });
  assert.deepEqual(shortfallShoppingLines([line(), milk], shopping), [milk]);
});

test("a checked line does not count as being on the list", () => {
  // The flour was bought (checked off); a fresh shortfall should be added.
  const shopping = [{ itemId: "itm_flour", checked: true }];
  const flour = line();
  assert.deepEqual(shortfallShoppingLines([flour], shopping), [flour]);
});

test("lines without an item id never match a list entry", () => {
  const shopping = [{ itemId: "itm_flour", checked: false }];
  assert.deepEqual(shortfallShoppingLines([line({ itemId: null })], shopping), []);
});
