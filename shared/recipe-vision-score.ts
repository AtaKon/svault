/**
 * Explicit scoring for the recipe vision benchmark.
 *
 * The benchmark must not pretend a model is "better" because its answer looks
 * nicer. Every run is scored against something the developer wrote down
 * beforehand: either a ground-truth recipe or, when no transcript exists, an
 * explicitly named reference model. Both bases are recorded with the result.
 *
 * Matching is accent-, case- and punctuation-insensitive so Greek pages can be
 * compared without typing every tonos. Quantities are compared numerically and
 * units through a small synonym table, because `γραμμ.` and `g` mean the same
 * thing on a handwritten page.
 */

export interface RecipeTruthIngredient {
  name: string;
  quantity?: number | null;
  unit?: string | null;
  optional?: boolean;
}

/** What a developer claims is actually on the page. */
export interface RecipeTruth {
  title?: string | null;
  ingredients?: RecipeTruthIngredient[];
  steps?: (string | null | undefined)[];
}

/** The shape the vision model is asked to return (loosely typed on purpose). */
export interface RecipeLike {
  title?: unknown;
  ingredients?: unknown;
  steps?: unknown;
  notes?: unknown;
}

export interface IngredientReading {
  name: string;
  quantity: number | null;
  unit: string | null;
}

/**
 * Weights for a ground-truth score. Names carry the most because a page of
 * invented ingredients is useless; quantities come next because a wrong digit
 * is the failure mode the OpenRouter observations found. Steps and title are
 * worth less because they are often paraphrased.
 */
export const RECIPE_SCORE_WEIGHTS = {
  names: 0.35,
  quantities: 0.25,
  units: 0.1,
  title: 0.1,
  steps: 0.2,
} as const;

const MATCH_THRESHOLD = 0.5;
const QUANTITY_TOLERANCE = 0.011;

