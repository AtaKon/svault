import { all } from "../db.js";
import { ApiError } from "../http.js";
import { serializeActivityEvent } from "../serialize.js";
import type { ActivityFeed, ActivityKind } from "../../shared/types.js";

/**
 * Read-only house timeline.
 *
 * There is no activity table and no new write path: every event is read from a
 * table that already stores an author and a timestamp. Each source is queried
 * separately with its own indexed, time-bounded `LIMIT`, then the small result
 * sets are merge-sorted in memory and cut to the requested page. That keeps the
 * cost at "page size per source" instead of scanning the house's history, on
 * both SQLite and PostgreSQL.
 *
 * Stable order: `occurred_at DESC`, then a source rank prefix plus the row id,
 * both descending. The cursor carries the last `(occurred_at, sort_key)` pair,
 * so entries sharing a timestamp page deterministically.
 */

export const ACTIVITY_KINDS: ActivityKind[] = [
  "stock.add",
  "stock.consume",
  "stock.waste",
  "stock.move",
  "stock.count",
  "receipt.saved",
  "item.created",
  "shopping.checked",
  "bill.saved",
];

const STOCK_TYPE_BY_KIND: Partial<Record<ActivityKind, string>> = {
  "stock.add": "in",
  "stock.consume": "out",
  "stock.waste": "waste",
  "stock.move": "move",
  "stock.count": "adjust",
};

export interface ActivityCursor {
  at: string;
  /** Null for a bare ISO `before` (strictly older than the timestamp). */
  key: string | null;
}

export interface ActivityQuery {
  houseId: string;
  limit: number;
  memberId: string | null;
  kinds: ActivityKind[] | null;
  itemId: string | null;
  locationId: string | null;
  from: string | null;
  to: string | null;
  cursor: ActivityCursor | null;
}

interface Source {
  sql: string;
  params: unknown[];
}

export function encodeActivityCursor(at: string, key: string): string {
  return Buffer.from(JSON.stringify({ at, key }), "utf8").toString("base64url");
}

/**
 * Accept either an opaque cursor from a previous page or a bare ISO timestamp.
 * A bare timestamp means "strictly older than this instant", which is handy for
 * links but cannot disambiguate rows saved in the same millisecond.
 */
export function decodeActivityCursor(raw: string | null | undefined): ActivityCursor | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const at = parseInstant(value);
    if (!at) throw new ApiError(400, "Invalid before timestamp");
    return { at, key: null };
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { at?: unknown; key?: unknown };
    if (typeof parsed.at !== "string" || typeof parsed.key !== "string") throw new Error("shape");
    const at = parseInstant(parsed.at);
    if (!at || !parsed.key) throw new Error("shape");
    return { at, key: parsed.key.slice(0, 200) };
  } catch {
    throw new ApiError(400, "Invalid activity cursor");
  }
}

function parseInstant(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** `from`/`to` accept a full ISO timestamp or a plain `YYYY-MM-DD` date. */
export function activityBound(value: string | null | undefined, endOfDay: boolean): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
  const at = parseInstant(text);
  if (!at) throw new ApiError(400, `Invalid ${endOfDay ? "to" : "from"} timestamp`);
  return at;
}

function timeClause(
  atExpression: string,
  keyExpression: string,
  cursor: ActivityCursor | null,
  from: string | null,
  to: string | null,
) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (from) {
    where.push(`${atExpression} >= ?`);
    params.push(from);
  }
  if (to) {
    where.push(`${atExpression} <= ?`);
    params.push(to);
  }
  if (cursor) {
    // Compare real columns, not the output aliases: PostgreSQL does not resolve
    // SELECT aliases in WHERE.
    if (cursor.key) {
      where.push(`(${atExpression} < ? OR (${atExpression} = ? AND ${keyExpression} < ?))`);
      params.push(cursor.at, cursor.at, cursor.key);
    } else {
      where.push(`${atExpression} < ?`);
      params.push(cursor.at);
    }
  }
  return { where, params };
}

function wants(query: ActivityQuery, kind: ActivityKind): boolean {
  return !query.kinds || query.kinds.includes(kind);
}

