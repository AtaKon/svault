import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import zxing from "@zxing/library";

// Bundle client/receipt-qr.ts exactly as the client does (the matching
// bundler spellings are explained in receipt-qr-live.test.mjs). The bundle is
// imported once per tag through distinct data: URLs, so each import is a
// fresh module instance with its own module-level BarcodeDetector probe
// cache: the still-image path caches the platform probe per page load, and
// the tests exercise an absent, an unsupported and a supported platform
// without one cached result leaking into the next.
async function importBundledInstances(entry, tags) {
  const [bundle] = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      lib: { entry, formats: ["es"] },
      rolldownOptions: { output: { codeSplitting: false } },
    },
    resolve: { alias: { "@shared": fileURLToPath(new URL("../shared", import.meta.url)) } },
  });
  const chunk = bundle.output.find((output) => output.type === "chunk");
  if (!chunk) throw new Error(`Bundling ${entry} produced no JavaScript chunk; check the Vite/Rolldown options above`);
  return Object.fromEntries(
    await Promise.all(tags.map(async (tag) => [
      tag,
      await import("data:text/javascript;base64," + Buffer.from(`${chunk.code}\n// ${tag}`).toString("base64")),
    ])),
  );
}

const { absent, unsupported, supported } = await importBundledInstances("client/receipt-qr.ts", [
  "absent",
  "unsupported",
  "supported",
]);

// The payload from the field report: an Epsilon Digital (Sklavenitis) thermal
// receipt whose QR only the platform decoder reads.
const epsilonUrl = "https://epsilondigital-sklavenitis.epsilonnet.gr/fd/2627ca2ea8d144f70a3808df39f01303:155";
const entersoftUrl = "https://e-invoicing.gr/edocuments/ViewInvoice/-1/12345678-1234-1234-1234-123456789abc_testAB12";

const width = 480;
const height = 360;

/** A clean synthetic receipt QR the software ladder decodes without help. */
function receiptQrGray() {
  const hints = new Map([[zxing.EncodeHintType.MARGIN, 0]]);
  const modules = new zxing.QRCodeWriter().encode(epsilonUrl, zxing.BarcodeFormat.QR_CODE, 0, 0, hints);
  const moduleSize = 3;
  const xOffset = Math.floor((width - modules.getWidth() * moduleSize) / 2);
  const yOffset = Math.floor((height - modules.getHeight() * moduleSize) / 2);
  const gray = new Uint8ClampedArray(width * height).fill(240);
  for (let y = 0; y < modules.getHeight(); y++) {
    for (let x = 0; x < modules.getWidth(); x++) {
      if (!modules.get(x, y)) continue;
      for (let row = 0; row < moduleSize; row++) {
        const start = (yOffset + y * moduleSize + row) * width + xOffset + x * moduleSize;
        gray.fill(30, start, start + moduleSize);
      }
    }
  }
  return gray;
}

const gray = receiptQrGray();
const rgba = new Uint8ClampedArray(gray.length * 4);
for (let i = 0; i < gray.length; i++) rgba.set([gray[i], gray[i], gray[i], 255], i * 4);

function replaceGlobal(t, name, value) {
  const before = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => {
    if (before) Object.defineProperty(globalThis, name, before);
    else delete globalThis[name];
  });
}

function ensureNoBarcodeDetector(t) {
  const before = Object.getOwnPropertyDescriptor(globalThis, "BarcodeDetector");
  delete globalThis.BarcodeDetector;
  t.after(() => {
    if (before) Object.defineProperty(globalThis, "BarcodeDetector", before);
    else delete globalThis.BarcodeDetector;
  });
}

/** The still-image decode environment: a fake bitmap whose pixels carry the synthetic QR. */
function stubStillImage(t) {
  const bitmap = { width, height, close: t.mock.fn() };
  const getImageData = t.mock.fn(() => ({ data: rgba, width, height }));
  const createElement = t.mock.fn(() => ({ getContext: () => ({ drawImage() {}, getImageData }) }));
  replaceGlobal(t, "createImageBitmap", t.mock.fn(async () => bitmap));
  replaceGlobal(t, "document", { createElement });
  return { bitmap, getImageData, createElement };
}

const fakeFile = () => new File([Uint8Array.of(1, 2, 3)], "receipt.jpg", { type: "image/jpeg" });

// The supported-platform stub. The still-image path caches its probe per page
// load, so the first decode builds the only detector instance the module ever
// uses; later tests steer it through these mutable closures and read the
// counters instead of replacing the class.
let nativeCalls = 0;
let formatsCalls = 0;
let lastNativeSource;
let nativeBehavior = async () => [{ format: "qr_code", rawValue: epsilonUrl }];

const supportedStub = class {
  static async getSupportedFormats() {
    formatsCalls++;
    return ["qr_code", "ean_13"];
  }
  async detect(source) {
    nativeCalls++;
    lastNativeSource = source;
    return nativeBehavior(source);
  }
};

