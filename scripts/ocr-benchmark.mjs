/**
 * Real-photo OCR benchmark for photographed handwritten recipe pages.
 *
 * The browser scanner is Tesseract.js, so this script runs the same engine and
 * the same `shared/notebook-scan` preprocessing against real photographs. It is
 * deliberately a manual tool, not part of `npm test`: it needs the photos, a
 * Tesseract runtime and (on macOS) `sips` for JPEG decoding.
 *
 *   node --import tsx scripts/ocr-benchmark.mjs data/ocrbench/manifest.json
 *   node --import tsx scripts/ocr-benchmark.mjs --self-check
 *
 * JPEG/PNG photos are decoded with macOS `sips`, so the full benchmark runs on
 * macOS; BMP files decode everywhere. `--self-check` verifies the BMP
 * encode/decode round trip without reading any photos or OCR data.
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
import { fileURLToPath } from "node:url";
import bmp from "bmp-js";
import { createWorker } from "tesseract.js";

import {
  MAX_RECIPE_OCR_PIXELS,
  MAX_RECIPE_OCR_WIDTH,
  cleanNotebookText,
  detectContentBounds,
  detectPaperRegion,
  estimateSkewDegrees,
} from "../shared/notebook-scan.ts";

/* ---------------------------------------------------------- OCR language data */

/** The repository root, resolved from this file, not from the caller's cwd. */
const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The same trained data the browser ships. `npm run dev` and `npm run build`
 * copy it into `public/tesseract` (gzipped); reading it from there keeps the
 * benchmark on the shipped models instead of whatever happens to be in cwd.
 */
function trainedDataDir() {
  const directory = path.join(SCRIPT_ROOT, "public", "tesseract");
  const missing = ["ell", "eng"].filter((lang) => !fs.existsSync(path.join(directory, `${lang}.traineddata.gz`)));
  if (missing.length) {
    throw new Error(
      `Missing ${missing.map((lang) => `${lang}.traineddata.gz`).join(", ")} in ${directory}. ` +
        "Run `node scripts/vendor-ocr.mjs` (or `npm run dev` once) to copy the OCR assets first.",
    );
  }
  return directory;
}

/* --------------------------------------------------------------- image I/O */

let temporaryFileCount = 0;

/**
 * A unique scratch path. `Date.now()` alone can repeat within one millisecond,
 * and two variants must never share (and delete) the same file.
 */
export function temporaryPath(extension) {
  temporaryFileCount += 1;
  return path.join(os.tmpdir(), `ocr-bench-${process.pid}-${temporaryFileCount}-${Date.now()}.${extension}`);
}

export function decodeImage(file) {
  if (/\.bmp$/i.test(file)) {
    const decoded = bmp.decode(fs.readFileSync(file));
    return { width: decoded.width, height: decoded.height, data: rgbaFromBmp(decoded) };
  }
  if (process.platform !== "darwin") {
    throw new Error(
      `${path.basename(file)} is not a BMP and this script decodes photos with macOS \`sips\`. ` +
        "Convert the manifests' photos to BMP, or run the benchmark on macOS.",
    );
  }
  const temp = temporaryPath("bmp");
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
export function rgbaFromBmp(decoded) {
  const data = new Uint8ClampedArray(decoded.width * decoded.height * 4);
  for (let pixel = 0, source = 0, target = 0; target < data.length; pixel++, source += 4, target += 4) {
    data[target] = decoded.data[source + 3];
    data[target + 1] = decoded.data[source + 2];
    data[target + 2] = decoded.data[source + 1];
    data[target + 3] = 255;
  }
  return data;
}

export function lumaOf(image) {
  const { data, width, height } = image;
  const luma = new Uint8ClampedArray(width * height);
  for (let pixel = 0, index = 0; index < data.length; index += 4, pixel++) {
    luma[pixel] = Math.round(0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]);
  }
  return luma;
}

export function sample(image, x, y, channel) {
  const clampedX = Math.max(0, Math.min(image.width - 1, x));
  const clampedY = Math.max(0, Math.min(image.height - 1, y));
  return image.data[(clampedY * image.width + clampedX) * 4 + channel];
}

