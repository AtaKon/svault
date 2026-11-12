/**
 * Image types accepted by vision models, shared by the server and the
 * developer benchmark so both label an upload with the same mime type.
 */

export const VISION_IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

/** Largest image sent inline to a vision model. */
export const MAX_VISION_IMAGE_BYTES = 8 * 1024 * 1024;

/** Mime type for an upload, from its file extension. */
export function imageMimeForPathName(filePath: string, fallback = "image/jpeg"): string {
  const match = /\.[A-Za-z0-9]+$/.exec(filePath);
  return (match && VISION_IMAGE_MIME_BY_EXT[match[0].toLowerCase()]) || fallback;
}
