/**
 * Browser-side document scanner for receipt photos.
 *
 * The paper is the bright blob in the frame, so a down-scaled copy is
 * thresholded, lightly closed to bridge print and shadow gaps, and the largest
 * plausible component is reduced to four corners. The photo is then warped with
 * a projective mesh, which also deskews a receipt shot at an angle.
 *
 * This is deliberately conservative: when the page cannot be found confidently
 * the original photo is returned untouched. Cropping a partial receipt off
 * would be worse than reading a noisy one.
 */

export interface Point {
  x: number;
  y: number;
}

/** Clockwise from the top-left corner, in source pixels. */
export type Quad = [Point, Point, Point, Point];

export interface DocumentScanResult {
  file: File;
  /** Detected page corners in source pixels, or null when the photo was left alone. */
  corners: Quad | null;
}

const ANALYSIS_MAX = 420;
const CLOSE_RADIUS = 3;
const MAX_COMPONENTS = 6;
const MIN_PAPER_SHARE = 0.1;
const MAX_PAPER_SHARE = 0.97;
const MIN_QUAD_HULL_SHARE = 0.82;
const MIN_INK_SHARE = 0.004;
const MIN_BACKGROUND_GAP = 10;
const MAX_OUTPUT_PIXELS = 12_000_000;
const DEFAULT_MAX_SIZE = 2400;
const DEFAULT_QUALITY = 0.92;

function otsu(histogram: Uint32Array, total: number): number {
  let sum = 0;
  for (let value = 0; value < histogram.length; value++) sum += value * histogram[value];

  let backgroundWeight = 0;
  let backgroundSum = 0;
  let best = -1;
  let threshold = 127;

  for (let value = 0; value < histogram.length; value++) {
    backgroundWeight += histogram[value];
    if (!backgroundWeight) continue;
    const foregroundWeight = total - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += value * histogram[value];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (sum - backgroundSum) / foregroundWeight;
    const between = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (between > best) {
      best = between;
      threshold = value;
    }
  }
  return threshold;
}

function percentile(histogram: Uint32Array, total: number, fraction: number): number {
  const target = Math.max(1, Math.floor(total * fraction));
  let seen = 0;
  for (let value = 0; value < histogram.length; value++) {
    seen += histogram[value];
    if (seen >= target) return value;
  }
  return 255;
}

/** One dilation or erosion pass with a square window. Out-of-frame pixels are ignored so paper may touch the edge. */
function morphMask(mask: Uint8Array, width: number, height: number, radius: number, keep: 0 | 1): Uint8Array {
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value: 0 | 1 = keep === 1 ? 0 : 1;
      for (let dy = -radius; dy <= radius && value !== keep; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (mask[ny * width + nx] === keep) {
            value = keep;
            break;
          }
        }
      }
      output[y * width + x] = value;
    }
  }
  return output;
}

/** Closing bridges the tiny gaps that print and shadows punch into the paper mask. */
function closeMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  return morphMask(morphMask(mask, width, height, radius, 1), width, height, radius, 0);
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function polygonArea(points: Point[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length];
    area += points[index].x * next.y - next.x * points[index].y;
  }
  return Math.abs(area) / 2;
}

