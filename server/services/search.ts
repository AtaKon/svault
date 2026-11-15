import { all } from "../db.js";
import { normaliseText } from "../../shared/recipe-vision-score.js";
import type { SearchGroup, SearchHit, SearchResponse, SearchType } from "../../shared/types.js";

/**
 * Global search across the five inventory-adjacent record types.
 *
 * Matching is a literal substring test on text folded by the same helper the
 * recipe scorer uses: lowercase, Greek tonos stripped and final sigma folded.
 * The folding happens in the app rather than in SQL because SQLite's `lower()`
 * is ASCII-only while PostgreSQL folds Greek, so a `LIKE` would disagree
 * between the two backends. Folding the row text as well makes `%` and `_`
 * ordinary characters instead of wildcards.
 *
 * Households are small, so each type is scanned from a bounded window ordered by
 * recency (items by last change, the rest by creation/purchase date). The cap
 * keeps a single search cheap even for a long-lived house.
 */
export const SEARCH_TYPES: SearchType[] = ["items", "recipes", "receipts", "bills", "shops"];

const SCAN_LIMITS: Record<SearchType, number> = {
  items: 1500,
  recipes: 500,
  receipts: 400,
  bills: 400,
  shops: 300,
};

interface Candidate {
  hit: SearchHit;
  haystack: string;
  recency: string;
}

function makeHit(
  type: SearchType,
  id: string,
  title: string,
  subtitle: string | null,
  route: string,
): SearchHit {
  return { type, id, title, subtitle, route };
}

function score(needle: string, candidate: Candidate): number {
  const title = normaliseText(candidate.hit.title);
  if (title === needle) return 100;
  if (title.startsWith(needle)) return 80;
  if (title.includes(needle)) return 60;
  if (normaliseText(candidate.haystack).includes(needle)) return 30;
  return 0;
}

function ranked(needle: string, candidates: Candidate[], limit: number): SearchHit[] {
  return candidates
    .map((candidate) => ({ candidate, score: score(needle, candidate) }))
    .filter((entry) => entry.score > 0 && normaliseText(entry.candidate.hit.title))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.candidate.recency !== left.candidate.recency) {
        return right.candidate.recency.localeCompare(left.candidate.recency);
      }
      return left.candidate.hit.title.localeCompare(right.candidate.hit.title);
    })
    .slice(0, limit)
    .map((entry) => entry.candidate.hit);
}

/* ---------------------------------------------------------------------- items */

async function itemCandidates(houseId: string): Promise<Candidate[]> {
  const rows = await all<any>(
    `SELECT i.id, i.name, i.brand, i.description, i.tags, i.unit, i.updated_at,
       c.name AS category_name,
       (SELECT COALESCE(SUM(l.quantity), 0) FROM stock_lots l WHERE l.item_id = i.id) AS quantity
     FROM items i
     LEFT JOIN categories c ON c.id = i.category_id
     WHERE i.house_id = ? AND i.archived = 0
     ORDER BY i.updated_at DESC
     LIMIT ?`,
    [houseId, SCAN_LIMITS.items],
  );
  const codes = new Map<string, string[]>();
  for (const row of await all<any>("SELECT item_id, code FROM item_barcodes WHERE house_id = ?", [houseId])) {
    const list = codes.get(row.item_id) ?? [];
    list.push(String(row.code));
    codes.set(row.item_id, list);
  }
  return rows.map((row) => {
    const barcodes = codes.get(row.id) ?? [];
    const subtitle = [
      row.brand ?? null,
      row.category_name ?? null,
      row.quantity == null ? null : `${Number(row.quantity)} ${row.unit ?? "pcs"}`,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      hit: makeHit("items", row.id, row.name, subtitle || null, `/items/${row.id}`),
      haystack: [row.name, row.brand, row.description, row.tags, row.unit, ...barcodes]
        .filter(Boolean)
        .join(" "),
      recency: row.updated_at ?? "",
    };
  });
}

/* -------------------------------------------------------------------- recipes */

async function recipeCandidates(houseId: string): Promise<Candidate[]> {
  const rows = await all<any>(
    `SELECT id, title, description, tags, prep_minutes, cook_minutes, updated_at
     FROM recipes WHERE house_id = ? ORDER BY updated_at DESC LIMIT ?`,
    [houseId, SCAN_LIMITS.recipes],
  );
  return rows.map((row) => {
    const minutes = Number(row.prep_minutes ?? 0) + Number(row.cook_minutes ?? 0);
    let tags: string[] = [];
    try {
      tags = Array.isArray(JSON.parse(row.tags ?? "[]")) ? JSON.parse(row.tags ?? "[]") : [];
    } catch {
      tags = [];
    }
    const subtitle = [tags.slice(0, 3).join(", ") || null, minutes > 0 ? `${minutes} min` : null]
      .filter(Boolean)
      .join(" · ");
    return {
      hit: makeHit("recipes", row.id, row.title, subtitle || null, `/recipes/${row.id}`),
      haystack: [row.title, row.description, row.tags].filter(Boolean).join(" "),
      recency: row.updated_at ?? "",
    };
  });
}

