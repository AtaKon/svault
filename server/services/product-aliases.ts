import { get, newId, now, run } from "../db.js";
import { normalizeVendorName } from "./vendors.js";

/** Stable key for a receipt line description, ignoring case, accents and punctuation. */
export function productAliasKey(value: string): string {
  return normalizeVendorName(
    String(value ?? "")
      .replace(/\s+-?\d{6,}\s*$/, "") // trailing article codes should not break matching
      .replace(/\s{2,}/g, " ")
      .trim(),
  );
}

export interface ProductAliasMatch {
  item: any;
  alias: {
    id: string;
    unit: string | null;
    category_id: string | null;
    attributes: string;
    uses: number;
  };
}

/**
 * Resolve a raw receipt line. A vendor-specific alias wins over an
 * all-vendor alias; both are learned from previous imports/corrections.
 */
export async function findProductAlias(
  houseId: string,
  vendorId: string | null | undefined,
  rawDescription: string,
): Promise<ProductAliasMatch | null> {
  const key = productAliasKey(rawDescription);
  if (!key) return null;
  const row = vendorId
    ? await get<any>("SELECT * FROM product_aliases WHERE house_id = ? AND vendor_key = ? AND raw_key = ?", [
        houseId,
        vendorId,
        key,
      ])
    : null;
  const fallback =
    row ??
    await get<any>("SELECT * FROM product_aliases WHERE house_id = ? AND vendor_key = '' AND raw_key = ?", [houseId, key]);
  if (!fallback?.item_id) return null;
  const item = await get<any>("SELECT * FROM items WHERE id = ? AND house_id = ? AND archived = 0", [fallback.item_id, houseId]);
  if (!item) return null;
  return { item, alias: fallback };
}

/** Remember (or correct) the item behind a raw receipt line. */
export async function learnProductAlias(opts: {
  houseId: string;
  vendorId: string | null | undefined;
  rawDescription: string;
  item: any;
}) {
  const key = productAliasKey(opts.rawDescription);
  if (!key || key.length < 2 || !opts.item?.id) return;
  await run(
    `INSERT INTO product_aliases
      (id, house_id, vendor_key, raw_key, raw_text, item_id, unit, category_id, attributes, uses, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(house_id, vendor_key, raw_key) DO UPDATE SET
       raw_text = excluded.raw_text,
       item_id = excluded.item_id,
       unit = excluded.unit,
       category_id = excluded.category_id,
       attributes = excluded.attributes,
       uses = product_aliases.uses + 1,
       updated_at = excluded.updated_at`,
    [
      newId("pal"),
      opts.houseId,
      opts.vendorId ?? "",
      key,
      opts.rawDescription.trim().slice(0, 200),
      opts.item.id,
      opts.item.unit ?? null,
      opts.item.category_id ?? null,
      opts.item.attributes ?? "{}",
      now(),
      now(),
    ],
  );
}
