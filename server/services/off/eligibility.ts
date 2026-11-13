import { all } from "../../db.js";
import type { OffContributionCandidate, OffProduct, OffProjectId } from "../../../shared/types.js";
import { isValidGtin } from "../../lib/redact.js";
import { getCachedOffProduct } from "../openfoodfacts.js";
import { contributionProjectIds, isOffProjectId, OFF_PROJECTS } from "./projects.js";
import { priceCandidates } from "./prices.js";

/**
 * Which items can be improved in Open Food Facts?
 *
 * The engine reads only the local cache and the local item. It never calls the
 * network: a candidate list is a cheap, repeatable query that the UI can show
 * on every visit. The contribution itself refreshes the product if needed.
 */

interface ItemRow {
  id: string;
  name: string;
  description: string | null;
  brand: string | null;
  category_name: string | null;
  image: string | null;
  nutrition: string | null;
  off_code: string | null;
  off_project: string | null;
  updated_at: string;
}

function hasNutrition(value: unknown): boolean {
  if (!value) return false;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Boolean(parsed && typeof parsed === "object" && Object.keys(parsed).length);
  } catch {
    return false;
  }
}

function preview(field: string, item: ItemRow): string | null {
  switch (field) {
    case "name":
      return item.name;
    case "brand":
      return item.brand;
    case "description":
      return item.description;
    case "category":
      return item.category_name;
    case "nutrition":
      return item.nutrition ? "Nutrition panel from this item" : null;
    case "image":
      return item.image;
    default:
      return null;
  }
}

function candidate(
  item: ItemRow,
  project: OffProjectId,
  code: string,
  kind: "new_product" | "missing_fields",
  fields: string[],
  product: OffProduct | null,
): OffContributionCandidate {
  const values: Record<string, string | null> = {};
  for (const field of fields) values[field] = preview(field, item);
  const score = kind === "new_product" ? 100 : Math.max(50, 90 - fields.length * 5);
  return {
    id: `${kind}:${project}:${code}:${item.id}`,
    kind,
    project,
    code,
    itemId: item.id,
    itemName: item.name,
    score,
    fields,
    values,
    product,
    image: item.image?.startsWith("/uploads/") ? item.image : null,
    ready: true,
    blocked: [],
  };
}

export async function contributionCandidates(
  houseId: string,
  limit = 50,
  itemId?: string,
): Promise<OffContributionCandidate[]> {
  const items = await all<ItemRow>(
    `SELECT i.id, i.name, i.description, i.brand, c.name AS category_name, i.image, i.nutrition,
            i.off_code, i.off_project, i.updated_at
     FROM items i
     LEFT JOIN categories c ON c.id = i.category_id AND c.house_id = i.house_id
     WHERE i.house_id = ? AND i.archived = 0 ${itemId ? "AND i.id = ?" : ""}
     ORDER BY i.updated_at DESC
     LIMIT 250`,
    itemId ? [houseId, itemId] : [houseId],
  );
  const barcodes = await all<{ item_id: string; code: string }>(
    "SELECT item_id, code FROM item_barcodes WHERE house_id = ? ORDER BY created_at",
    [houseId],
  );
  const byItem = new Map<string, string[]>();
  for (const row of barcodes) {
    const list = byItem.get(row.item_id) ?? [];
    list.push(row.code);
    byItem.set(row.item_id, list);
  }

  const seen = new Map<string, OffContributionCandidate>();
  const writable = new Set(contributionProjectIds());
  for (const item of items) {
    const project: OffProjectId = isOffProjectId(item.off_project) ? item.off_project : "off";
    if (!writable.has(project)) continue;
    const localImage = item.image?.startsWith("/uploads/") ? item.image : null;
    const product = item.off_code ? await getCachedOffProduct(item.off_code, project) : null;

    if (!product) {
      const code = [item.off_code, ...(byItem.get(item.id) ?? [])]
        .filter(Boolean)
        .map((value) => String(value).trim())
        .find((value) => isValidGtin(value));
      if (!code) continue;
      // A barcode already in another project is a report, not a duplicate.
      const elsewhere = await getCachedOffProduct(code, "all");
      if (elsewhere && elsewhere.project !== project) {
        const report = {
          type: "product" as const,
          reason: "wrong_project",
          comment: `This product looks like ${OFF_PROJECTS[elsewhere.project].label}, not ${OFF_PROJECTS[project].label}.`,
          flavor: elsewhere.project,
        };
        const entry: OffContributionCandidate = {
          id: `wrong_project:${elsewhere.project}:${code}:${item.id}`,
          kind: "wrong_project",
          project: elsewhere.project,
          code,
          itemId: item.id,
          itemName: item.name,
          score: 60,
          fields: ["report"],
          values: { report: report.comment },
          product: elsewhere,
          image: localImage,
          report,
          ready: true,
          blocked: [],
        };
        if (!seen.has(entry.id)) seen.set(entry.id, entry);
        continue;
      }
      const fields: string[] = ["name"];
      if (item.brand) fields.push("brand");
      if (item.category_name) fields.push("category");
      if (hasNutrition(item.nutrition)) fields.push("nutrition");
      // A new product is created first; photos can be shared afterwards, once
      // the product exists and has a cache entry.
      // A new product needs at least a name and one identifying detail.
      if (!item.name.trim() || !(item.brand || item.category_name)) continue;
      const entry = candidate(item, project, code, "new_product", fields, null);
      const key = `${project}:${code}`;
      if (!seen.has(key) || seen.get(key)!.score < entry.score) seen.set(key, entry);
      continue;
    }

    const fields: string[] = [];
    if (!product.name.trim() && item.name.trim()) fields.push("name");
    if (!product.brand.trim() && item.brand) fields.push("brand");
    if (!product.genericName.trim() && item.description) fields.push("description");
    if (!product.categories.length && item.category_name) fields.push("category");
    if (!product.nutrition && hasNutrition(item.nutrition)) fields.push("nutrition");
    if (!product.image && localImage) fields.push("image");
    if (!fields.length) continue;
    const entry = candidate(item, project, product.code || item.off_code!, "missing_fields", fields, product);
    const key = `${project}:${entry.code}`;
    if (!seen.has(key) || seen.get(key)!.score < entry.score) seen.set(key, entry);
  }

  const result = [...seen.values()].sort((a, b) => b.score - a.score || a.itemName.localeCompare(b.itemName));
  const prices = await priceCandidates(houseId, limit);
  for (const price of prices) {
    if (result.length >= limit) break;
    if (!result.some((entry) => entry.id === price.id)) result.push(price);
  }
  return result.slice(0, limit);
}