/** Andrew's monotonic chain. Collinear points are dropped so corners stay crisp. */
function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return [];
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const deduped: Point[] = [];
  for (const point of sorted) {
    const last = deduped[deduped.length - 1];
    if (!last || last.x !== point.x || last.y !== point.y) deduped.push(point);
  }
  if (deduped.length < 3) return [];

  const lower: Point[] = [];
  for (const point of deduped) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Point[] = [];
  for (let index = deduped.length - 1; index >= 0; index--) {
    const point = deduped[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/** Clockwise order with the visually top-left corner first. */
function orderQuad(points: Point[]): Quad | null {
  if (points.length !== 4) return null;
  for (let index = 0; index < points.length; index++) {
    for (let other = index + 1; other < points.length; other++) {
      if (distance(points[index], points[other]) < 4) return null;
    }
  }

  const cx = points.reduce((sum, point) => sum + point.x, 0) / 4;
  const cy = points.reduce((sum, point) => sum + point.y, 0) / 4;
  const ordered = [...points].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );
  const topLeft = ordered.reduce(
    (best, point, index) => (point.x + point.y < ordered[best].x + ordered[best].y ? index : best),
    0,
  );
  const rotated = [...ordered.slice(topLeft), ...ordered.slice(0, topLeft)];

  for (let index = 0; index < 4; index++) {
    const turn = cross(rotated[index], rotated[(index + 1) % 4], rotated[(index + 2) % 4]);
    if (turn <= 0) return null;
  }
  return rotated as Quad;
}

function cornerAngles(quad: Quad): number[] {
  return quad.map((point, index) => {
    const previous = quad[(index + 3) % 4];
    const next = quad[(index + 1) % 4];
    const ax = previous.x - point.x;
    const ay = previous.y - point.y;
    const bx = next.x - point.x;
    const by = next.y - point.y;
    const length = Math.hypot(ax, ay) * Math.hypot(bx, by);
    if (!length) return 0;
    return (Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / length))) * 180) / Math.PI;
  });
}

/** The diagonal extremes of the hull are the four page corners for any sane photo. */
function quadFromHull(hull: Point[]): Quad | null {
  if (hull.length < 4) return null;
  let topLeft = hull[0];
  let bottomRight = hull[0];
  let topRight = hull[0];
  let bottomLeft = hull[0];
  for (const point of hull) {
    if (point.x + point.y < topLeft.x + topLeft.y) topLeft = point;
    if (point.x + point.y > bottomRight.x + bottomRight.y) bottomRight = point;
    if (point.x - point.y > topRight.x - topRight.y) topRight = point;
    if (point.x - point.y < bottomLeft.x - bottomLeft.y) bottomLeft = point;
  }
  if (new Set([topLeft, topRight, bottomRight, bottomLeft]).size !== 4) return null;
  return orderQuad([topLeft, topRight, bottomRight, bottomLeft]);
}

function pointInQuad(point: Point, quad: Quad): boolean {
  let sign = 0;
  for (let index = 0; index < 4; index++) {
    const value = cross(quad[index], quad[(index + 1) % 4], point);
    if (value === 0) continue;
    const direction = value > 0 ? 1 : -1;
    if (!sign) sign = direction;
    else if (sign !== direction) return false;
  }
  return true;
}

