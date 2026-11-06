/**
 * Unsaved receipt scans, kept in IndexedDB so a draft survives the reload a
 * mobile browser often does after the camera closes. One draft per user and
 * house; page photos are stored as blobs next to the edited lines.
 */

const DB_NAME = "svault-receipt-drafts";
const STORE = "drafts";
const VERSION = 1;

export interface StoredReceiptDraft<T = unknown> {
  key: string;
  savedAt: string;
  data: T;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this browser"));
      return;
    }
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the receipt draft store"));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Receipt draft request failed"));
  });
}

export function receiptDraftKey(userId: string | null | undefined, houseId: string): string {
  return `${userId ?? "anon"}:${houseId}`;
}

export async function loadReceiptDraft<T>(key: string): Promise<StoredReceiptDraft<T> | null> {
  try {
    const db = await openDb();
    const store = db.transaction(STORE, "readonly").objectStore(STORE);
    return ((await requestResult(store.get(key))) as StoredReceiptDraft<T> | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function saveReceiptDraft<T>(key: string, data: T): Promise<boolean> {
  try {
    const db = await openDb();
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    await requestResult(store.put({ key, savedAt: new Date().toISOString(), data } satisfies StoredReceiptDraft<T>));
    return true;
  } catch {
    // Private mode or a full disk: the draft simply is not kept.
    return false;
  }
}

export async function clearReceiptDraft(key: string): Promise<void> {
  try {
    const db = await openDb();
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    await requestResult(store.delete(key));
  } catch {
    /* nothing stored */
  }
}
