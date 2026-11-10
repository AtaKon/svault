import { billPhotoName, billPhotoSize, isBillPdf } from "../shared/bill-document.js";

/**
 * Browser-side preparation of a bill photo.
 *
 * Phone camera rolls hand over HEIC/HEIF (iPhone), AVIF, GIF, BMP and TIFF.
 * The server and the local OCR worker need a format every browser can decode,
 * so the first decodable photo is re-encoded to JPEG once and the same bytes
 * are used for the scan, the upload and a later re-read. HEIC is decoded by the
 * browser only on Safari (iOS/macOS); elsewhere the UI asks for the camera
 * button or a JPEG instead of uploading a file nothing can read.
 */

export const BILL_PHOTO_HEIC_ERROR = "bill-photo-heic";
export const BILL_PHOTO_DECODE_ERROR = "bill-photo-decode";

/** Largest edge kept when a phone photo is re-encoded before upload. */
const MAX_PHOTO_EDGE = 2600;
const PASSTHROUGH_TYPES = new Set(["image/jpeg", "image/jpg", "image/pjpeg", "image/png", "image/webp"]);
const HEIC_TYPE = /^image\/hei[cf]$/i;
const HEIC_NAME = /\.(?:heic|heif)$/i;

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.92));
}

/** Re-encode a phone photo as JPEG; pass PDFs and web-native images through. */
export async function prepareBillImage(file: File): Promise<File> {
  if (isBillPdf(file) || PASSTHROUGH_TYPES.has(file.type)) return file;
  const heic = HEIC_TYPE.test(file.type) || HEIC_NAME.test(file.name);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(heic ? BILL_PHOTO_HEIC_ERROR : BILL_PHOTO_DECODE_ERROR);
  }
  let canvas: HTMLCanvasElement | null = null;
  try {
    const { width, height } = billPhotoSize(bitmap.width, bitmap.height, MAX_PHOTO_EDGE);
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(BILL_PHOTO_DECODE_ERROR);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvasToJpeg(canvas);
    if (!blob) throw new Error(BILL_PHOTO_DECODE_ERROR);
    return new File([blob], billPhotoName(file.name), { type: "image/jpeg", lastModified: Date.now() });
  } catch {
    throw new Error(heic ? BILL_PHOTO_HEIC_ERROR : BILL_PHOTO_DECODE_ERROR);
  } finally {
    // Release the large backing store on every path, not just success.
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    bitmap.close();
  }
}
