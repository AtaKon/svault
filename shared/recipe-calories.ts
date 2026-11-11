/**
 * Calories for a scaled cook session.
 *
 * A recipe stores nutrition for its own servings. Cook mode may show a
 * different number of portions, so both the total and the per-portion figure
 * are derived from the same scaled total: perPortion × portions always equals
 * the total shown next to it.
 */

export interface RecipeCalories {
  /** Estimated kcal in the whole recipe at the current scale. */
  totalKcal: number | null;
  /** Estimated kcal in one of the portions being cooked. */
  perPortionKcal: number | null;
}

export function scaledCalories(
  nutrition: { totalKcal: number | null; perServingKcal: number | null },
  baseServings: number | null,
  portions: number,
): RecipeCalories {
  const count = Math.max(1, portions);
  const base = baseServings != null && baseServings > 0 ? baseServings : null;
  let totalKcal: number | null = null;
  if (nutrition.totalKcal != null) {
    totalKcal = base ? nutrition.totalKcal * (count / base) : nutrition.totalKcal;
  } else if (nutrition.perServingKcal != null) {
    totalKcal = nutrition.perServingKcal * count;
  }
  return { totalKcal, perPortionKcal: totalKcal == null ? null : totalKcal / count };
}
