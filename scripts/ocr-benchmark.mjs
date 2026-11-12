/**
 * Real-photo OCR benchmark for photographed handwritten recipe pages.
 *
 * The browser scanner is Tesseract.js, so this script runs the same engine and
 * the same `shared/notebook-scan` preprocessing against real photographs. It is
 * deliberately a manual tool, not part of `npm test`: it needs the photos, a
 * Tesseract runtime and (on macOS) `sips` for JPEG decoding.
 *
 *   node --import tsx scripts/ocr-benchmark.mjs data/ocrbench/manifest.json
 *
 * The manifest lists images, the words that are visibly on each page and, when
 * available, a full transcription:
 *
 *   {
 *     "images": [
 *       {
 *         "path": "photo.jpg",
 *         "label": "revani",
 *         "keywords": ["ΡΕΒΑΝΙ", "ΙΝΔΟΚΑΡΥΔΟ", "ΒΟΥΤΥΡΟ"],
 *         "truth": "Ρεβάνι με ινδοκάρυδο\n160 γραμμ. βούτυρο ..."
 *       }
 *     ]
 *   }
 *
 * Results are written as JSON so a report can quote exact numbers.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bmp from "bmp-js";
import { createWorker } from "tesseract.js";

import {
  cleanNotebookText,
  detectContentBounds,
  detectPaperRegion,
  estimateSkewDegrees,
} from "../shared/notebook-scan.ts";

/* --------------------------------------------------------------- image I/O */

function decodeImage(file) {
  if (/\.bmp$/i.test(file)) {
    const decoded = bmp.decode(fs.readFileSync(file));
    return { width: decoded.width, height: decoded.height, data: rgbaFromBmp(decoded) };
  }
  const temp = path.join(os.tmpdir(), `ocr-bench-${process.pid}-${Date.now()}.bmp`);
  try {
    execFileSync("sips", ["-s", "format", "bmp", file, "--out", temp], { stdio: "ignore" });
    const decoded = bmp.decode(fs.readFileSync(temp));
    return { width: decoded.width, height: decoded.height, data: rgbaFromBmp(decoded) };
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/**
 * bmp-js stores pixels as [0, blue, green, red] and already normalises rows to
 * top-down. Re-pack into real RGBA so the shared helpers see true colours.
 */
function rgbaFromBmp(decoded) {
  const data = new Uint8ClampedArray(decoded.width * decoded.height * 4);
  for (let pixel = 0, source = 0, target = 0; target < data.length; pixel++, source += 4, target += 4) {
    data[target] = decoded.data[source + 3];
    data[target + 1] = decoded.data[source + 2];
    data[target + 2] = decoded.data[source + 1];
    data[target + 3] = 255;
  }
  return data;
}

function lumaOf(image) {
  const { data, width, height } = image;
  const luma = new Uint8ClampedArray(width * height);
  for (let pixel = 0, index = 0; index < data.length; index += 4, pixel++) {
    luma[pixel] = Math.round(0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]);
  }
  return luma;
}

function sample(image, x, y, channel) {
  const clampedX = Math.max(0, Math.min(image.width - 1, x));
  const clampedY = Math.max(0, Math.min(image.height - 1, y));
  return image.data[(clampedY * image.width + clampedX) * 4 + channel];
}

/** Bilinear resize over RGBA. */
function resize(image, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  const scaleX = image.width / width;
  const scaleY = image.height / height;
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(image.height - 1, (y + 0.5) * scaleY - 0.5);
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const fy = sourceY - y0;
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(image.width - 1, (x + 0.5) * scaleX - 0.5);
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const fx = sourceX - x0;
      const target = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const top = sample(image, x0, y0, channel) * (1 - fx) + sample(image, x1, y0, channel) * fx;
        const bottom = sample(image, x0, y1, channel) * (1 - fx) + sample(image, x1, y1, channel) * fx;
        out[target + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
      out[target + 3] = 255;
    }
  }
  return { width, height, data: out };
}

function crop(image, region) {
  const out = new Uint8ClampedArray(region.width * region.height * 4);
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      const source = ((region.top + y) * image.width + region.left + x) * 4;
      const target = (y * region.width + x) * 4;
      out[target] = image.data[source];
      out[target + 1] = image.data[source + 1];
      out[target + 2] = image.data[source + 2];
      out[target + 3] = 255;
    }
  }
  return { width: region.width, height: region.height, data: out };
}

