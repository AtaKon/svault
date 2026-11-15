import { api, ApiError } from "./api";

/**
 * Offline draft for a stocktake. Counting PATCHes one line at a time; when the
 * connection drops, the value is kept in localStorage and replayed the next
 * time the page is opened or the browser comes back online. This is a
 * per-browser safety net, not a sync engine: the session itself still lives on
 * the server and commit needs a connection.
 */

export interface PendingStocktakeCount {
  lineId: string;
  countedQty: number | null;
  note?: string | null;
  updatedAt: string;
}

type PendingMap = Record<string, PendingStocktakeCount>;

function storageKey(houseId: string, stocktakeId: string): string {
  return `sv-stocktake-draft:${houseId}:${stocktakeId}`;
}

export function readPendingCounts(houseId: string, stocktakeId: string): PendingMap {
  try {
    const raw = localStorage.getItem(storageKey(houseId, stocktakeId));
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return {};
    const out: PendingMap = {};
    for (const [lineId, value] of Object.entries(parsed as Record<string, any>)) {
      if (!value || typeof value !== "object") continue;
      const counted = value.countedQty;
      if (counted !== null && (typeof counted !== "number" || !Number.isFinite(counted))) continue;
      out[lineId] = {
        lineId,
        countedQty: counted,
        note: value.note === undefined ? undefined : value.note,
        updatedAt: String(value.updatedAt ?? new Date().toISOString()),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(houseId: string, stocktakeId: string, pending: PendingMap): void {
  try {
    if (!Object.keys(pending).length) localStorage.removeItem(storageKey(houseId, stocktakeId));
    else localStorage.setItem(storageKey(houseId, stocktakeId), JSON.stringify(pending));
  } catch {
    /* storage may be unavailable; the server still has every saved line */
  }
}

export function queuePendingCount(
  houseId: string,
  stocktakeId: string,
  lineId: string,
  countedQty: number | null,
  note?: string | null,
): void {
  const pending = readPendingCounts(houseId, stocktakeId);
  pending[lineId] = { lineId, countedQty, note, updatedAt: new Date().toISOString() };
  writeAll(houseId, stocktakeId, pending);
}

export function clearPendingCount(houseId: string, stocktakeId: string, lineId: string): void {
  const pending = readPendingCounts(houseId, stocktakeId);
  if (!(lineId in pending)) return;
  delete pending[lineId];
  writeAll(houseId, stocktakeId, pending);
}

/** Replay queued counts in order. Stops on a transport failure; drops a queued
 * line the server refuses permanently (the session closed or the line is gone). */
/** HTTP statuses after which retrying the same count can never succeed. */
const PERMANENT_REJECTIONS = new Set([400, 404, 409, 410, 422]);

export async function flushPendingCounts(
  houseId: string,
  stocktakeId: string,
): Promise<{ synced: number; remaining: number }> {
  const pending = readPendingCounts(houseId, stocktakeId);
  const entries = Object.values(pending).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  let synced = 0;
  for (const entry of entries) {
    try {
      await api(`/api/houses/${houseId}/stocktakes/${stocktakeId}/lines/${entry.lineId}`, {
        method: "PATCH",
        body: {
          countedQty: entry.countedQty,
          ...(entry.note === undefined ? {} : { note: entry.note }),
        },
      });
      clearPendingCount(houseId, stocktakeId, entry.lineId);
      synced++;
    } catch (error) {
      if (error instanceof ApiError && error.status === 0) {
        return { synced, remaining: entries.length - synced };
      }
      // Only a permanent rejection (bad value, line gone, session closed) may
      // drop a queued count. 401/403/408/425/429 can pass, so the count stays
      // queued and replay stops here rather than silently losing it.
      if (error instanceof ApiError && PERMANENT_REJECTIONS.has(error.status)) {
        clearPendingCount(houseId, stocktakeId, entry.lineId);
        synced++;
        continue;
      }
      return { synced, remaining: entries.length - synced };
    }
  }
  return { synced, remaining: 0 };
}
