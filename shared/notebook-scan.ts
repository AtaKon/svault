/**
 * Helpers for photographed handwritten recipe pages.
 *
 * A page torn from a Greek diary is a much harder scan than a printed card:
 * the photo is usually shot at an angle, the paper is ruled, the ink is blue,
 * lighting is uneven, and a printed planner frame surrounds the writing (hours
 * down the left edge, weekday/month headings, week numbers, saints' names and
 * printer codes). Tesseract happily reads all of it and mixes it into the
 * recipe, which then confuses ingredient parsing and the AI cleanup step.
 *
 * Everything here is pure and DOM-free so the browser OCR pipeline, the API and
 * the tests share one implementation:
 *
 * - `detectPaperRegion` finds the bright sheet, so the desk, the spine shadow
 *   and the neighbouring page can be cropped away before recognition.
 * - `detectContentBounds` tightens that box to the written area, using local
 *   contrast (strokes and rules) rather than absolute brightness, so cream
 *   paper on a beige desk still separates.
 * - `estimateSkewDegrees` finds how far the ruled lines tilt so the browser can
 *   straighten the page before recognition.
 * - `cleanNotebookText` removes the printed planner furniture and OCR
 *   duplicates, leaving the handwritten recipe in reading order.
 */

export interface ScanRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Tesseract.js runs out of wasm heap on very large pages: a 2400x3200 photo
 * aborts the worker ("Too many properties to enumerate") instead of returning
 * text. Real 1500x2000 phone photos stay well under this limit.
 */
export const MAX_RECIPE_OCR_PIXELS = 5_500_000;
export const MAX_RECIPE_OCR_WIDTH = 2000;

/**
 * Scale for a cropped recipe page so the worker stays inside both budgets.
 * Small crops are upscaled (capped at 2.4×), but a crop that is already larger
 * than the width or pixel cap is downscaled. Straightening a page grows its
 * canvas, so an oversized crop is a real path, not a theoretical one.
 */
export function recipeOcrScale(width: number, height: number): number {
  return Math.min(
    2.4,
    MAX_RECIPE_OCR_WIDTH / Math.max(1, width),
    Math.sqrt(MAX_RECIPE_OCR_PIXELS / Math.max(1, width * height)),
  );
}

/**
 * Scale for a frame that is not being cropped: it may only shrink. The
 * scanner returns the whole photo when the content box looks like a detector
 * miss, but straightening grows that frame, so a "keep everything" result can
 * still be over the worker budget and must be downscaled before recognition.
 */
export function recipeOcrFitScale(width: number, height: number): number {
  return Math.min(1, recipeOcrScale(width, height));
}

/** A pixel is ink when it is clearly darker than its neighbourhood. */
const INK_CONTRAST = 20;
/** How dark a pixel must be on its own before a faint contrast still counts. */
const INK_ABSOLUTE = 90;
const MIN_INK_PIXELS = 40;

function boxBlur(luma: Uint8ClampedArray, width: number, height: number, radius: number): Uint32Array {
  const integral = new Uint32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    const row = y * width;
    const previous = y * (width + 1);
    const current = (y + 1) * (width + 1);
    for (let x = 0; x < width; x++) {
      rowSum += luma[row + x];
      integral[current + x + 1] = integral[previous + x + 1] + rowSum;
    }
  }

  const blurred = new Uint32Array(width * height);
  for (let y = 0; y < height; y++) {
    const top = Math.max(0, y - radius);
    const bottom = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width - 1, x + radius);
      const sum =
        integral[(bottom + 1) * (width + 1) + right + 1] -
        integral[top * (width + 1) + right + 1] -
        integral[(bottom + 1) * (width + 1) + left] +
        integral[top * (width + 1) + left];
      const count = (right - left + 1) * (bottom - top + 1);
      blurred[y * width + x] = Math.round(sum / count);
    }
  }
  return blurred;
}

/** Local-contrast ink mask: rules, handwriting and stamps, not the desk. */
export function buildInkMask(luma: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const radius = Math.max(2, Math.round(Math.min(width, height) / 60));
  const blurred = boxBlur(luma, width, height, radius);
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index++) {
    const value = luma[index];
    const contrast = blurred[index] - value;
    if (contrast >= INK_CONTRAST || (value < INK_ABSOLUTE && contrast >= 8)) mask[index] = 1;
  }
  return mask;
}

