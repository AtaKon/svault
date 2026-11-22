/**
 * Pure lens-selection and format rules for the product barcode scanner
 * (client/barcode-camera-stream.ts owns the DOM side): which rear camera is
 * the main lens on multi-camera phones, and how native BarcodeDetector
 * format names map to the ZXing BarcodeFormat names the rest of the app
 * already receives. DOM-free so a Node test can import it directly
 * (see scripts/barcode-camera.test.mjs).
 */

export interface CameraDeviceLike {
  deviceId: string;
  label: string;
}

const BACK_CAMERA_LABEL = /back|rear|environment/i;
const AUXILIARY_LENS_LABEL = /ultra|wide|tele|zoom|depth|macro|infrared/i;
const ANDROID_MAIN_LENS_LABEL = /camera2 0\b/i;
const ANDROID_LENS_INDEX = /camera2 (\d+)\b/i;

/**
 * Back cameras in the order the Lens button should cycle them: the main lens
 * first, then the rest by their camera2 index and list order. Devices whose
 * label does not identify them as back cameras (including label-less entries
 * before a permission grant) are left out.
 */
export function rearCameras(devices: CameraDeviceLike[]): CameraDeviceLike[] {
  const mainRank = (label: string): number => {
    // Android names the main rear lens "camera2 0"; the ultra-wide and
    // telephoto lenses that cannot focus at barcode distance come later.
    if (ANDROID_MAIN_LENS_LABEL.test(label)) return 0;
    return AUXILIARY_LENS_LABEL.test(label) ? 2 : 1;
  };
  const lensIndex = (label: string): number => {
    const match = ANDROID_LENS_INDEX.exec(label);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  };
  return devices
    .map((device, index) => ({ device, index }))
    .filter(({ device }) => BACK_CAMERA_LABEL.test(device.label))
    .sort((a, b) => {
      const byRank = mainRank(a.device.label) - mainRank(b.device.label);
      if (byRank !== 0) return byRank;
      const byLens = lensIndex(a.device.label) - lensIndex(b.device.label);
      if (byLens !== 0) return byLens;
      return a.index - b.index;
    })
    .map(({ device }) => device);
}

/**
 * The deviceId of the main rear lens, or null when the browser's own
 * facingMode choice should stand. Only Android names its lenses in a way
 * that identifies the main one ("camera2 0, facing back"), and Android
 * Chrome is where a plain facingMode request hands out the ultra-wide or
 * telephoto lens. Other platforms (iOS Safari offers virtual multi-lens
 * cameras that switch for close focus on their own) keep their default,
 * and so do single-lens devices and label-less lists before a permission
 * grant. The Lens button still cycles every back camera manually.
 */
export function pickRearCamera(devices: CameraDeviceLike[]): string | null {
  const rear = rearCameras(devices);
  if (rear.length < 2) return null;
  const main = rear[0];
  return main && ANDROID_MAIN_LENS_LABEL.test(main.label) ? main.deviceId || null : null;
}

/**
 * The barcode formats the product scanner accepts, in native
 * BarcodeDetector naming. QR_CODE stays in the list: SVault label QR codes
 * route through parseLabelScan in the scanner component.
 */
export const PRODUCT_BARCODE_FORMATS = [
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_128",
  "code_39",
  "code_93",
  "itf",
  "codabar",
  "qr_code",
] as const;

const NATIVE_FORMAT_NAMES: Record<string, string> = {
  aztec: "AZTEC",
  codabar: "CODABAR",
  code_128: "CODE_128",
  code_39: "CODE_39",
  code_93: "CODE_93",
  data_matrix: "DATA_MATRIX",
  ean_13: "EAN_13",
  ean_8: "EAN_8",
  itf: "ITF",
  pdf417: "PDF_417",
  qr_code: "QR_CODE",
  upc_a: "UPC_A",
  upc_e: "UPC_E",
};

/**
 * How long the native detector loop may run without ever detecting a code
 * before ZXing takes over for the rest of the session.
 */
export const NATIVE_IDLE_FALLBACK_MS = 6000;

/**
 * Some Android BarcodeDetector implementations resolve [] for every 1D
 * barcode they cannot read instead of throwing, so a session could sit on
 * a detector that never finds anything. Such a loop hands the frames to
 * ZXing once it has run this long without a single detection; a detector
 * that has detected any code in the session is trusted and never retired
 * on idle.
 */
export function nativeIdleFallback(startedAt: number, lastDetectionAt: number | null, now: number): boolean {
  if (lastDetectionAt !== null) return false;
  return now - startedAt >= NATIVE_IDLE_FALLBACK_MS;
}

/**
 * Map a native BarcodeDetector format name to the ZXing BarcodeFormat enum
 * name callers already receive (EAN_13, UPC_A, CODE_128, ...). Unknown names
 * fall back to the same upper-snake-case shape so a new native format still
 * produces a familiar string.
 */
export function nativeFormatName(format: string): string {
  const known = NATIVE_FORMAT_NAMES[format];
  if (known) return known;
  return format
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
