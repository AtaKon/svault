/**
 * Browser-safe helpers for bill documents.
 *
 * These live in `shared/` so the server test suite can exercise the pure
 * signatures, line grouping and type detection without importing the browser
 * OCR bundle.
 */

interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
}

export function isBillPdf(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export function isSupportedBillFile(file: File): boolean {
  if (isBillPdf(file)) return true;
  return file.type === "image/jpeg" ||
    file.type === "image/png" ||
    file.type === "image/webp" ||
    /\.(?:jpe?g|png|webp)$/i.test(file.name);
}

/** Group PDF text runs into visual lines, keeping wide label/amount gaps. */
export function pdfItemsToText(items: unknown[]): string {
  const runs: Array<{ x: number; y: number; width: number; text: string }> = [];

  for (const item of items) {
    if (!item || typeof item !== "object" || !("str" in item) || !("transform" in item)) continue;
    const text = String((item as PdfTextItem).str ?? "").replace(/\s+/g, " ").trim();
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
  if (buffer.byteLength < 2) return null;
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 12));
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a) return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Load a saved bill document back into a File so it can be re-read. */
export async function fetchBillFile(url: string, name: string): Promise<File | null> {
  // Same-origin cookies are what the document route uses; make that explicit.
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) return null;
  const blob = await response.blob();
  const buffer = await blob.arrayBuffer();
  // The authenticated document route sets a real Content-Type, but a proxy or
  // generic download can strip it. Inspect the bytes before trusting it, and
  // only fall back to a supported type (never text/html error pages).
  const supported = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
  const type = documentMime(buffer) ?? (blob.type && supported.has(blob.type) ? blob.type : null);
  if (!type) return null;
  const extension = type === "application/pdf" ? "pdf" : type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
  return new File([buffer], `${name || "bill"}.${extension}`, { type });
}