function projectionBounds(counts: Uint32Array): { start: number; end: number } | null {
  let peak = 0;
  for (const value of counts) if (value > peak) peak = value;
  if (peak <= 0) return null;

  // A page edge only needs a sliver of ink; the 2% floor keeps a single dust
  // speck from stretching the crop back to the photo border.
  const floor = Math.max(1, Math.floor(peak * 0.02));
  let start = -1;
  let end = -1;
  for (let index = 0; index < counts.length; index++) {
    if (counts[index] >= floor) {
      if (start < 0) start = index;
      end = index;
    }
  }
  if (start < 0) return null;
  return { start, end };
}

/**
 * Bounding box of the written area, ignoring the desk and the neighbouring
 * page. Returns null when the frame is essentially empty.
 */
export function detectContentBounds(luma: Uint8ClampedArray, width: number, height: number): ScanRegion | null {
  if (width < 8 || height < 8) return null;
  const mask = buildInkMask(luma, width, height);

  const columns = new Uint32Array(width);
  const rows = new Uint32Array(height);
  let ink = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!mask[row + x]) continue;
      columns[x]++;
      rows[y]++;
      ink++;
    }
  }
  if (ink < MIN_INK_PIXELS) return null;

  const horizontal = projectionBounds(columns);
  const vertical = projectionBounds(rows);
  if (!horizontal || !vertical) return null;

  return {
    left: horizontal.start,
    top: vertical.start,
    width: horizontal.end - horizontal.start + 1,
    height: vertical.end - vertical.start + 1,
  };
}

function tan(degrees: number): number {
  return Math.tan((degrees * Math.PI) / 180);
}

/**
 * Bounding box of the bright paper sheet, so the desk, the deep shadow at the
 * spine and the dark table around the notebook are trimmed away. Uses coarse
 * cell means so stains, rules and handwriting do not move the border.
 *
 * Returns null when the whole frame already looks like one sheet of paper.
 */
export function detectPaperRegion(luma: Uint8ClampedArray, width: number, height: number): ScanRegion | null {
  if (width < 24 || height < 24) return null;
  const cell = 8;
  const columns = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const means = new Float32Array(columns * rows);

  for (let row = 0; row < rows; row++) {
    const top = row * cell;
    const bottom = Math.min(height, top + cell);
    for (let column = 0; column < columns; column++) {
      const left = column * cell;
      const right = Math.min(width, left + cell);
      let sum = 0;
      let count = 0;
      for (let y = top; y < bottom; y++) {
        const offset = y * width;
        for (let x = left; x < right; x++) {
          sum += luma[offset + x];
          count++;
        }
      }
      means[row * columns + column] = count ? sum / count : 0;
    }
  }

  const sorted = Float32Array.from(means).sort();
  // The page is the bright majority; the 75th percentile is its paper tone even
  // when a third of the frame is desk or shadow.
  const paper = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
  const threshold = paper - 32;

  const columnScore = new Float32Array(columns);
  const rowScore = new Float32Array(rows);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      if (means[row * columns + column] < threshold) continue;
      columnScore[column]++;
      rowScore[row]++;
    }
  }

  const span = (scores: Float32Array) => {
    const minimum = scores.length * 0.5;
    let start = -1;
    let end = -1;
    for (let index = 0; index < scores.length; index++) {
      if (scores[index] >= minimum) {
        if (start < 0) start = index;
        end = index;
      }
    }
    return start < 0 ? null : { start, end };
  };

  const horizontal = span(columnScore);
  const vertical = span(rowScore);
  if (!horizontal || !vertical) return null;

  const region: ScanRegion = {
    left: horizontal.start * cell,
    top: vertical.start * cell,
    width: Math.min(width, (horizontal.end + 1) * cell) - horizontal.start * cell,
    height: Math.min(height, (vertical.end + 1) * cell) - vertical.start * cell,
  };
  // Never crop away most of the photo on a guess.
  if (region.width < width * 0.5 || region.height < height * 0.5) return null;
  if (region.width >= width * 0.98 && region.height >= height * 0.98) return null;
  return region;
}

