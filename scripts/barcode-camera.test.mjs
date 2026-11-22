import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  nativeFormatName,
  nativeIdleFallback,
  NATIVE_IDLE_FALLBACK_MS,
  pickRearCamera,
  PRODUCT_BARCODE_FORMATS,
  rearCameras,
} from "../client/barcode-camera.js";

// The package ships as CommonJS; loading it through require keeps the enum
// readable without relying on Node's named-export detection.
const { BarcodeFormat } = createRequire(import.meta.url)("@zxing/library");

const device = (deviceId, label) => ({ deviceId, label });

// The device list Chrome on a Samsung Galaxy exposes after the permission
// grant: several rear lenses named only by their camera2 index, plus the
// front camera. A plain facingMode request often hands out camera2 1 or 2.
const galaxy = [
  device("front", "camera2 1, facing front"),
  device("galaxy-2", "camera2 2, facing back"),
  device("galaxy-0", "camera2 0, facing back"),
  device("galaxy-1", "camera2 1, facing back"),
];

const iphone = [
  device("front", "Front Camera"),
  device("tele", "Back Telephoto Camera"),
  device("ultra", "Back Ultra Wide Camera"),
  device("wide", "Back Wide Camera"),
  device("main", "Back Camera"),
];

test("pickRearCamera prefers the Android main lens on a Galaxy device list", () => {
  assert.equal(pickRearCamera(galaxy), "galaxy-0");
});

test("pickRearCamera keeps the browser default on iPhone labels", () => {
  // iOS Safari already defaults to a suitable lens and offers virtual
  // multi-lens cameras; only Android lens names identify the main lens.
  assert.equal(pickRearCamera(iphone), null);
});

test("pickRearCamera returns null for a single back camera", () => {
  assert.equal(pickRearCamera([device("only", "Back Camera"), device("front", "Front Camera")]), null);
  assert.equal(pickRearCamera([device("only", "camera2 0, facing back")]), null);
});

test("pickRearCamera returns null before the permission grant fills the labels", () => {
  assert.equal(pickRearCamera([device("a", ""), device("b", ""), device("c", "")]), null);
});

test("pickRearCamera ignores unidentified lenses once two back cameras are labeled", () => {
  // Two back cameras exist, but only one can be identified as back; the
  // choice cannot be made, so the facingMode stream stays untouched.
  assert.equal(pickRearCamera([device("known", "camera2 0, facing back"), device("mystery", "")]), null);
});

test("pickRearCamera makes no choice when no Android main lens is identifiable", () => {
  const ultra = device("ultra", "Back Ultra Wide Camera");
  const tele = device("tele", "Back Telephoto Camera");
  assert.equal(pickRearCamera([tele, ultra, device("front", "Front Camera")]), null);
  assert.equal(pickRearCamera([device("b2", "camera2 2, facing back"), device("b3", "camera2 3, facing back")]), null);
});

test("rearCameras orders the Galaxy lenses main first and drops the front camera", () => {
  assert.deepEqual(rearCameras(galaxy).map(({ deviceId }) => deviceId), ["galaxy-0", "galaxy-1", "galaxy-2"]);
});

test("rearCameras orders iPhone lenses by rank, then list order", () => {
  assert.deepEqual(rearCameras(iphone).map(({ deviceId }) => deviceId), ["main", "tele", "ultra", "wide"]);
});

test("rearCameras recognizes rear and environment labels too", () => {
  const devices = [
    device("rear-1", "Rear Camera 1"),
    device("rear-0", "camera2 0, facing back"),
    device("env", "environment facing camera"),
    device("front", "Front Camera"),
  ];
  assert.deepEqual(rearCameras(devices).map(({ deviceId }) => deviceId), ["rear-0", "rear-1", "env"]);
});

test("rearCameras keeps a stable order for labels without a camera2 index", () => {
  const devices = [device("a", "Back Camera"), device("b", "Back Camera")];
  assert.deepEqual(rearCameras(devices).map(({ deviceId }) => deviceId), ["a", "b"]);
});

test("nativeFormatName maps BarcodeDetector names to ZXing enum names", () => {
  assert.equal(nativeFormatName("ean_13"), "EAN_13");
  assert.equal(nativeFormatName("ean_8"), "EAN_8");
  assert.equal(nativeFormatName("upc_a"), "UPC_A");
  assert.equal(nativeFormatName("upc_e"), "UPC_E");
  assert.equal(nativeFormatName("code_128"), "CODE_128");
  assert.equal(nativeFormatName("code_39"), "CODE_39");
  assert.equal(nativeFormatName("code_93"), "CODE_93");
  assert.equal(nativeFormatName("itf"), "ITF");
  assert.equal(nativeFormatName("codabar"), "CODABAR");
  assert.equal(nativeFormatName("qr_code"), "QR_CODE");
  assert.equal(nativeFormatName("pdf417"), "PDF_417");
});

test("nativeFormatName keeps a familiar shape for unknown native formats", () => {
  assert.equal(nativeFormatName("new_format"), "NEW_FORMAT");
});

test("nativeIdleFallback retires a detector only after the full grace period", () => {
  const startedAt = 1_000;
  assert.equal(nativeIdleFallback(startedAt, null, startedAt + NATIVE_IDLE_FALLBACK_MS - 1), false);
  assert.equal(nativeIdleFallback(startedAt, null, startedAt + NATIVE_IDLE_FALLBACK_MS), true);
  assert.equal(nativeIdleFallback(startedAt, null, startedAt + NATIVE_IDLE_FALLBACK_MS + 1), true);
});

test("nativeIdleFallback never retires a detector that has detected a code", () => {
  // One detection anywhere in the session trusts the detector for good,
  // no matter how long a later quiet stretch lasts.
  const startedAt = 1_000;
  assert.equal(nativeIdleFallback(startedAt, 4_000, startedAt + NATIVE_IDLE_FALLBACK_MS), false);
  assert.equal(nativeIdleFallback(startedAt, 4_000, Number.MAX_SAFE_INTEGER), false);
});

test("nativeIdleFallback keeps waiting while the loop has just started", () => {
  assert.equal(nativeIdleFallback(1_000, null, 1_001), false);
  assert.equal(nativeIdleFallback(1_000, null, 999), false);
});

test("every product format maps to an existing ZXing BarcodeFormat name", () => {
  assert.ok(PRODUCT_BARCODE_FORMATS.includes("qr_code"), "SVault label QR codes stay scannable");
  for (const format of PRODUCT_BARCODE_FORMATS) {
    const name = nativeFormatName(format);
    assert.ok(name in BarcodeFormat, `${format} should map to a BarcodeFormat member, got ${name}`);
  }
});
