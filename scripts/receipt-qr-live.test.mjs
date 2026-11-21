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

function receiptPixels(width, height) {
  const hints = new Map([[zxing.EncodeHintType.MARGIN, 0]]);
  const modules = new zxing.QRCodeWriter().encode(text, zxing.BarcodeFormat.QR_CODE, 0, 0, hints);
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

test("a full-resolution photo preserves a small code", async () => {
  const width = 2200;
  const height = 1600;
  assert.equal(await qr.decodeReceiptQrPixels({ gray: receiptPixels(width, height), width, height }), text);
});

function replaceGlobal(t, name, value) {
  const before = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => {
    if (before) Object.defineProperty(globalThis, name, before);
    else delete globalThis[name];
  });
}

test("live frames are bounded and serialized, with native retry before switching to software", async (t) => {
  const width = 720;
  const height = 1280;
  const gray = receiptPixels(width, height);
  const rgba = new Uint8ClampedArray(gray.length * 4);
  for (let i = 0; i < gray.length; i++) rgba.set([gray[i], gray[i], gray[i], 255], i * 4);
  const track = { stop: t.mock.fn() };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  let frame;
  const firstDetection = Promise.withResolvers();
  const failure = new Error("Native detector unavailable");
  const nativeQr = "native QR payload";
  const replies = [firstDetection.promise, failure, [], failure, [{ format: "qr_code", rawValue: nativeQr }], failure, failure];
  const expectedNativeAttempts = replies.length;
  const detect = t.mock.fn(async (source) => {
    assert.equal(source.width * source.height, width * height);
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const getImageData = t.mock.fn(() => ({ data: rgba, width, height }));
  const terminateWorker = t.mock.fn();
  let holdSoftwareFrame = false;
  const postFrame = t.mock.fn(function (frame, transfer) {
    assert.deepEqual(transfer, [frame.data.buffer]);
    if (!holdSoftwareFrame) {
      const pixels = qr.rgbaToGray(frame.data, frame.width, frame.height);
      this.onmessage({ data: qr.decodeReceiptQrFrame(pixels) });
    }
  });
  const clearInterval = t.mock.fn();
  replaceGlobal(t, "navigator", { mediaDevices: { getUserMedia: async () => stream } });
  replaceGlobal(t, "window", {
    setInterval(callback, delay) {
      assert.equal(delay, 250);
      frame = callback;
      return 1;
    },
    clearInterval,
  });
  replaceGlobal(t, "document", {
    createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData }) }),
  });
  replaceGlobal(t, "BarcodeDetector", class {
    static async getSupportedFormats() { return ["qr_code"]; }
    detect = detect;
  });
  replaceGlobal(t, "Worker", class {
    postMessage = postFrame;
    terminate = terminateWorker;
  });

  const video = { videoWidth: 1920, videoHeight: 1080, readyState: 2, play: async () => {} };
  const scan = new AbortController();
  t.after(() => scan.abort());
  const found = [];
  const handle = await startLiveQrScan(video, (payload) => found.push(payload), scan.signal);
  assert.equal(video.srcObject, stream);
  const pendingFrame = frame();
  assert.equal(detect.mock.calls[0].arguments[0].width, 1280);
  await frame();
  assert.equal(detect.mock.callCount(), 1);
  firstDetection.resolve([{ format: "ean_13", rawValue: "0123456789012" }, { format: "qr_code", rawValue: "" }]);
  await pendingFrame;
  assert.deepEqual(found, []);
  video.videoWidth = 1080;
  video.videoHeight = 1920;
  for (let tick = 0; tick < expectedNativeAttempts; tick++) await frame();
  const expected = [text, text, nativeQr, text, text, text];
  assert.deepEqual(found, expected);
  assert.equal(detect.mock.callCount(), expectedNativeAttempts);
  assert.deepEqual(getImageData.mock.calls.map((call) => call.arguments), Array(5).fill([0, 0, width, height]));
  holdSoftwareFrame = true;
  const pendingSoftware = frame();
  await frame();
  assert.equal(postFrame.mock.callCount(), 6);
  handle.stop();
  handle.stop();
  scan.abort();
  await pendingSoftware;
  await frame();
  assert.deepEqual(found, expected);
  assert.equal(track.stop.mock.callCount(), 1);
  assert.equal(clearInterval.mock.callCount(), 1);
  assert.equal(terminateWorker.mock.callCount(), 1);
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
    await assert.rejects(pending, abortDuringPlay ? { name: "AbortError" } : (failure) => failure.cause === error);
    assert.equal(track.stop.mock.callCount(), 1);
    assert.equal(video.srcObject, null);
  });
}

test("torch checks the reported state and ignores a completion after stop", async (t) => {
  const error = new Error("Cannot set torch");
  let torchSetting;
  const track = {
    stop: t.mock.fn(),
    getCapabilities: () => ({ torch: true }),
    getSettings: () => ({ torch: torchSetting }),
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
    torchSetting = false;
    assert.equal(await handle.setTorch(true), false);
    torchSetting = true;
    assert.equal(await handle.setTorch(true), true);
    track.applyConstraints.mock.mockImplementation(() => { throw error; });
    assert.equal(await handle.setTorch(false), false);
    track.applyConstraints.mock.mockImplementation(async () => { throw error; });
    assert.equal(await handle.setTorch(false), false);
    track.applyConstraints.mock.mockImplementation(async () => undefined);
    torchSetting = false;
    assert.equal(await handle.setTorch(false), true);
    const change = Promise.withResolvers();
    track.applyConstraints.mock.mockImplementation(() => change.promise);
    const pending = handle.setTorch(true);
    handle.stop();
    change.resolve();
    assert.equal(await pending, false);
    assert.equal(track.stop.mock.callCount(), 1);
  } finally {
    scan.abort();
  }
});

test("a live frame with an expired budget skips decoding a readable QR", () => {
  const width = 320;
  const height = 480;
  const frame = { gray: receiptPixels(width, height), width, height };
  assert.equal(qr.decodeReceiptQrFrame(frame), text);
  assert.equal(qr.decodeReceiptQrFrame(frame, { budgetMs: -1 }), null);
});

test("grayscale reuses storage only when it fits the current pixels", () => {
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
  const { gray } = qr.rgbaToGray(rgba, 2, 1);
  assert.deepEqual([...gray], [76, 150]);
  assert.equal(qr.rgbaToGray(rgba, 1, 2, gray).gray, gray);
  assert.equal(qr.rgbaToGray(rgba, 1, 1, gray).gray.length, 1);
});
