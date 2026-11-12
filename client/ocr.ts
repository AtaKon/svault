import {
  MAX_RECIPE_OCR_PIXELS,
  MAX_RECIPE_OCR_WIDTH,
  cleanNotebookTextReport,
  detectContentBounds,
  detectPaperRegion,
  estimateSkewDegrees,
  inkLumaFromRgba,
  measureBlueInk,
  normaliseLumaFromRgba,
  scoreRecipeText,
} from "@shared/notebook-scan";

type OcrMode = "recipe" | "receipt" | "bill";

export interface OcrOptions {
  mode?: OcrMode;
  /**
   * Called once with the recognition result the scanner kept — the pass with
   * the highest score, not necessarily the first — and that pass's reported
   * confidence. Cleanup removes planner furniture and OCR duplicates, and
   * handwriting is read so poorly that the raw reading must stay available to
   * the user.
   */
  onRawText?: (text: string, meta: { confidence: number }) => void;
  /** Complete readings, called when a product region was found and additional passes succeeded. */
  onCandidates?: (texts: string[]) => void;
}

interface BoundingBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface PageLine {
  text: string;
  confidence?: number;
  bbox?: BoundingBox;
}

interface PageBlock {
  paragraphs?: Array<{ lines?: PageLine[] }>;
}

interface PageLike {
  text: string;
  blocks?: PageBlock[] | null;
}

interface TextLine {
  text: string;
  top: number;
  bottom: number;
  left: number;
}

interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Candidate {
  variant: "full" | "grayscale" | "binary";
  text: string;
  score: number;
  confidence: number;
}

const GREEK_CHAR = /[\u0370-\u03ff\u1f00-\u1fff]/gu;
const HEADER_LINE = /(?:ΦΟΡΟΛΟΓΙΚΗ|ΑΠΟΔΕΙΞΗ\s+ΛΙΑΝΙΚΗΣ\s+ΠΩΛΗΣΗΣ)/iu;
const PRODUCT_TAIL = /\s-?\d{1,4}[.,]\d{2}(?:\s*(?:€|EUR))?(?:\s+\d{1,2}(?:[.,]\d+)?\s*%)?\s*(?:[A-ZΑ-Ω])?\s*$/iu;
const QUANTITY_ROW = /^\d+(?:[.,]\d+)?\s*(?:kg|g|l|ml)?\s*[x×*]\s*\d+[.,]\d{2}/iu;
const NON_PRODUCT_ROW =
  /^(?:ΣΥΝΟΛΟ|ΣΥΝΟΛΙΚ|ΦΠΑ|Φ\.Π\.Α|ΚΑΡΤΑ|ΜΕΤΡΗΤΑ|ΡΕΣΤΑ|ΠΛΗΡΩΜ|ΑΦΜ|ΤΑΜΕΙΟ|ΑΠΟΔΕΙΞΗ|ΗΜΕΡ|ΩΡΑ|ΤΗΛ|LIDL\s*PLUS|ΕΚΠΤΩΣ|ΕΞΟΙΚΟΝΟΜ)/iu;
const MAX_IMAGE_PIXELS = 18_000_000;
const MAX_PRODUCT_PIXELS = 10_000_000;
const MAX_PRODUCT_WIDTH = 3200;
const RECIPE_ANALYSIS_WIDTH = 900;

/** Fold look-alike Latin characters so a misread ΣΥΝΟΛΟ still anchors the layout. */
function foldGreekLookalikes(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/Y/g, "Υ")
    .replace(/[O0]/g, "Ο")
    .replace(/N/g, "Ν")
    .replace(/S/g, "Σ");
}

function isTotalLine(text: string): boolean {
  const line = text.trim().replace(/^[^\p{L}\d]+/u, "");
  return /^ΣΥΝΟΛΟ(?!\s+(?:ΕΚΠΤΩΣΕΩΝ|ΕΙΔΩΝ|ΠΟΣΟΤΗΤ|ΤΕΜΑΧΙ))(?=$|[\s:.\d])/u.test(
    foldGreekLookalikes(line),
  );
}

