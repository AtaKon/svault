import type { RecipeIngredient, RecipeStep } from "../shared/types";

export interface IngredientRow {
  itemId?: string | null;
  note?: string | null;
  name: string;
  quantity: string;
  unit: string;
  optional: boolean;
}

export function recipeFormRows(ingredients: RecipeIngredient[], steps: RecipeStep[]) {
  return {
    ingredients: ingredients.length ? ingredients.map((ingredient) => ({
      itemId: ingredient.itemId,
      note: ingredient.note,
      name: ingredient.name,
      quantity: ingredient.quantity != null ? String(ingredient.quantity) : "",
      unit: ingredient.unit ?? "",
      optional: ingredient.optional,
    })) : [{ name: "", quantity: "", unit: "", optional: false }],
    steps: steps.length ? steps.map((step) => ({ text: step.text, timerSeconds: step.timerSeconds })) : [{ text: "" }],
  };
}

export function recipeFormPayload(ingredients: IngredientRow[], steps: RecipeStep[]) {
  return {
    steps: steps.map((step) => ({ ...step, text: step.text.trim() })).filter((step) => step.text),
    ingredients: ingredients.filter((row) => row.name.trim()).map((row) => ({
      itemId: row.itemId ?? null,
      note: row.note ?? null,
      name: row.name.trim(),
      quantity: row.quantity ? Number(row.quantity) : null,
      unit: row.unit.trim() || null,
      optional: row.optional,
    })),
  };
}
