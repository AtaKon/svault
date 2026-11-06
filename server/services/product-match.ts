import { all } from "../db.js";
import { normalizeVendorName } from "./vendors.js";
import { productAliasKey } from "./product-aliases.js";

/**
 * Lightweight local product matching. It combines:
 *  - exact learned aliases
 *  - folded Greek/Latin text (OCR often mixes scripts)
 *  - cosine similarity over hashed character trigrams
 *  - token Jaccard similarity
 *
 * No model download or external embedding service is needed. The vectors are
 * deterministic and computed on demand; the catalogue is small enough that
 * this stays fast for a household inventory.
 */

const DIMENSIONS = 256;

const GREEK_FOLD: Record<string, string> = {
  α: "a",
  β: "v",
  γ: "g",
  δ: "d",
  ε: "e",
  ζ: "z",
  η: "i",
  θ: "th",
  ι: "i",
  κ: "k",
  λ: "l",
  μ: "m",
  ν: "n",
  ξ: "x",
  ο: "o",
  π: "p",
  ρ: "r",
  σ: "s",
  τ: "t",
  υ: "y",
  φ: "f",
  χ: "ch",
  ψ: "ps",
  ω: "o",
};

function fold(value: string): string {
  const normalized = normalizeVendorName(value);
  let out = "";
  for (const character of normalized) out += GREEK_FOLD[character] ?? character;
  return out
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|g|gr|mg|l|lt|ml|cl|dl|pcs|pc|pack|packs|box|bag|bottle|can|jar|tub|roll|τεμ|φετ|κιλ|γρ|λιτ)\b/g, " ")
    .replace(/\b(?:lidl|plus|discount|offer|προσφορα|εκπτωση)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function charGrams(text: string): string[] {
  const padded = ` ${text} `;
  const grams: string[] = [];
  for (let index = 0; index < padded.length - 2; index++) grams.push(padded.slice(index, index + 3));
  return grams;
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function vectorize(text: string): Float64Array {
  const vector = new Float64Array(DIMENSIONS);
  for (const gram of charGrams(text)) vector[hash(gram) % DIMENSIONS] += 1;
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let index = 0; index < vector.length; index++) vector[index] /= norm;
  return vector;
}

function cosine(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let index = 0; index < a.length; index++) sum += a[index] * b[index];
  return sum;
}

function tokenSet(text: string): Set<string> {
  return new Set(text.split(" ").filter((token) => token.length >= 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function similarity(a: string, b: string): number {
  const foldedA = fold(a);
  const foldedB = fold(b);
  if (!foldedA || !foldedB) return 0;
  if (foldedA === foldedB) return 1;
  const vectorScore = cosine(vectorize(foldedA), vectorize(foldedB));
  const tokenScore = jaccard(tokenSet(foldedA), tokenSet(foldedB));
  const containment = foldedA.includes(foldedB) || foldedB.includes(foldedA) ? 1 : 0;
  return Math.min(1, vectorScore * 0.65 + tokenScore * 0.25 + containment * 0.1);
}

export interface ProductSuggestion {
  itemId: string;
  itemName: string;
  unit: string;
  categoryId: string | null;
  score: number;
  source: "alias" | "name" | "vector";
}

interface CandidateText {
  text: string;
  source: "alias" | "name" | "vector";
  vendorSpecific: boolean;
}

export async function suggestProductMatches(
  houseId: string,
  vendorId: string | null | undefined,
  rawDescription: string,
  limit = 3,
): Promise<ProductSuggestion[]> {
  const raw = String(rawDescription ?? "").trim();
  if (raw.length < 2) return [];
  const rawKey = productAliasKey(raw);

  const items = await all<any>("SELECT id, name, brand, unit, category_id FROM items WHERE house_id = ? AND archived = 0", [
    houseId,
  ]);
  const aliases = await all<any>(
    "SELECT item_id, vendor_key, raw_key, raw_text FROM product_aliases WHERE house_id = ? AND (vendor_key = ? OR vendor_key = '')",
    [houseId, vendorId ?? ""],
  );

  const byItem = new Map<string, { item: any; texts: CandidateText[] }>();
  for (const item of items) {
    const entry = { item, texts: [] as CandidateText[] };
    entry.texts.push({ text: String(item.name ?? ""), source: "name", vendorSpecific: false });
    if (item.brand) entry.texts.push({ text: String(item.brand), source: "name", vendorSpecific: false });
    byItem.set(item.id, entry);
  }
  for (const alias of aliases) {
    const entry = byItem.get(alias.item_id);
    if (!entry) continue;
    entry.texts.push({
      text: String(alias.raw_text ?? alias.raw_key ?? ""),
      source: "alias",
      vendorSpecific: Boolean(vendorId) && alias.vendor_key === vendorId,
    });
  }

  const ranked: ProductSuggestion[] = [];
  for (const { item, texts } of byItem.values()) {
    let best: { score: number; source: ProductSuggestion["source"] } = { score: 0, source: "vector" };
    for (const candidate of texts) {
      if (!candidate.text) continue;
      let score = similarity(raw, candidate.text);
      if (candidate.source === "alias" && productAliasKey(candidate.text) === rawKey) score = 1;
      else if (candidate.source === "alias") score += 0.04;
      else if (productAliasKey(candidate.text) === rawKey) score = Math.max(score, 0.96);
      if (candidate.vendorSpecific) score += 0.02;
      score = Math.min(1, score);
      if (score > best.score) best = { score, source: candidate.source };
    }
    if (best.score >= 0.32) {
      ranked.push({
        itemId: item.id,
        itemName: item.name,
        unit: item.unit,
        categoryId: item.category_id ?? null,
        score: Math.round(best.score * 1000) / 1000,
        source: best.source,
      });
    }
  }

  return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
}
