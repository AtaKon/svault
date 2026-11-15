import { z } from "zod";
import type { InventorySort } from "../../shared/types.js";

/**
 * The inventory list filters in one place, so a saved view is validated against
 * exactly the shape the item list accepts. Unknown filter keys are rejected:
 * a typo must not silently save a view that shows everything.
 */
export const inventorySortSchema = z.enum(["name", "recent", "quantity", "value"]);

export const INVENTORY_SORTS = inventorySortSchema.options;

export const inventoryFilterSchema = z.strictObject({
  q: z.string().trim().max(120).optional(),
  categoryId: z.string().trim().min(1).max(60).nullish(),
  locationId: z.string().trim().min(1).max(60).nullish(),
  tag: z.string().trim().min(1).max(60).nullish(),
  low: z.boolean().optional(),
  expiring: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export type InventoryFilters = z.infer<typeof inventoryFilterSchema>;

/** Drop empty values so a stored view stays stable and comparable. */
export function cleanInventoryFilters(filters: InventoryFilters): InventoryFilters {
  const clean: InventoryFilters = {};
  if (filters.q?.trim()) clean.q = filters.q.trim();
  if (filters.categoryId) clean.categoryId = filters.categoryId;
  if (filters.locationId) clean.locationId = filters.locationId;
  if (filters.tag) clean.tag = filters.tag;
  if (filters.low) clean.low = true;
  if (filters.expiring) clean.expiring = true;
  if (filters.archived) clean.archived = true;
  return clean;
}

/** Stable key used by the client to tell whether a view is currently applied. */
export function inventoryFiltersKey(filters: InventoryFilters, sort: InventorySort | string): string {
  const clean = cleanInventoryFilters(filters);
  const keys = Object.keys(clean).sort();
  return JSON.stringify([keys.map((key) => [key, clean[key as keyof InventoryFilters]]), sort]);
}
