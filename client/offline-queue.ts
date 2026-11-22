import { api, ApiError } from "./api";

export interface QueuedStockAction {
  id: string;
  userId: string;
  houseId: string;
  itemId: string;
  itemName: string;
  unit: string;
  body: Record<string, unknown>;
  baseUpdatedAt: string | null;
  createdAt: string;
}

export interface QueueConflict {
  action: QueuedStockAction;
  status: number;
  details: Record<string, any>;
}

const DB_NAME = "svault-offline";
const STORE = "stock-queue";
const VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this browser"));
      return;
    }
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("scope", ["userId", "houseId"], { unique: false });
        store.createIndex("created", "createdAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the offline queue"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Offline queue request failed"));
  });
}

export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export function newQueueId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Normalise a queued action before it is written, so old or hand-edited
 * entries cannot break replay. */
export function normaliseQueuedAction(action: QueuedStockAction): QueuedStockAction {
  return {
    ...action,
    id: String(action.id),
    userId: String(action.userId),
    houseId: String(action.houseId),
    itemId: String(action.itemId),
    itemName: String(action.itemName ?? "item"),
    unit: String(action.unit ?? "pcs"),
    body: { ...(action.body ?? {}) },
    baseUpdatedAt: action.baseUpdatedAt ? String(action.baseUpdatedAt) : null,
    createdAt: action.createdAt || new Date().toISOString(),
  };
}

export async function enqueueStockAction(action: Omit<QueuedStockAction, "id" | "createdAt"> & { id?: string }): Promise<QueuedStockAction> {
  const queued = normaliseQueuedAction({
    ...action,
    id: action.id ?? newQueueId(),
    createdAt: new Date().toISOString(),
  });
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(queued);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not queue the stock change"));
    });
  } finally {
    db.close();
  }
  window.dispatchEvent(new CustomEvent("sv:queue-changed"));
  return queued;
}

export async function updateQueuedAction(action: QueuedStockAction): Promise<void> {
  const queued = normaliseQueuedAction(action);
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(queued);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not update the queued change"));
    });
  } finally {
    db.close();
  }
  window.dispatchEvent(new CustomEvent("sv:queue-changed"));
}

export async function listQueuedActions(userId?: string, houseId?: string): Promise<QueuedStockAction[]> {
  if (typeof indexedDB === "undefined") return [];
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readonly");
    const rows = await requestResult(tx.objectStore(STORE).getAll() as IDBRequest<QueuedStockAction[]>);
    return rows
      .filter((row) => (!userId || row.userId === userId) && (!houseId || row.houseId === houseId))
      .map(normaliseQueuedAction)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } finally {
    db.close();
  }
}

export async function removeQueuedAction(id: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not remove the queued change"));
    });
  } finally {
    db.close();
  }
  window.dispatchEvent(new CustomEvent("sv:queue-changed"));
}

export async function clearQueuedActions(userId?: string, houseId?: string): Promise<void> {
  const actions = await listQueuedActions(userId, houseId);
  for (const action of actions) await removeQueuedAction(action.id);
}

export interface SyncResult {
  synced: number;
  remaining: number;
  conflict: QueueConflict | null;
}

/** HTTP statuses after which replaying the same action can never succeed
 * (client/stocktake-draft.ts plus 403, for a member whose role was lowered
 * to viewer while changes were queued). Anything else, such as offline,
 * timeout, rate limit or 5xx, may pass later, so the queue retries with
 * backoff. */
export const PERMANENT_REJECTIONS = new Set([400, 403, 404, 409, 410, 422]);

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/** Exponential backoff for retrying a transient sync failure: 1 s, 2 s, 4 s…
 * capped at 30 s so an unreachable server cannot drain the battery. */
export function syncBackoffMs(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

/** Every stock movement bumps the item's updated_at, so a queued "set" would
 * 409 against the user's own earlier queued movement. Replaying uses the
 * timestamp the server returned for the previous action on that item as the
 * base for the next one; without one the queued baseline stands. */
export function rebaseQueuedAction(action: QueuedStockAction, latestUpdatedAt: string | null): QueuedStockAction {
  return latestUpdatedAt ? { ...action, baseUpdatedAt: latestUpdatedAt } : action;
}

/** Replay queued mutations in creation order. Stops on the first permanent
 * rejection (surfaced as a conflict the user can discard) or transport failure
 * so later actions cannot silently overtake it; transient failures are left
 * queued for the caller to retry with backoff. */
export async function syncQueue(
  userId: string,
  houseId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<SyncResult> {
  const actions = await listQueuedActions(userId, houseId);
  let synced = 0;
  const latestByItem = new Map<string, string>();
  for (const action of actions) {
    try {
      const rebased = rebaseQueuedAction(action, latestByItem.get(action.itemId) ?? null);
      const detail = await api<{ updatedAt?: string }>(`/api/items/${action.itemId}/stock`, {
        method: "POST",
        body: {
          ...rebased.body,
          idempotencyKey: action.id,
          baseUpdatedAt: rebased.baseUpdatedAt ?? undefined,
        },
      });
      if (detail?.updatedAt) latestByItem.set(action.itemId, detail.updatedAt);
      await removeQueuedAction(action.id);
      synced++;
      onProgress?.(synced, actions.length);
    } catch (error) {
      if (error instanceof ApiError && PERMANENT_REJECTIONS.has(error.status)) {
        // A 409 carries the server's newer baseline; 400/404/410/422 can
        // never succeed on retry, but both are decisions for the user, so
        // they surface like a conflict instead of blocking the queue.
        const details = { ...((error.details ?? {}) as Record<string, any>), message: error.message };
        return {
          synced,
          remaining: actions.length - synced,
          conflict: { action, status: error.status, details },
        };
      }
      return { synced, remaining: actions.length - synced, conflict: null };
    }
  }
  window.dispatchEvent(new CustomEvent("sv:queue-changed"));
  return { synced, remaining: 0, conflict: null };
}