function stockSource(query: ActivityQuery): Source | null {
  const kinds = query.kinds?.filter((kind) => STOCK_TYPE_BY_KIND[kind]) ?? null;
  if (kinds && kinds.length === 0) return null;
  const types = kinds ? [...new Set(kinds.map((kind) => STOCK_TYPE_BY_KIND[kind]!))] : null;

  const where = ["m.house_id = ?"];
  const params: unknown[] = [query.houseId];
  if (types) {
    where.push(`m.type IN (${types.map(() => "?").join(", ")})`);
    params.push(...types);
  }
  if (query.memberId) {
    where.push("m.user_id = ?");
    params.push(query.memberId);
  }
  if (query.itemId) {
    where.push("m.item_id = ?");
    params.push(query.itemId);
  }
  if (query.locationId) {
    where.push("m.location_id = ?");
    params.push(query.locationId);
  }
  const range = timeClause("m.created_at", `'1:' || m.id`, query.cursor, query.from, query.to);
  where.push(...range.where);
  params.push(...range.params);

  return {
    sql: `
      SELECT
        CASE m.type
          WHEN 'in' THEN 'stock.add'
          WHEN 'out' THEN 'stock.consume'
          WHEN 'waste' THEN 'stock.waste'
          WHEN 'move' THEN 'stock.move'
          ELSE 'stock.count'
        END AS kind,
        m.created_at AS occurred_at,
        m.id AS source_id,
        '1:' || m.id AS sort_key,
        m.user_id AS actor_id,
        u.name AS actor_name,
        m.item_id AS item_id,
        i.name AS item_name,
        m.location_id AS location_id,
        l.name AS location_name,
        m.quantity AS quantity,
        m.unit AS unit,
        NULL AS amount,
        NULL AS currency,
        m.reason AS title,
        m.receipt_id AS receipt_id,
        NULL AS bill_id,
        NULL AS shopping_item_id
      FROM stock_movements m
      LEFT JOIN items i ON i.id = m.item_id AND i.house_id = m.house_id
      LEFT JOIN locations l ON l.id = m.location_id AND l.house_id = m.house_id
      LEFT JOIN house_members hm ON hm.house_id = m.house_id AND hm.user_id = m.user_id
      LEFT JOIN users u ON u.id = hm.user_id
      WHERE ${where.join(" AND ")}`,
    params,
  };
}

function receiptSource(query: ActivityQuery): Source | null {
  if (!wants(query, "receipt.saved")) return null;
  if (query.locationId) return null;

  const where = ["r.house_id = ?"];
  const params: unknown[] = [query.houseId];
  if (query.memberId) {
    where.push("r.created_by = ?");
    params.push(query.memberId);
  }
  if (query.itemId) {
    where.push("EXISTS (SELECT 1 FROM receipt_lines rl WHERE rl.receipt_id = r.id AND rl.item_id = ?)");
    params.push(query.itemId);
  }
  const range = timeClause("r.created_at", `'2:' || r.id`, query.cursor, query.from, query.to);
  where.push(...range.where);
  params.push(...range.params);

  return {
    sql: `
      SELECT
        'receipt.saved' AS kind,
        r.created_at AS occurred_at,
        r.id AS source_id,
        '2:' || r.id AS sort_key,
        r.created_by AS actor_id,
        u.name AS actor_name,
        NULL AS item_id,
        NULL AS item_name,
        NULL AS location_id,
        NULL AS location_name,
        NULL AS quantity,
        NULL AS unit,
        r.total AS amount,
        r.currency AS currency,
        COALESCE(v.name, r.vendor_name) AS title,
        r.id AS receipt_id,
        NULL AS bill_id,
        NULL AS shopping_item_id
      FROM receipts r
      LEFT JOIN vendors v ON v.id = r.vendor_id AND v.house_id = r.house_id
      LEFT JOIN house_members hm ON hm.house_id = r.house_id AND hm.user_id = r.created_by
      LEFT JOIN users u ON u.id = hm.user_id
      WHERE ${where.join(" AND ")}`,
    params,
  };
}

function itemSource(query: ActivityQuery): Source | null {
  if (!wants(query, "item.created")) return null;
  if (query.locationId) return null;

  const where = ["i.house_id = ?"];
  const params: unknown[] = [query.houseId];
  if (query.memberId) {
    where.push("i.created_by = ?");
    params.push(query.memberId);
  }
  if (query.itemId) {
    where.push("i.id = ?");
    params.push(query.itemId);
  }
  const range = timeClause("i.created_at", `'3:' || i.id`, query.cursor, query.from, query.to);
  where.push(...range.where);
  params.push(...range.params);

  return {
    sql: `
      SELECT
        'item.created' AS kind,
        i.created_at AS occurred_at,
        i.id AS source_id,
        '3:' || i.id AS sort_key,
        i.created_by AS actor_id,
        u.name AS actor_name,
        i.id AS item_id,
        i.name AS item_name,
        NULL AS location_id,
        NULL AS location_name,
        NULL AS quantity,
        NULL AS unit,
        NULL AS amount,
        NULL AS currency,
        NULL AS title,
        NULL AS receipt_id,
        NULL AS bill_id,
        NULL AS shopping_item_id
      FROM items i
      LEFT JOIN house_members hm ON hm.house_id = i.house_id AND hm.user_id = i.created_by
      LEFT JOIN users u ON u.id = hm.user_id
      WHERE ${where.join(" AND ")}`,
    params,
  };
}

