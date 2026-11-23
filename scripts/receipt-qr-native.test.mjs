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
  const before = nativeCalls;
  assert.equal(await supported.decodeReceiptQrFile(fakeFile()), epsilonUrl);
  // The full frame was offered, then every retry window (the crops reuse
  // the stubbed bitmap), before the software ladder found the code.
  assert.equal(nativeCalls, before + 1 + supported.nativeRetryTiles(width, height).length);
  // The supported-formats probe ran once and its result is cached.
  assert.equal(formatsCalls, 1);
  assert.equal(createElement.mock.callCount(), 1);
  assert.equal(getImageData.mock.callCount(), 1);
  // Every retry crop is closed, then the source bitmap.
  assert.equal(bitmap.close.mock.callCount(), 1 + supported.nativeRetryTiles(width, height).length);
});

test("a thrown native error falls back to the software ladder", async (t) => {
  const { getImageData, createElement } = stubStillImage(t);
  replaceGlobal(t, "BarcodeDetector", supportedStub);
  nativeBehavior = async () => { throw new Error("Native detector failed"); };
  const before = nativeCalls;
  assert.equal(await supported.decodeReceiptQrFile(fakeFile()), epsilonUrl);
  // A detector that crashes on the full frame is not retried on crops.
  assert.equal(nativeCalls, before + 1);
  assert.equal(formatsCalls, 1);
  assert.equal(createElement.mock.callCount(), 1);
  assert.equal(getImageData.mock.callCount(), 1);
});

test("a spent budget skips the native attempt too", async (t) => {
  const { createElement } = stubStillImage(t);
  replaceGlobal(t, "BarcodeDetector", supportedStub);
  nativeBehavior = async () => [{ rawValue: epsilonUrl }];
  const before = nativeCalls;
  assert.equal(await supported.decodeReceiptQrFile(fakeFile(), { budgetMs: 0 }), null);
  assert.equal(nativeCalls, before);
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

test("the retry grid covers the frame, lower rows and centre column first", () => {
  const tiles = supported.nativeRetryTiles(1500, 2000);
  assert.deepEqual(tiles.map(({ sx, sy }) => `${sx},${sy}`), [
    "375,1000", "0,1000", "750,1000",
    "375,500", "0,500", "750,500",
    "375,0", "0,0", "750,0",
  ]);
  for (const tile of tiles) {
    assert.deepEqual([tile.sw, tile.sh], [750, 1000]);
    assert.ok(tile.sx >= 0 && tile.sy >= 0 && tile.sx + tile.sw <= 1500 && tile.sy + tile.sh <= 2000);
  }
  // Odd and tiny frames still produce windows inside the bitmap.
  for (const [width, height] of [[1501, 2001], [3, 2], [1, 1]]) {
    for (const tile of supported.nativeRetryTiles(width, height)) {
      assert.ok(tile.sw >= 1 && tile.sh >= 1);
      assert.ok(tile.sx >= 0 && tile.sy >= 0 && tile.sx + tile.sw <= width && tile.sy + tile.sh <= height);
    }
  }
});

test("a full-frame miss is retried on upscaled crops until a window hits", async (t) => {
  const bitmap = { width: 480, height: 360, close: t.mock.fn() };
  const crops = [];
  replaceGlobal(t, "createImageBitmap", t.mock.fn(async (source, sx, sy, sw, sh, options) => {
    const crop = { source, sx, sy, sw, sh, options, close: t.mock.fn() };
    crops.push(crop);
    return crop;
  }));
  // The detector only finds a code inside one particular window, so the
  // returned payload proves the windows were cropped and decoded in order.
  const hit = { sx: 240, sy: 90 };
  const detector = {
    detect: async (source) =>
      source !== bitmap && source.sx === hit.sx && source.sy === hit.sy ? [{ rawValue: entersoftUrl }] : [],
  };
  assert.equal(await supported.decodeReceiptQrNatively(bitmap, detector), entersoftUrl);
  const tiles = supported.nativeRetryTiles(480, 360);
  const hitIndex = tiles.findIndex((tile) => tile.sx === hit.sx && tile.sy === hit.sy);
  assert.deepEqual(
    crops.map((crop) => [crop.sx, crop.sy]),
    tiles.slice(0, hitIndex + 1).map((tile) => [tile.sx, tile.sy]),
    "windows are cropped in grid order and stop at the hit",
  );
  for (const crop of crops) {
    assert.equal(crop.source, bitmap);
    assert.deepEqual(crop.options, {
      resizeWidth: crop.sw * 2,
      resizeHeight: crop.sh * 2,
      resizeQuality: "high",
    });
    assert.equal(crop.close.mock.callCount(), 1, "every crop is closed");
  }
  assert.equal(bitmap.close.mock.callCount(), 0, "the source bitmap belongs to the caller");
});

test("the crop retry stops at the deadline", async (t) => {
  const bitmap = { width: 480, height: 360, close: t.mock.fn() };
  const create = t.mock.fn(async () => ({ close: t.mock.fn() }));
  replaceGlobal(t, "createImageBitmap", create);
  const detect = t.mock.fn(async () => []);
  const now = t.mock.method(Date, "now", () => 20_000);
  try {
    assert.equal(await supported.decodeReceiptQrNatively(bitmap, { detect }, { deadline: 19_999 }), null);
  } finally {
    now.mock.restore();
  }
  assert.equal(detect.mock.callCount(), 1, "only the full frame is decoded");
  assert.equal(create.mock.callCount(), 0, "no crop is made at or past the deadline");
});

test("an expired deadline mid-grid leaves the remaining windows undecoded", async (t) => {
  const bitmap = { width: 480, height: 360, close: t.mock.fn() };
  const create = t.mock.fn(async () => ({ close: t.mock.fn() }));
  replaceGlobal(t, "createImageBitmap", create);
  const detect = t.mock.fn(async () => []);
  const times = [10_000, 10_050, 10_100];
  const now = t.mock.method(Date, "now", () => times.shift() ?? 99_999);
  try {
    assert.equal(await supported.decodeReceiptQrNatively(bitmap, { detect }, { deadline: 10_500 }), null);
  } finally {
    now.mock.restore();
  }
  assert.equal(detect.mock.callCount(), 4, "the full frame plus two windows were decoded");
  assert.equal(create.mock.callCount(), 3);
});

test("a window that cannot be cropped is skipped, not fatal", async (t) => {
  const bitmap = { width: 480, height: 360, close: t.mock.fn() };
  let made = 0;
  replaceGlobal(t, "createImageBitmap", t.mock.fn(async () => {
    made++;
    if (made === 1) throw new Error("crop failed");
    return { tag: `crop-${made}`, close: t.mock.fn() };
  }));
  const detect = t.mock.fn(async (source) =>
    typeof source === "object" && source.tag === "crop-3" ? [{ rawValue: entersoftUrl }] : []);
  assert.equal(await supported.decodeReceiptQrNatively(bitmap, { detect }), entersoftUrl);
  assert.equal(made, 3, "the failed crop did not end the grid");
  assert.equal(detect.mock.callCount(), 3, "the failed crop was never decoded");
});
