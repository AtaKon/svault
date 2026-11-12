import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  MAX_RECIPE_OCR_PIXELS,
  MAX_RECIPE_OCR_WIDTH,
  cleanNotebookText,
  cleanNotebookTextReport,
  detectContentBounds,
  detectPaperRegion,
  detectScript,
  estimateSkewDegrees,
  inkLumaFromRgba,
  isPlannerNoiseLine,
  normaliseLumaFromRgba,
  readableWordRatio,
  recipeOcrFitScale,
  recipeOcrScale,
  splitRecipeSections,
} from "../../shared/notebook-scan.js";
import { heuristicRecipe, heuristicRecipes, parseIngredientLine } from "../services/recipe-local.js";

/** Synthetic luma canvas: background then dark "ink" strokes. */
function drawLuma(
  width: number,
  height: number,
  paint: (set: (x: number, y: number) => void) => void,
): Uint8ClampedArray {
  const luma = new Uint8ClampedArray(width * height).fill(245);
  const set = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    luma[y * width + x] = 30;
  };
  paint(set);
  return luma;
}

function ruledPage(width: number, height: number, degrees: number, left: number, right: number, top: number, bottom: number) {
  const slope = Math.tan((degrees * Math.PI) / 180);
  return drawLuma(width, height, (set) => {
    for (let row = top; row <= bottom; row += 16) {
      for (let x = left; x <= right; x++) {
        const y = Math.round(row + (x - width / 2) * slope);
        set(x, y);
        set(x, y + 1);
      }
    }
  });
}

describe("notebook OCR cleanup", () => {
  it("removes the printed diary frame and duplicate OCR rows", () => {
    const page = [
      "5 6 7 8 9",
      "3 10 17 24",
      "Α Τ Τ Π Π Σ Κ",
      "ΦΕΒΡΟΥΑΡΙΟΣ / FEBRUARY",
      "ΔΕΥΤΕΡΑ / MONDAY",
      "† Χαραλάμπους Ἱερομάρτ., Πορφυρίου, Ζήνωνος",
      "41-325",
      "MD5904101",
      "07:00",
      "07:00 Ρεβανί με ίδρυσμάτι",
      "08:00 160 γραμμ. βούτυρο",
      "08:00 160 γραμμ. βούτυρο",
      "Εκτέλεση",
      "09:00 Ανακατεύουμε όλα τα υλικά.",
    ].join("\n");

    const cleaned = cleanNotebookText(page);
    assert.match(cleaned, /Ρεβανί με ίδρυσμάτι/);
    assert.match(cleaned, /160 γραμμ\. βούτυρο/);
    assert.match(cleaned, /Εκτέλεση/);
    assert.equal(cleaned.split("\n").filter((line) => /160 γραμμ/.test(line)).length, 1);
    for (const noise of ["ΦΕΒΡΟΥΑΡΙΟΣ", "MONDAY", "5 6 7 8 9", "41-325", "MD5904101", "07:00", "00:41", "†"]) {
      assert.ok(!cleaned.includes(noise), `expected ${noise} to be removed`);
    }
  });

  it("keeps a repeated ingredient that comes back later in the recipe", () => {
    const cleaned = cleanNotebookText("1 ποτήρι νερό\n2 αυγά\n2 αυγά\nλίγο αλάτι\n1 ποτήρι νερό");
    assert.deepEqual(cleaned.split("\n"), ["1 ποτήρι νερό", "2 αυγά", "λίγο αλάτι", "1 ποτήρι νερό"]);
  });

  it("is idempotent", () => {
    const page = "ΦΕΒΡΟΥΑΡΙΟΣ / FEBRUARY\n07:00 Τσουρέκια\n08:00 17 αυγά";
    assert.equal(cleanNotebookText(cleanNotebookText(page)), cleanNotebookText(page));
  });

  it("reports every removed line instead of deleting it silently", () => {
    const page = [
      "ΦΕΒΡΟΥΑΡΙΟΣ / FEBRUARY",
      "Τσουρέκια Λαμπριάτικα",
      "17 αυγά",
      "17 αυγά",
      "41-325",
      "17",
    ].join("\n");
    const result = cleanNotebookTextReport(page);
    assert.deepEqual(result.text.split("\n"), ["Τσουρέκια Λαμπριάτικα", "17 αυγά"]);
    assert.ok(result.removed.some((entry) => entry.line.includes("ΦΕΒΡΟΥΑΡΙΟΣ") && entry.reason === "planner"));
    assert.ok(result.removed.some((entry) => entry.line === "41-325" && entry.reason === "planner"));
    assert.ok(result.removed.some((entry) => entry.line === "17 αυγά" && entry.reason === "duplicate"));
    assert.ok(result.removed.some((entry) => entry.line === "17" && entry.reason === "planner"));
  });

  it("never drops an ingredient row that starts with an amount", () => {
    // A quantity plus a word is content even when it is only two tokens, and a
    // row that repeats later in the recipe is kept.
    const cleaned = cleanNotebookText("3 αυγά\n1 ποτήρι νερό\n3 αυγά\n2 ώρες");
    assert.deepEqual(cleaned.split("\n"), ["3 αυγά", "1 ποτήρι νερό", "3 αυγά", "2 ώρες"]);
  });

  it("recognises planner rows without eating recipe rows", () => {
    assert.equal(isPlannerNoiseLine("3 10 17 24"), true);
    assert.equal(isPlannerNoiseLine("Α Τ Τ Π Π Σ Κ"), true);
    assert.equal(isPlannerNoiseLine("ΦΕΒΡΟΥΑΡΙΟΣ / FEBRUARY"), true);
    assert.equal(isPlannerNoiseLine("41-325"), true);
    assert.equal(isPlannerNoiseLine("160 γραμμ. βούτυρο"), false);
    assert.equal(isPlannerNoiseLine("3 αυγά"), false);
  });
});