/**
 * Checkoffs record when a line was ticked off but not who ticked it off, so the
 * event is shown with no actor instead of guessing from `created_by`.
 */
function shoppingSource(query: ActivityQuery): Source | null {
  if (!wants(query, "shopping.checked")) return null;
  if (query.locationId || query.memberId) return null;

  const where = ["s.house_id = ?", "s.checked = 1", "s.checked_at IS NOT NULL"];
  const params: unknown[] = [query.houseId];
  if (query.itemId) {
    where.push("s.item_id = ?");
    params.push(query.itemId);
  }
  const range = timeClause("s.checked_at", `'4:' || s.id`, query.cursor, query.from, query.to);
  where.push(...range.where);
  params.push(...range.params);

  return {
    sql: `
      SELECT
        'shopping.checked' AS kind,
        s.checked_at AS occurred_at,
        s.id AS source_id,
        '4:' || s.id AS sort_key,
        NULL AS actor_id,
        NULL AS actor_name,
        s.item_id AS item_id,
        i.name AS item_name,
        NULL AS location_id,
        NULL AS location_name,
        s.quantity AS quantity,
        s.unit AS unit,
        NULL AS amount,
        NULL AS currency,
        s.name AS title,
        NULL AS receipt_id,
        NULL AS bill_id,
        s.id AS shopping_item_id
      FROM shopping_list_items s
      LEFT JOIN items i ON i.id = s.item_id AND i.house_id = s.house_id
      WHERE ${where.join(" AND ")}`,
    params,
  };
}

function billSource(query: ActivityQuery): Source | null {
  if (!wants(query, "bill.saved")) return null;
  if (query.locationId || query.itemId) return null;

  const where = ["b.house_id = ?"];
  const params: unknown[] = [query.houseId];
  if (query.memberId) {
    where.push("b.created_by = ?");
    params.push(query.memberId);
  }
  const range = timeClause("b.created_at", `'5:' || b.id`, query.cursor, query.from, query.to);
  where.push(...range.where);
  params.push(...range.params);

  return {
    sql: `
      SELECT
        'bill.saved' AS kind,
        b.created_at AS occurred_at,
        b.id AS source_id,
        '5:' || b.id AS sort_key,
        b.created_by AS actor_id,
        u.name AS actor_name,
        NULL AS item_id,
        NULL AS item_name,
        NULL AS location_id,
        NULL AS location_name,
        NULL AS quantity,
        NULL AS unit,
        b.amount AS amount,
        b.currency AS currency,
        b.name AS title,
        NULL AS receipt_id,
        b.id AS bill_id,
        NULL AS shopping_item_id
      FROM bills b
      LEFT JOIN house_members hm ON hm.house_id = b.house_id AND hm.user_id = b.created_by
      LEFT JOIN users u ON u.id = hm.user_id
      WHERE ${where.join(" AND ")}`,
    params,
  };
}

function compareRows(a: any, b: any): number {
  if (a.occurred_at !== b.occurred_at) return a.occurred_at < b.occurred_at ? 1 : -1;
  if (a.sort_key === b.sort_key) return 0;
  return a.sort_key < b.sort_key ? 1 : -1;
}

export async function houseActivity(query: ActivityQuery): Promise<ActivityFeed> {
  const limit = Math.min(Math.max(Math.trunc(query.limit) || 30, 1), 100);
  const sources = [stockSource, receiptSource, itemSource, shoppingSource, billSource]
    .map((build) => build(query))
    .filter((source): source is Source => source !== null);

  if (!sources.length) return { events: [], nextCursor: null, hasMore: false };

  // One extra row per source is enough to know whether another page exists.
  const pages = await Promise.all(
    sources.map((source) =>
      all<any>(`${source.sql} ORDER BY occurred_at DESC, sort_key DESC LIMIT ?`, [...source.params, limit + 1]),
    ),
  );
  const merged = pages.flat().sort(compareRows);
  const rows = merged.slice(0, limit);
  const hasMore = merged.length > limit;
  const last = rows[rows.length - 1];

  return {
    events: rows.map((row) => serializeActivityEvent(row)),
    nextCursor: hasMore && last ? encodeActivityCursor(last.occurred_at, last.sort_key) : null,
    hasMore,
  };
}