interface Analysis {
  width: number;
  height: number;
  luma: Uint8Array;
  threshold: number;
  pixels: number[];
  area: number;
  sumLuma: number;
  hull: Point[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Candidate {
  quad: Quad;
  ink: number;
}

/** Bounding boxes that touch or nearly touch; used to spot a shadow-split page. */
function isNear(a: Analysis, b: Analysis, margin: number): boolean {
  return (
    a.minX - margin <= b.maxX &&
    b.minX - margin <= a.maxX &&
    a.minY - margin <= b.maxY &&
    b.minY - margin <= a.maxY
  );
}

/**
 * Walks the closed mask from largest component down and returns the first one
 * that looks like a page: bright against its surroundings, rectangular enough,
 * and actually carrying ink.
 */
function findPaperQuad(bitmap: ImageBitmap): Quad | null {
  const scale = Math.min(1, ANALYSIS_MAX / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(8, Math.round(bitmap.width * scale));
  const height = Math.max(8, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, width, height);

  let image: ImageData;
  try {
    image = context.getImageData(0, 0, width, height);
  } catch {
    return null;
  }

  const data = image.data;
  const total = width * height;
  const luma = new Uint8Array(total);
  const histogram = new Uint32Array(256);
  for (let pixel = 0, index = 0; pixel < total; pixel++, index += 4) {
    const value = Math.round(0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]);
    luma[pixel] = value;
    histogram[value]++;
  }

  const threshold = otsu(histogram, total);
  const raw = new Uint8Array(total);
  for (let pixel = 0; pixel < total; pixel++) raw[pixel] = luma[pixel] > threshold ? 1 : 0;
  const mask = closeMask(raw, width, height, CLOSE_RADIUS);

  const visited = new Uint8Array(total);
  const components: Analysis[] = [];
  const stack: number[] = [];

  for (let start = 0; start < total; start++) {
    if (!mask[start] || visited[start]) continue;
    visited[start] = 1;
    stack.push(start);
    const pixels: number[] = [];
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let sumLuma = 0;

    while (stack.length) {
      const index = stack.pop()!;
      pixels.push(index);
      const x = index % width;
      const y = (index - x) / width;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      sumLuma += luma[index];

      if (x > 0 && mask[index - 1] && !visited[index - 1]) {
        visited[index - 1] = 1;
        stack.push(index - 1);
      }
      if (x + 1 < width && mask[index + 1] && !visited[index + 1]) {
        visited[index + 1] = 1;
        stack.push(index + 1);
      }
      if (y > 0 && mask[index - width] && !visited[index - width]) {
        visited[index - width] = 1;
        stack.push(index - width);
      }
      if (y + 1 < height && mask[index + width] && !visited[index + width]) {
        visited[index + width] = 1;
        stack.push(index + width);
      }
    }

    const area = pixels.length;
    if (area < total * MIN_PAPER_SHARE) continue;

    const boundary: Point[] = [];
    for (const index of pixels) {
      const x = index % width;
      const y = (index - x) / width;
      if (
        x === 0 ||
        y === 0 ||
        x === width - 1 ||
        y === height - 1 ||
        !mask[index - 1] ||
        !mask[index + 1] ||
        !mask[index - width] ||
        !mask[index + width]
      ) {
        boundary.push({ x, y });
      }
    }

    components.push({
      width,
      height,
      luma,
      threshold,
      pixels,
      area,
      sumLuma,
      hull: convexHull(boundary),
      minX,
      minY,
      maxX,
      maxY,
    });
  }

  components.sort((a, b) => b.area - a.area);

  const candidates: Candidate[] = [];
  for (const component of components.slice(0, MAX_COMPONENTS)) {
    // A second bright blob of similar size right next to this one usually means
    // the paper was split by a shadow. Leave that photo alone rather than risk
    // cropping half a receipt.
    const margin = Math.max(width, height) * 0.08;
    const split =
      components.some(
        (other) =>
          other !== component &&
          other.area >= component.area * 0.4 &&
          isNear(component, other, margin),
      );
    if (split) continue;

    const quad = quadFromHull(component.hull);
    if (!quad) continue;

    const quadArea = polygonArea(quad);
    const share = quadArea / total;
    if (share < MIN_PAPER_SHARE || share > MAX_PAPER_SHARE) continue;
    if (quadArea < polygonArea(component.hull) * MIN_QUAD_HULL_SHARE) continue;
    if (cornerAngles(quad).some((angle) => angle < 50 || angle > 130)) continue;

    // A page should stand out from what is around it. Compare its mean brightness
    // with the median of everything outside the component.
    const componentHistogram = new Uint32Array(256);
    for (const index of component.pixels) componentHistogram[component.luma[index]]++;
    const backgroundHistogram = new Uint32Array(256);
    for (let value = 0; value < 256; value++) {
      backgroundHistogram[value] = Math.max(0, histogram[value] - componentHistogram[value]);
    }
    const background = percentile(backgroundHistogram, total - component.area, 0.5);
    if (component.sumLuma / component.area < background + MIN_BACKGROUND_GAP) continue;

    const ink = measureInk(component, quad);
    if (ink.share < MIN_INK_SHARE) continue;

    candidates.push({ quad, ink: ink.pixels });
  }

  // Text is the best tie-breaker: the receipt carries far more ink than a bright
  // wall, window or table that slipped through the shape checks.
  if (!candidates.length) return null;
  const best = candidates.sort((a, b) => b.ink - a.ink)[0].quad;

  const inv = 1 / scale;
  return best.map((point) => ({
    x: Math.max(0, Math.min(bitmap.width - 1, point.x * inv)),
    y: Math.max(0, Math.min(bitmap.height - 1, point.y * inv)),
  })) as Quad;
}

interface InkStats {
  /** Ink pixels as a share of the quad area. */
  share: number;
  pixels: number;
}

/** Text is what makes a receipt worth scanning; a plain bright table is not. */
function measureInk(component: Analysis, quad: Quad): InkStats {
  const inkThreshold = Math.max(0, component.threshold - 10);
  let inside = 0;
  let ink = 0;

  for (let y = component.minY; y <= component.maxY; y++) {
    for (let x = component.minX; x <= component.maxX; x++) {
      if (!pointInQuad({ x, y }, quad)) continue;
      inside++;
      if (component.luma[y * component.width + x] < inkThreshold) ink++;
    }
  }
  return { share: inside ? ink / inside : 0, pixels: ink };
}

interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

interface Homography {
  a11: number;
  a21: number;
  a31: number;
  a12: number;
  a22: number;
  a32: number;
  a13: number;
  a23: number;
}

/**
 * Projective map from the unit square onto a quad (Heckbert). Corners are
 * (0,0), (1,0), (1,1), (0,1) to match a TL/TR/BR/BL ordered quad.
 */
function squareToQuad(quad: Quad): Homography {
  const [p0, p1, p2, p3] = quad;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;

  if (Math.abs(dx3) < 1e-6 && Math.abs(dy3) < 1e-6) {
    return {
      a11: p1.x - p0.x,
      a21: p2.x - p1.x,
      a31: p0.x,
      a12: p1.y - p0.y,
      a22: p2.y - p1.y,
      a32: p0.y,
      a13: 0,
      a23: 0,
    };
  }

  const denominator = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(denominator) < 1e-6) {
    return {
      a11: p1.x - p0.x,
      a21: p2.x - p1.x,
      a31: p0.x,
      a12: p1.y - p0.y,
      a22: p2.y - p1.y,
      a32: p0.y,
      a13: 0,
      a23: 0,
    };
  }

  const a13 = (dx3 * dy2 - dx2 * dy3) / denominator;
  const a23 = (dx1 * dy3 - dx3 * dy1) / denominator;
  return {
    a11: p1.x - p0.x + a13 * p1.x,
    a21: p3.x - p0.x + a23 * p3.x,
    a31: p0.x,
    a12: p1.y - p0.y + a13 * p1.y,
    a22: p3.y - p0.y + a23 * p3.y,
    a32: p0.y,
    a13,
    a23,
  };
}

function project(homography: Homography, u: number, v: number): Point {
  const w = homography.a13 * u + homography.a23 * v + 1;
  return {
    x: (homography.a11 * u + homography.a21 * v + homography.a31) / w,
    y: (homography.a12 * u + homography.a22 * v + homography.a32) / w,
  };
}


/** Affine map that carries three source points onto three target points. */
function triangleTransform(source: [Point, Point, Point], target: [Point, Point, Point]): Affine | null {
  const [s0, s1, s2] = source;
  const [t0, t1, t2] = target;
  const denominator = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
  if (Math.abs(denominator) < 1e-6) return null;

  const a = ((t1.x - t0.x) * (s2.y - s0.y) - (t2.x - t0.x) * (s1.y - s0.y)) / denominator;
  const c = ((t2.x - t0.x) * (s1.x - s0.x) - (t1.x - t0.x) * (s2.x - s0.x)) / denominator;
  const b = ((t1.y - t0.y) * (s2.y - s0.y) - (t2.y - t0.y) * (s1.y - s0.y)) / denominator;
  const d = ((t2.y - t0.y) * (s1.x - s0.x) - (t1.y - t0.y) * (s2.x - s0.x)) / denominator;
  return {
    a,
    b,
    c,
    d,
    e: t0.x - a * s0.x - c * s0.y,
    f: t0.y - b * s0.x - d * s0.y,
  };
}

function expandTriangle(triangle: [Point, Point, Point], amount: number): [Point, Point, Point] {
  const cx = (triangle[0].x + triangle[1].x + triangle[2].x) / 3;
  const cy = (triangle[0].y + triangle[1].y + triangle[2].y) / 3;
  return triangle.map((point) => {
    const length = Math.hypot(point.x - cx, point.y - cy);
    const factor = length ? 1 + amount / length : 1;
    return { x: cx + (point.x - cx) * factor, y: cy + (point.y - cy) * factor };
  }) as [Point, Point, Point];
}

/** Each mesh cell is a clipped affine draw; together they approximate the projective warp. */
function drawTriangle(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  source: [Point, Point, Point],
  target: [Point, Point, Point],
): void {
  const transform = triangleTransform(source, target);
  if (!transform) return;

  const clip = expandTriangle(target, 0.75);
  context.save();
  context.beginPath();
  context.moveTo(clip[0].x, clip[0].y);
  context.lineTo(clip[1].x, clip[1].y);
  context.lineTo(clip[2].x, clip[2].y);
  context.closePath();
  context.clip();
  context.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0);
  context.restore();
}

