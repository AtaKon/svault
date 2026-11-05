/**
 * Visual receipt stitching.
 *
 * Receipt photos arrive one page at a time. This combines the already
 * straightened pages into a single tall JPEG so a receipt stays one stored
 * image, one thumbnail and one full-size viewer entry.
 *
 * Purely presentational: OCR runs on each page before this, so a seam never
 * hides or duplicates recognised text. Keep the canvas inside browser limits
 * (iOS Safari caps the total area) and re-encode smaller when the upload would
 * approach the server's size limit.
 */

export interface StitchOptions {
  /** Widest output, in pixels. Pages are scaled down but never up. */
  maxWidth?: number;
  /** Tallest output, in pixels. */
  maxHeight?: number;
  /** Total canvas area in pixels; iOS Safari rejects very large canvases. */
  maxPixels?: number;
  quality?: number;
  background?: string;
}

const DEFAULTS = {
  maxWidth: 2000,
  maxHeight: 12000,
  maxPixels: 16_000_000,
  quality: 0.9,
  background: "#ffffff",
};

/** Leave headroom under the default 20 MB upload limit. */
const MAX_FILE_BYTES = 18 * 1024 * 1024;

interface Layout {
  width: number;
  heights: number[];
  totalHeight: number;
}

function layoutPages(bitmaps: ImageBitmap[], maxWidth: number, maxHeight: number, maxPixels: number): Layout {
  const naturalWidth = Math.max(...bitmaps.map((bitmap) => bitmap.width));
  let width = Math.max(1, Math.min(naturalWidth, maxWidth));
  let heights = bitmaps.map((bitmap) => Math.max(1, Math.round((bitmap.height / bitmap.width) * width)));
  let totalHeight = heights.reduce((sum, height) => sum + height, 0);

  const scale = Math.min(1, maxHeight / totalHeight, Math.sqrt(maxPixels / (width * totalHeight)));
  if (scale < 1) {
    width = Math.max(1, Math.floor(width * scale));
    heights = bitmaps.map((bitmap) => Math.max(1, Math.round((bitmap.height / bitmap.width) * width)));
    totalHeight = heights.reduce((sum, height) => sum + height, 0);
  }

  return { width, heights, totalHeight };
}

function drawPages(bitmaps: ImageBitmap[], layout: Layout, background: string): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = layout.width;
  canvas.height = layout.totalHeight;
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  let y = 0;
  bitmaps.forEach((bitmap, index) => {
    context.drawImage(bitmap, 0, y, layout.width, layout.heights[index]);
    y += layout.heights[index];
  });
  return canvas;
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
  });
}

/**
 * Stacks the pages top to bottom into one JPEG. A single page is returned
 * untouched so a normal scan is not re-compressed. Returns null when the
 * browser cannot decode or encode the images.
 */
export async function stitchImages(files: File[], options: StitchOptions = {}): Promise<File | null> {
  if (!files.length) return null;
  if (files.length === 1) return files[0];

  const settings = { ...DEFAULTS, ...options };
  const bitmaps: ImageBitmap[] = [];
  try {
    for (const file of files) bitmaps.push(await createImageBitmap(file));

    let layout = layoutPages(bitmaps, settings.maxWidth, settings.maxHeight, settings.maxPixels);
    let canvas = drawPages(bitmaps, layout, settings.background);
    if (!canvas) return null;

    let blob = await encode(canvas, settings.quality);
    if (!blob) return null;

    // Quality is cheaper to give up than legibility: only shrink the page width
    // when the lowest usable quality still overshoots the upload limit.
    for (const quality of [0.8, 0.7, 0.6]) {
      if (blob.size <= MAX_FILE_BYTES) break;
      const smaller = await encode(canvas, quality);
      if (smaller) blob = smaller;
    }
    if (blob.size > MAX_FILE_BYTES) {
      layout = layoutPages(bitmaps, Math.floor(layout.width * 0.75), settings.maxHeight, settings.maxPixels);
      canvas = drawPages(bitmaps, layout, settings.background);
      const smaller = canvas ? await encode(canvas, 0.72) : null;
      if (smaller) blob = smaller;
    }

    return new File([blob], `receipt-combined-${Date.now()}.jpg`, { type: "image/jpeg" });
  } catch {
    return null;
  } finally {
    for (const bitmap of bitmaps) bitmap.close?.();
  }
}
