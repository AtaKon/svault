import { all, get, newId, now, run } from "../db.js";
import { ApiError } from "../http.js";
import { compatible, convert, round, unitKind } from "../units.js";
import type { DuplicateGroup, DuplicateItem, DuplicatePair, DuplicateReason } from "../../shared/types.js";

/**
 * Deterministic duplicate detection. No AI, no fuzzy external service: names
 * are folded (case, diacritics, Greek accents, punctuation), unit tokens are
 * canonicalised, and comparisons only happen inside small buckets so a house
 * with a few thousand items stays fast.
 */

/* ------------------------------------------------------------ normalisation */

const UNIT_ALIASES: Record<string, string> = {
  // mass
  mg: "mg",
  mgr: "mg",
  γρ: "g",
  γραμμ: "g",
  γραμμαρια: "g",
  gr: "g",
  gram: "g",
  grams: "g",
  g: "g",
  kg: "kg",
  kgs: "kg",
  kilo: "kg",
  kilos: "kg",
  kilogram: "kg",
  kilograms: "kg",
  κιλ: "kg",
  κιλα: "kg",
  κιλο: "kg",
  κιλου: "kg",
  // volume
  ml: "ml",
  mls: "ml",
  mltr: "ml",
  μλ: "ml",
  cl: "cl",
  dl: "dl",
  l: "l",
  lt: "l",
  ltr: "l",
  lts: "l",
  litre: "l",
  litres: "l",
  liter: "l",
  liters: "l",
  λιτρ: "l",
  λιτρα: "l",
  λιτρο: "l",
  λιτρου: "l",
  // count
  pcs: "pcs",
  pc: "pcs",
  piece: "pcs",
  pieces: "pcs",
  τεμ: "pcs",
  τεμαχια: "pcs",
  τεμαχιο: "pcs",
  pack: "pack",
  packs: "pack",
  πακετο: "pack",
  πακετα: "pack",
  box: "box",
  boxes: "box",
  κουτι: "box",
  κουτια: "box",
  bottle: "bottle",
  bottles: "bottle",
  μπουκαλι: "bottle",
  μπουκαλια: "bottle",
  can: "can",
  cans: "can",
  κονσερβα: "can",
  jar: "jar",
  jars: "jar",
  βαζο: "jar",
};

// Longest aliases first so "κιλα" wins over "κιλ" and "grams" over "g".
const UNIT_PATTERN = new RegExp(
  `(\\d+(?:\\.\\d+)?)\\s*(${Object.keys(UNIT_ALIASES)
    .sort((a, b) => b.length - a.length)
    .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})(?![a-z0-9\\u0370-\\u03ff])`,
  "g",
);

export interface NormalizedName {
  /** Folded name with canonical unit tokens, e.g. "milk 1.5l". */
  key: string;
  /** Significant words without the quantity/unit token. */
  tokens: string[];
  /** Canonical unit found in the name, if any. */
  unit: string | null;
  /** Quantity found next to the unit, if any. */
  amount: number | null;
}

/** Fold case, diacritics (tonos included), final sigma and punctuation. */
export function foldItemText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ς/g, "σ")
    .toLowerCase()
    .replace(/(\d),(\d)/g, "$1.$2");
}

/**
 * Turn a product name into a comparison key. Unit spellings and decimal
 * commas collapse to one form so "Milk 1L", "MILK 1 l" and "Γάλα 1,5 λίτρα"
 * compare on the same footing.
 */
export function normalizeItemName(name: string): NormalizedName {
  const folded = foldItemText(name);
  let unit: string | null = null;
  let amount: number | null = null;
  const replaced = folded.replace(UNIT_PATTERN, (_match, quantity: string, alias: string) => {
    const canonical = UNIT_ALIASES[alias] ?? alias;
    const number = Number(quantity);
    if (unit === null) {
      unit = canonical;
      amount = Number.isFinite(number) ? number : null;
    }
    const formatted = Number.isFinite(number) ? String(round(number, 3)) : quantity;
    return ` ${formatted}${canonical} `;
  });
  const tokens = replaced
    .split(/[^a-z0-9\u0370-\u03ff]+/)
    .filter(Boolean)
    .filter((token) => !/^\d/.test(token));
  const key = replaced.split(/[^a-z0-9\u0370-\u03ff.]+/).filter(Boolean).join(" ");
  return { key, tokens, unit, amount };
}