/** Rotate by `degrees`, positive clockwise, filling the corners with white. */
function rotate(image, degrees) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const width = Math.ceil(image.width * cos + image.height * sin);
  const height = Math.ceil(image.width * sin + image.height * cos);
  const out = new Uint8ClampedArray(width * height * 4).fill(255);
  const centreX = width / 2;
  const centreY = height / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - centreX;
      const dy = y - centreY;
      const sourceX = dx * Math.cos(radians) + dy * Math.sin(radians) + image.width / 2;
      const sourceY = -dx * Math.sin(radians) + dy * Math.cos(radians) + image.height / 2;
      if (sourceX < 0 || sourceY < 0 || sourceX >= image.width - 1 || sourceY >= image.height - 1) continue;
      const target = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const x0 = Math.floor(sourceX);
        const y0 = Math.floor(sourceY);
        const fx = sourceX - x0;
        const fy = sourceY - y0;
        const top = sample(image, x0, y0, channel) * (1 - fx) + sample(image, x0 + 1, y0, channel) * fx;
        const bottom =
          sample(image, x0, y0 + 1, channel) * (1 - fx) + sample(image, x0 + 1, y0 + 1, channel) * fx;
        out[target + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return { width, height, data: out };
}

function percentile(histogram, total, fraction) {
  const target = Math.round(total * fraction);
  let seen = 0;
  for (let value = 0; value < histogram.length; value++) {
    seen += histogram[value];
    if (seen >= target) return value;
  }
  return 255;
}

/** Grayscale + gentle percentile stretch, mirroring `normalizeCanvas`. */
function normalize(image) {
  const luma = lumaOf(image);
  const histogram = new Uint32Array(256);
  for (const value of luma) histogram[value]++;
  const low = percentile(histogram, luma.length, 0.01);
  const high = percentile(histogram, luma.length, 0.99);
  const range = Math.max(1, high - low);
  const out = new Uint8ClampedArray(image.width * image.height * 4);
  for (let pixel = 0, index = 0; pixel < luma.length; pixel++, index += 4) {
    const value = Math.max(0, Math.min(255, Math.round(((luma[pixel] - low) * 255) / range)));
    out[index] = value;
    out[index + 1] = value;
    out[index + 2] = value;
    out[index + 3] = 255;
  }
  return { width: image.width, height: image.height, data: out };
}

/** Minimum-channel ink isolation, mirroring `inkCanvas`. */
function ink(image) {
  const total = image.width * image.height;
  const values = new Uint8ClampedArray(total);
  const histogram = new Uint32Array(256);
  for (let pixel = 0, index = 0; pixel < total; pixel++, index += 4) {
    const value = Math.min(image.data[index], image.data[index + 1], image.data[index + 2]);
    values[pixel] = value;
    histogram[value]++;
  }
  const low = percentile(histogram, total, 0.02);
  const high = percentile(histogram, total, 0.98);
  const range = high - low;
  const out = new Uint8ClampedArray(total * 4);
  for (let pixel = 0, index = 0; pixel < total; pixel++, index += 4) {
    let value = values[pixel];
    if (range >= 24) value = ((value - low) * 255) / range;
    value = Math.max(0, Math.min(255, Math.round(value)));
    out[index] = value;
    out[index + 1] = value;
    out[index + 2] = value;
    out[index + 3] = 255;
  }
  return { width: image.width, height: image.height, data: out };
}

/** Paper crop + deskew + upscale, mirroring `tightenRecipePage`. */
function tighten(image) {
  let page = image;
  const before = lumaOf(page);
  const skew = estimateSkewDegrees(before, page.width, page.height);
  if (Math.abs(skew) >= 1) page = rotate(page, -skew);
  return { image: page, skew };
}

function cropToContent(image) {
  const luma = lumaOf(image);
  const paper = detectPaperRegion(luma, image.width, image.height);
  const content = detectContentBounds(luma, image.width, image.height);
  let box = paper ?? { left: 0, top: 0, width: image.width, height: image.height };
  if (content) {
    const left = Math.max(box.left, content.left);
    const top = Math.max(box.top, content.top);
    const right = Math.min(box.left + box.width, content.left + content.width);
    const bottom = Math.min(box.top + box.height, content.top + content.height);
    if (right - left >= box.width * 0.5 && bottom - top >= box.height * 0.5) {
      box = { left, top, width: right - left, height: bottom - top };
    }
  }
  if (box.width < image.width * 0.3 || box.height < image.height * 0.3) return image;
  const cropped = crop(image, box);
  // Tesseract.js in Node aborts on a 2400x3200 page ("Too many properties to
  // enumerate"); 2000 px wide and <= 5.5 Mpx stays inside its wasm heap.
  const scale = Math.min(2.4, Math.max(1, 2000 / Math.max(1, cropped.width)));
  const targetWidth = Math.round(cropped.width * scale);
  const targetHeight = Math.round(cropped.height * scale);
  const capped = Math.min(1, Math.sqrt(5_500_000 / Math.max(1, targetWidth * targetHeight)));
  return scale * capped > 1.01
    ? resize(cropped, Math.round(cropped.width * scale * capped), Math.round(cropped.height * scale * capped))
    : cropped;
}

