/**
 * Unit coverage for the developer OCR benchmark's pure helpers. The script is
 * never part of production code, but its unit conversions and caps decide every
 * number a report quotes, so they are tested like production code.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { MAX_RECIPE_OCR_PIXELS, MAX_RECIPE_OCR_WIDTH } from "../../shared/notebook-scan.ts";
import {
  assertBmpRoundTrip,
  contentScale,
  cropToContent,
  evaluate,
  keywordFound,
  temporaryPath,
  toBmpFile,
  tokensOf,
} from "../../scripts/ocr-benchmark.mjs";

function solidImage(width, height, rgb = { r: 255, g: 255, b: 255 }) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = rgb.r;
    data[index + 1] = rgb.g;
    data[index + 2] = rgb.b;
    data[index + 3] = 255;
  }
  return { width, height, data };
}

describe("ocr benchmark image caps", () => {
  it("upscales a small crop but never past the shared caps", () => {
    assert.equal(contentScale(100, 100), 2.4);

    const wide = contentScale(3000, 20);
    assert.ok(wide <= MAX_RECIPE_OCR_WIDTH / 3000);
    assert.ok(3000 * wide <= MAX_RECIPE_OCR_WIDTH + 1);

    const huge = contentScale(4000, 3000);
    assert.ok(huge < 1, "an oversized photo must be downscaled");
    assert.ok(4000 * huge <= MAX_RECIPE_OCR_WIDTH + 1);
    assert.ok(4000 * huge * (3000 * huge) <= MAX_RECIPE_OCR_PIXELS * 1.002);
  });

  it("returns a crop that satisfies the width budget even when it cannot upscale", () => {
    // Wide, shallow and mostly light: the paper box is the whole frame, so the
    // crop is the input and must still be shrunk to the shared width.
    const image = solidImage(2500, 40);
    const cropped = cropToContent(image);
    assert.ok(cropped.width <= MAX_RECIPE_OCR_WIDTH, `width ${cropped.width} exceeds the cap`);
    assert.ok(cropped.width < image.width, "the oversized frame was not downscaled");
    assert.ok(cropped.width * cropped.height <= MAX_RECIPE_OCR_PIXELS);
  });

  it("upscales a small page crop", () => {
    const image = solidImage(100, 100);
    const cropped = cropToContent(image);
    assert.equal(cropped.width, 240);
    assert.equal(cropped.height, 240);
  });
});

describe("ocr benchmark keyword scoring", () => {
  it("folds accents, case and punctuation without matching inside a longer word", () => {
    const page = tokensOf("Ρεβάνι, με νερό και ΝΕΡΟΚΟΚΚΟ.");
    assert.equal(keywordFound("ΡΕΒΑΝΙ", page), true);
    assert.equal(keywordFound("νερο", page), true, "an accent-free keyword matches the accented page word");
    assert.equal(keywordFound("ΝΕΡΟ", page), true, "the standalone word is present");
    assert.equal(keywordFound("ΑΛΕΥΡΙ", page), false);
    assert.equal(keywordFound("ΡΕΒΑΝΙ ΜΕ", page), true, "multi-word keywords match consecutive words");
  });

  it("does not let a keyword match a prefix of a longer OCR word", () => {
    const page = tokensOf("ΝΕΡΟΚΟΚΚΟ ΑΛΕΥΡΟΥ ΒΟΥΤΥΡΟΥ");
    assert.equal(keywordFound("ΝΕΡΟ", page), false);
    assert.equal(keywordFound("ΑΛΕΥΡΙ", page), false);
    assert.equal(keywordFound("ΒΟΥΤΥΡΟ", page), false);
  });

  it("reports whole-word recall and the missing keywords", () => {
    const result = evaluate(
      { keywords: ["ΡΕΒΑΝΙ", "ΝΕΡΟ", "ΙΝΔΟΚΑΡΥΔΟ"] },
      "Ρεβάνι με νερό. ΝΕΡΟΚΟΚΚΟ παντού.",
    );
    assert.equal(result.found, 2);
    assert.equal(result.keywords, 3);
    assert.equal(result.keywordRecall, 2 / 3);
    assert.deepEqual(result.missing, ["ΙΝΔΟΚΑΡΥΔΟ"]);
  });

  it("returns null recall when the manifest lists no keywords", () => {
    assert.equal(evaluate({}, "anything").keywordRecall, null);
  });
});

describe("ocr benchmark temp files", () => {
  it("never hands the same scratch path to two variants", () => {
    const first = temporaryPath("bmp");
    const second = temporaryPath("bmp");
    assert.notEqual(first, second);

    const image = solidImage(4, 4);
    const fileA = toBmpFile(image);
    const fileB = toBmpFile(image);
    try {
      assert.notEqual(fileA, fileB);
      assert.ok(fs.existsSync(fileA) && fs.existsSync(fileB));
    } finally {
      fs.rmSync(fileA, { force: true });
      fs.rmSync(fileB, { force: true });
    }
  });
});

describe("ocr benchmark BMP guard", () => {
  it("passes the independent encoder, decoder and sips checks", () => {
    assert.doesNotThrow(() => assertBmpRoundTrip());
  });
});
