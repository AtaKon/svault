import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "vite";
import zxing from "@zxing/library";

// Match the client's resolution of ZXing's browser-side exports.
async function importBundled(entry) {
  const [bundle] = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      lib: { entry, formats: ["es"] },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
  const chunk = bundle.output.find((output) => output.type === "chunk");
  return import("data:text/javascript;base64," + Buffer.from(chunk.code).toString("base64"));
}

const [qr, { startLiveQrScan }] = await Promise.all([
  importBundled("client/receipt-qr.ts"),
  importBundled("client/receipt-qr-live.ts"),
]);

const text = "https://e-invoicing.gr/edocuments/ViewInvoice/-1/12345678-1234-1234-1234-123456789abc_testAB12";
const hints = new Map([[zxing.DecodeHintType.TRY_HARDER, true]]);

function qrModules(payload, version) {
  return new zxing.QRCodeWriter().encode(payload, zxing.BarcodeFormat.QR_CODE, 0, 0, new Map([
    [zxing.EncodeHintType.MARGIN, 0],
    [zxing.EncodeHintType.QR_VERSION, version],
    [zxing.EncodeHintType.ERROR_CORRECTION, "L"],
  ]));
}

/**
 * Emulates a hand-held photo of the printed code: the QR sits at a few
 * pixels per module inside a much larger frame, every pixel samples nine
 * points to approximate camera blur, and the paper is not fully white.
 * Warping curls the paper the way thermal receipts curl.
 */
function renderPhoto(modules, width, height, pxPerModule, warped) {
  const size = modules.getWidth();
  const codeSide = size * pxPerModule;
  const offX = (width - codeSide) / 2;
  const offY = (height - codeSide) / 2;
  const gray = new Uint8ClampedArray(width * height).fill(246);
  for (let y = Math.max(0, Math.floor(offY) - 3); y < Math.min(height, Math.ceil(offY + codeSide) + 3); y++) {
    for (let x = Math.max(0, Math.floor(offX) - 3); x < Math.min(width, Math.ceil(offX + codeSide) + 3); x++) {
      let dark = 0;
      for (const dx of [-0.35, 0, 0.35]) for (const dy of [-0.35, 0, 0.35]) {
        const sx = x + dx - offX;
        const sy = y + dy - offY;
        const column = Math.floor(warped ? (sx + 0.03 * sy) / (pxPerModule - 0.08) + 0.24 * Math.sin(sy * 0.03) : sx / pxPerModule);
        const row = Math.floor(warped ? (sy - 0.04 * sx) / (pxPerModule - 0.08) + 0.3 * Math.sin(sx * 0.04) : sy / pxPerModule);
        if (column >= 0 && row >= 0 && column < size && row < size && modules.get(column, row)) dark++;
      }
      gray[y * width + x] = 244 - 212 * dark / 9;
    }
  }
  return gray;
}

test("still ladder: a phone photo of a curled low-resolution receipt QR", async () => {
  // ~3 px per module, warped and blurred: the standard readers cannot read
  // it (proved below), so the ladder has to go through the recovery sampler.
  const modules = qrModules(text, 5);
  const gray = renderPhoto(modules, 130, 130, 2.9, true);
  const luminance = new zxing.RGBLuminanceSource(gray, 130, 130);
  const bitmap = new zxing.BinaryBitmap(new zxing.HybridBinarizer(luminance));
  const global = new zxing.BinaryBitmap(new zxing.GlobalHistogramBinarizer(luminance));
  for (const input of [bitmap, global]) assert.throws(() => new zxing.QRCodeReader().decode(input, hints));
  assert.equal(await qr.decodeReceiptQrPixels({ gray, width: 130, height: 130 }), text);
});

test("still ladder: a small code inside a full-resolution phone photo", async () => {
  // A 2200×1600 frame with the printed code occupying a
  // small region — the resolution regime mobile photos land in, where the
  // code must be read at the untouched pixels before any downscale.
  const modules = qrModules(text, 5);
  const gray = renderPhoto(modules, 2200, 1600, 2.9, false);
  assert.equal(await qr.decodeReceiptQrPixels({ gray, width: 2200, height: 1600 }), text);
});

test("still ladder: a photo with no readable QR and an exhausted budget yield null", async () => {
  const blank = new Uint8ClampedArray(300 * 200).fill(235);
  assert.equal(await qr.decodeReceiptQrPixels({ gray: blank, width: 300, height: 200 }), null);
  const modules = qrModules(text, 5);
  const gray = renderPhoto(modules, 130, 130, 2.9, true);
  assert.equal(await qr.decodeReceiptQrPixels({ gray, width: 130, height: 130 }, { budgetMs: -1 }), null);
});

function replaceGlobal(t, name, value) {
  const before = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => {
    if (before) Object.defineProperty(globalThis, name, before);
    else delete globalThis[name];
  });
}