/** Bilinear resize over RGBA. */
export function resize(image, width, height) {
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

export function crop(image, region) {
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
export function rotate(image, degrees) {
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
export function normalize(image) {
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
export function ink(image) {
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

/** Deskew only. Paper cropping and the upscale cap happen in `cropToContent`. */
export function tighten(image) {
  let page = image;
  const before = lumaOf(page);
  const skew = estimateSkewDegrees(before, page.width, page.height);
  if (Math.abs(skew) >= 1) page = rotate(page, -skew);
  return { image: page, skew };
}

/**
 * Final scale for a cropped page. Mirrors `prepareDocument` in the browser: up
 * to 2.4× for a small crop, but never past the shared width or pixel budget, so
 * an oversized photo is downscaled instead of being handed to Tesseract whole.
 */
export function contentScale(width, height) {
  return Math.min(
    2.4,
    MAX_RECIPE_OCR_WIDTH / Math.max(1, width),
    Math.sqrt(MAX_RECIPE_OCR_PIXELS / Math.max(1, width * height)),
  );
}

export function cropToContent(image) {
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
  // Mirror `tightenRecipePage`: Tesseract.js in Node aborts on a 2400x3200 page
  // ("Too many properties to enumerate"), so the final image must satisfy both
  // the shared width and total-pixel budget. This scale can be below 1 when the
  // crop is already larger than the budget.
  const scale = contentScale(cropped.width, cropped.height);
  if (Math.abs(scale - 1) <= 0.01) return cropped;
  return resize(cropped, Math.max(1, Math.round(cropped.width * scale)), Math.max(1, Math.round(cropped.height * scale)));
}

/**
 * Encode as a 24-bit BMP. bmp-js expects the input buffer in its decoded layout
 * `[a, b, g, r]` (the alpha slot is ignored by the 24-bit encoder) and writes
 * the file as top-down BGR rows because of the negative height it stores.
 * `rgbaFromBmp` reverses exactly this packing.
 */
export function encodeBmp(image) {
  const width = image.width;
  const height = image.height;
  const rows = new Uint8Array(width * height * 4);
  for (let pixel = 0, index = 0; pixel < width * height; pixel++, index += 4) {
    const source = pixel * 4;
    rows[index] = 0;
    rows[index + 1] = image.data[source + 2];
    rows[index + 2] = image.data[source + 1];
    rows[index + 3] = image.data[source];
  }
  return bmp.encode({ data: Buffer.from(rows), width, height });
}

export function toBmpFile(image) {
  const encoded = encodeBmp(image);
  const file = temporaryPath("bmp");
  fs.writeFileSync(file, encoded.data);
  return file;
}

/**
 * A 24-bit BMP written from the specification, not by `encodeBmp`. Decoding it
 * proves `rgbaFromBmp` reads channel order and row order correctly even if the
 * encoder had the same mistake (a symmetric swap would pass a self round trip).
 */
function handBuiltBmp(width, height, rgbAt) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const buffer = Buffer.alloc(54 + pixelBytes);
  buffer.write("BM", 0, "ascii");
  buffer.writeUInt32LE(54 + pixelBytes, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22); // positive height: rows are stored bottom-up
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(pixelBytes, 34);
  buffer.writeUInt32LE(2835, 38);
  buffer.writeUInt32LE(2835, 42);
  for (let fileRow = 0; fileRow < height; fileRow++) {
    const sourceRow = height - 1 - fileRow;
    for (let x = 0; x < width; x++) {
      const { r, g, b } = rgbAt(x, sourceRow);
      const offset = 54 + fileRow * rowSize + x * 3;
      buffer[offset] = b;
      buffer[offset + 1] = g;
      buffer[offset + 2] = r;
    }
  }
  return buffer;
}

/**
 * Guard the decode/encode round trip at startup. A previous evaluation run was
 * discarded because of a channel-order bug, and that must never come back
 * silently. Three independent checks:
 *   1. the bytes `encodeBmp` hands to bmp-js are [0, b, g, r] as that API wants;
 *   2. a BMP built from the spec decodes back to the expected RGB;
 *   3. on macOS, `sips` can read the encoded file and returns the same colours.
 */
export function assertBmpRoundTrip() {
  const pixels = [
    { r: 10, g: 20, b: 30 },
    { r: 40, g: 50, b: 60 },
    { r: 70, g: 80, b: 90 },
    { r: 100, g: 110, b: 120 },
  ];
  const data = new Uint8ClampedArray(16);
  pixels.forEach((pixel, index) => {
    data[index * 4] = pixel.r;
    data[index * 4 + 1] = pixel.g;
    data[index * 4 + 2] = pixel.b;
    data[index * 4 + 3] = 255;
  });
  const image = { width: 2, height: 2, data };
  const encoded = encodeBmp(image);

  // 1. The encoder's output buffer must be in bmp-js's [a, b, g, r] layout.
  const raw = bmp.decode(encoded.data);
  for (let index = 0; index < pixels.length; index++) {
    const expected = pixels[index];
    const actual = { b: raw.data[index * 4 + 1], g: raw.data[index * 4 + 2], r: raw.data[index * 4 + 3] };
    if (actual.r !== expected.r || actual.g !== expected.g || actual.b !== expected.b) {
      throw new Error(
        `BMP encoding wrote pixel ${index} as rgb(${actual.r},${actual.g},${actual.b}) ` +
          `but expected rgb(${expected.r},${expected.g},${expected.b}). Refusing to benchmark on swapped channels.`,
      );
    }
  }

  // 2. A specification-built file must survive the decoder.
  const external = handBuiltBmp(2, 2, (x, y) => pixels[y * 2 + x]);
  const decodedExternal = rgbaFromBmp(bmp.decode(external));
  for (let index = 0; index < pixels.length; index++) {
    const expected = pixels[index];
    const actual = {
      r: decodedExternal[index * 4],
      g: decodedExternal[index * 4 + 1],
      b: decodedExternal[index * 4 + 2],
    };
    if (actual.r !== expected.r || actual.g !== expected.g || actual.b !== expected.b) {
      throw new Error(
        `BMP decoding changed spec-built pixel ${index}: expected rgb(${expected.r},${expected.g},${expected.b}) ` +
          `but read rgb(${actual.r},${actual.g},${actual.b}). Refusing to benchmark on swapped channels.`,
      );
    }
  }

  // 3. An external reader must see the same colours as the encoder intended.
  if (process.platform === "darwin") {
    const input = temporaryPath("bmp");
    const output = temporaryPath("bmp");
    try {
      fs.writeFileSync(input, encoded.data);
      execFileSync("sips", ["-s", "format", "bmp", input, "--out", output], { stdio: "ignore" });
      const fromSips = rgbaFromBmp(bmp.decode(fs.readFileSync(output)));
      for (let index = 0; index < pixels.length; index++) {
        const expected = pixels[index];
        const actual = {
          r: fromSips[index * 4],
          g: fromSips[index * 4 + 1],
          b: fromSips[index * 4 + 2],
        };
        if (
          Math.abs(actual.r - expected.r) > 2 ||
          Math.abs(actual.g - expected.g) > 2 ||
          Math.abs(actual.b - expected.b) > 2
        ) {
          throw new Error(
            `sips read encoded pixel ${index} as rgb(${actual.r},${actual.g},${actual.b}) ` +
              `instead of rgb(${expected.r},${expected.g},${expected.b}). Refusing to benchmark on swapped channels.`,
          );
        }
      }
    } finally {
      fs.rmSync(input, { force: true });
      fs.rmSync(output, { force: true });
    }
  }
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

export const LANGS = ["ell", "eng"];
export const PSM_MODES = ["4", "11"];

async function withWorker(lang, fn) {
  const worker = await createWorker(lang, 1, {
    langPath: trainedDataDir(),
    gzip: true,
    cachePath: path.join(os.tmpdir(), "ocr-bench-cache"),
    logger: () => {},
  });
  try {
    return await fn(worker);
  } finally {
    await worker.terminate();
  }
}

async function main() {
  const manifestFile = process.argv[2];
  if (manifestFile === "--self-check") {
    assertBmpRoundTrip();
    console.log("BMP round trip OK: encode/decode, the spec decoder and sips preserve RGB channels.");
    return;
  }
  if (!manifestFile) {
    console.error("usage: node --import tsx scripts/ocr-benchmark.mjs <manifest.json> [--json out.json]");
    console.error("       node --import tsx scripts/ocr-benchmark.mjs --self-check");
    process.exitCode = 2;
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  assertBmpRoundTrip();
  const baseDir = path.dirname(path.resolve(manifestFile));
  const jsonFlag = process.argv.indexOf("--json");
  const jsonOut = jsonFlag > 0 ? process.argv[jsonFlag + 1] : null;
  const results = [];

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
}

/** Only run the benchmark when executed, not when a test imports the helpers. */
const invokedDirectly =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