describe("script detection from the page, not the interface", () => {
  it("reveals Greek handwriting even when the UI is English", () => {
    assert.equal(detectScript("Ρεβάνι με ινδοκάρυδο\n160 γραμμ. βούτυρο"), "greek");
    assert.equal(detectScript("Pancakes\n2 eggs\n100 g flour"), "latin");
    assert.equal(detectScript("Tsoureki με βούτυρο"), "mixed");
    assert.equal(detectScript("ΞΞΞ === ---"), "none");
  });

  it("separates ruled-paper noise from a real reading", () => {
    assert.ok(readableWordRatio("ΞΞΞ\nΕΞ\n—=—\nΕΕ") < 0.5);
    assert.ok(readableWordRatio("Ρεβάνι με ινδοκάρυδο\n160 γραμμ. βούτυρο") > 0.7);
  });
});

describe("shared OCR pixel transforms", () => {
  it("stretches a low-contrast page without changing its order", () => {
    const rgba = new Uint8ClampedArray([10, 10, 10, 255, 60, 60, 60, 255, 110, 110, 110, 255, 160, 160, 160, 255]);
    const values = normaliseLumaFromRgba(rgba, 4);
    assert.equal(values.length, 4);
    assert.ok(values[0] < values[1] && values[1] < values[2], "lighter pixels stay lighter");
    assert.ok(values[0] <= 2, `darkest ${values[0]}`);
    assert.ok(values[3] >= 250, `lightest ${values[3]}`);
  });

  it("keeps blue ballpoint darker than cream paper in the ink variant", () => {
    const blue = [0, 0, 255, 255];
    const paper = [245, 235, 200, 255];
    const rgba = new Uint8ClampedArray([...paper, ...blue, ...paper, ...blue]);
    const values = inkLumaFromRgba(rgba, 4);
    assert.ok(values[1] < values[0], "the blue ink pixel must be darker than the paper");
    assert.ok(values[3] < values[2]);
  });
});