function toBmpFile(image) {
  const width = image.width;
  const height = image.height;
  // bmp-js expects top-down rows as [0, blue, green, red]; the encoder writes a
  // negative height so no row flip is needed here.
  const rows = new Uint8Array(width * height * 4);
  for (let pixel = 0, index = 0; pixel < width * height; pixel++, index += 4) {
    const source = pixel * 4;
    rows[index] = 0;
    rows[index + 1] = image.data[source + 2];
    rows[index + 2] = image.data[source + 1];
    rows[index + 3] = image.data[source];
  }
  const encoded = bmp.encode({ data: Buffer.from(rows), width, height });
  const file = path.join(os.tmpdir(), `ocr-bench-${process.pid}-${Date.now()}.bmp`);
  fs.writeFileSync(file, encoded.data);
  return file;
}

/* -------------------------------------------------------------- evaluation */

function fold(text) {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function evaluate(entry, text) {
  const folded = fold(text);
  const keywords = entry.keywords ?? [];
  const found = keywords.filter((word) => folded.includes(fold(word)));
  const truth = entry.truth ? fold(entry.truth) : "";
  return {
    keywordRecall: keywords.length ? found.length / keywords.length : null,
    found: found.length,
    keywords: keywords.length,
    missing: keywords.filter((word) => !found.includes(word)),
    characterErrorRate: truth ? levenshtein(truth, folded) / Math.max(1, truth.length) : null,
  };
}

/* -------------------------------------------------------------------- main */

const manifestFile = process.argv[2];
if (!manifestFile) {
  console.error("usage: node --import tsx scripts/ocr-benchmark.mjs <manifest.json> [--json out.json]");
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const baseDir = path.dirname(path.resolve(manifestFile));
const jsonFlag = process.argv.indexOf("--json");
const jsonOut = jsonFlag > 0 ? process.argv[jsonFlag + 1] : null;

const LANGS = ["ell", "eng"];
const PSM_MODES = ["4", "11"];
const results = [];

async function withWorker(lang, fn) {
  const worker = await createWorker(lang, 1, {
    langPath: path.resolve("."),
    gzip: false,
    cachePath: path.join(os.tmpdir(), "ocr-bench-cache"),
    logger: () => {},
  });
  try {
    return await fn(worker);
  } finally {
    await worker.terminate();
  }
}

for (const entry of manifest.images) {
  const file = path.isAbsolute(entry.path) ? entry.path : path.join(baseDir, entry.path);
  console.log(`\n### ${entry.label ?? path.basename(file)}`);
  const original = decodeImage(file);
  const tight = tighten(original);
  const cropped = cropToContent(tight.image);

  const variants = {
    "photo-normalized": normalize(original),
    "page-normalized": normalize(tight.image),
    "page-cropped": normalize(cropped),
    "page-ink": ink(cropped),
  };

  for (const [variant, image] of Object.entries(variants)) {
    const bmpFile = toBmpFile(image);
    for (const lang of LANGS) {
      const row = await withWorker(lang, async (worker) => {
        const started = Date.now();
        let text = "";
        let confidence = 0;
        for (const psm of PSM_MODES) {
          await worker.setParameters({
            tessedit_pageseg_mode: psm,
            preserve_interword_spaces: "1",
            user_defined_dpi: "300",
          });
          const { data } = await worker.recognize(bmpFile);
          if (data.text.trim().length > text.trim().length) {
            text = data.text;
            confidence = data.confidence;
          }
        }
        const metrics = evaluate(entry, text);
        const cleaned = cleanNotebookText(text);
        const cleanedMetrics = evaluate(entry, cleaned);
        return {
          image: entry.label ?? path.basename(file),
          variant,
          lang,
          ms: Date.now() - started,
          confidence,
          chars: text.trim().length,
          ...metrics,
          cleanedChars: cleaned.trim().length,
          cleanedKeywordRecall: cleanedMetrics.keywordRecall,
          cleanedCharacterErrorRate: cleanedMetrics.characterErrorRate,
          text: text.trim(),
        };
      });
      results.push(row);
      console.log(
        `${variant.padEnd(16)} ${lang.padEnd(8)} conf=${String(Math.round(row.confidence)).padStart(3)} ` +
          `chars=${String(row.chars).padStart(5)} keywords=${row.found}/${row.keywords} ` +
          `CER=${row.characterErrorRate == null ? "n/a" : row.characterErrorRate.toFixed(2)} ` +
          `cleanedKeywords=${Math.round((row.cleanedKeywordRecall ?? 0) * row.keywords)}/${row.keywords}`,
      );
    }
    fs.rmSync(bmpFile, { force: true });
  }
  console.log(
    `skew=${tight.skew}° crop=${cropped.width}x${cropped.height} (from ${original.width}x${original.height})`,
  );
}

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nwrote ${jsonOut}`);
}
