/**
 * Unit coverage for the developer OCR benchmark's pure helpers. The script is
 * never part of production code, but its unit conversions and caps decide every
 * number a report quotes, so they are tested like production code.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MAX_RECIPE_OCR_PIXELS, MAX_RECIPE_OCR_WIDTH } from "../../shared/notebook-scan.ts";
import {
  assertBmpRoundTrip,
  contentScale,
  cropToContent,
  evaluate,
  keywordFound,
  parseManifest,
  rotate,
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

  it("still enforces the size budget when a crop is rejected as a detector miss", () => {
    // A bright page covering ~55% of an oversized frame, with a dark block that
    // covers half of it. The content box is below the 30% crop threshold, so
    // `cropToContent` keeps the whole photo; the full photo must still be
    // shrunk, otherwise a 4000x3000 image reaches Tesseract whole.
    const image = solidImage(4000, 3000, { r: 210, g: 210, b: 210 });
    const paint = (left, top, right, bottom, value) => {
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const index = (y * image.width + x) * 4;
          image.data[index] = value;
          image.data[index + 1] = value;
          image.data[index + 2] = value;
        }
      }
    };
    paint(200, 500, 2400, 2500, 245); // the sheet
    paint(700, 1000, 1800, 2100, 30); // the written block, half the sheet

    const cropped = cropToContent(image);
    assert.ok(cropped.width <= MAX_RECIPE_OCR_WIDTH, `width ${cropped.width} exceeds the cap`);
    assert.ok(cropped.width * cropped.height <= MAX_RECIPE_OCR_PIXELS);
    assert.ok(cropped.width < image.width, "the rejected crop path returned the oversized frame");
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

describe("ocr benchmark rotation", () => {
  it("rotates by a positive angle clockwise", () => {
    // Two marked pixels either side of the centre. Clockwise means the left
    // (red) mark moves up and the right (blue) mark moves down. `tighten()`
    // calls rotate(-skew), so an inverted sign here would silently change every
    // benchmark number.
    const width = 5;
    const height = 5;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    const mark = (x, y, r, g, b) => {
      const index = (y * width + x) * 4;
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
    };
    mark(1, 2, 255, 0, 0);
    mark(3, 2, 0, 0, 255);
    const image = { width, height, data };

    const pixel = (source, x, y) => {
      const index = (y * source.width + x) * 4;
      return { r: source.data[index], g: source.data[index + 1], b: source.data[index + 2] };
    };
    const findStrongest = (source, score) => {
      let best = null;
      for (let y = 0; y < source.height; y++) {
        for (let x = 0; x < source.width; x++) {
          const value = score(pixel(source, x, y));
          if (value > 60 && (!best || value > best.value)) best = { x, y, value };
        }
      }
      return best;
    };
    const reddest = (p) => p.r - Math.max(p.g, p.b);
    const bluest = (p) => p.b - Math.max(p.r, p.g);

    const clockwise = rotate(image, 90);
    assert.ok(
      findStrongest(clockwise, reddest).y < findStrongest(clockwise, bluest).y,
      "clockwise: the left mark ends above the right mark",
    );

    const counter = rotate(image, -90);
    assert.ok(
      findStrongest(counter, reddest).y > findStrongest(counter, bluest).y,
      "negative is anticlockwise",
    );
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

describe("ocr benchmark manifest", () => {
  it("rejects a manifest without a non-empty images array", () => {
    assert.throws(() => parseManifest({}, process.cwd()), /images/);
    assert.throws(() => parseManifest({ images: [] }, process.cwd()), /non-empty/);
    assert.throws(() => parseManifest(null, process.cwd()), /JSON object/);
  });

  it("rejects an entry without a usable path before any OCR starts", () => {
    assert.throws(
      () => parseManifest({ images: [{ label: "page" }] }, process.cwd()),
      /images\[0\]\.path/,
    );
    assert.throws(
      () => parseManifest({ images: [{ path: "   " }] }, process.cwd()),
      /images\[0\]\.path/,
    );
  });

  it("rejects a manifest that names a photo that does not exist", () => {
    assert.throws(
      () => parseManifest({ images: [{ path: "missing-photo.jpg" }] }, process.cwd()),
      /does not exist/,
    );
  });

  it("resolves each relative path against the manifest directory", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-manifest-"));
    try {
      const photo = path.join(directory, "page.bmp");
      fs.writeFileSync(photo, Buffer.alloc(0));
      const images = parseManifest({ images: [{ path: "page.bmp", label: "page" }] }, directory);
      assert.equal(images.length, 1);
      assert.equal(images[0].file, photo);
      assert.equal(images[0].label, "page");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("ocr benchmark BMP guard", () => {
  it("passes the independent encoder, decoder and sips checks", () => {
    assert.doesNotThrow(() => assertBmpRoundTrip());
  });
});