describe("notebook page detection", () => {
  it("finds the written area and ignores the surround", () => {
    const luma = ruledPage(240, 200, 0, 30, 209, 20, 180);
    const bounds = detectContentBounds(luma, 240, 200);
    assert.ok(bounds);
    assert.ok(Math.abs(bounds.left - 30) <= 4, `left ${bounds.left}`);
    assert.ok(Math.abs(bounds.left + bounds.width - 210) <= 5, `right ${bounds.left + bounds.width}`);
    assert.ok(Math.abs(bounds.top - 20) <= 4, `top ${bounds.top}`);
    assert.ok(Math.abs(bounds.top + bounds.height - 181) <= 6, `bottom ${bounds.top + bounds.height}`);
  });

  it("returns nothing for a blank frame", () => {
    assert.equal(detectContentBounds(new Uint8ClampedArray(240 * 200).fill(245), 240, 200), null);
  });

  it("finds the sheet on a dark desk", () => {
    const luma = drawLuma(200, 160, (set) => {
      // Desk fill is handled below; keep strokes inside the sheet.
      for (let row = 24; row <= 136; row += 12) for (let x = 40; x <= 160; x++) set(x, row);
    });
    for (let y = 0; y < 160; y++) {
      for (let x = 0; x < 200; x++) {
        if (x < 32 || x > 168 || y < 16 || y > 144) luma[y * 200 + x] = 58;
      }
    }
    const paper = detectPaperRegion(luma, 200, 160);
    assert.ok(paper);
    assert.ok(Math.abs(paper.left - 32) <= 10, `left ${paper.left}`);
    assert.ok(Math.abs(paper.left + paper.width - 169) <= 10, `right ${paper.left + paper.width}`);
    assert.ok(Math.abs(paper.top - 16) <= 10, `top ${paper.top}`);
    assert.ok(Math.abs(paper.top + paper.height - 145) <= 10, `bottom ${paper.top + paper.height}`);
  });

  it("does not crop a frame that is already paper", () => {
    assert.equal(detectPaperRegion(new Uint8ClampedArray(240 * 200).fill(238), 240, 200), null);
  });

  it("estimates the tilt of ruled lines", () => {
    const tilted = ruledPage(320, 240, 4, 20, 300, 20, 220);
    const estimate = estimateSkewDegrees(tilted, 320, 240);
    assert.ok(Math.abs(estimate - 4) <= 1, `expected about 4°, got ${estimate}`);

    const downhill = ruledPage(320, 240, -3, 20, 300, 40, 220);
    const negative = estimateSkewDegrees(downhill, 320, 240);
    assert.ok(Math.abs(negative + 3) <= 1, `expected about -3°, got ${negative}`);
  });

  it("does not rotate a level page", () => {
    assert.equal(estimateSkewDegrees(ruledPage(320, 240, 0, 20, 300, 20, 220), 320, 240), 0);
  });
});