function warpQuad(bitmap: ImageBitmap, quad: Quad, maxSize: number, quality: number): Promise<Blob | null> {
  const [topLeft, topRight, bottomRight, bottomLeft] = quad;
  let width = Math.round(Math.max(distance(topLeft, topRight), distance(bottomLeft, bottomRight)));
  let height = Math.round(Math.max(distance(topLeft, bottomLeft), distance(topRight, bottomRight)));
  width = Math.max(1, width);
  height = Math.max(1, height);

  const shrink = Math.min(
    1,
    maxSize / Math.max(width, height),
    Math.sqrt(MAX_OUTPUT_PIXELS / (width * height)),
  );
  width = Math.max(1, Math.round(width * shrink));
  height = Math.max(1, Math.round(height * shrink));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return Promise.resolve(null);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);

  // A mesh of small triangles keeps the projective warp faithful instead of
  // bending text along a single diagonal.
  const homography = squareToQuad(quad);
  const cells = 8;
  for (let row = 0; row < cells; row++) {
    for (let column = 0; column < cells; column++) {
      const u0 = column / cells;
      const u1 = (column + 1) / cells;
      const v0 = row / cells;
      const v1 = (row + 1) / cells;

      const p00 = project(homography, u0, v0);
      const p10 = project(homography, u1, v0);
      const p11 = project(homography, u1, v1);
      const p01 = project(homography, u0, v1);

      const d00 = { x: u0 * width, y: v0 * height };
      const d10 = { x: u1 * width, y: v0 * height };
      const d11 = { x: u1 * width, y: v1 * height };
      const d01 = { x: u0 * width, y: v1 * height };

      drawTriangle(context, bitmap, [p00, p10, p11], [d00, d10, d11]);
      drawTriangle(context, bitmap, [p00, p11, p01], [d00, d11, d01]);
    }
  }

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
  });
}

/**
 * Finds the receipt in a photo and straightens it. Returns the original file
 * when no page is found or anything goes wrong.
 */
export async function scanDocument(
  file: File,
  options: { maxSize?: number; quality?: number } = {},
): Promise<DocumentScanResult> {
  if (!file.type.startsWith("image/")) return { file, corners: null };

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const corners = findPaperQuad(bitmap);
    if (!corners) return { file, corners: null };

    const scanned = await warpQuad(
      bitmap,
      corners,
      options.maxSize ?? DEFAULT_MAX_SIZE,
      options.quality ?? DEFAULT_QUALITY,
    );
    if (!scanned) return { file, corners: null };

    const name = file.name.replace(/\.[^.]+$/, "") || "scan";
    const warped = new File([scanned], `${name}.jpg`, { type: "image/jpeg" });
    if (import.meta.env.DEV) console.debug("[scan] paper corners", corners);
    return { file: warped, corners };
  } catch {
    return { file, corners: null };
  } finally {
    bitmap?.close?.();
  }
}