export function normaliseText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/ς/g, "σ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function words(value: unknown): Set<string> {
  const text = normaliseText(value);
  return new Set(text ? text.split(" ") : []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function trigrams(text: string): Set<string> {
  const clean = normaliseText(text).replace(/\s+/g, "");
  if (clean.length < 3) return new Set(clean ? [clean] : []);
  const set = new Set<string>();
  for (let index = 0; index <= clean.length - 3; index++) set.add(clean.slice(index, index + 3));
  return set;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/** Levenshtein distance with a bounded input, enough for ingredient names. */
function editDistance(left: string, right: string): number {
  const a = left.slice(0, 120);
  const b = right.slice(0, 120);
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

function editRatio(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (!longest) return 1;
  return 1 - editDistance(a, b) / longest;
}

/**
 * Similarity of two labels: exact match after normalisation, otherwise word
 * overlap plus character-shape similarity (trigrams and edit distance), so one
 * misspelled letter in a Greek ingredient name is still recognised as the same
 * ingredient without matching two unrelated names.
 */
export function textSimilarity(left: unknown, right: unknown): number {
  const a = normaliseText(left);
  const b = normaliseText(right);
  if (a === b) return 1;
  if (!a || !b) return 0;
  const wordScore = jaccard(words(a), words(b));
  const shapeScore = Math.max(dice(trigrams(a), trigrams(b)), editRatio(a, b));
  return Math.round((0.4 * wordScore + 0.6 * shapeScore) * 1000) / 1000;
}

const UNIT_SYNONYMS: Record<string, string> = {
  g: "g",
  gr: "g",
  gram: "g",
  grams: "g",
  γρ: "g",
  γραμμ: "g",
  γραμμαριο: "g",
  γραμμαρια: "g",
  kg: "kg",
  kgr: "kg",
  κιλ: "kg",
  κιλο: "kg",
  κιλα: "kg",
  ml: "ml",
  μλ: "ml",
  l: "l",
  lt: "l",
  λιτρ: "l",
  λιτρο: "l",
  λιτρα: "l",
  pcs: "pcs",
  pc: "pcs",
  piece: "pcs",
  pieces: "pcs",
  τεμ: "pcs",
  τεμαχιο: "pcs",
  τεμαχια: "pcs",
  tbsp: "tbsp",
  κουτ: "tbsp",
  κουταλια: "tbsp",
  // Greek plural "κουταλιές" normalises to κουταλιεσ (final sigma folded to σ).
  κουταλιεσ: "tbsp",
  tsp: "tsp",
  κγ: "tsp",
  // normaliseText("κ.γ.") is "κ γ" because punctuation becomes a space.
  "κ γ": "tsp",
  κουταλακι: "tsp",
  cup: "cup",
  cups: "cup",
  φλιτζ: "cup",
  φλιτζανι: "cup",
  φλιτζανια: "cup",
  pinch: "pinch",
  πρεζα: "pinch",
  πρεζεσ: "pinch",
};

/** Canonical unit key, or the cleaned text when it is not a known synonym. */
export function normaliseUnit(value: unknown): string {
  const text = normaliseText(value);
  if (!text) return "";
  return UNIT_SYNONYMS[text] ?? text;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim().replace(",", ".");
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function readIngredients(value: unknown): IngredientReading[] {
  if (!Array.isArray(value)) return [];
  const entries: IngredientReading[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const name = String(row.name ?? "").trim();
    if (!name) continue;
    entries.push({
      name,
      quantity: readNumber(row.quantity),
      unit: normaliseUnit(row.unit) || null,
    });
  }
  return entries;
}

export function readSteps(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const steps: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      if (entry.trim()) steps.push(entry);
    } else if (entry && typeof entry === "object") {
      const text = (entry as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim()) steps.push(text);
    }
  }
  return steps;
}

function quantitiesEqual(left: number | null, right: number | null): boolean {
  if (left == null || right == null) return left == null && right == null;
  // Absolute on purpose: recipe amounts are small and a wrong digit (2 vs 9,
  // 160 vs 610) must fail, while 0.5 and 0.51 are the same reading.
  return Math.abs(left - right) <= QUANTITY_TOLERANCE;
}

export interface RecipeScore {
  /** Weighted 0…1 score. */
  score: number;
  titleScore: number;
  /** F1 of named ingredients (recall against the truth, precision against invented rows). */
  namesScore: number;
  quantityScore: number;
  unitScore: number;
  stepsScore: number;
  expectedIngredients: number;
  matchedIngredients: number;
  inventedIngredients: number;
  expectedQuantities: number;
  matchedQuantities: number;
  expectedUnits: number;
  matchedUnits: number;
}

interface Pairing {
  /** Best truth index for each draft ingredient. */
  bestTruth: number[];
  /** Best draft index for each truth ingredient (null when nothing matched). */
  bestDraft: (number | null)[];
  similarity: number[];
}

function pairIngredients(truth: IngredientReading[], draft: IngredientReading[]): Pairing {
  // One-to-one assignment: two truth rows may not both claim the same draft
  // row, because that would inflate recall on a page where the model repeated
  // or merged an ingredient. Strongest pairs are placed first.
  const pairs: { truth: number; draft: number; score: number }[] = [];
  truth.forEach((expected, truthIndex) => {
    draft.forEach((actual, draftIndex) => {
      const score = textSimilarity(expected.name, actual.name);
      if (score >= MATCH_THRESHOLD) pairs.push({ truth: truthIndex, draft: draftIndex, score });
    });
  });
  pairs.sort((left, right) => right.score - left.score || left.truth - right.truth || left.draft - right.draft);

  const bestDraft: (number | null)[] = truth.map(() => null);
  const bestTruth: number[] = draft.map(() => -1);
  const similarity: number[] = truth.map(() => 0);
  for (const pair of pairs) {
    if (bestDraft[pair.truth] != null || bestTruth[pair.draft] >= 0) continue;
    bestDraft[pair.truth] = pair.draft;
    bestTruth[pair.draft] = pair.truth;
    similarity[pair.truth] = pair.score;
  }
  return { bestTruth, bestDraft, similarity };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Score one answer against a written ground truth. Components with no truth
 * entries are dropped and the remaining weights renormalised, so a transcript
 * that records only ingredients is not penalised for missing steps.
 */
export function scoreRecipeAgainstTruth(draft: RecipeLike, truth: RecipeTruth): RecipeScore {
  const expected = readIngredients(truth.ingredients ?? []);
  const actual = readIngredients(draft.ingredients);
  const truthSteps = readSteps(truth.steps ?? []);
  const draftSteps = readSteps(draft.steps);
  const truthTitle = String(truth.title ?? "").trim();

  const weights: Record<keyof typeof RECIPE_SCORE_WEIGHTS, number> = { ...RECIPE_SCORE_WEIGHTS };
  if (!truthTitle) weights.title = 0;
  if (!expected.length) {
    weights.names = 0;
    weights.quantities = 0;
    weights.units = 0;
  }
  if (!truthSteps.length) weights.steps = 0;

  const pairing = pairIngredients(expected, actual);
  const matchedIngredients = pairing.bestDraft.filter((index) => index != null).length;
  const matchedDraft = pairing.bestTruth.filter((index) => index >= 0).length;
  const inventedIngredients = actual.length - matchedDraft;
  const recall = expected.length ? matchedIngredients / expected.length : 1;
  const precision = actual.length ? matchedDraft / actual.length : expected.length ? 0 : 1;
  const namesScore = expected.length
    ? recall + precision === 0
      ? 0
      : (2 * recall * precision) / (recall + precision)
    : actual.length
      ? 0
      : 1;

  let expectedQuantities = 0;
  let matchedQuantities = 0;
  let expectedUnits = 0;
  let matchedUnits = 0;
  expected.forEach((row, truthIndex) => {
    const draftIndex = pairing.bestDraft[truthIndex];
    const found = draftIndex == null ? null : actual[draftIndex];
    if (row.quantity != null) {
      expectedQuantities += 1;
      if (found && quantitiesEqual(row.quantity, found.quantity)) matchedQuantities += 1;
    }
    if (row.unit) {
      expectedUnits += 1;
      if (found && found.unit === row.unit) matchedUnits += 1;
    }
  });
  const quantityScore = expectedQuantities ? matchedQuantities / expectedQuantities : 1;
  const unitScore = expectedUnits ? matchedUnits / expectedUnits : 1;
  // A truth that records no quantity (or no unit) cannot judge that dimension.
  // Leaving its weight in would award full credit for information the truth
  // never contained and inflate the score of an otherwise incomplete reading.
  if (!expectedQuantities) weights.quantities = 0;
  if (!expectedUnits) weights.units = 0;
  const weightTotal = Object.values(weights).reduce((sum, value) => sum + value, 0) || 1;

  const stepsScore = truthSteps.length
    ? truthSteps.reduce((sum, step) => {
        const expectedWords = words(step);
        if (!expectedWords.size) return sum + 1;
        let best = 0;
        for (const actualStep of draftSteps) {
          const actualWords = words(actualStep);
          let shared = 0;
          for (const word of expectedWords) if (actualWords.has(word)) shared += 1;
          best = Math.max(best, shared / expectedWords.size);
        }
        return sum + best;
      }, 0) / truthSteps.length
    : 1;

  const titleScore = truthTitle ? textSimilarity(truthTitle, draft.title) : 1;

  const weighted =
    namesScore * weights.names +
    quantityScore * weights.quantities +
    unitScore * weights.units +
    titleScore * weights.title +
    stepsScore * weights.steps;

  return {
    score: round(weighted / weightTotal),
    titleScore: round(titleScore),
    namesScore: round(namesScore),
    quantityScore: round(quantityScore),
    unitScore: round(unitScore),
    stepsScore: round(stepsScore),
    expectedIngredients: expected.length,
    matchedIngredients,
    inventedIngredients,
    expectedQuantities,
    matchedQuantities,
    expectedUnits,
    matchedUnits,
  };
}

/** Turn a reference model's answer into the same shape as a written truth. */
export function referenceAsTruth(reference: RecipeLike): RecipeTruth {
  return {
    title: typeof reference.title === "string" ? reference.title : null,
    ingredients: readIngredients(reference.ingredients).map((row) => ({
      name: row.name,
      quantity: row.quantity,
      unit: row.unit,
    })),
    steps: readSteps(reference.steps),
  };
}

/**
 * Similarity to an explicitly named reference model's answer. This is **not**
 * accuracy: a candidate that copies a reference's wrong digit scores highly.
 * It answers "does this model see the same page as the reference?", which is
 * useful when no transcript exists.
 */
export function scoreSimilarityToReference(candidate: RecipeLike, reference: RecipeLike): RecipeScore {
  return scoreRecipeAgainstTruth(candidate, referenceAsTruth(reference));
}