describe("handwritten Greek ingredient lines", () => {
  it("reads Greek unit abbreviations", () => {
    const butter = parseIngredientLine("160 γραμμ. βούτυρο βιτάμ");
    assert.equal(butter?.quantity, 160);
    assert.equal(butter?.unit, "g");
    assert.equal(butter?.name, "βούτυρο βιτάμ");

    assert.equal(parseIngredientLine("1 φλιτζ. αλεύρι")?.unit, "cup");
    assert.equal(parseIngredientLine("2 κουτ. ζάχαρη")?.unit, "tbsp");
    assert.equal(parseIngredientLine("1 κ.γ. αλάτι")?.unit, "tsp");
    assert.equal(parseIngredientLine("1 κιλ. πατάτες")?.unit, "kg");
  });

  it("reads quantities written as Greek words", () => {
    const half = parseIngredientLine("μισό κιλό αλεύρι");
    assert.equal(half?.quantity, 0.5);
    assert.equal(half?.unit, "kg");
    assert.equal(half?.name, "αλεύρι");

    assert.equal(parseIngredientLine("δύο αυγά")?.quantity, 2);
    assert.equal(parseIngredientLine("ενάμισι φλιτζ. γάλα")?.quantity, 1.5);
  });

  it("reads a mixed fraction", () => {
    const sugar = parseIngredientLine("1½ φλιτζ. ζάχαρη");
    assert.equal(sugar?.quantity, 1.5);
    assert.equal(sugar?.unit, "cup");
    assert.equal(sugar?.name, "ζάχαρη");
  });

  it("carries the ditto mark's unit from the previous line", () => {
    const ditto = parseIngredientLine("150 » ίδρυσμάτι", "g");
    assert.equal(ditto?.quantity, 150);
    assert.equal(ditto?.unit, "g");
    assert.equal(ditto?.name, "ίδρυσμάτι");

    assert.equal(parseIngredientLine("150 » ίδρυσμάτι")?.unit, null);
    // A dash is a bullet, not a ditto mark.
    assert.equal(parseIngredientLine("1 - ελιές", "g")?.unit, null);
  });

  it("does not read an opening smart quote as a ditto mark", () => {
    // OCR turns a handwritten quotation mark into a curly quote; it must not
    // inherit the previous unit just because it follows a number.
    assert.equal(parseIngredientLine("2 “eggs", "g")?.unit, null);
    assert.equal(parseIngredientLine("2 “eggs")?.quantity, 2);
    // A single straight quote is an opening quote too, not a ditto.
    assert.equal(parseIngredientLine('2 " eggs', "g")?.unit, null);
    assert.equal(parseIngredientLine('2 " eggs')?.quantity, 2);
    // A doubled mark is the handwritten ditto and still inherits the unit.
    assert.equal(parseIngredientLine('150 "" νερό', "g")?.unit, "g");
  });

  it("keeps OCR double spacing inside one ingredient row", () => {
    const draft = heuristicRecipe(
      ["Pancakes", "2  eggs", "1  cup  flour", "Εκτέλεση", "Whisk everything."].join("\n"),
    );
    assert.equal(draft.ingredients.length, 2, "a double space is not an ingredient separator");
    assert.deepEqual(
      draft.ingredients.map((ingredient) => ingredient.name),
      ["eggs", "flour"],
    );
    assert.equal(draft.ingredients[0].quantity, 2);
    assert.equal(draft.ingredients[1].unit, "cup");

    const wrapped = heuristicRecipe(
      ["Pancakes", "1 cup flour", "  continued below", "Εκτέλεση", "Whisk."].join("\n"),
    );
    assert.equal(wrapped.ingredients[0].quantity, 1);
    assert.equal(wrapped.ingredients[0].unit, "cup");
    assert.equal(wrapped.ingredients[0].name, "flour");
  });

  it("does not invent a step for an empty page", () => {
    const draft = heuristicRecipe("");
    assert.equal(draft.ingredients.length, 0);
    assert.ok(draft.steps.every((step) => !step.text.trim()), "no whitespace-only step is a recipe");
  });
});

describe("handwritten Greek notebook page", () => {
  it("rebuilds title, ingredients and method from a planner page", () => {
    const page = [
      "ΦΕΒΡΟΥΑΡΙΟΣ / FEBRUARY",
      "ΤΕΤΑΡΤΗ / WEDNESDAY",
      "12",
      "Μελετίου Αντιοχείας, Σατωρνίνου και Πλουτίνου",
      "07:00",
      "Αραπίνα Νίκη",
      "08:00 8 κουταλιές ζάχαρη",
      "150 » νερό",
      "1 ποτήρι νερό",
      "Εκτέλεση",
      "12:00 Το νερό το βάζουμε να βράσει.",
    ].join("\n");

    const draft = heuristicRecipe(cleanNotebookText(page));
    assert.equal(draft.title, "Αραπίνα Νίκη");
    assert.equal(draft.ingredients.length, 3);
    assert.equal(draft.ingredients[0].quantity, 8);
    assert.equal(draft.ingredients[0].unit, "tbsp");
    assert.equal(draft.ingredients[1].quantity, 150);
    assert.equal(draft.ingredients[1].unit, "tbsp");
    assert.equal(draft.ingredients[1].name, "νερό");
    assert.equal(draft.steps.length, 1);
    assert.equal(draft.steps[0].text, "Το νερό το βάζουμε να βράσει.");
    assert.ok(!draft.steps[0].text.includes("12:00"));
  });

  it("prefers the dish over a portion note above it", () => {
    const draft = heuristicRecipe(
      ["Μισή δόση", "3 κούπες γάλα", "Τσουρέκια Λαμπριάτικα", "17 αυγά", "Εκτέλεση", "Τα ζυμώνουμε."].join("\n"),
    );
    assert.equal(draft.title, "Τσουρέκια Λαμπριάτικα");
    assert.equal(draft.ingredients.length, 2);
    assert.equal(draft.ingredients[0].unit, "cup");
  });

  it("inherits grams through ditto marks and splits two ingredients on one row", () => {
    const draft = heuristicRecipe(
      [
        "Ρεβανί με ίδρυσμάτι",
        "160 γραμμ. βούτυρο",
        "150 » ίδρυσμάτι",
        "2 αυγά   1 μπέικιν πάουντερ",
        "Εκτέλεση",
        "Λιώνουμε το βούτυρο.",
      ].join("\n"),
    );
    assert.equal(draft.title, "Ρεβανί με ίδρυσμάτι");
    assert.equal(draft.ingredients.length, 4);
    assert.equal(draft.ingredients[1].unit, "g");
    assert.equal(draft.ingredients[2].name, "αυγά");
    assert.equal(draft.ingredients[3].name, "μπέικιν πάουντερ");
    assert.ok(draft.tags.includes("dessert"));
  });
});