/** Projection sharpness for one candidate tilt. Ruled lines peak sharply. */
function projectionScore(
  points: Int32Array,
  padding: number,
  centerX: number,
  degrees: number,
  counts: Float64Array,
): number {
  counts.fill(0);
  const slope = tan(degrees);
  for (let index = 0; index < points.length; index += 2) {
    const shifted = Math.round(points[index + 1] - (points[index] - centerX) * slope) + padding;
    if (shifted >= 0 && shifted < counts.length) counts[shifted]++;
  }
  let score = 0;
  for (let index = 0; index < counts.length; index++) score += counts[index] * counts[index];
  return score;
}

/**
 * Tilt of the written lines in degrees, positive when they run downhill to the
 * right. Rotate the image by `-result` to straighten it. Returns 0 when the page
 * has no line structure worth correcting.
 *
 * Only long horizontal ink runs are measured. Ruled notebook lines and
 * underlines follow the page geometry, while handwriting and shadows do not;
 * mixing them in lets a page that is genuinely tilted score best at 0°.
 */
export function estimateSkewDegrees(
  luma: Uint8ClampedArray,
  width: number,
  height: number,
  maxDegrees = 8,
): number {
  if (width < 16 || height < 16) return 0;
  const mask = buildInkMask(luma, width, height);

  const minimumRun = Math.max(12, Math.round(width * 0.15));
  const longRuns = new Uint8Array(mask.length);
  let runPoints = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let x = 0;
    while (x < width) {
      if (!mask[row + x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < width && mask[row + x]) x++;
      if (x - start >= minimumRun) {
        for (let runX = start; runX < x; runX += 2) longRuns[row + runX] = 1;
        runPoints += Math.ceil((x - start) / 2);
      }
    }
  }

  const source = runPoints >= 40 ? longRuns : mask;
  const points: number[] = [];
  for (let y = 0; y < height; y += 2) {
    const row = y * width;
    for (let x = 0; x < width; x += 2) {
      if (source[row + x]) points.push(x, y);
    }
  }
  if (points.length < 100) return 0;

  const padding = Math.ceil(width * tan(maxDegrees)) + 2;
  const counts = new Float64Array(height + padding * 2 + 2);
  const centerX = width / 2;
  const packed = Int32Array.from(points);

  let best = 0;
  let bestScore = projectionScore(packed, padding, centerX, 0, counts);
  const baseline = bestScore;

  for (let degrees = -maxDegrees; degrees <= maxDegrees + 0.001; degrees += 0.5) {
    const score = projectionScore(packed, padding, centerX, degrees, counts);
    if (score > bestScore) {
      bestScore = score;
      best = degrees;
    }
  }

  // Require a real peak: a page whose lines are already level, or a photo with
  // no rules at all, should not be rotated on noise.
  if (baseline > 0 && bestScore < baseline * 1.15) return 0;
  if (Math.abs(best) < 1) return 0;

  let refined = best;
  let refinedScore = bestScore;
  for (let degrees = best - 0.4; degrees <= best + 0.4 + 0.001; degrees += 0.1) {
    const score = projectionScore(packed, padding, centerX, degrees, counts);
    if (score > refinedScore) {
      refinedScore = score;
      refined = degrees;
    }
  }
  return Math.round(refined * 100) / 100;
}

function foldForNoise(line: string): string {
  return line
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .trim();
}

