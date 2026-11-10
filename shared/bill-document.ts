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

/** Matches the server upload limit; protects re-read from oversized objects. */
export const MAX_BILL_DOCUMENT_BYTES = 20 * 1024 * 1024;

const IMAGE_FILE_EXTENSIONS = /\.(?:jpe?g|png|webp|gif|avif|heic|heif|bmp|tiff?)$/i;
const HEIF_BRANDS = new Set(["avif", "avis", "heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);
const DOCUMENT_EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/bmp": "bmp",
  "image/tiff": "tif",
};

export function isBillPdf(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export function isSupportedBillFile(file: File): boolean {
  if (isBillPdf(file)) return true;
  // The server sniffs the real bytes, so accept any raster image: phone camera
  // rolls hand over HEIC/HEIF and AVIF, which the client converts to JPEG before
  // upload. SVG is a scriptable document, not a photo, and stays rejected.
  if (file.type === "image/svg+xml") return false;
  return file.type.startsWith("image/") || IMAGE_FILE_EXTENSIONS.test(file.name);
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
  const bytes = new Uint8Array(buffer, 0, 12);
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG" &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp" && HEIF_BRANDS.has(ascii(8, 12))) {
    return ascii(8, 12).startsWith("avi") ? "image/avif" : "image/heic";
  }
  if (ascii(0, 2) === "BM") return "image/bmp";
  if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)) {
    return "image/tiff";
  }
  return null;
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