describe("more than one recipe on a page", () => {
  const page = [
    "Μισή δόση",
    "3 κουπές γάλα",
    "Τσουρέκια Λαμπριάτικα",
    "17 αυγά",
    "250 γραμμ. μαγιά",
    "1 κιλ. γάλα",
    "1200 γραμμ. ζάχαρη",
    "6 μαχλέπι",
    "λίγο αλάτι",
    "Τιροπιάκια κουρού μερέντα",
    "1 κουτ. βιτάμ",
    "1 » λάδι αραβοσίτου",
    "1 » γάλα",
    "3 αυγά",
    "1 μπέικιν",
  ].join("\n");

  it("splits the page into separate sections", () => {
    const sections = splitRecipeSections(page);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].title, "Τσουρέκια Λαμπριάτικα");
    assert.equal(sections[1].title, "Τιροπιάκια κουρού μερέντα");
    // The "half batch" note above the first title stays with that recipe.
    assert.ok(sections[0].lines.includes("Μισή δόση"));
    assert.ok(!sections[1].lines.includes("17 αυγά"));
  });

  it("treats multi-digit and word-number amounts as recipe content", () => {
    // Section detection needs at least one amount row under a title. A quantity
    // of 160 or "μισό" must count exactly like "1"; matching only the first
    // digit (or only ASCII word boundaries) used to hide ordinary pages.
    const digits = splitRecipeSections(
      ["Τσουρέκι", "160 γραμμ. βούτυρο", "17 αυγά", "Κουραμπιέδες", "250 γραμμ. αλεύρι", "3 αυγά"].join("\n"),
    );
    assert.equal(digits.length, 2);
    assert.equal(digits[0].title, "Τσουρέκι");
    assert.equal(digits[1].title, "Κουραμπιέδες");

    const words = splitRecipeSections(
      ["Τσουρέκι", "μισό κιλό αλεύρι", "δύο αυγά", "Κουραμπιέδες", "ένα φλιτζάνι βούτυρο", "τρία αυγά"].join("\n"),
    );
    assert.equal(words.length, 2);
    assert.equal(words[0].title, "Τσουρέκι");
    assert.equal(words[1].title, "Κουραμπιέδες");

    // The wider boundary must not turn a printed planner code into content.
    assert.equal(isPlannerNoiseLine("41-325"), true);
  });

  it("returns one draft per recipe instead of merging them", () => {
    const drafts = heuristicRecipes(page);
    assert.equal(drafts.length, 2);
    assert.equal(drafts[0].title, "Τσουρέκια Λαμπριάτικα");
    assert.equal(drafts[1].title, "Τιροπιάκια κουρού μερέντα");
    const firstNames = drafts[0].ingredients.map((ingredient) => ingredient.name);
    const secondNames = drafts[1].ingredients.map((ingredient) => ingredient.name);
    assert.ok(firstNames.some((name) => name.includes("μαγιά")));
    assert.ok(!secondNames.some((name) => name.includes("μαγιά")));
    assert.ok(secondNames.some((name) => name.includes("λάδι")));
    assert.ok(!firstNames.some((name) => name.includes("λάδι")));
  });

  it("does not split a single recipe into sections", () => {
    assert.deepEqual(splitRecipeSections(["Ρεβανί", "160 γραμμ. βούτυρο", "Εκτέλεση", "Λιώνουμε το βούτυρο."].join("\n")), []);
    assert.equal(heuristicRecipes("Ρεβανί\n160 γραμμ. βούτυρο\nΕκτέλεση\nΛιώνουμε το βούτυρο.").length, 1);
  });

  it("keeps consecutive titles out of each other's ingredient list", () => {
    // Two titles on consecutive lines: the amounts below belong to the second
    // one, so the first is not a section start and the page is not split on a
    // guess. Its slice never contains the second title's amounts.
    const sections = splitRecipeSections(
      ["Ρεβανί", "Τσουρέκι", "17 αυγά", "250 γραμμ. μαγιά", "Εκτέλεση", "Τα ζυμώνουμε."].join("\n"),
    );
    assert.deepEqual(sections, []);
  });

  it("keeps the OCR pixel budget below the size where Tesseract aborts", () => {
    // Measured: 2400x3200 aborts the worker; the scanner caps at 5.5 Mpx.
    assert.ok(MAX_RECIPE_OCR_PIXELS < 2400 * 3200);
    assert.ok(MAX_RECIPE_OCR_PIXELS > 1500 * 2000);
  });
});