/** Bounded Levenshtein distance, useful for typo-level name differences. */
function editDistance(a: string, b: string, limit = 4): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > limit) return limit + 1;
    for (let j = 0; j <= b.length; j++) previous[j] = current[j];
  }
  return previous[b.length];
}

function overlap(a: string[], b: string[]): { shared: number; union: number; containment: number } {
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  const union = setA.size + setB.size - shared;
  return { shared, union, containment: Math.min(setA.size, setB.size) ? shared / Math.min(setA.size, setB.size) : 0 };
}

/**
 * 0..1 name similarity. A shorter name contained in a longer one ("milk" vs
 * "fresh milk") counts as a near match; otherwise word overlap and edit
 * distance decide. The caller combines this with brand, barcode and unit
 * signals before calling anything a duplicate.
 */
export function itemNameSimilarity(a: NormalizedName, b: NormalizedName): number {
  if (!a.tokens.length || !b.tokens.length) return a.key === b.key ? 1 : 0;
  const { shared, union, containment } = overlap(a.tokens, b.tokens);
  const jaccard = union ? shared / union : 0;
  const sharedLength = [...new Set(a.tokens)].filter((token) => b.tokens.includes(token));
  const longestShared = sharedLength.reduce((max, token) => Math.max(max, token.length), 0);
  // Containment is only meaningful when the shared word is distinctive.
  const containmentScore = containment >= 1 && longestShared >= 3 ? 0.95 * containment : 0;
  const compactA = a.tokens.join("");
  const compactB = b.tokens.join("");
  const distance = editDistance(compactA, compactB);
  const editScore = distance <= 2 ? 1 - distance / Math.max(compactA.length, compactB.length) : 0;
  return Math.max(jaccard * 0.9, containmentScore, editScore * 0.9);
}

/* ------------------------------------------------------------- suggestions */

interface ItemRow {
  id: string;
  name: string;
  brand: string | null;
  unit: string;
  off_code: string | null;
  off_project: string | null;
  created_at: string;
  quantity: number;
}

const MIN_CONFIDENCE = 0.6;
/** Per-bucket comparison cap; buckets are already narrowed by a shared token. */
const BUCKET_LIMIT = 60;

interface Candidate {
  item: ItemRow;
  normalized: NormalizedName;
  brandKey: string;
  barcodes: string[];
}

/** The minimum an item needs for the deterministic signals. */
export interface DuplicateSignalInput {
  name: string;
  brand: string | null;
  unit: string;
  barcodes: string[];
  offCode: string | null;
  offProject: string | null;
}

export interface DuplicateSignals {
  confidence: number;
  reasons: DuplicateReason[];
}

function brandKeyOf(brand: string | null): string {
  return brand ? foldItemText(brand).replace(/[^a-z0-9\u0370-\u03ff]+/g, " ").trim() : "";
}

/** Compare pack sizes in one base unit per family, so 1 l and 1000 ml agree. */
function baseAmount(normalized: NormalizedName): number | null {
  if (normalized.amount == null || !normalized.unit) return null;
  const kind = unitKind(normalized.unit);
  if (!kind) return null;
  const base = kind === "mass" ? "g" : kind === "volume" ? "ml" : "pcs";
  return convert(normalized.amount, normalized.unit, base);
}

/**
 * Score one pair from the cheap deterministic signals. Exported so the
 * normalisation and confidence rules can be tested without a database.
 */