test("the native attempt prefers the first code that is a receipt link", async () => {
  const bitmap = {};
  const seen = [];
  const detector = {
    detect: async (source) => {
      seen.push(source);
      return [
        { rawValue: "https://example.com/menu" },
        { rawValue: epsilonUrl },
        { rawValue: entersoftUrl },
      ];
    },
  };
  assert.equal(await supported.decodeReceiptQrNatively(bitmap, detector), epsilonUrl);
  assert.deepEqual(seen, [bitmap]);
  assert.equal(await supported.decodeReceiptQrNatively(bitmap, Promise.resolve(detector)), epsilonUrl);
});

test("a native hit without any receipt link still returns its decoded text", async () => {
  const detector = { detect: async () => [{ rawValue: "not a receipt link" }] };
  assert.equal(await supported.decodeReceiptQrNatively({}, detector), "not a receipt link");
});

test("an empty or blank native reply yields no payload", async () => {
  assert.equal(await supported.decodeReceiptQrNatively({}, { detect: async () => [] }), null);
  assert.equal(await supported.decodeReceiptQrNatively({}, { detect: async () => [{ rawValue: "" }] }), null);
});

test("a failing or missing native detector yields no payload", async () => {
  const failing = { detect: async () => { throw new Error("Native detector crashed"); } };
  assert.equal(await supported.decodeReceiptQrNatively({}, failing), null);
  assert.equal(await supported.decodeReceiptQrNatively({}, Promise.reject(new Error("probe failed"))), null);
  assert.equal(await supported.decodeReceiptQrNatively({}, null), null);
  assert.equal(await supported.decodeReceiptQrNatively({}, Promise.resolve(null)), null);
});

test("a native hit returns the receipt link payload without running the software decoder", async (t) => {
  const { bitmap, createElement } = stubStillImage(t);
  replaceGlobal(t, "BarcodeDetector", supportedStub);
  nativeBehavior = async () => [{ rawValue: "https://example.com/menu" }, { rawValue: epsilonUrl }];
  assert.equal(await supported.decodeReceiptQrFile(fakeFile()), epsilonUrl);
  assert.equal(nativeCalls, 1);
  assert.equal(lastNativeSource, bitmap, "detection sees the untouched, full-resolution bitmap");
  assert.equal(createElement.mock.callCount(), 0, "no canvas is read, so the ZXing ladder never ran");
  assert.equal(bitmap.close.mock.callCount(), 1);
  assert.equal(formatsCalls, 1);
});

test("an empty native result falls back to the software ladder", async (t) => {
  const { bitmap, getImageData, createElement } = stubStillImage(t);
  replaceGlobal(t, "BarcodeDetector", supportedStub);
  nativeBehavior = async () => [];
  assert.equal(await supported.decodeReceiptQrFile(fakeFile()), epsilonUrl);
  assert.equal(nativeCalls, 2);
  // The supported-formats probe ran once and its result is cached.
  assert.equal(formatsCalls, 1);
  assert.equal(createElement.mock.callCount(), 1);
  assert.equal(getImageData.mock.callCount(), 1);
  assert.equal(bitmap.close.mock.callCount(), 1);
});

test("a thrown native error falls back to the software ladder", async (t) => {
  const { getImageData, createElement } = stubStillImage(t);
  replaceGlobal(t, "BarcodeDetector", supportedStub);
  nativeBehavior = async () => { throw new Error("Native detector failed"); };
  assert.equal(await supported.decodeReceiptQrFile(fakeFile()), epsilonUrl);
  assert.equal(nativeCalls, 3);
  assert.equal(formatsCalls, 1);
  assert.equal(createElement.mock.callCount(), 1);
  assert.equal(getImageData.mock.callCount(), 1);
});

test("a spent budget skips the native attempt too", async (t) => {
  const { createElement } = stubStillImage(t);
  replaceGlobal(t, "BarcodeDetector", supportedStub);
  nativeBehavior = async () => [{ rawValue: epsilonUrl }];
  assert.equal(await supported.decodeReceiptQrFile(fakeFile(), { budgetMs: 0 }), null);
  assert.equal(nativeCalls, 3);
  assert.equal(createElement.mock.callCount(), 1);
});

test("a platform without BarcodeDetector decodes with the software ladder", async (t) => {
  ensureNoBarcodeDetector(t);
  const { createElement } = stubStillImage(t);
  assert.equal(await absent.decodeReceiptQrFile(fakeFile()), epsilonUrl);
  assert.equal(createElement.mock.callCount(), 1);
});

test("a platform whose detector lacks qr_code support decodes with the software ladder", async (t) => {
  const { createElement } = stubStillImage(t);
  const formats = t.mock.fn(async () => ["ean_13", "pdf417"]);
  const detect = t.mock.fn(async () => assert.fail("detect must not run without qr_code support"));
  replaceGlobal(t, "BarcodeDetector", class {
    static getSupportedFormats = formats;
    detect = detect;
  });
  assert.equal(await unsupported.decodeReceiptQrFile(fakeFile()), epsilonUrl);
  assert.equal(formats.mock.callCount(), 1);
  assert.equal(detect.mock.callCount(), 0);
  assert.equal(createElement.mock.callCount(), 1);
});
