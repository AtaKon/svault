import {
  BinaryBitmap,
  BitMatrix,
  DecodeHintType,
  FormatException,
  HybridBinarizer,
  NotFoundException,
  PerspectiveTransform,
  RGBLuminanceSource,
} from "@zxing/library";
import Decoder from "@zxing/library/esm/core/qrcode/decoder/Decoder.js";
import Detector from "@zxing/library/esm/core/qrcode/detector/Detector.js";

/**
 * When a QR module is only a few pixels wide, rounding the sampling grid can
 * move a row off its centers. Reuse ZXing's detected geometry and correction
 * code, trying sub-module adjustments ranked by contrast on known patterns.
 */
export function recoverReceiptQr(
  bitmap: BinaryBitmap,
  luminance: Uint8ClampedArray,
  width: number,
  height: number,
  deadline = Infinity,
): string | null {
  if (Date.now() >= deadline) return null;
  const detection = detectGeometry(bitmap, luminance, width, height);
  if (!detection) return null;
  const size = detection.getBits().getWidth();
  const [bottomLeft, topLeft, topRight, alignment] = detection.getPoints();
  // Version 1 has no alignment pattern. Recovery needs that fourth point.
  if (!alignment || size < 25 || size > 57) return null;

  const acrossX = (topRight.getX() - topLeft.getX()) / (size - 7);
  const acrossY = (topRight.getY() - topLeft.getY()) / (size - 7);
  const downX = (bottomLeft.getX() - topLeft.getX()) / (size - 7);
  const downY = (bottomLeft.getY() - topLeft.getY()) / (size - 7);
  if (Math.min(Math.hypot(acrossX, acrossY), Math.hypot(downX, downY)) > 6) return null;

  const pixel = (x: number, y: number) => {
    if (x < 0 || x >= width - 1 || y < 0 || y >= height - 1) return 255;
    const column = Math.floor(x);
    const row = Math.floor(y);
    const index = row * width + column;
    const dx = x - column;
    const dy = y - row;
    const top = luminance[index] * (1 - dx) + luminance[index + 1] * dx;
    const bottom = luminance[index + width] * (1 - dx) + luminance[index + width + 1] * dx;
    return top * (1 - dy) + bottom * dy;
  };

  const known = knownModules(size);
  const knownCoordinates = Float32Array.from(known.flatMap(({ x, y }) => [x + 0.5, y + 0.5]));
  const knownSamples = new Float32Array(knownCoordinates.length);
  const darkCount = known.filter(({ dark }) => dark).length;
  const lightCount = known.length - darkCount;
  const candidates: { transform: PerspectiveTransform; black: number; contrast: number }[] = [];
  const offsets = [0, -0.18, 0.18, -0.36, 0.36, -0.54, 0.54];
  const bottomRight = size - 6.5;
  const farFinder = size - 3.5;

  for (const top of offsets) for (const bottom of offsets) for (const across of offsets) for (const lower of offsets) {
    if (Date.now() >= deadline) return null;
    const x = across * acrossX;
    const y = across * acrossY;
    const transform = PerspectiveTransform.quadrilateralToQuadrilateral(
      3.5, 3.5, farFinder, 3.5, bottomRight, bottomRight, 3.5, farFinder,
      topLeft.getX() + x + top * downX, topLeft.getY() + y + top * downY,
      topRight.getX() + x + top * downX, topRight.getY() + y + top * downY,
      alignment.getX() + x + lower * downX, alignment.getY() + y + lower * downY,
      bottomLeft.getX() + x + bottom * downX, bottomLeft.getY() + y + bottom * downY,
    );
    knownSamples.set(knownCoordinates);
    transform.transformPoints(knownSamples);
    let darkSum = 0;
    let lightSum = 0;
    for (let i = 0; i < known.length; i++) {
      const value = pixel(knownSamples[2 * i], knownSamples[2 * i + 1]);
      if (known[i].dark) darkSum += value;
      else lightSum += value;
    }
    const black = darkSum / darkCount;
    candidates.push({ transform, black, contrast: lightSum / lightCount - black });
  }

  const moduleCoordinates = new Float32Array(2 * size * size);
  for (let index = 0; index < size * size; index++) {
    moduleCoordinates[2 * index] = index % size + 0.5;
    moduleCoordinates[2 * index + 1] = Math.floor(index / size) + 0.5;
  }
  const positions = new Float32Array(moduleCoordinates.length);
  const samples = new Float32Array(size * size);
  const decoder = new Decoder();
  candidates.sort((left, right) => right.contrast - left.contrast);
  for (const { transform, black, contrast } of candidates.slice(0, 96)) {
    if (Date.now() >= deadline) return null;
    positions.set(moduleCoordinates);
    transform.transformPoints(positions);
    for (let i = 0; i < samples.length; i++) samples[i] = pixel(positions[2 * i], positions[2 * i + 1]);
    for (const ratio of [0.35, 0.5, 0.31, 0.42, 0.58]) {
      const threshold = black + ratio * contrast;
      const matrix = new BitMatrix(size);
      for (let i = 0; i < samples.length; i++) {
        if (samples[i] < threshold) matrix.set(i % size, Math.floor(i / size));
      }
      try {
        const text = decoder.decodeBitMatrix(matrix).getText();
        if (text) return text;
      } catch {
        // Incorrect sampling positions can exceed the QR error-correction budget.
      }
    }
  }
  return null;
}

function detectGeometry(
  bitmap: BinaryBitmap,
  luminance: Uint8ClampedArray,
  width: number,
  height: number,
): ReturnType<Detector["detect"]> | null {
  const hints = new Map([[DecodeHintType.TRY_HARDER, true]]);
  try {
    return new Detector(bitmap.getBlackMatrix()).detect(hints);
  } catch (error) {
    if (error instanceof NotFoundException) return null;
    if (!(error instanceof FormatException)) throw error;
  }
  // A blurred timing row can give FinderPattern an invalid module count.
  // Retry geometry with a fixed cutoff. Payload sampling still uses the
  // original luminance with thresholds derived from the detected QR patterns.
  const thresholded = luminance.map((value) => value < 115 ? 0 : 255);
  const binarizer = new HybridBinarizer(new RGBLuminanceSource(thresholded, width, height));
  try {
    return new Detector(binarizer.getBlackMatrix()).detect(hints);
  } catch (error) {
    if (error instanceof NotFoundException || error instanceof FormatException) return null;
    throw error;
  }
}

function knownModules(size: number) {
  const modules: { x: number; y: number; dark: boolean }[] = [];
  for (const [centerX, centerY, radius] of [[3, 3, 4], [size - 4, 3, 4], [3, size - 4, 4], [size - 7, size - 7, 2]]) {
    const darkRings = radius === 4 ? [0, 1, 3] : [0, 2];
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const x = centerX + dx;
      const y = centerY + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) {
        modules.push({ x, y, dark: darkRings.includes(Math.max(Math.abs(dx), Math.abs(dy))) });
      }
    }
  }
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    modules.push({ x: i, y: 6, dark }, { x: 6, y: i, dark });
  }
  return modules;
}
