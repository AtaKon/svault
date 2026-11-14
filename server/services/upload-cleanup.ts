import fs from "node:fs";
import path from "node:path";
import { all, get } from "../db.js";
import { UPLOAD_DIR } from "../config.js";

/**
 * Uploaded files live under /uploads, so a file must disappear once the row
 * that owned it is gone. Bill PDFs remain private behind authenticated routes.
 * Rows are removed first; their files are then
 * deleted unless another row still points at them. A daily sweep catches
 * everything else (replaced images, abandoned scan drafts, receipts deleted
 * elsewhere).
 */

export const UPLOAD_FOLDERS = ["items", "recipes", "photos", "receipts", "bills", "item-documents"] as const;

/**
 * Every column that stores an `/uploads/...` URL. Keep this in sync when a new
 * column starts storing upload paths, otherwise the sweep treats those files
 * as orphans after a day.
 */
export const UPLOAD_URL_COLUMNS: { table: string; column: string }[] = [
  { table: "items", column: "image" },
  { table: "recipes", column: "image" },
  { table: "recipes", column: "source_image" },
  { table: "receipts", column: "image" },
];

const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

/** Map `/uploads/<folder>/<file>` to `<folder>/<file>`, or null for anything else. */
function uploadKey(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = url.match(/^\/uploads\/(items|recipes|photos|receipts|bills|item-documents)\/([^/?#]+)$/);
  if (!match || match[2] === "." || match[2] === "..") return null;
  return `${match[1]}/${match[2]}`;
}

async function isReferenced(key: string): Promise<boolean> {
  const [folder, file] = key.split("/");
  if (folder === "photos" && await get("SELECT id FROM photos WHERE filename = ? LIMIT 1", [file])) return true;
  if (folder === "bills" && await get("SELECT id FROM bills WHERE document = ? LIMIT 1", [file])) return true;
  if (folder === "item-documents" && await get("SELECT id FROM item_documents WHERE filename = ? LIMIT 1", [file])) return true;
  const url = `/uploads/${key}`;
  for (const { table, column } of UPLOAD_URL_COLUMNS) {
    if (await get(`SELECT 1 AS hit FROM ${table} WHERE ${column} = ? LIMIT 1`, [url])) return true;
  }
  return false;
}

/** Delete the files behind these upload URLs unless a remaining row still uses them. */
export async function removeUnreferencedUploads(urls: Iterable<unknown>): Promise<number> {
  let removed = 0;
  const keys = new Set<string>();
  for (const url of urls) {
    const key = uploadKey(url);
    if (key) keys.add(key);
  }
  for (const key of keys) {
    if (await isReferenced(key)) continue;
    const [folder, file] = key.split("/");
    try {
      fs.rmSync(path.join(UPLOAD_DIR, folder, path.basename(file)), { force: true });
      removed++;
    } catch {
      /* the sweep will try again */
    }
  }
  return removed;
}

/** Upload URLs referenced by one house's rows. Collect them before deleting the house. */
/** Return normalized upload references for cleanup; entries are not necessarily fetchable public URLs. */
export async function houseUploadUrls(houseId: string): Promise<string[]> {
  const urls: string[] = [];
  for (const { table, column } of UPLOAD_URL_COLUMNS) {
    const rows = await all<{ url: string | null }>(
      `SELECT ${column} AS url FROM ${table} WHERE house_id = ? AND ${column} LIKE '/uploads/%'`,
      [houseId],
    );
    for (const row of rows) if (row.url) urls.push(row.url);
  }
  for (const row of await all<{ filename: string }>("SELECT filename FROM photos WHERE house_id = ?", [houseId])) {
    urls.push(`/uploads/photos/${row.filename}`);
  }
  for (const row of await all<{ filename: string }>("SELECT document AS filename FROM bills WHERE house_id = ? AND document IS NOT NULL", [houseId])) {
    urls.push(`/uploads/bills/${row.filename}`);
  }
  for (const row of await all<{ filename: string }>("SELECT filename FROM item_documents WHERE house_id = ?", [houseId])) urls.push(`/uploads/item-documents/${row.filename}`);
  return urls;
}

/** Files that no row references and that are older than `maxAgeMs`. */
export async function orphanCandidates(
  maxAgeMs = ORPHAN_AGE_MS,
): Promise<{ key: string; path: string; size: number; modifiedAt: string }[]> {
  const referenced = new Set<string>();
  for (const { table, column } of UPLOAD_URL_COLUMNS) {
    const rows = await all<{ url: string | null }>(
      `SELECT ${column} AS url FROM ${table} WHERE ${column} LIKE '/uploads/%'`,
    );
    for (const row of rows) {
      const key = uploadKey(row.url);
      if (key) referenced.add(key);
    }
  }
  for (const row of await all<{ filename: string }>("SELECT filename FROM photos")) {
    referenced.add(`photos/${row.filename}`);
  }
  for (const row of await all<{ filename: string }>("SELECT document AS filename FROM bills WHERE document IS NOT NULL")) {
    referenced.add(`bills/${row.filename}`);
  }

  for (const row of await all<{ filename: string }>("SELECT filename FROM item_documents")) referenced.add(`item-documents/${row.filename}`);

  const cutoff = Date.now() - maxAgeMs;
  const found: { key: string; path: string; size: number; modifiedAt: string }[] = [];
  for (const folder of UPLOAD_FOLDERS) {
    const dir = path.join(UPLOAD_DIR, folder);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || referenced.has(`${folder}/${entry.name}`)) continue;
      const file = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs > cutoff) continue;
        found.push({
          key: `${folder}/${entry.name}`,
          path: file,
          size: stat.size,
          modifiedAt: new Date(stat.mtimeMs).toISOString(),
        });
      } catch {
        /* a file that vanished meanwhile is fine */
      }
    }
  }
  return found;
}

/** Remove files in the upload folders that no row references and that are older than `maxAgeMs`. */
export async function sweepOrphanUploads(maxAgeMs = ORPHAN_AGE_MS): Promise<number> {
  let removed = 0;
  for (const candidate of await orphanCandidates(maxAgeMs)) {
    try {
      fs.rmSync(candidate.path, { force: true });
      removed++;
    } catch {
      /* the sweep will try again */
    }
  }
  return removed;
}
