import { parseBillText } from "@shared/bill-parser";
import type { BillParseResult } from "@shared/types";
import { ocrImage } from "./ocr";

/**
 * Turn a bill PDF or photo into text, then into a reviewable draft.
 *
 * A PDF with a real text layer is read directly, which is both faster and more
 * accurate than OCR. Scanned PDFs and photos go through the same on-device
 * Tesseract worker as receipts and recipes; nothing is uploaded for OCR.
 */

export interface BillScanResult {
  text: string;
  pages: number;
  usedOcr: boolean;
  result: BillParseResult;
}

interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
}

/** Most pages OCR'd from one bill. Utility bills are rarely longer. */
const MAX_OCR_PAGES = 6;
const TEXT_LAYER_MIN_CHARS = 60;
const MAX_PAGE_WIDTH = 2200;

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
  const lines: Array<{ y: number; parts: Array<{ x: number; width: number; text: string }> }> = [];

  for (const item of items) {
    if (!item || typeof item !== "object" || !("str" in item) || !("transform" in item)) continue;
    const text = String((item as PdfTextItem).str ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const transform = (item as PdfTextItem).transform;
    const x = Number(transform?.[4] ?? 0);
    const y = Number(transform?.[5] ?? 0);
    const width = Number((item as PdfTextItem).width ?? 0);
    const line = lines.find((entry) => Math.abs(entry.y - y) <= 4);
    if (line) line.parts.push({ x, width, text });
    else lines.push({ y, parts: [{ x, width, text }] });
  }

  return lines
    .sort((a, b) => b.y - a.y)
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

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.92));
}

async function readPdf(
  file: File,
  onProgress: (progress: number, status: string) => void,
): Promise<{ text: string; pages: number; usedOcr: boolean }> {
  const pdfjs = await import("pdfjs-dist");
  const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;

  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pageCount = Math.min(pdf.numPages, MAX_OCR_PAGES);

  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      onProgress(((pageNumber - 1) / pageCount) * 0.25, "Reading the PDF");
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(pdfItemsToText(content.items));
    }

    const extracted = pages.join("\n").trim();
    const meaningful = extracted.replace(/[^A-Za-zΑ-Ωα-ω0-9]/g, "").length;
    if (meaningful >= TEXT_LAYER_MIN_CHARS && /\d/.test(extracted)) {
      onProgress(1, "Text read from the PDF");
      return { text: extracted, pages: pageCount, usedOcr: false };
    }

    // A scanned PDF has little or no text layer, so render and OCR each page.
    const texts: string[] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(3, Math.max(1, MAX_PAGE_WIDTH / base.width));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      await page.render({ canvas, viewport }).promise;

      const blob = await canvasToBlob(canvas);
      canvas.width = 0;
      canvas.height = 0;
      if (!blob) continue;
      const image = new File([blob], `bill-page-${pageNumber}.jpg`, { type: "image/jpeg" });
      const text = await ocrImage(
        image,
        (progress, status) => onProgress(
          0.25 + (((pageNumber - 1) + progress) / pageCount) * 0.75,
          status || "Recognising the bill",
        ),
        { mode: "bill" },
      );
      texts.push(text);
    }
    return { text: texts.join("\n\n").trim(), pages: pageCount, usedOcr: true };
  } finally {
    await pdf.destroy();
  }
}

export async function scanBillFile(
  file: File,
  onProgress: (progress: number, status: string) => void,
  options: { currency?: string | null } = {},
): Promise<BillScanResult> {
  if (isBillPdf(file)) {
    const pdf = await readPdf(file, onProgress);
    return { ...pdf, result: parseBillText(pdf.text, options) };
  }

  const text = await ocrImage(
    file,
    (progress, status) => onProgress(progress, status || "Recognising the bill"),
    { mode: "bill" },
  );
  onProgress(1, "Bill read");
  return { text, pages: 1, usedOcr: true, result: parseBillText(text, options) };
}

/** Load a saved bill document back into a File so it can be re-read. */
export async function fetchBillFile(url: string, name: string): Promise<File | null> {
  const response = await fetch(url);
  if (!response.ok) return null;
  const blob = await response.blob();
  const type = blob.type || (/\.pdf$/i.test(url) ? "application/pdf" : "image/jpeg");
  const extension = type === "application/pdf" ? "pdf" : type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
  return new File([blob], `${name || "bill"}.${extension}`, { type });
}
