/**
 * Still-image QR decoding for the receipt scan flow.
 *
 * Receipt photos carry a QR with the issuer's digital receipt link. The photo
 * is decoded at its original resolution before any straightening or
 * recompression, because a small code (~3 px per module) does not survive
 * resampling. Standard ZXing runs first across a small ladder of
 * binarizer/downscale variants; when every quick attempt fails, the
 * low-resolution recovery sampler is loaded lazily and retried on the
 * untouched pixels (see client/receipt-qr-recovery.ts).
 *
 * The module never throws: a photo without a readable QR simply yields null.
 * Only QR is decoded — other barcode formats are not receipt links.
 */

import {
  BinaryBitmap,
  DecodeHintType,
  GlobalHistogramBinarizer,
  HybridBinarizer,
  QRCodeReader,
  RGBLuminanceSource,
} from "@zxing/library";

export interface ReceiptQrDecodeOptions {
  /** Soft wall-clock budget for all attempts. Default 4000 ms. */
  budgetMs?: number;
}

const DEFAULT_BUDGET_MS = 4000;
/** Photos above this are downscaled once; the QR needs the pixels it can get. */
const MAX_SOURCE_SIDE = 5120;
/** Extra decodes at smaller sizes; small codes are often found faster there. */
const DOWNSCALE_TARGETS = [1400, 900, 600];

/** A grayscale image: row-major luminance 0 (black) … 255 (white). */
export interface GrayPixels {
  gray: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Average-pool downscale used only to build extra decode attempts. */
function downscale(source: GrayPixels, targetMaxSide: number): GrayPixels {
  const factor = Math.max(2, Math.ceil(Math.max(source.width, source.height) / targetMaxSide));
  const width = Math.max(1, Math.floor(source.width / factor));
  const height = Math.max(1, Math.floor(source.height / factor));
  const gray = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      const yStart = y * factor;
      const xStart = x * factor;
      for (let dy = 0; dy < factor && yStart + dy < source.height; dy++) {
        const row = (yStart + dy) * source.width;
        for (let dx = 0; dx < factor && xStart + dx < source.width; dx++) {
          sum += source.gray[row + xStart + dx];
          count++;
        }
      }
      gray[y * width + x] = sum / Math.max(1, count);
    }
  }
  return { gray, width, height };
}

/** Standard ZXing QR decode over one grayscale variant. */
function decodeStandard(pixels: GrayPixels, deadline: number): string | null {
  const hints = new Map([[DecodeHintType.TRY_HARDER, true]]);
  const source = new RGBLuminanceSource(pixels.gray, pixels.width, pixels.height);
  for (const Binarizer of [HybridBinarizer, GlobalHistogramBinarizer]) {
    if (Date.now() > deadline) return null;
    try {
      const bitmap = new BinaryBitmap(new Binarizer(source));
      const text = new QRCodeReader().decode(bitmap, hints).getText();
      if (text) return text;
    } catch {
      // NotFoundException/FormatException/ChecksumException — try the next pass.
    }
  }
  return null;
}

type RecoveryModule = typeof import("./receipt-qr-recovery.js");
let recoveryModule: Promise<RecoveryModule | null> | null = null;

function loadRecovery(): Promise<RecoveryModule | null> {
  // Loaded only when standard ZXing failed to read the original pixels.
  recoveryModule ??= import("./receipt-qr-recovery.js").catch(() => null);
  return recoveryModule;
}

async function decodeWithRecovery(pixels: GrayPixels, deadline: number): Promise<string | null> {
  const recovery = await loadRecovery();
  if (!recovery || Date.now() > deadline) return null;
  try {
    const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(pixels.gray, pixels.width, pixels.height)));
    return recovery.recoverReceiptQr(bitmap, pixels.gray, pixels.width, pixels.height, deadline);
  } catch {
    return null;
  }
}

/**
 * Decode a QR from grayscale pixels. The untouched-resolution variant is tried
 * first (with the recovery sampler as its fallback); smaller sizes follow only
 * while the budget lasts.
 */
export async function decodeReceiptQrPixels(
  pixels: GrayPixels,
  options: ReceiptQrDecodeOptions = {},
): Promise<string | null> {
  const deadline = Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);
  const initial = decodeStandard(pixels, deadline) ?? await decodeWithRecovery(pixels, deadline);
  if (initial) return initial;
  for (const target of DOWNSCALE_TARGETS) {
    if (Date.now() > deadline) break;
    if (Math.max(pixels.width, pixels.height) <= target + 200) continue;
    const text = decodeStandard(downscale(pixels, target), deadline);
    if (text) return text;
  }
  return null;
}

/** Draw a decoded image to grayscale, capping extreme resolutions. */
function bitmapToGray(bitmap: ImageBitmap): GrayPixels {
  const scale = Math.min(1, MAX_SOURCE_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("no 2d context");
  context.drawImage(bitmap, 0, 0, width, height);
  const rgba = context.getImageData(0, 0, width, height).data;
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
  }
  canvas.width = 0;
  canvas.height = 0;
  return { gray, width, height };
}

/**
 * Decode a QR from a receipt photo File. The original pixels are used before
 * any straightening or recompression the scan flow applies later.
 */
export async function decodeReceiptQrFile(
  file: File,
  options: ReceiptQrDecodeOptions = {},
): Promise<string | null> {
  if (!file.type.startsWith("image/")) return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const pixels = bitmapToGray(bitmap);
    return await decodeReceiptQrPixels(pixels, options);
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}