export function duplicateSignals(a: DuplicateSignalInput, b: DuplicateSignalInput): DuplicateSignals | null {
  const reasons: DuplicateReason[] = [];
  const sharedBarcode = a.barcodes.some((code) => b.barcodes.includes(code));
  if (sharedBarcode) reasons.push("shared_barcode");

  const sameOff =
    Boolean(a.offCode) &&
    a.offCode === b.offCode &&
    (a.offProject ?? "off") === (b.offProject ?? "off");
  if (sameOff) reasons.push("same_product_link");

  let score = 0;
  if (sharedBarcode) score = Math.max(score, 0.98);
  if (sameOff) score = Math.max(score, 0.96);

  const normalizedA = normalizeItemName(a.name);
  const normalizedB = normalizeItemName(b.name);
  const sameName = normalizedA.key === normalizedB.key;
  const similarity = itemNameSimilarity(normalizedA, normalizedB);
  if (sameName) {
    reasons.push("same_name");
    score = Math.max(score, 0.9);
  } else if (similarity >= 0.66) {
    reasons.push("similar_name");
    score = Math.max(score, 0.58 + similarity * 0.28);
  }

  const brandA = brandKeyOf(a.brand);
  const brandB = brandKeyOf(b.brand);
  const sameBrand = Boolean(brandA) && brandA === brandB;
  if (sameBrand && similarity >= 0.5) {
    reasons.push("same_brand");
    score = Math.max(score, 0.7);
  }

  const unitsCompatible = compatible(a.unit, b.unit);
  if (unitsCompatible) {
    if (a.unit !== b.unit) reasons.push("compatible_units");
    score = Math.min(0.99, score + 0.02);
  } else {
    // Same-looking names in different unit families are much more likely to be
    // different products (a bottle of milk vs a litre of milk).
    score *= 0.85;
  }

  // Two pack sizes of the same product (milk 1 l vs milk 2 l) are not a
  // duplicate. Strong signals such as a barcode or product link still win.
  const amountA = baseAmount(normalizedA);
  const amountB = baseAmount(normalizedB);
  if (amountA != null && amountB != null && Math.abs(amountA - amountB) > 1e-6 && score < 0.9) {
    score *= 0.6;
  }

  if (score < MIN_CONFIDENCE || reasons.length === 0) return null;
  // A reason list with only "compatible units" is not evidence on its own.
  if (reasons.every((reason) => reason === "compatible_units")) return null;
  return { confidence: round(score, 2), reasons };
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function duplicateItem(item: ItemRow, barcodes: string[]): DuplicateItem {
  return {
    id: item.id,
    name: item.name,
    brand: item.brand,
    unit: item.unit,
    quantity: round(Number(item.quantity ?? 0)),
    archived: false,
    barcodes,
    offCode: item.off_code,
    createdAt: item.created_at,
  };
}

/** All "not a duplicate" pairs for a house, in canonical order. */
export async function dismissedPairs(houseId: string): Promise<Set<string>> {
  const rows = await all<{ item_a: string; item_b: string }>(
    "SELECT item_a, item_b FROM item_duplicate_dismissals WHERE house_id = ?",
    [houseId],
  );
  return new Set(rows.map((row) => `${row.item_a}|${row.item_b}`));
}

interface ScoredPair extends DuplicatePair {
  /** Signal strength before the group's confidence is ranked. */
  score: number;
}

function scorePair(a: Candidate, b: Candidate): ScoredPair | null {
  const signals = duplicateSignals(
    {
      name: a.item.name,
      brand: a.item.brand,
      unit: a.item.unit,
      barcodes: a.barcodes,
      offCode: a.item.off_code,
      offProject: a.item.off_project,
    },
    {
      name: b.item.name,
      brand: b.item.brand,
      unit: b.item.unit,
      barcodes: b.barcodes,
      offCode: b.item.off_code,
      offProject: b.item.off_project,
    },
  );
  if (!signals) return null;
  return {
    a: a.item.id,
    b: b.item.id,
    confidence: signals.confidence,
    reasons: signals.reasons,
    score: signals.confidence,
  };
}

/**
 * Rank candidate duplicate groups for a house.
 *
 * Items are bucketed by barcode, OpenFoodFacts link, normalised name, each
 * significant word and brand. Only pairs inside a bucket are scored, so the
 * work grows with the buckets rather than with the square of the inventory.
 */
export async function findDuplicateGroups(
  houseId: string,
  options: { limit?: number } = {},
): Promise<{ groups: DuplicateGroup[]; scannedItems: number }> {
  const rows = await all<ItemRow>(
    `SELECT i.id, i.name, i.brand, i.unit, i.off_code, i.off_project, i.created_at,
       COALESCE((SELECT SUM(l.quantity) FROM stock_lots l WHERE l.item_id = i.id), 0) AS quantity
     FROM items i
     WHERE i.house_id = ? AND i.archived = 0 AND (i.merged_into IS NULL OR i.merged_into = '')
     ORDER BY i.created_at`,
    [houseId],
  );
  if (rows.length < 2) return { groups: [], scannedItems: rows.length };

  const barcodeRows = await all<{ item_id: string; code: string }>(
    "SELECT item_id, code FROM item_barcodes WHERE house_id = ?",
    [houseId],
  );
  const barcodeMap = new Map<string, string[]>();
  for (const row of barcodeRows) {
    const list = barcodeMap.get(row.item_id) ?? [];
    list.push(row.code);
    barcodeMap.set(row.item_id, list);
  }

  const candidates = new Map<string, Candidate>();
  for (const row of rows) {
    const normalized = normalizeItemName(row.name);
    candidates.set(row.id, {
      item: row,
      normalized,
      brandKey: row.brand ? foldItemText(row.brand).replace(/[^a-z0-9\u0370-\u03ff]+/g, " ").trim() : "",
      barcodes: barcodeMap.get(row.id) ?? [],
    });
  }

  const buckets = new Map<string, Candidate[]>();
  const push = (key: string, candidate: Candidate) => {
    const list = buckets.get(key) ?? [];
    if (list.length >= BUCKET_LIMIT) return;
    list.push(candidate);
    buckets.set(key, list);
  };
  for (const candidate of candidates.values()) {
    const { item, normalized, brandKey } = candidate;
    for (const code of candidate.barcodes) push(`barcode:${code}`, candidate);
    if (item.off_code) push(`off:${item.off_project ?? "off"}:${item.off_code}`, candidate);
    if (normalized.key) push(`name:${normalized.key}`, candidate);
    for (const token of new Set(normalized.tokens)) {
      if (token.length >= 3) push(`token:${token}`, candidate);
    }
    if (brandKey) push(`brand:${brandKey}`, candidate);
  }

  const dismissed = await dismissedPairs(houseId);
  const scored = new Map<string, ScoredPair>();
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i];
        const b = bucket[j];
        if (a.item.id === b.item.id) continue;
        const key = pairKey(a.item.id, b.item.id);
        const [first, second] = canonicalPair(a.item.id, b.item.id);
        if (dismissed.has(`${first}|${second}`)) continue;
        const pair = scorePair(a, b);
        if (!pair) continue;
        const previous = scored.get(key);
        if (!previous || pair.score > previous.score) scored.set(key, pair);
      }
    }
  }

  // Group connected candidates with union-find, then rank by the strongest pair.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = parent.get(id) ?? id;
    while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root;
    return root;
  };
  const union = (a: string, b: string) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };
  for (const pair of scored.values()) union(pair.a, pair.b);

  const grouped = new Map<string, ScoredPair[]>();
  for (const pair of scored.values()) {
    const root = find(pair.a);
    const list = grouped.get(root) ?? [];
    list.push(pair);
    grouped.set(root, list);
  }

  const groups: DuplicateGroup[] = [];
  for (const pairs of grouped.values()) {
    const itemIds = [...new Set(pairs.flatMap((pair) => [pair.a, pair.b]))];
    const reasons = [...new Set(pairs.flatMap((pair) => pair.reasons))];
    const confidence = Math.max(...pairs.map((pair) => pair.confidence));
    groups.push({
      key: [...itemIds].sort()[0],
      confidence,
      reasons,
      items: itemIds
        .map((id) => candidates.get(id))
        .filter((candidate): candidate is Candidate => Boolean(candidate))
        .map((candidate) => duplicateItem(candidate.item, candidate.barcodes)),
      pairs: pairs.map(({ a, b, confidence: pairConfidence, reasons: pairReasons }) => ({
        a,
        b,
        confidence: pairConfidence,
        reasons: pairReasons,
      })),
    });
  }

  groups.sort((a, b) => b.confidence - a.confidence || b.items.length - a.items.length || a.key.localeCompare(b.key));
  const limit = Math.max(1, Math.min(options.limit ?? 60, 200));
  return { groups: groups.slice(0, limit), scannedItems: rows.length };
}

/** Persist "not a duplicate" for a pair. Idempotent; the pair is canonicalised. */
export async function dismissDuplicatePair(opts: {
  houseId: string;
  itemId: string;
  otherItemId: string;
  userId: string;
}): Promise<{ itemA: string; itemB: string }> {
  if (opts.itemId === opts.otherItemId) throw new ApiError(400, "Pick two different items");
  const [first, second] = canonicalPair(opts.itemId, opts.otherItemId);
  const found = await all<{ id: string }>("SELECT id FROM items WHERE house_id = ? AND id IN (?, ?)", [
    opts.houseId,
    first,
    second,
  ]);
  if (found.length !== 2) throw new ApiError(404, "Item not found");
  const exists = await get<{ id: string }>(
    "SELECT id FROM item_duplicate_dismissals WHERE house_id = ? AND item_a = ? AND item_b = ?",
    [opts.houseId, first, second],
  );
  if (!exists) {
    await run(
      `INSERT INTO item_duplicate_dismissals (id, house_id, item_a, item_b, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [newId("dup"), opts.houseId, first, second, opts.userId, now()],
    );
  }
  return { itemA: first, itemB: second };
}
