/**
 * Browser-safe helpers for bill documents.
 *
 * These live in `shared/` so the server test suite can exercise the pure
 * signatures, line grouping and type detection without importing the browser
 * OCR bundle.
 */

import { sniffImageBytes } from "./image-sniff.js";

interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
}

/** Matches the server upload limit; protects re-read from oversized objects. */
export const MAX_BILL_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** Extensions the bill photo picker and uploader accept, shared with the server filter. */
export const BILL_PHOTO_EXTENSIONS: ReadonlySet<string> = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif",
  ".heic", ".heif", ".bmp", ".tif", ".tiff",
]);

/**
 * Input image types the picker and converter accept. This is not the stored
 * type list: `image/heif`, `image/jpg` and similar arrive from browsers and are
 * normalised to JPEG by `prepareBillImage`, while `DOCUMENT_EXTENSIONS` keys
 * below are only the types the server sniffer can return.
 */
const BILL_INPUT_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/pjpeg",
  "image/png", "image/webp", "image/gif", "image/avif",
  "image/heic", "image/heif", "image/bmp", "image/tiff",
]);
const DOCUMENT_EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/bmp": "bmp",
  "image/tiff": "tif",
};

export function isBillPdf(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export function isSupportedBillFile(file: File): boolean {
  if (isBillPdf(file)) return true;
  if (BILL_INPUT_TYPES.has(file.type)) return true;
  const dot = file.name.lastIndexOf(".");
  return dot >= 0 && BILL_PHOTO_EXTENSIONS.has(file.name.slice(dot).toLowerCase());
}

/** Group PDF text runs into visual lines, keeping wide label/amount gaps. */
export function pdfItemsToText(items: unknown[]): string {
  const runs: Array<{ x: number; y: number; width: number; text: string }> = [];

  for (const item of items) {
    if (!item || typeof item !== "object" || !("str" in item) || !("transform" in item)) continue;
    const text = String((item as PdfTextItem).str ?? "").replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").trim();
    if (!text) continue;
    const transform = (item as PdfTextItem).transform;
    runs.push({
      x: Number(transform?.[4] ?? 0),
      y: Number(transform?.[5] ?? 0),
      width: Number((item as PdfTextItem).width ?? 0),
      text,
    });
  }

  // Sort once, then group adjacent runs; this keeps large text layers linear
  // after the sort instead of searching the whole line list for every run.
  runs.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Array<{ y: number; parts: typeof runs }> = [];
  for (const run of runs) {
    const current = lines[lines.length - 1];
    if (current && Math.abs(current.y - run.y) <= 4) current.parts.push(run);
    else lines.push({ y: run.y, parts: [run] });
  }

  return lines
    .map((line) => {
      const parts = line.parts.sort((a, b) => a.x - b.x);
      let result = "";
      let previousEnd: number | null = null;
      for (const part of parts) {
        if (previousEnd != null) {
          // A wide gap usually separates a label from its printed amount.
          result += part.x - previousEnd > 14 ? "   " : " ";
        }
        result += part.text;
        previousEnd = part.x + part.width;
      }
      return result.trim();
    })
    .filter(Boolean)
    .join("\n");
}

/** Detect a stored bill document from its bytes, independent of headers. */
export function documentMime(buffer: ArrayBuffer): string | null {
  if (buffer.byteLength < 12) return null;
  // HEIF/AVIF compatible brands live after the 12-byte header; scan the same
  // 1024-byte prefix the server reads so a `mif1` phone photo resolves to the
  // codec it actually carries.
  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 1024));
  if (String.fromCharCode(...head.subarray(0, 5)) === "%PDF-") return "application/pdf";
  return sniffImageBytes(head);
}

/** JPEG name used when a phone photo is re-encoded before upload. */
export function billPhotoName(name: string): string {
  // A picker normally hands over a basename, but never let a directory or a
  // control character survive into the File name shown or sent upstream.
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const stem = base.replace(/\.[^.]+$/, "").trim();
  return `${stem || "bill"}.jpg`;
}

/** Fit a photo inside `maxEdge` without ever upscaling it. */
export function billPhotoSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 1;
  const scale = Math.min(1, maxEdge / Math.max(safeWidth, safeHeight));
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

/** Load a saved bill document back into a File so it can be re-read. */
export async function fetchBillFile(url: string, name: string): Promise<File | null> {
  // The authenticated document route relies on same-origin cookies.
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) return null;
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > MAX_BILL_DOCUMENT_BYTES) return null;
  const blob = await response.blob();
  if (blob.size > MAX_BILL_DOCUMENT_BYTES) return null;
  const buffer = await blob.arrayBuffer();
  // Trust the bytes, not the response header: a proxy or generic download can
  // mislabel an error page or a truncated file.
  const type = documentMime(buffer);
  if (!type) return null;
  const extension = DOCUMENT_EXTENSIONS[type] ?? "jpg";
  return new File([buffer], `${name || "bill"}.${extension}`, { type });
}
