import type { MealPlanEntry } from "../../shared/types.js";

/**
 * Serialize plan rows with an async serializer. Failures propagate instead of
 * leaving unresolved promises that JSON-encode as empty objects.
 */
export function serializePlanEntries<T>(
  rows: T[],
  serializer: (row: T) => Promise<MealPlanEntry>,
): Promise<MealPlanEntry[]> {
  return Promise.all(rows.map((row) => serializer(row)));
}