function isProductLike(text: string): boolean {
  const line = text.trim();
  if (line.length < 3) return false;
  if (HEADER_LINE.test(line) || isTotalLine(line) || NON_PRODUCT_ROW.test(line)) return false;
  if (QUANTITY_ROW.test(line)) return true;
  if (!/\p{L}{2}/u.test(line)) return false;
  return PRODUCT_TAIL.test(line);
}

function collectLines(page: PageLike): TextLine[] {
  const lines: TextLine[] = [];
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const text = line.text?.trim();
        if (!text || !line.bbox) continue;
        lines.push({ text, top: line.bbox.y0, bottom: line.bbox.y1, left: line.bbox.x0 });
      }
    }
  }
  return lines.sort((a, b) => a.top - b.top || a.left - b.left);
}

export function detectProductRegion(page: PageLike, width: number, height: number): Region | null {
  const lines = collectLines(page);
  if (lines.length < 3) return null;

  const header = lines.find((line) => HEADER_LINE.test(line.text));
  const totals = lines.filter((line) => isTotalLine(line.text));
  if (!totals.length) return null;
  const total = (header ? totals.find((line) => line.top > header.top) : totals[0]) ?? totals[totals.length - 1];
  if (!total) return null;

  const startLimit = header ? header.bottom : 0;
  const beforeTotal = lines.filter((line) => line.top >= startLimit && line.bottom <= total.top + 2);
  const firstProduct = beforeTotal.find((line) => isProductLike(line.text));

  let top: number;
  if (header) {
    // Even when Tesseract splits names and prices into separate lines, cropping
    // everything between the receipt header and ΣΥΝΟΛΟ still covers the basket.
    top = Math.min(header.bottom + 2, total.top - 24);
  } else if (firstProduct) {
    top = firstProduct.top - 8;
  } else {
    return null;
  }

  const bottom = total.top - 4;
  top = Math.max(0, top);
  if (bottom - top < 24) return null;
  return { left: 0, top, width, height: Math.min(height, bottom) - top };
}

