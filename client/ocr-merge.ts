/**
 * Merges per-page receipt OCR into one clean text block.
 *
 * When a long receipt is photographed in several overlapping shots, the same
 * printed lines appear at the bottom of one page and the top of the next. This
 * finds the largest trustworthy suffix/prefix overlap between consecutive
 * pages and drops the repeated lines, so the parser sees each product once.
 *
 * Conservative by design: a single short match is not enough to delete
 * anything, because receipts legitimately repeat lines such as "TOTAL".
 */

export interface MergedOcrText {
  text: string;
  /** Lines removed as repeated overlap between pages. */
  removedLines: number;
}

const MAX_OVERLAP_LINES = 60;
const MIN_OVERLAP_LINES = 2;
const SINGLE_LINE_MIN_LENGTH = 16;
const MAX_LINE_LENGTH = 240;
/** A line this close is treated as the same printed row. */
const LINE_MATCH = 0.85;
/** Stricter value used to prove the block is a real re-shoot, not similar rows. */
const NEAR_EXACT = 0.97;

function normalize(line: string): string {
  return line
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;

  let previous = new Array<number>(n + 1);
  let current = new Array<number>(n + 1);
  for (let column = 0; column <= n; column++) previous[column] = column;

  for (let row = 1; row <= m; row++) {
    current[0] = row;
    const code = a.charCodeAt(row - 1);
    for (let column = 1; column <= n; column++) {
      const cost = code === b.charCodeAt(column - 1) ? 0 : 1;
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + cost);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[n];
}

/** 0..1 similarity that tolerates the small disagreements between two OCR runs. */
function lineSimilarity(left: string, right: string): number {
  const a = normalize(left).slice(0, MAX_LINE_LENGTH);
  const b = normalize(right).slice(0, MAX_LINE_LENGTH);
  if (a === b) return 1;
  if (!a || !b) return 0;
  const shortest = Math.min(a.length, b.length);
  if (shortest < 4) return 0;
  // Lines of very different length are not the same printed row; skip the
  // edit-distance pass, which is the expensive part of the overlap search.
  if (Math.max(a.length, b.length) > shortest * 1.6 + 2) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function overlapLength(previous: string[], next: string[]): number {
  const limit = Math.min(previous.length, next.length, MAX_OVERLAP_LINES);
  for (let size = limit; size >= MIN_OVERLAP_LINES; size--) {
    // The first overlapping row must line up before comparing the whole block;
    // this keeps the descending size search cheap when there is no overlap.
    const anchor = lineSimilarity(previous[previous.length - size], next[0]);
    if (anchor < 0.45) continue;

    // Require most lines to be near-exact. Similar-looking but different rows
    // (two products with a one-digit price change) would otherwise look like a
    // re-shot page and silently delete a real product line.
    let total = anchor;
    let strong = anchor >= LINE_MATCH ? 1 : 0;
    let nearExact = anchor >= NEAR_EXACT ? 1 : 0;
    for (let index = 1; index < size; index++) {
      const similarity = lineSimilarity(previous[previous.length - size + index], next[index]);
      total += similarity;
      if (similarity >= LINE_MATCH) strong++;
      if (similarity >= NEAR_EXACT) nearExact++;
    }
    const average = total / size;
    if (strong === size && average >= 0.9 && (nearExact >= Math.ceil(size / 2) || average >= 0.96)) return size;
  }

  // A single near-identical, substantial line (the overlapping page starts on
  // a clean boundary) is enough to splice, while short rows like "TOTAL" are not.
  if (previous.length && next.length) {
    const single = lineSimilarity(previous[previous.length - 1], next[0]);
    if (single >= 0.95 && normalize(next[0]).length >= SINGLE_LINE_MIN_LENGTH) return 1;
  }
  return 0;
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export function mergeOcrTexts(pages: string[]): MergedOcrText {
  const merged: string[] = [];
  let removedLines = 0;

  for (const page of pages) {
    const lines = splitLines(page);
    if (!lines.length) continue;
    const overlap = overlapLength(merged, lines);
    removedLines += overlap;
    merged.push(...lines.slice(overlap));
  }

  return { text: merged.join("\n"), removedLines };
}

/** Only compare complete alternative passes, and never override edited text. */
export function mergeOcrCandidates(pages: { text: string; candidates?: string[] }[], text: string): string[] {
  if (!pages.length || text !== mergeOcrTexts(pages.map((page) => page.text)).text) return [];
  const alternatives: string[] = [];
  for (const index of [1, 2]) {
    if (!pages.every((page) => Boolean(page.candidates?.[index]?.trim()))) continue;
    const candidate = mergeOcrTexts(pages.map((page) => page.candidates![index])).text;
    if (candidate && candidate !== text && !alternatives.includes(candidate)) alternatives.push(candidate);
  }
  return alternatives;
}
