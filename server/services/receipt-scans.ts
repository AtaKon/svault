import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { get } from "../db.js";
import { uploadPath } from "../upload.js";
import { fileToDataUrl } from "../ai.js";

/**
 * Short-lived records of receipt scans and uploads.
 *
 * A scan's provenance (which parser read it, what the AI call cost, which
 * template matched and which images were sent) is kept on the server so the
 * import can copy it instead of trusting values the browser sends back. SVault
 * runs as a single container, so an in-memory map with a TTL is enough; after a
 * restart an import simply records the receipt as manual.
 */

export const RECEIPT_IMAGE_PATTERN = /^\/uploads\/receipts\/[A-Za-z0-9._-]+$/;
const SCAN_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_RECORDS = 5000;

export interface ScanRecord {
  id: string;
  houseId: string;
  userId: string;
  provider: "ai" | "local" | "template";
  aiCost: number | null;
  templateId: string | null;
  templateConfidence: number | null;
  images: string[];
  createdAt: number;
}

const scans = new Map<string, ScanRecord>();
/** Upload path -> house that uploaded it, so one house cannot delete another's draft image. */
const uploads = new Map<string, { houseId: string; createdAt: number }>();

function prune(now = Date.now()) {
  for (const [id, record] of scans) if (now - record.createdAt > SCAN_TTL_MS) scans.delete(id);
  for (const [path, entry] of uploads) if (now - entry.createdAt > SCAN_TTL_MS) uploads.delete(path);
  // Bound memory even under abuse: drop the oldest entries first (Map keeps insertion order).
  while (scans.size > MAX_RECORDS) scans.delete(scans.keys().next().value!);
  while (uploads.size > MAX_RECORDS) uploads.delete(uploads.keys().next().value!);
}

export function createScanRecord(record: Omit<ScanRecord, "id" | "createdAt">): ScanRecord {
  prune();
  const entry: ScanRecord = { ...record, id: `scn_${randomBytes(12).toString("hex")}`, createdAt: Date.now() };
  scans.set(entry.id, entry);
  return entry;
}

/** The scan record for this house, or null when unknown, expired or from another house. */
export function getScanRecord(scanId: string | null | undefined, houseId: string): ScanRecord | null {
  if (!scanId) return null;
  prune();
  const record = scans.get(scanId);
  if (!record || record.houseId !== houseId) return null;
  return record;
}

export function forgetScanRecord(scanId: string) {
  scans.delete(scanId);
}

export function rememberUpload(path: string, houseId: string) {
  prune();
  uploads.set(path, { houseId, createdAt: Date.now() });
}

/** False only when the upload is known to belong to a different house. */
export function uploadBelongsTo(path: string, houseId: string): boolean {
  const entry = uploads.get(path);
  return !entry || entry.houseId === houseId;
}

export function isReceiptImagePath(value: unknown): value is string {
  return typeof value === "string" && RECEIPT_IMAGE_PATTERN.test(value);
}

export function receiptImageFile(path: string): string {
  return uploadPath("receipts", path.split("/").pop()!);
}

export async function receiptImageExists(path: string): Promise<boolean> {
  if (!isReceiptImagePath(path)) return false;
  const stat = await fs.stat(receiptImageFile(path)).catch(() => null);
  return Boolean(stat?.isFile());
}

/**
 * Delete an uploaded receipt image unless a stored receipt still points at it.
 * Returns true when the file was removed.
 */
export async function removeReceiptImageIfUnused(path: string | null | undefined): Promise<boolean> {
  if (!path || !isReceiptImagePath(path)) return false;
  const referenced = await get("SELECT id FROM receipts WHERE image = ? LIMIT 1", [path]);
  if (referenced) return false;
  try {
    await fs.unlink(receiptImageFile(path));
    uploads.delete(path);
    return true;
  } catch {
    return false;
  }
}

/** Most page photos sent to a vision model for one receipt. */
export const MAX_SCAN_IMAGES = 8;

/**
 * Read uploaded receipt photos as data URLs for a vision model. Paths that are
 * not receipt uploads, missing files and files over the size limit are
 * skipped and counted so the caller can warn instead of silently dropping them.
 */
export async function loadVisionImages(paths: string[]): Promise<{ images: string[]; skipped: number }> {
  const images: string[] = [];
  let skipped = 0;
  for (const path of paths.slice(0, MAX_SCAN_IMAGES)) {
    const dataUrl = isReceiptImagePath(path) ? await fileToDataUrl(receiptImageFile(path)) : null;
    if (dataUrl) images.push(dataUrl);
    else skipped++;
  }
  return { images, skipped };
}

export function skippedImagesWarning(skipped: number, total: number): string | null {
  if (!skipped) return null;
  return total === 1
    ? "The photo could not be sent to the vision model (missing or larger than 8 MB); only the recognised text was used."
    : `${skipped} of ${total} photos could not be sent to the vision model (missing or larger than 8 MB); the rest were used.`;
}
