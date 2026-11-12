import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_RECIPE_OCR_PIXELS,
  cleanNotebookText,
  cleanNotebookTextReport,
  detectContentBounds,
  detectPaperRegion,
  detectScript,
  estimateSkewDegrees,
  isPlannerNoiseLine,
  readableWordRatio,
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

  it("keeps the OCR pixel budget below the size where Tesseract aborts", () => {
    // Measured: 2400x3200 aborts the worker; the scanner caps at 5.5 Mpx.
    assert.ok(MAX_RECIPE_OCR_PIXELS < 2400 * 3200);
    assert.ok(MAX_RECIPE_OCR_PIXELS > 1500 * 2000);
  });
});
