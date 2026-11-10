import { parseBillText } from "@shared/bill-parser";
import { isBillPdf, pdfItemsToText } from "@shared/bill-document";
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
  usedOcr: boolean;
  result: BillParseResult;
}

/** Most pages OCR'd from one bill. Utility bills are rarely longer. */
const MAX_OCR_PAGES = 6;
/** Text-layer extraction is cheap, so long e-bills keep all their pages. */
const MAX_TEXT_PAGES = 50;
const TEXT_LAYER_MIN_CHARS = 60;
const MAX_PAGE_WIDTH = 2200;

/** Load pdf.js and install the worker URL once for the whole session. */
let pdfjsModule: Promise<typeof import("pdfjs-dist")> | null = null;
async function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  pdfjsModule ??= (async () => {
    const pdfjs = await import("pdfjs-dist");
    const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = worker;
    return pdfjs;
  })();
  return pdfjsModule;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.92));
}

async function readPdf(
  file: File,
  onProgress: (progress: number, status: string) => void,
): Promise<{ text: string; usedOcr: boolean }> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  // Keep the loading task: pdf.js v6 removed PDFDocumentProxy.destroy(), and
  // task.destroy() tears down the document and worker on both v5 and v6.
  const task = pdfjs.getDocument({ data });
  const pdf = await task.promise;
  const textPages = Math.min(pdf.numPages, MAX_TEXT_PAGES);

  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= textPages; pageNumber++) {
      onProgress(((pageNumber - 1) / textPages) * 0.25, "Reading the PDF");
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(pdfItemsToText(content.items));
    }

    const meaningful = (text: string) => (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
    const ocrPage = async (pageNumber: number, phaseStart: number, phaseSpan: number): Promise<string> => {
      const page = await pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(3, Math.max(1, MAX_PAGE_WIDTH / base.width));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      if (!context) return "";
      // Pass the canvas element directly to PDF.js.
      await page.render({ canvas, viewport }).promise;
      const blob = await canvasToBlob(canvas);
      canvas.width = 0;
      canvas.height = 0;
      if (!blob) return "";
      const image = new File([blob], `bill-page-${pageNumber}.jpg`, { type: "image/jpeg" });
      return ocrImage(
        image,
        (progress, status) => onProgress(phaseStart + progress * phaseSpan, status || "Recognising the bill"),
        { mode: "bill" },
      );
    };

    const extracted = pages.join("\n").trim();
    if (meaningful(extracted) >= TEXT_LAYER_MIN_CHARS && /\d/.test(extracted)) {
      // A hybrid PDF can have a text cover page and scanned invoice pages;
      // OCR only the pages whose text layer is effectively empty.
      const missing = pages
        .map((text, index) => meaningful(text) < 20 || !/\d/.test(text) ? index + 1 : 0)
        .filter((pageNumber) => pageNumber > 0)
        .slice(0, MAX_OCR_PAGES);
      if (!missing.length) {
        onProgress(1, "Text read from the PDF");
        return { text: extracted, usedOcr: false };
      }
      for (let index = 0; index < missing.length; index++) {
        const pageNumber = missing[index];
        const text = await ocrPage(pageNumber, 0.25 + (index / missing.length) * 0.75, 0.75 / missing.length);
        if (text) pages[pageNumber - 1] = text;
      }
      onProgress(1, "Bill read");
      return { text: pages.join("\n\n").trim(), usedOcr: true };
    }

    // A scanned PDF has little or no text layer, so render and OCR each page.
    const ocrPages = Math.min(pdf.numPages, MAX_OCR_PAGES);
    const texts: string[] = [];
    for (let pageNumber = 1; pageNumber <= ocrPages; pageNumber++) {
      const text = await ocrPage(
        pageNumber,
        0.25 + ((pageNumber - 1) / ocrPages) * 0.75,
        0.75 / ocrPages,
      );
      if (text) texts.push(text);
    }
    return { text: texts.join("\n\n").trim(), usedOcr: true };
  } finally {
    // destroy() also tears down the pdf.js worker; never mask the original error.
    try { await task.destroy(); } catch { /* ignore cleanup failures */ }
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
  return { text, usedOcr: true, result: parseBillText(text, options) };
}