test("live camera caps native frame size, ignores non-QR results and falls back if detection throws", async (t) => {
  const width = 1280;
  const height = 720;
  const gray = renderPhoto(qrModules(text, 5), width, height, 4, false);
  const rgba = new Uint8ClampedArray(gray.length * 4);
  for (let i = 0; i < gray.length; i++) rgba.set([gray[i], gray[i], gray[i], 255], i * 4);
  const track = { stop: t.mock.fn() };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  let frame;
  let nativeAttempts = 0;
  const nativeFrames = [];
  const clearInterval = t.mock.fn();
  replaceGlobal(t, "navigator", { mediaDevices: { getUserMedia: async () => stream } });
  replaceGlobal(t, "window", {
    setInterval: (callback) => { frame = callback; return 1; },
    clearInterval,
  });
  replaceGlobal(t, "document", {
    createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: rgba }) }) }),
  });
  replaceGlobal(t, "BarcodeDetector", class {
    static async getSupportedFormats() { return ["qr_code"]; }
    async detect(source) {
      nativeAttempts++;
      nativeFrames.push({ width: source.width, height: source.height });
      if (nativeAttempts === 1) {
        return [{ format: "ean_13", rawValue: "0123456789012" }];
      }
      if (nativeAttempts === 2) {
        return [{ format: "qr_code", rawValue: "" }];
      }
      throw new Error("Native detector unavailable");
    }
  });

  const video = { videoWidth: 1920, videoHeight: 1080, readyState: 2, play: async () => {} };
  const scan = new AbortController();
  t.after(() => scan.abort());
  const found = [];
  await startLiveQrScan(video, (payload) => found.push(payload), scan.signal);
  assert.equal(video.srcObject, stream);
  frame();
  await Promise.resolve();
  assert.deepEqual(found, []);
  frame();
  await Promise.resolve();
  assert.deepEqual(found, []);
  frame();
  await Promise.resolve();
  assert.deepEqual(nativeFrames, Array(3).fill({ width, height }));
  assert.deepEqual(found, [text]);
  scan.abort();
  frame();
  assert.deepEqual(found, [text]);
  assert.equal(track.stop.mock.callCount(), 1);
  assert.equal(clearInterval.mock.callCount(), 1);
  assert.equal(video.srcObject, null);
});

test("closing while awaiting camera permission releases the late stream", async (t) => {
  const track = { stop: t.mock.fn() };
  const stream = { getTracks: () => [track] };
  const { promise, resolve } = Promise.withResolvers();
  const scan = new AbortController();
  const addListener = t.mock.method(scan.signal, "addEventListener");
  replaceGlobal(t, "BarcodeDetector", undefined);
  replaceGlobal(t, "navigator", { mediaDevices: { getUserMedia: () => {
    assert.equal(addListener.mock.calls[0]?.arguments[0], "abort");
    return promise;
  } } });
  const video = { srcObject: null, play: t.mock.fn() };
  const pending = startLiveQrScan(video, () => assert.fail("Unexpected QR payload"), scan.signal);

  const reason = new Error("Scanner dismissed");
  scan.abort(reason);
  resolve(stream);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(track.stop.mock.callCount(), 1);
  assert.equal(video.play.mock.callCount(), 0);
  assert.equal(video.srcObject, null);
});

for (const abortDuringPlay of [false, true]) {
  test(`releases the stream when video playback rejects${abortDuringPlay ? " after closing" : ""}`, async (t) => {
    const track = { stop: t.mock.fn() };
    const stream = { getTracks: () => [track] };
    const playing = Promise.withResolvers();
    const playback = Promise.withResolvers();
    replaceGlobal(t, "BarcodeDetector", undefined);
    replaceGlobal(t, "navigator", { mediaDevices: { getUserMedia: async () => stream } });
    const video = {
      srcObject: null,
      play() {
        playing.resolve();
        return playback.promise;
      },
    };
    const scan = new AbortController();
    const pending = startLiveQrScan(video, () => assert.fail("Unexpected QR payload"), scan.signal);
    await playing.promise;
    assert.equal(video.srcObject, stream);

    if (abortDuringPlay) {
      scan.abort();
      assert.equal(track.stop.mock.callCount(), 1);
      assert.equal(video.srcObject, null);
    }
    const error = new DOMException("Playback failed", "NotAllowedError");
    playback.reject(error);
    await assert.rejects(pending, abortDuringPlay ? { name: "AbortError" } : error);
    assert.equal(track.stop.mock.callCount(), 1);
    assert.equal(video.srcObject, null);
  });
}

test("torch reports camera constraint failures without throwing", async (t) => {
  const error = new Error("Cannot set torch");
  const track = {
    stop() {},
    getCapabilities: () => ({ torch: true }),
    applyConstraints: t.mock.fn(async () => undefined),
  };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  replaceGlobal(t, "BarcodeDetector", undefined);
  replaceGlobal(t, "navigator", { mediaDevices: { getUserMedia: async () => stream } });
  replaceGlobal(t, "window", { setInterval: () => 1, clearInterval() {} });
  const scan = new AbortController();
  try {
    const handle = await startLiveQrScan({ play: async () => {} }, () => {}, scan.signal);
    assert.equal(handle.torchAvailable, true);
    assert.equal(await handle.setTorch(true), true);
    assert.deepEqual(track.applyConstraints.mock.calls[0].arguments, [{ advanced: [{ torch: true }] }]);
    track.applyConstraints.mock.mockImplementation(() => { throw error; });
    assert.equal(await handle.setTorch(false), false);
    track.applyConstraints.mock.mockImplementation(async () => { throw error; });
    assert.equal(await handle.setTorch(false), false);
  } finally {
    scan.abort();
  }
});

test("live frame: blank or exhausted frames yield null without throwing", () => {
  const blank = new Uint8ClampedArray(640 * 480).fill(200);
  assert.equal(qr.decodeReceiptQrFrame({ gray: blank, width: 640, height: 480 }), null);
  assert.equal(qr.decodeReceiptQrFrame({ gray: blank, width: 640, height: 480 }, { budgetMs: -1 }), null);
});