const MONTH_HEADER =
  /^(?:ΙΑΝΟΥΑΡΙΟΣ|ΦΕΒΡΟΥΑΡΙΟΣ|ΜΑΡΤΙΟΣ|ΑΠΡΙΛΙΟΣ|ΜΑΙΟΣ|ΜΑΙ|ΙΟΥΝΙΟΣ|ΙΟΥΛΙΟΣ|ΑΥΓΟΥΣΤΟΣ|ΣΕΠΤΕΜΒΡΙΟΣ|ΟΚΤΩΒΡΙΟΣ|ΝΟΕΜΒΡΙΟΣ|ΔΕΚΕΜΒΡΙΟΣ|JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s*(?:\/\s*[\p{L}]+)?$/u;
const WEEKDAY_HEADER =
  /^(?:ΔΕΥΤΕΡΑ|ΤΡΙΤΗ|ΤΕΤΑΡΤΗ|ΠΕΜΠΤΗ|ΠΑΡΑΣΚΕΥΗ|ΣΑΒΒΑΤΟ|ΚΥΡΙΑΚΗ|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)\s*(?:\/\s*[\p{L}]+)?$/u;
/** Printed diary codes such as "41-325" or the MD print run. */
const PLANNER_CODE = /^(?:\d{1,3}\s*-\s*\d{1,3}|M[DO0][A-Z0-9]{4,})$/i;
const SAINT_LINE = /^[†‡✝✞☦]/u;
const GUTTER_TIME = /^(\d{1,2})\s*[:.]\s*(\d{2})(?!\d)/;
const TRAILING_TIME = /\s+\d{1,2}\s*[:.]\s*(\d{2})$/;

/**
 * A row that starts with an amount is recipe content, never planner furniture.
 *
 * The boundary is Unicode-aware on purpose: `\b` is ASCII-only, so it never
 * matched after a Greek word or a fraction, and it also failed after the first
 * digit of a multi-digit quantity ("160" looked like "1" followed by a word
 * character). Only single digits ever counted as content, which kept
 * `splitRecipeSections` from seeing ordinary rows such as "160 γραμμ. βούτυρο".
 */
const CONTENT_START =
  /^\s*(?:\d+|[½¼¾⅓⅔]|μισ[όήο]|ένα|δύο|τρία|τέσσερα|πέντε|half|one|two|three)(?![\p{L}\p{N}])/iu;

function letterCount(line: string): number {
  return (line.match(/\p{L}/gu) ?? []).length;
}

/**
 * True for the printed furniture of a diary page: hour gutter, weekday and
 * month headings, week-number grids, printer codes, saints' names, icons.
 *
 * Deliberately conservative: anything that starts with an amount is kept, so a
 * misread ingredient ("17 αυγά") can never be thrown away as a page number.
 */
export function isPlannerNoiseLine(raw: string): boolean {
  const line = raw.trim().replace(/^[|¦•·*_>»\s]+/u, "");
  if (!line) return true;
  if (CONTENT_START.test(line) && letterCount(line) > 0) return false;
  const folded = foldForNoise(line);

  if (MONTH_HEADER.test(folded) || WEEKDAY_HEADER.test(folded)) return true;
  if (PLANNER_CODE.test(folded)) return true;
  if (SAINT_LINE.test(line)) return true;
  if (/^[^\p{L}\p{N}]+$/u.test(line)) return true;

  // Printed weekday-initial row: "Α Τ Τ Π Π Σ Κ".
  const tokens = folded.split(/\s+/).filter(Boolean);
  if (tokens.length >= 3 && tokens.every((token) => token.length === 1 && "ΑΤΠΣΚ".includes(token))) return true;

  // Week-number grid rows like "5 6 7 8 9" or "3 10 17 24".
  if (tokens.length >= 2 && tokens.every((token) => /^\d{1,3}$/.test(token))) return true;

  // A lone printed day or page number. Fractions ("1/2") and decimals ("2.5")
  // are left alone: they are quantities, not page furniture.
  if (letterCount(line) === 0 && tokens.length === 1 && /^\d{1,4}$/.test(tokens[0])) return true;

  return false;
}

function stripGutter(line: string): string {
  let rest = line.replace(/^[|¦•·*_>«»"'\s]+/u, "");
  const leading = GUTTER_TIME.exec(rest);
  if (leading) {
    const hour = Number(leading[1]);
    const minute = Number(leading[2]);
    if (hour <= 23 && minute <= 59) rest = rest.slice(leading[0].length).replace(/^[\s|¦:.\-–]+/u, "");
  }
  // The hour column is printed on the left of the page; the same times also
  // leak in from the right margin, so trim a trailing one when text remains.
  const trailing = TRAILING_TIME.exec(rest);
  if (trailing && letterCount(rest.slice(0, trailing.index)) >= 2) rest = rest.slice(0, trailing.index);
  return rest.trim();
}

/** Why a line was dropped, so the UI can show what cleanup removed. */
export interface RemovedLine {
  line: string;
  reason: "planner" | "duplicate" | "empty";
}

export interface NotebookCleanResult {
  text: string;
  removed: RemovedLine[];
}

/**
 * Strip OCR duplicates and planner noise from a photographed notebook page,
 * and report every line that was removed. Recognition is lossy on handwriting,
 * so callers keep the raw text too: cleanup must never be the only copy.
 */
export function cleanNotebookTextReport(text: string): NotebookCleanResult {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  const removed: RemovedLine[] = [];

  for (const raw of lines) {
    let line = stripGutter(raw);
    if (!line.trim()) {
      if (raw.trim()) removed.push({ line: raw.trim(), reason: "empty" });
      continue;
    }
    if (isPlannerNoiseLine(line)) {
      removed.push({ line: line.trim(), reason: "planner" });
      continue;
    }
    // Collapse the long runs OCR emits, but keep a wide gap as an ingredient
    // separator for the local parser.
    line = line.replace(/\s{4,}/g, "   ").replace(/\s+$/u, "").trim();
    if (!line) continue;
    // Overlapping OCR passes repeat a row back to back. Only collapse an
    // immediately repeated line: a line that comes back later is part of the
    // recipe (two "1 ποτήρι νερό" steps) and is kept.
    const previous = kept[kept.length - 1];
    if (previous && previous.toLowerCase() === line.toLowerCase()) {
      removed.push({ line, reason: "duplicate" });
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), removed };
}

/**
 * Strip OCR duplicates and planner noise from a photographed notebook page.
 * Idempotent, so the API can clean text the browser already cleaned.
 */
export function cleanNotebookText(text: string): string {
  return cleanNotebookTextReport(text).text;
}

/* ------------------------------------------------------- script and sections */

const GREEK_LETTER = /[\u0370-\u03ff\u1f00-\u1fff]/gu;
const LATIN_LETTER = /[A-Za-z]/g;

/** Which alphabet dominates a reading. Used instead of the UI language. */
export function detectScript(text: string): "greek" | "latin" | "mixed" | "none" {
  const greek = (text.match(GREEK_LETTER) ?? []).length;
  const latin = (text.match(LATIN_LETTER) ?? []).length;
  if (greek + latin < 12) return "none";
  const ratio = greek / (greek + latin);
  if (ratio >= 0.75) return "greek";
  if (ratio <= 0.25) return "latin";
  return "mixed";
}

/**
 * How much a full reading looks like a recipe rather than ruled paper. Tesseract
 * returns high confidence while reading the rules themselves as "ΞΞΞ" or "—",
 * so the scanner scores the text instead of trusting `data.confidence`.
 */
export function scoreRecipeText(text: string): number {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  let score = 0;

  for (const line of lines) {
    if (isPlannerNoiseLine(line)) score -= 2;
    const greek = (line.match(GREEK_LETTER) ?? []).length;
    const letters = (line.match(/\p{L}/gu) ?? []).length;
    if (letters >= 2) score += 1 + Math.min(greek, 12) * 0.1;
    if (/^(?:υλικ|συστατικ|εκτελεσ|εκτέλεσ|οδηγι|μεθοδ|παρασκευ|instructions?|ingredients?|method|steps)/iu.test(line)) {
      score += 6;
    }
    // Quantity followed by a word is the shape of an ingredient or a step.
    if (/^\d{1,3}(?:[.,]\d+)?\s+\p{L}/u.test(line)) score += 2;
    if (/^\d{1,2}\s*[:.]\s*\d{2}\b/u.test(line)) score -= 2;
    if (/[|¦~^`{}<>©®@]/u.test(line)) score -= 1;
  }
  return score;
}

/**
 * Fraction of letter sequences with a basic word-like shape. This does not
 * check a dictionary and cannot establish whether OCR is correct.
 */
export function readableWordRatio(text: string): number {
  const words = text.match(/\p{L}{2,}/gu) ?? [];
  if (!words.length) return 0;
  const readable = words.filter((word) => {
    const letters = [...word];
    const distinct = new Set(letters.map((letter) => letter.toLowerCase())).size;
    return letters.length >= 3 && distinct >= 2 && !/^(.)\1+$/u.test(word);
  }).length;
  return readable / words.length;
}

/** Notes above a title ("Μισή δόση", "half batch") are not recipe titles. */
const TITLE_NOTE =
  /^(?:(?:μισ[ήηό]|διπλ[ήη]|μία|μια|μισό|μισο|half|double)\s*)?(?:δόσ|δοσ|μερίδ|μεριδ|portion|batch|servings?)[\p{L}]*$|^για\s+\d+\s+(?:άτομα|ατομα|μερίδες|μεριδες|persons?|people)$/iu;
const SECTION_HEADER = /^(?:υλικά|υλικα|συστατικά|συστατικα|εκτέλεση|εκτελεση|οδηγίες|οδηγιες|παρασκευή|παρασκευη|μέθοδος|μεθοδος|ingredients?|method|instructions?|steps?|directions?)$/iu;
const STEP_SENTENCE = /(?:^|\s)(?:ρίχνουμε|βάζουμε|ανακατεύουμε|χτυπάμε|ψήνουμε|ζυμώνουμε|λιώνουμε|βράζουμε|mix|stir|bake|whisk|knead|add|pour|heat|cook)\b/iu;

export interface RecipeSection {
  title: string;
  /** Cleaned page lines that belong to this recipe, title first. */
  lines: string[];
  /** Index of the title line inside `lines`. */
  startLine: number;
}

function isTitleCandidate(line: string): boolean {
  const trimmed = line.trim();
  const letters = letterCount(trimmed);
  if (letters < 3 || trimmed.length > 70) return false;
  // A written title starts with a capital. Ingredient rows and wrapped steps do
  // not, and requiring it keeps "λίγο αλάτι" from starting a phantom recipe.
  if (!/^\p{Lu}/u.test(trimmed)) return false;
  if (/^\s*(?:\d|[½¼¾])/.test(trimmed)) return false;
  if (TITLE_NOTE.test(trimmed) || SECTION_HEADER.test(trimmed)) return false;
  if (/[.!?;:]$/.test(trimmed)) return false;
  if (trimmed.split(/\s+/).length > 8) return false;
  if (STEP_SENTENCE.test(trimmed)) return false;
  if (/^(?:για|for)\s/i.test(trimmed)) return false;
  return true;
}

/**
 * Split one page into the recipes written on it.
 *
 * A handwritten page often holds two or three recipes stacked in the same
 * column (a tsoureki above the kourou biscuits, a cake plus its icing). Merging
 * them produces one absurd ingredient list, so the scanner offers each section
 * separately and lets the reader choose. A section only starts at a short
 * title-like line that is followed by an amount line before the next title, and
 * the page is only split when at least two such starts exist.
 */
export function splitRecipeSections(text: string): RecipeSection[] {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 3) return [];

  const starts: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!isTitleCandidate(line)) continue;
    // Look ahead for the ingredients this title introduces.
    let follows = false;
    for (let next = index + 1; next < Math.min(lines.length, index + 8); next++) {
      const candidate = lines[next];
      if (isTitleCandidate(candidate) && next > index + 1) break;
      if (CONTENT_START.test(candidate) && letterCount(candidate) > 0) {
        follows = true;
        break;
      }
    }
    if (follows) starts.push(index);
  }

  if (starts.length < 2) return [];

  const sections: RecipeSection[] = [];
  for (let position = 0; position < starts.length; position++) {
    const titleIndex = starts[position];
    // Anything above the first title (a "half batch" note, the diary date) is
    // kept with the first recipe instead of being silently dropped.
    const start = position === 0 ? 0 : titleIndex;
    const end = position + 1 < starts.length ? starts[position + 1] : lines.length;
    const slice = lines.slice(start, end);
    if (!slice.some((line) => CONTENT_START.test(line) && letterCount(line) > 0)) continue;
    sections.push({ title: lines[titleIndex], lines: slice, startLine: titleIndex - start });
  }
  return sections.length >= 2 ? sections : [];
}

/* --------------------------------------------------------------- ink helpers */

function histogramValue(histogram: Uint32Array, total: number, fraction: number): number {
  const target = Math.max(1, Math.floor(total * fraction));
  let seen = 0;
  for (let value = 0; value < histogram.length; value++) {
    seen += histogram[value];
    if (seen >= target) return value;
  }
  return 255;
}

/**
 * Grayscale plus the gentle percentile stretch the browser scanner applies
 * before recognition. Shared with the OCR benchmark so a measured run describes
 * the pixels the scanner actually sends to Tesseract. `rgba` is 8-bit RGBA.
 */
export function normaliseLumaFromRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  pixelCount: number,
): Uint8ClampedArray {
  const values = new Uint8ClampedArray(pixelCount);
  const histogram = new Uint32Array(256);
  for (let pixel = 0, index = 0; pixel < pixelCount; pixel++, index += 4) {
    const value = Math.round(0.299 * rgba[index] + 0.587 * rgba[index + 1] + 0.114 * rgba[index + 2]);
    values[pixel] = value;
    histogram[value]++;
  }
  const low = histogramValue(histogram, pixelCount, 0.01);
  const high = histogramValue(histogram, pixelCount, 0.99);
  const range = high - low;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    let value = values[pixel];
    if (range >= 32) value = ((value - low) * 255) / range;
    // A small contrast boost keeps anti-aliased Greek glyphs readable.
    values[pixel] = Math.max(0, Math.min(255, Math.round((value - 128) * 1.12 + 128)));
  }
  return values;
}

/**
 * Minimum-channel grayscale: blue ballpoint, black ink and pencil stay dark
 * while cream paper and yellow age stains stay light. `rgba` is 8-bit RGBA.
 */
export function inkLumaFromRgba(rgba: Uint8ClampedArray | Uint8Array, pixelCount: number): Uint8ClampedArray {
  const values = new Uint8ClampedArray(pixelCount);
  const histogram = new Uint32Array(256);
  for (let pixel = 0, index = 0; pixel < pixelCount; pixel++, index += 4) {
    const value = Math.min(rgba[index], rgba[index + 1], rgba[index + 2]);
    values[pixel] = value;
    histogram[value]++;
  }
  let low = 0;
  let high = 255;
  let seen = 0;
  const lowTarget = pixelCount * 0.02;
  const highTarget = pixelCount * 0.98;
  for (let value = 0; value < 256; value++) {
    seen += histogram[value];
    if (seen >= lowTarget) {
      low = value;
      break;
    }
  }
  seen = 0;
  for (let value = 0; value < 256; value++) {
    seen += histogram[value];
    if (seen >= highTarget) {
      high = value;
      break;
    }
  }
  const range = high - low;
  if (range < 24) return values;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    values[pixel] = Math.max(0, Math.min(255, Math.round(((values[pixel] - low) * 255) / range)));
  }
  return values;
}

/** Average blue-minus-red of the darkest pixels. Blue ballpoint scores high. */
export function measureBlueInk(rgba: Uint8ClampedArray | Uint8Array, pixelCount: number): number {
  const histogram = new Uint32Array(256);
  const values = new Uint8ClampedArray(pixelCount);
  for (let pixel = 0, index = 0; pixel < pixelCount; pixel++, index += 4) {
    const value = Math.min(rgba[index], rgba[index + 1], rgba[index + 2]);
    values[pixel] = value;
    histogram[value]++;
  }
  const target = pixelCount * 0.12;
  let seen = 0;
  let cutoff = 0;
  for (let value = 0; value < 256; value++) {
    seen += histogram[value];
    if (seen >= target) {
      cutoff = value;
      break;
    }
  }
  let sum = 0;
  let count = 0;
  for (let pixel = 0, index = 0; pixel < pixelCount; pixel++, index += 4) {
    if (values[pixel] > cutoff) continue;
    sum += rgba[index + 2] - rgba[index];
    count++;
  }
  return count ? sum / count : 0;
}
