import { all, get } from "../db.js";
import { convert } from "../units.js";
import { findProductAlias } from "./product-aliases.js";

/**
 * Decide which inventory item every receipt line goes to. The import and the
 * dry-run validation both call `planReceiptLines`, so the preview the user
 * sees is exactly what the import will do.
 */

const SIZE_TOKEN =
  /(?<![\p{L}\p{N}])\d+(?:[.,]\d+)?\s*(?:kg|g|gr|mg|l|lt|ml|cl|dl|pcs|pc|pack|packs|box|bag|bottle|can|jar|tub|roll|τεμ|τμχ|γρ|κιλ|λιτ|λτ)s?(?![\p{L}\p{N}])/gu;

/** Normalised word tokens: accents removed, Greek kept, pack sizes and bare numbers dropped. */
export function nameTokens(value: string): string[] {
  const text = String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ς/g, "σ")
    .replace(SIZE_TOKEN, " ");
  const tokens = text.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2 && !/^\d+$/.test(token));
  return [...new Set(tokens)];
}

/** Sørensen–Dice coefficient over token sets (0..1). */
export function tokenSimilarity(a: string, b: string): number {
  const left = nameTokens(a);
  const right = new Set(nameTokens(b));
  if (!left.length || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return (2 * shared) / (left.length + right.size);
}

/**
 * A fuzzy match needs nearly all words in common: "Sourdough rye bread" ↔
 * "Sourdough rye bread loaf" (0.86) matches, while "Oat milk" ↔ "Oat milk
 * chocolate" (0.8) and "Milk" ↔ "Milk chocolate" (0.67) do not. Anything
 * looser is left to the suggestions the user confirms.
 */
export const FUZZY_MATCH_THRESHOLD = 0.85;

function unitsCompatible(lineUnit: string | null, itemUnit: string): boolean {
  return !lineUnit || convert(1, lineUnit, itemUnit) != null;
}

/** Best fuzzy item for a description, or null when nothing is close enough or two items tie. */
export function bestFuzzyItem<T extends { name: string; unit: string }>(
  description: string,
  unit: string | null,
  candidates: T[],
): { item: T; score: number } | null {
  let best: { item: T; score: number } | null = null;
  let tie = false;
  for (const candidate of candidates) {
    if (!unitsCompatible(unit, candidate.unit)) continue;
    const score = tokenSimilarity(description, candidate.name);
    if (score < FUZZY_MATCH_THRESHOLD) continue;
    if (!best || score > best.score + 1e-9) {
      best = { item: candidate, score };
      tie = false;
    } else if (Math.abs(score - best.score) <= 1e-9) {
      tie = true;
    }
  }
  return best && !tie ? best : null;
}

export interface PlanLineInput {
  description: string;
  rawDescription?: string | null;
  unit?: string | null;
  itemId?: string | null;
  barcode?: string | null;
  locationId?: string | null;
}

export interface LinePlan {
  index: number;
  /** Existing item the line goes to (null when one will be created). */
  item: any | null;
  /** Lower-cased name of the item this line creates or shares with an earlier new line. */
  createKey: string | null;
  willCreate: boolean;
  match: "chosen" | "alias" | "barcode" | "name" | "fuzzy" | "new";
  /** Only user-confirmed or newly created links teach a product alias. */
  learn: boolean;
  unit: string | null;
  /** Unit the target item is (or will be) stocked in. */
  itemUnit: string;
  itemName: string;
  error: string | null;
}

export function newItemKey(description: string): string {
  return description.replace(/\s+/g, " ").trim().slice(0, 120).toLowerCase();
}

export async function planReceiptLines(
  houseId: string,
  vendorId: string | null,
  lines: PlanLineInput[],
): Promise<LinePlan[]> {
  let candidates: any[] | null = null;
  const loadCandidates = async () =>
    (candidates ??= await all<any>("SELECT * FROM items WHERE house_id = ? AND archived = 0", [houseId]));
  const pending = new Map<string, { unit: string; name: string }>();
  const locationOk = new Map<string, boolean>();
  const plans: LinePlan[] = [];

  for (const [index, line] of lines.entries()) {
    const unit = line.unit ? line.unit.toLowerCase() : null;
    const rawDescription = line.rawDescription ?? line.description;
    let item: any | null = null;
    let match: LinePlan["match"] = "new";
    let learn = false;
    let error: string | null = null;
    let createKey: string | null = null;
    let willCreate = false;

    if (line.itemId) {
      item = await get<any>("SELECT * FROM items WHERE id = ? AND house_id = ?", [line.itemId, houseId]);
      match = "chosen";
      learn = true;
      if (!item) error = "The chosen item is not in this house";
    } else {
      const alias = rawDescription ? await findProductAlias(houseId, vendorId, rawDescription) : null;
      if (alias) {
        item = alias.item;
        match = "alias";
      }
      if (!item && line.barcode) {
        item = await get<any>(
          `SELECT i.* FROM items i JOIN item_barcodes b ON b.item_id = i.id WHERE i.house_id = ? AND b.code = ?`,
          [houseId, line.barcode],
        );
        if (item) match = "barcode";
      }
      if (!item) {
        item = await get<any>("SELECT * FROM items WHERE house_id = ? AND archived = 0 AND LOWER(name) = LOWER(?)", [
          houseId,
          line.description,
        ]);
        if (item) match = "name";
      }
      if (!item) {
        const key = newItemKey(line.description);
        const created = pending.get(key);
        if (created) {
          // A second line for a product this receipt is already creating.
          createKey = key;
          learn = true;
        } else {
          const fuzzy = bestFuzzyItem(line.description, unit, await loadCandidates());
          if (fuzzy) {
            item = fuzzy.item;
            match = "fuzzy";
          } else {
            createKey = key;
            willCreate = true;
            learn = true;
            pending.set(key, { unit: (unit ?? "pcs").slice(0, 10), name: line.description.replace(/\s+/g, " ").trim().slice(0, 120) });
          }
        }
      }
    }

    const target = item ? { unit: String(item.unit), name: String(item.name) } : createKey ? pending.get(createKey)! : null;
    if (!error && target) {
      const fromUnit = unit ?? target.unit;
      if (convert(1, fromUnit, target.unit) == null) {
        error = `Cannot add “${line.description}” in ${fromUnit} to an item stocked in ${target.unit}. Pick another unit or item.`;
      }
    }
    if (!error && line.locationId) {
      if (!locationOk.has(line.locationId)) {
        locationOk.set(
          line.locationId,
          Boolean(await get("SELECT id FROM locations WHERE id = ? AND house_id = ?", [line.locationId, houseId])),
        );
      }
      if (!locationOk.get(line.locationId)) error = "The chosen place is not in this house";
    }

    plans.push({
      index,
      item,
      createKey,
      willCreate,
      match,
      learn,
      unit,
      itemUnit: target?.unit ?? (unit ?? "pcs"),
      itemName: target?.name ?? line.description,
      error,
    });
  }
  return plans;
}
