/**
 * Which cook-result shortfalls should become shopping lines, pure of the API:
 * only tracked items with a positive shortfall that are not already on the
 * open shopping list (checked lines have already been bought).
 * Each rule can be tested on its own (see scripts/cook-shortfall.test.mjs).
 */

export interface CookResultLine {
  name: string;
  shortfall: number;
  unit: string;
  itemId?: string | null;
}

export interface ShoppingLineSnapshot {
  itemId: string | null;
  checked: boolean;
}

export function shortfallShoppingLines(
  result: CookResultLine[],
  shopping: ShoppingLineSnapshot[],
): CookResultLine[] {
  const onList = new Set(
    shopping
      .filter((line) => !line.checked && line.itemId)
      .map((line) => line.itemId as string),
  );
  return result.filter((line) => line.shortfall > 0 && line.itemId && !onList.has(line.itemId));
}