function scoreProductText(text: string): number {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  let productRows = 0;
  let quantityRows = 0;
  let vatRows = 0;
  let greek = 0;
  let noise = 0;

  for (const line of lines) {
    const product = isProductLike(line);
    if (product) {
      productRows++;
      greek += (line.match(GREEK_CHAR) ?? []).length;
    }
    if (QUANTITY_ROW.test(line)) quantityRows++;
    if (/\d{1,2}(?:[.,]\d+)?\s*%\s*$/u.test(line)) vatRows++;
    if (/[|¦~^`]/u.test(line)) noise++;
  }

  return productRows * 10 + quantityRows * 4 + vatRows * 1.5 + Math.min(greek, 200) * 0.05 - noise * 0.5;
}

function extractProductSectionText(fullText: string): string | null {
  const lines = fullText.replace(/\r\n?/g, "\n").split("\n");
  const headerIndex = lines.findIndex((line) => HEADER_LINE.test(line));
  if (headerIndex < 0) return null;

  let totalIndex = -1;
  for (let index = headerIndex + 1; index < lines.length; index++) {
    if (isTotalLine(lines[index])) {
      totalIndex = index;
      break;
    }
  }
  if (totalIndex < 0) return null;

  return lines
    .slice(headerIndex + 1, totalIndex)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

export function spliceProductText(fullText: string, productText: string): string {
  const lines = fullText.replace(/\r\n?/g, "\n").split("\n");
  const trimmed = lines.map((line) => line.trim());
  const headerIndex = trimmed.findIndex((line) => HEADER_LINE.test(line));
  if (headerIndex < 0) return fullText;

  let totalIndex = -1;
  for (let index = headerIndex + 1; index < trimmed.length; index++) {
    if (isTotalLine(trimmed[index])) {
      totalIndex = index;
      break;
    }
  }
  if (totalIndex < 0) return fullText;

  const start = headerIndex + 1;

  const replacement = productText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !HEADER_LINE.test(line) && !isTotalLine(line));
  if (!replacement.length) return fullText;

  return [...lines.slice(0, start), ...replacement, ...lines.slice(totalIndex)].join("\n");
}

/** Grayscale plus a gentle percentile stretch. Keeps anti-aliased Greek glyphs intact. */
function normalizeCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return source;
  context.drawImage(source, 0, 0);

  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  const total = canvas.width * canvas.height;
  const values = normaliseLumaFromRgba(data, total);

  for (let pixel = 0; pixel < total; pixel++) {
    const value = values[pixel];
    const index = pixel * 4;
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
    data[index + 3] = 255;
  }

  context.putImageData(image, 0, 0);
  return canvas;
}

async function prepareDocument(file: File, mode: OcrMode): Promise<HTMLCanvasElement | File> {
  if (!file.type.startsWith("image/")) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const dense = mode === "receipt" || mode === "bill";
    const maxWidth = dense ? 2400 : MAX_RECIPE_OCR_WIDTH;
    const maxUpscale = dense ? 3 : 2.5;
    const maxPixels = dense ? MAX_IMAGE_PIXELS : MAX_RECIPE_OCR_PIXELS;
    const scale = Math.min(
      maxUpscale,
      maxWidth / bitmap.width,
      Math.sqrt(maxPixels / (bitmap.width * bitmap.height)),
    );
    const width = Math.max(1, Math.round(bitmap.width * Math.max(0.25, scale)));
    const height = Math.max(1, Math.round(bitmap.height * Math.max(0.25, scale)));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return file;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    // Recipe pages keep their colour: the ink variant needs the channel
    // difference to separate blue ballpoint from cream paper.
    return dense ? normalizeCanvas(canvas) : canvas;
  } catch {
    return file;
  }
}

function productScale(region: Region): number {
  const desired = Math.min(3, Math.max(1, Math.sqrt(MAX_PRODUCT_PIXELS / (region.width * region.height))));
  return Math.max(1, Math.min(desired, MAX_PRODUCT_WIDTH / Math.max(1, region.width)));
}

function cropCanvas(source: HTMLCanvasElement, region: Region, scale: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(region.width * scale));
  canvas.height = Math.max(1, Math.round(region.height * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return canvas;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    source,
    region.left,
    region.top,
    region.width,
    region.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return canvas;
}

interface PageAnalysis {
  luma: Uint8ClampedArray;
  width: number;
  height: number;
  /** Average blue-minus-red of the darkest pixels. Blue ballpoint scores high. */
  bluish: number;
}

/** Downscaled grayscale copy used to find the page and its tilt cheaply. */
function analysePage(source: HTMLCanvasElement): PageAnalysis | null {
  const scale = Math.min(1, RECIPE_ANALYSIS_WIDTH / Math.max(1, source.width));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;

  const luma = new Uint8ClampedArray(width * height);
  for (let pixel = 0, index = 0; index < data.length; index += 4, pixel++) {
    luma[pixel] = Math.round(0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]);
  }

  return { luma, width, height, bluish: measureBlueInk(data, width * height) };
}

/** Rotate the image by `degrees`, positive being clockwise (canvas convention). */
function rotateCanvas(source: HTMLCanvasElement, degrees: number): HTMLCanvasElement {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const width = Math.ceil(source.width * cos + source.height * sin);
  const height = Math.ceil(source.width * sin + source.height * cos);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return source;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.translate(width / 2, height / 2);
  context.rotate(radians);
  context.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

/**
 * Minimum-channel grayscale. Blue ballpoint, black ink and pencil all stay
 * dark while cream paper and yellow age stains stay light, which is exactly
 * what a global Otsu pass gets wrong on uneven notebook photos.
 */
function inkCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return source;
  context.drawImage(source, 0, 0);

  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  const total = canvas.width * canvas.height;
  const values = inkLumaFromRgba(data, total);

  for (let pixel = 0; pixel < total; pixel++) {
    const value = values[pixel];
    const index = pixel * 4;
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
    data[index + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Straighten and crop a photographed page before recognition. The ruled lines
 * give a reliable tilt; the bright-paper box ignores the desk, the neighbouring
 * page and the deep shadow at the spine.
 */
function tightenRecipePage(source: HTMLCanvasElement): HTMLCanvasElement {
  let page = source;
  const before = analysePage(page);
  if (before) {
    const skew = estimateSkewDegrees(before.luma, before.width, before.height);
    if (Math.abs(skew) >= 1) page = rotateCanvas(page, -skew);
  }

  const analysis = analysePage(page);
  if (!analysis) return page;

  const paper = detectPaperRegion(analysis.luma, analysis.width, analysis.height);
  const ink = detectContentBounds(analysis.luma, analysis.width, analysis.height);
  let box: Region = paper ?? { left: 0, top: 0, width: analysis.width, height: analysis.height };
  if (ink) {
    const left = Math.max(box.left, ink.left);
    const top = Math.max(box.top, ink.top);
    const right = Math.min(box.left + box.width, ink.left + ink.width);
    const bottom = Math.min(box.top + box.height, ink.top + ink.height);
    // Only trust the ink box when it still covers most of the paper, so a
    // single dense paragraph cannot crop the ingredients above it away.
    if (right - left >= box.width * 0.5 && bottom - top >= box.height * 0.5) {
      box = { left, top, width: right - left, height: bottom - top };
    }
  }

  // A crop that would throw away most of the frame means the detector found a
  // small block of ink, not the page edge. Keep the full photo instead.
  if (box.width < analysis.width * 0.3 || box.height < analysis.height * 0.3) return page;

  const scaleX = page.width / analysis.width;
  const scaleY = page.height / analysis.height;
  const marginX = Math.round(box.width * 0.015 * scaleX);
  const marginY = Math.round(box.height * 0.015 * scaleY);
  const left = Math.max(0, Math.round(box.left * scaleX) - marginX);
  const top = Math.max(0, Math.round(box.top * scaleY) - marginY);
  const right = Math.min(page.width, Math.round((box.left + box.width) * scaleX) + marginX);
  const bottom = Math.min(page.height, Math.round((box.top + box.height) * scaleY) + marginY);
  const region: Region = { left, top, width: right - left, height: bottom - top };
  // Tesseract.js aborts on a 2400x3200 page (its wasm heap), so the upscale is
  // capped by total pixels as well as by width.
  const widthScale = MAX_RECIPE_OCR_WIDTH / Math.max(1, region.width);
  const pixelScale = Math.sqrt(MAX_RECIPE_OCR_PIXELS / Math.max(1, region.width * region.height));
  const scale = Math.min(2.4, Math.max(1, Math.min(widthScale, pixelScale)));
  return cropCanvas(page, region, scale);
}

type OcrWorker = Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>>;
type OcrPsm = NonNullable<Parameters<OcrWorker["setParameters"]>[0]["tessedit_pageseg_mode"]>;

async function recognizeRecipePage(
  worker: OcrWorker,
  prepared: HTMLCanvasElement | File,
  psm: { SINGLE_COLUMN: OcrPsm; SPARSE_TEXT: OcrPsm },
  setPhase: (start: number, span: number) => void,
  onRawText?: (text: string, meta: { confidence: number }) => void,
): Promise<string> {
  if (!(prepared instanceof HTMLCanvasElement)) {
    await worker.setParameters({
      tessedit_pageseg_mode: psm.SINGLE_COLUMN,
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    });
    const plain = await worker.recognize(prepared);
    onRawText?.(plain.data.text, { confidence: plain.data.confidence });
    return cleanNotebookTextReport(plain.data.text).text;
  }

  const page = tightenRecipePage(prepared);
  const analysis = analysePage(page);
  // A blue ballpoint page reads best on the minimum channel; let the measured
  // ink colour decide which variant runs first.
  const preferInk = (analysis?.bluish ?? 0) > 16;
  const buildVariant = (ink: boolean) => (ink ? inkCanvas(page) : normalizeCanvas(page));

  await worker.setParameters({
    // A notebook page is one column of handwriting; SINGLE_COLUMN keeps the
    // rows in reading order, which the local parser relies on.
    tessedit_pageseg_mode: psm.SINGLE_COLUMN,
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });

  const passes: { text: string; score: number; confidence: number }[] = [];
  const average = (pass: { text: string; score: number }) =>
    pass.score / Math.max(1, pass.text.split("\n").filter((line) => line.trim()).length);

  setPhase(0.35, 0.4);
  const primary = buildVariant(preferInk);
  const first = await worker.recognize(primary);
  passes.push({ text: first.data.text, score: scoreRecipeText(first.data.text), confidence: first.data.confidence });

  // Only spend the second preparation and pass when the first reading is thin.
  // Most pages are decided by the variant chosen from the ink colour.
  if (average(passes[0]) < 1.6) {
    setPhase(0.7, 0.2);
    const second = await worker.recognize(buildVariant(!preferInk));
    passes.push({ text: second.data.text, score: scoreRecipeText(second.data.text), confidence: second.data.confidence });
  }

  passes.sort((a, b) => b.score - a.score);
  let best = passes[0];

  if (average(best) < 0.8) {
    // Handwriting spread over a ruled page: sparse mode keeps separate words
    // apart instead of merging rows into one blob.
    setPhase(0.9, 0.1);
    await worker.setParameters({
      tessedit_pageseg_mode: psm.SPARSE_TEXT,
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    });
    const sparse = await worker.recognize(primary);
    const candidate = {
      text: sparse.data.text,
      score: scoreRecipeText(sparse.data.text),
      confidence: sparse.data.confidence,
    };
    if (candidate.score > best.score) best = candidate;
  }

  if (import.meta.env.DEV) {
    console.debug(
      "[ocr] recipe passes",
      passes.map((pass) => ({ score: Math.round(pass.score), chars: pass.text.length })),
    );
  }

  onRawText?.(best.text, { confidence: best.confidence });
  return cleanNotebookTextReport(best.text).text;
}

function otsuThreshold(histogram: Uint32Array, total: number): number {
  let sum = 0;
  for (let value = 0; value < histogram.length; value++) sum += value * histogram[value];

  let backgroundWeight = 0;
  let backgroundSum = 0;
  let best = 0;
  let threshold = 127;

  for (let value = 0; value < histogram.length; value++) {
    backgroundWeight += histogram[value];
    if (!backgroundWeight) continue;
    const foregroundWeight = total - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += value * histogram[value];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (sum - backgroundSum) / foregroundWeight;
    const between = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (between > best) {
      best = between;
      threshold = value;
    }
  }
  return threshold;
}

/** Otsu binary copy. Handles the occasional inverted (dark paper) scan. */
function binaryCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const context = source.getContext("2d", { willReadFrequently: true });
  if (!context) return source;
  const image = context.getImageData(0, 0, source.width, source.height);
  const data = image.data;
  const histogram = new Uint32Array(256);
  const total = source.width * source.height;

  for (let index = 0; index < data.length; index += 4) histogram[data[index]]++;

  const threshold = otsuThreshold(histogram, total);
  let dark = 0;
  for (let value = 0; value <= threshold; value++) dark += histogram[value];
  const inverted = dark > total * 0.6;

  for (let index = 0; index < data.length; index += 4) {
    const isInk = inverted ? data[index] > threshold : data[index] <= threshold;
    const value = isInk ? 0 : 255;
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
    data[index + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return source;
}

export async function ocrImage(
  file: File,
  onProgress: (progress: number, status: string) => void,
  options: OcrOptions = {},
): Promise<string> {
  const mode = options.mode ?? "recipe";
  const { createWorker, PSM } = await import("tesseract.js");

  let phaseStart = 0;
  let phaseSpan = 0.25;
  const report = (message: { progress?: number; status?: string }) => {
    const progress = Math.max(0, Math.min(1, message.progress ?? 0));
    onProgress(Math.min(1, phaseStart + progress * phaseSpan), message.status ?? "");
  };
  const setPhase = (start: number, span: number) => {
    phaseStart = start;
    phaseSpan = span;
  };

  // The language is a property of the page, not of the interface: a Greek
  // household can run the English UI and photograph a Greek notebook, and a
  // recipe card can be written in English on a Greek page. Recognition
  // therefore always loads both models; `detectScript` reports what was found
  // instead of the caller guessing from the UI language.
  const languages = ["ell", "eng"];
  const worker = await createWorker(languages.join("+"), 1, {
    workerPath: "/tesseract/worker.min.js",
    corePath: "/tesseract/core",
    langPath: "/tesseract",
    gzip: true,
    logger: report,
  });

  try {
    const prepared = await prepareDocument(file, mode);
    if (mode === "recipe") {
      setPhase(0.25, 0.75);
      return await recognizeRecipePage(worker, prepared, PSM, setPhase, options.onRawText);
    }
    const receiptPage = mode === "receipt" && prepared instanceof HTMLCanvasElement ? prepared : null;

    setPhase(0.25, receiptPage ? 0.25 : 0.75);
    await worker.setParameters({
      // Receipts are a single column with right-aligned prices. Keeping that
      // assumption preserves top-to-bottom order, which the merge step needs.
      tessedit_pageseg_mode: PSM.SINGLE_COLUMN,
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    });
    const full = await worker.recognize(prepared, {}, { blocks: Boolean(receiptPage) });
    const fullText = full.data.text;
    if (!receiptPage) return fullText;

    const fullSection = extractProductSectionText(fullText);
    if (fullSection == null) return fullText;

    const page = full.data as unknown as PageLike;
    const region = detectProductRegion(page, receiptPage.width, receiptPage.height);
    if (!region) return fullText;

    const scale = productScale(region);
    const crop = cropCanvas(receiptPage, region, scale);
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    });

    const candidates: Candidate[] = [
      {
        variant: "full",
        text: fullSection,
        score: scoreProductText(fullSection),
        confidence: full.data.confidence,
      },
    ];

    setPhase(0.5, 0.25);
    const grayscale = await worker.recognize(crop);
    candidates.push({
      variant: "grayscale",
      text: grayscale.data.text,
      score: scoreProductText(grayscale.data.text),
      confidence: grayscale.data.confidence,
    });

    setPhase(0.75, 0.25);
    try {
      const binary = await worker.recognize(binaryCanvas(crop));
      candidates.push({
        variant: "binary",
        text: binary.data.text,
        score: scoreProductText(binary.data.text),
        confidence: binary.data.confidence,
      });
    } catch {
      // The grayscale candidate is enough when the binary pass runs out of memory.
    }

    if (import.meta.env.DEV) {
      console.debug(
        "[ocr] product candidates",
        candidates.map(({ variant, score, confidence }) => ({
          variant,
          score: Math.round(score * 10) / 10,
          confidence: Math.round(confidence * 10) / 10,
        })),
      );
    }

    const fullCandidate = candidates[0];
    const best = candidates
      .slice(1)
      .sort((a, b) => b.score - a.score || b.confidence - a.confidence)[0];

    // Only replace the full pass when the dedicated crop is clearly better. A
    // small score difference is usually OCR noise, and the full pass has more
    // context for the parser.
    const selected = !best || best.score < fullCandidate.score + 2 ? fullText : spliceProductText(fullText, best.text);
    options.onCandidates?.([...new Set([selected, fullText, ...candidates.slice(1).map((candidate) => spliceProductText(fullText, candidate.text))])]);
    return selected;
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}