describe("recipe OCR size budget", () => {
  it("downscales a crop that straightening pushed over the budget", () => {
    // A page prepared at the caps (2000x2667) grows to about 2140x2851 when it
    // is rotated to straighten the ruled lines, and the whole frame can be the
    // crop. It must be shrunk, not handed to Tesseract whole.
    const width = 2140;
    const height = 2851;
    const scale = recipeOcrScale(width, height);
    assert.ok(scale < 1, "an oversized crop must be downscaled");
    assert.ok(Math.round(width * scale) <= MAX_RECIPE_OCR_WIDTH);
    assert.ok(Math.round(width * scale) * Math.round(height * scale) <= MAX_RECIPE_OCR_PIXELS);
  });

  it("fits an uncropped straightened frame to the budget without upscaling it", () => {
    // When the crop looks like a detector miss the scanner keeps the whole
    // photo. Straightening already grew that frame past the caps, so it must
    // still be shrunk; otherwise the rejected-crop path hands Tesseract a page
    // larger than the size that aborts the worker.
    const width = 2093;
    const height = 2760;
    const scale = recipeOcrFitScale(width, height);
    assert.ok(scale < 1, "an oversized full frame must be downscaled");
    assert.ok(Math.round(width * scale) <= MAX_RECIPE_OCR_WIDTH);
    assert.ok(Math.round(width * scale) * Math.round(height * scale) <= MAX_RECIPE_OCR_PIXELS);
    assert.equal(recipeOcrFitScale(1500, 2000), 1, "a page inside the budget is left alone");
    assert.equal(recipeOcrFitScale(100, 100), 1, "a full frame is never upscaled");
  });

  it("upscales a small crop and leaves a crop at the width cap alone", () => {
    assert.equal(recipeOcrScale(100, 100), 2.4);
    assert.equal(recipeOcrScale(MAX_RECIPE_OCR_WIDTH, 2600), 1);
  });
});

describe("OCR benchmark tooling", () => {
  it("round-trips RGB channels through its BMP encoder", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", path.resolve("scripts/ocr-benchmark.mjs"), "--self-check"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /BMP round trip OK/);
    // The external `sips` check only exists on macOS; the output must say so
    // instead of claiming a check that did not run.
    assert.match(
      result.stdout,
      process.platform === "darwin" ? /sips preserve RGB channels/ : /sips check skipped on this platform/,
    );
  });
});