/* ------------------------------------------------------------------- receipts */

async function receiptCandidates(houseId: string): Promise<Candidate[]> {
  const rows = await all<any>(
    `SELECT r.id, COALESCE(v.name, r.vendor_name) AS vendor_name, r.purchased_at, r.total, r.currency,
       r.notes, r.created_at,
       (SELECT COUNT(*) FROM receipt_lines rl WHERE rl.receipt_id = r.id) AS line_count
     FROM receipts r LEFT JOIN vendors v ON v.id = r.vendor_id
     WHERE r.house_id = ?
     ORDER BY COALESCE(r.purchased_at, r.created_at) DESC
     LIMIT ?`,
    [houseId, SCAN_LIMITS.receipts],
  );
  if (!rows.length) return [];
  const ids = rows.map((row) => String(row.id));
  const descriptions = new Map<string, string[]>();
  const placeholders = ids.map(() => "?").join(", ");
  for (const line of await all<any>(
    `SELECT receipt_id, description FROM receipt_lines WHERE receipt_id IN (${placeholders})`,
    ids,
  )) {
    const list = descriptions.get(line.receipt_id) ?? [];
    list.push(String(line.description));
    descriptions.set(line.receipt_id, list);
  }
  return rows.map((row) => {
    const title = row.vendor_name || row.purchased_at || `#${String(row.id).slice(-6)}`;
    const subtitle = [
      row.purchased_at ?? null,
      row.total == null ? null : `${Number(row.total).toFixed(2)} ${row.currency ?? ""}`.trim(),
      Number(row.line_count ?? 0) > 0 ? `${Number(row.line_count)} lines` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      hit: makeHit("receipts", row.id, title, subtitle || null, "/receipts"),
      haystack: [row.vendor_name, row.notes, ...(descriptions.get(row.id) ?? [])].filter(Boolean).join(" "),
      recency: row.purchased_at ?? row.created_at ?? "",
    };
  });
}

/* ---------------------------------------------------------------------- bills */

async function billCandidates(houseId: string): Promise<Candidate[]> {
  const rows = await all<any>(
    `SELECT id, name, bill_type, amount, currency, due_date, notes, created_at
     FROM bills WHERE house_id = ? ORDER BY created_at DESC LIMIT ?`,
    [houseId, SCAN_LIMITS.bills],
  );
  return rows.map((row) => {
    const subtitle = [
      `${Number(row.amount ?? 0).toFixed(2)} ${row.currency ?? ""}`.trim(),
      row.due_date ?? null,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      hit: makeHit("bills", row.id, row.name, subtitle || null, "/bills"),
      haystack: [row.name, row.bill_type, row.notes, row.due_date].filter(Boolean).join(" "),
      recency: row.created_at ?? "",
    };
  });
}

/* ---------------------------------------------------------------------- shops */

async function shopCandidates(houseId: string): Promise<Candidate[]> {
  const rows = await all<any>(
    `SELECT v.id, v.name, v.kind, v.note, v.created_at,
       (SELECT COUNT(*) FROM stock_lots l WHERE l.vendor_id = v.id) AS purchases
     FROM vendors v WHERE v.house_id = ?
     ORDER BY lower(v.name) LIMIT ?`,
    [houseId, SCAN_LIMITS.shops],
  );
  return rows.map((row) => {
    const subtitle = [row.kind ?? null, row.note ?? null].filter(Boolean).join(" · ");
    return {
      hit: makeHit("shops", row.id, row.name, subtitle || null, "/receipts"),
      haystack: [row.name, row.note, row.kind].filter(Boolean).join(" "),
      recency: row.created_at ?? "",
    };
  });
}

const LOADERS: Record<SearchType, (houseId: string) => Promise<Candidate[]>> = {
  items: itemCandidates,
  recipes: recipeCandidates,
  receipts: receiptCandidates,
  bills: billCandidates,
  shops: shopCandidates,
};

/**
 * Run one search. Callers must have already authorised the house; every loader
 * filters on `house_id`, so another house's rows can never leak into the result.
 */
export async function searchHouse(
  houseId: string,
  rawQuery: string,
  types: SearchType[],
  perTypeLimit: number,
): Promise<SearchResponse> {
  const query = rawQuery.trim();
  const needle = normaliseText(query);
  const groups: SearchGroup[] = [];
  let total = 0;
  if (needle) {
    for (const type of types) {
      const hits = ranked(needle, await LOADERS[type](houseId), perTypeLimit);
      if (!hits.length) continue;
      groups.push({ type, hits });
      total += hits.length;
    }
  }
  return { query, groups, total };
}
