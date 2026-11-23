/**
 * Still-image QR decoding for the receipt scan flow.
 *
 * Receipt photos carry a QR with the issuer's digital receipt link. The
 * photo's untouched, full-resolution bitmap is offered to the browser's
 * native BarcodeDetector first when the platform has one — platform decoders
 * tolerate the faint white rows and slight warp thermal printers leave
 * across a code, which defeat pure-JavaScript decoders. When the platform
 * detector reads nothing there, it is retried once on a coarse grid of
 * overlapping, upscaled crops before software runs: a code too small for
 * the detector's view of a large frame is often readable inside a window
 * of it. Whatever the platform cannot read falls back to software. The
 * photo is decoded at its original resolution before any straightening or
 * recompression, because a small code (~3 px per module) does not survive
 * resampling. Standard ZXing runs across a small ladder of
 * binarizer/downscale variants; when every quick attempt fails, the
 * low-resolution recovery sampler is loaded lazily and retried on the
 * untouched pixels (see client/receipt-qr-recovery.ts).
 *
 * The module never throws: a photo without a readable QR simply yields null.
 * Only QR is decoded — other barcode formats are not receipt links.
 */

import { matchReceiptQrLink } from "@shared/receipt-qr-links";
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

/** Standard ZXing QR decode with a Date.now() deadline checked before each pass. */
function decodeStandard(pixels: GrayPixels, deadlineEpochMs: number): string | null {
  const hints = new Map([[DecodeHintType.TRY_HARDER, true]]);
  const source = new RGBLuminanceSource(pixels.gray, pixels.width, pixels.height);
  for (const Binarizer of [HybridBinarizer, GlobalHistogramBinarizer]) {
    // At or past the deadline no new pass starts, so a spent or negative
    // budget decodes nothing.
    if (Date.now() >= deadlineEpochMs) return null;
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

const DEFAULT_FRAME_BUDGET_MS = 200;

/** Decode a live frame synchronously. Check the soft deadline between passes. */
export function decodeReceiptQrFrame(pixels: GrayPixels, options: ReceiptQrDecodeOptions = {}): string | null {
  return decodeStandard(pixels, Date.now() + (options.budgetMs ?? DEFAULT_FRAME_BUDGET_MS));
}

/** RGBA image data to row-major grayscale luminance (ITU-R 601). */
export function rgbaToGray(rgba: Uint8ClampedArray, width: number, height: number, buffer?: Uint8ClampedArray): GrayPixels {
  const pixelCount = width * height;
  if (rgba.length < pixelCount * 4) throw new RangeError("RGBA data is shorter than width × height × 4");
  const gray = buffer?.length === pixelCount ? buffer : new Uint8ClampedArray(pixelCount);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
  }
  return { gray, width, height };
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
  const pixels = rgbaToGray(context.getImageData(0, 0, width, height).data, width, height);
  canvas.width = 0;
  canvas.height = 0;
  return pixels;
}

/** One native detection result; only its payload matters here. */
type DetectedQrCode = { rawValue: string };

/**
 * The Shape Detection API's minimal surface for still images. The standard
 * DOM types do not include BarcodeDetector (Chromium-only), so this module
 * declares the slice it uses, as the live scanner and BarcodeScanner do.
 */
export interface NativeQrDetector {
  detect(source: ImageBitmap): Promise<DetectedQrCode[]>;
}

interface NativeQrDetectorClass {
  new (options: { formats: string[] }): NativeQrDetector;
  getSupportedFormats(): Promise<string[]>;
}

/** Cached platform probe and detector; null once the platform has none. */
let nativeQrDetector: Promise<NativeQrDetector | null> | null = null;

function loadNativeQrDetector(): Promise<NativeQrDetector | null> {
  nativeQrDetector ??= (async () => {
    try {
      if (!("BarcodeDetector" in globalThis)) return null;
      const Detector = (globalThis as { BarcodeDetector?: NativeQrDetectorClass }).BarcodeDetector;
      if (!Detector) return null;
      if (!(await Detector.getSupportedFormats()).includes("qr_code")) return null;
      return new Detector({ formats: ["qr_code"] });
    } catch {
      // Any native failure leaves the photo to the software ladder.
      return null;
    }
  })();
  return nativeQrDetector;
}

/** One retry window over the source bitmap, in source pixels. */
export interface NativeQrTile {
  /** Crop origin. */
  sx: number;
  sy: number;
  /** Crop size. */
  sw: number;
  sh: number;
}

/**
 * A coarse grid of overlapping windows covering the frame, ordered for the
 * native retry: receipt QRs sit in the lower half of a photo and near the
 * horizontal centre, so those windows are tried first. Each window is half
 * the frame wide and tall, so every code smaller than a quarter of the
 * photo fits fully inside at least one of them.
 */
export function nativeRetryTiles(width: number, height: number): NativeQrTile[] {
  const sw = Math.max(1, Math.round(width / 2));
  const sh = Math.max(1, Math.round(height / 2));
  // Crop origins, clamped inside the frame for odd or tiny dimensions.
  const origins = (frame: number, side: number, order: readonly number[]) =>
    order.map((at) => Math.max(0, Math.min(Math.round(frame * at), frame - side)));
  const xs = origins(width, sw, [1 / 4, 0, 1 / 2]); // centre column first
  const ys = origins(height, sh, [1 / 2, 1 / 4, 0]); // lower rows first
  return ys.flatMap((sy) => xs.map((sx) => ({ sx, sy, sw, sh })));
}

/** Retry windows are doubled: a small thermal code grows past the size the
 * platform decoder reads reliably inside a full phone frame. */
const NATIVE_TILE_UPSCALE = 2;

/**
 * Prefer the first code that is a receipt link; when no code is one, the
 * first decoded text is returned anyway, exactly as the software ladder
 * returns payloads it does not recognize.
 */
function pickNativePayload(codes: DetectedQrCode[]): string | null {
  let decoded: string | null = null;
  for (const code of codes) {
    if (!code.rawValue) continue;
    if (matchReceiptQrLink(code.rawValue)) return code.rawValue;
    decoded ??= code.rawValue;
  }
  return decoded;
}

/** Options for the native decode of a still photo. */
export interface NativeQrDecodeOptions {
  /**
   * Epoch-ms wall-clock deadline: at or past it no further retry window is
   * cropped or decoded. The full-frame attempt always runs. Default: the
   * retry is not time-limited.
   */
  deadline?: number;
}

/**
 * Decode a QR with the platform's native detector, injected so tests can
 * stub it. The untouched bitmap is offered first; when that yields no code
 * at all, the detector is retried on a coarse grid of overlapping,
 * upscaled crops while the deadline (when given) lasts. Null means no
 * native answer — the caller falls back to the ZXing ladder.
 */
export async function decodeReceiptQrNatively(
  bitmap: ImageBitmap,
  detector: NativeQrDetector | null | Promise<NativeQrDetector | null>,
  { deadline = Infinity }: NativeQrDecodeOptions = {},
): Promise<string | null> {
  try {
    const native = await detector;
    if (!native) return null;
    const payload = pickNativePayload(await native.detect(bitmap));
    if (payload !== null) return payload;
    // Nothing on the full frame: retry on windows of it while the soft
    // budget lasts. Crops need createImageBitmap; without it (non-browser
    // hosts) there is nothing to retry.
    if (typeof createImageBitmap !== "function") return null;
    for (const tile of nativeRetryTiles(bitmap.width, bitmap.height)) {
      // At or past the deadline no new crop is made or decoded.
      if (Date.now() >= deadline) break;
      let crop: ImageBitmap;
      try {
        crop = await createImageBitmap(bitmap, tile.sx, tile.sy, tile.sw, tile.sh, {
          resizeWidth: tile.sw * NATIVE_TILE_UPSCALE,
          resizeHeight: tile.sh * NATIVE_TILE_UPSCALE,
          resizeQuality: "high",
        });
      } catch {
        continue; // A window that cannot be cropped leaves the rest to try.
      }
      try {
        const tilePayload = pickNativePayload(await native.detect(crop));
        if (tilePayload !== null) return tilePayload;
      } catch {
        // A failing window decode falls through to the next crop.
      } finally {
        crop.close();
      }
    }
    return null;
  } catch {
    // Any native error falls through to the software ladder.
    return null;
  }
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
    // The platform detector reads the untouched bitmap first, at the
    // original resolution and before any downscale; the soft budget covers
    // the whole read — the full frame, its retry windows, and the software
    // ladder in whatever time remains.
    const deadline = Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);
    if (Date.now() < deadline) {
      const native = await decodeReceiptQrNatively(bitmap, loadNativeQrDetector(), { deadline });
      if (native !== null) return native;
    }
    const pixels = bitmapToGray(bitmap);
    return await decodeReceiptQrPixels(pixels, { ...options, budgetMs: Math.max(0, deadline - Date.now()) });
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}
