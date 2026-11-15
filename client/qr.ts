/**
 * QR codes for printable labels, rendered as an SVG path.
 *
 * The encoder is ZXing's `QRCodeWriter`, from the `@zxing/library` package the
 * camera scanner already uses (Apache-2.0). That means no new runtime
 * dependency and no extra bytes in the main bundle: the library is in the main
 * chunk for the scanner either way.
 *
 * The module is imported as a namespace so this file also loads under
 * `node --test` (where the package resolves to CommonJS and only `default` is
 * visible). Production code passes the Vite/ES-module namespace, while the
 * tests pass the unwrapped CommonJS object through the `zxing` argument.
 */
import * as zxingExports from "@zxing/library";

export interface QrMatrix {
  /** Width and height in modules, quiet zone included. */
  size: number;
  /** SVG path data drawing every dark module as a 1×1 square. */
  path: string;
}

type Zxing = typeof import("@zxing/library");
type HintKey = import("@zxing/library").EncodeHintType;

const defaultZxing = zxingExports as unknown as Zxing;

/** Pure helper so the SVG geometry can be tested without the encoder. */
export function matrixToSvgPath(isDark: (x: number, y: number) => boolean, size: number): string {
  let path = "";
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (isDark(x, y)) path += `M${x} ${y}h1v1h-1z`;
    }
  }
  return path;
}

const cache = new Map<string, QrMatrix>();

/** Encode one label link. Results are cached: the same link is printed often. */
export async function qrMatrixFor(text: string, zxing: Zxing = defaultZxing): Promise<QrMatrix> {
  const cached = cache.get(text);
  if (cached) return cached;
  const hints = new Map<HintKey, unknown>([
    // Medium correction tolerates a smudge on a freezer label without growing
    // the code too much; the default four-module quiet zone is kept.
    [zxing.EncodeHintType.ERROR_CORRECTION, "M"],
    [zxing.EncodeHintType.MARGIN, 4],
  ]);
  const matrix = new zxing.QRCodeWriter().encode(text, zxing.BarcodeFormat.QR_CODE, 0, 0, hints);
  const size = matrix.getWidth();
  const result: QrMatrix = { size, path: matrixToSvgPath((x, y) => matrix.get(x, y), size) };
  cache.set(text, result);
  return result;
}
