import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "vite";
import zxing from "@zxing/library";

// Bundle as the client does so ZXing's browser-side module resolution is tested.
const [bundle] = await build({
  configFile: false,
  logLevel: "silent",
  build: { write: false, lib: { entry: "client/receipt-qr-recovery.ts", formats: ["es"] } },
});
const chunk = bundle.output.find((output) => output.type === "chunk");
const { recoverReceiptQr } = await import("data:text/javascript;base64," + Buffer.from(chunk.code).toString("base64"));

const text = "https://e-invoicing.gr/edocuments/ViewInvoice/-1/12345678-1234-1234-1234-123456789abc_testAB12";
const width = 130;
const height = 130;
const hints = new Map([[zxing.DecodeHintType.TRY_HARDER, true]]);

function qrModules(payload, version) {
  return new zxing.QRCodeWriter().encode(payload, zxing.BarcodeFormat.QR_CODE, 0, 0, new Map([
    [zxing.EncodeHintType.MARGIN, 0],
    [zxing.EncodeHintType.QR_VERSION, version],
    [zxing.EncodeHintType.ERROR_CORRECTION, "L"],
  ]));
}

function grayscale(modules, warped) {
  const size = modules.getWidth();
  const gray = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let dark = 0;
      // Sample each pixel at nine points to emulate camera blur at ~3 pixels per module.
      for (const dx of [-0.35, 0, 0.35]) for (const dy of [-0.35, 0, 0.35]) {
        const sx = x + dx - 10.35;
        const sy = y + dy - 10.35;
        const column = Math.floor(warped ? (sx + 0.03 * sy) / 2.82 + 0.24 * Math.sin(sy * 0.03) : sx / 4);
        const row = Math.floor(warped ? (sy - 0.04 * sx) / 2.82 + 0.3 * Math.sin(sx * 0.04) : sy / 4);
        if (column >= 0 && row >= 0 && column < size && row < size && modules.get(column, row)) dark++;
      }
      gray[y * width + x] = 240 - 210 * dark / 9;
    }
  }
  return gray;
}

test("recovers a warped low-resolution QR that the standard readers cannot decode", () => {
  const gray = grayscale(qrModules(text, 5), true);
  const luminance = new zxing.RGBLuminanceSource(gray, width, height);
  const bitmap = new zxing.BinaryBitmap(new zxing.HybridBinarizer(luminance));
  const global = new zxing.BinaryBitmap(new zxing.GlobalHistogramBinarizer(luminance));
  for (const input of [bitmap, global]) {
    assert.throws(() => new zxing.QRCodeReader().decode(input, hints));
  }
  assert.equal(recoverReceiptQr(bitmap, gray, width, height), text);
});

test("leaves version-one QR codes without an alignment pattern to the standard reader", () => {
  const gray = grayscale(qrModules("version one", 1), false);
  const bitmap = new zxing.BinaryBitmap(new zxing.HybridBinarizer(new zxing.RGBLuminanceSource(gray, width, height)));
  assert.equal(new zxing.QRCodeReader().decode(bitmap, hints).getText(), "version one");
  assert.equal(recoverReceiptQr(bitmap, gray, width, height), null);
});

test("a blank image has no receipt QR", () => {
  const gray = new Uint8ClampedArray(width * height).fill(240);
  const bitmap = new zxing.BinaryBitmap(new zxing.HybridBinarizer(new zxing.RGBLuminanceSource(gray, width, height)));
  assert.equal(recoverReceiptQr(bitmap, gray, width, height), null);
});
