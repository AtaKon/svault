import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
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
  const detect = t.mock.fn(async () => {
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const getImageData = t.mock.fn(() => ({ data: rgba, width, height }));
  const terminateWorker = t.mock.fn();
  let holdSoftwareFrame = false;
  let softwareStarted = Promise.withResolvers();
  let replyToWorker;
  const postFrame = t.mock.fn(function (frame, transfer) {
    assert.deepEqual(transfer, [frame.data.buffer]);
    replyToWorker = this.onmessage;
    softwareStarted.resolve();
    if (!holdSoftwareFrame) {
      const pixels = qr.rgbaToGray(frame.data, frame.width, frame.height);
      this.onmessage({ data: qr.decodeReceiptQrFrame(pixels) });
    }
  });
  const clearInterval = t.mock.fn();
  const setInterval = t.mock.fn((callback, delay) => {
    assert.equal(delay, 250);
    frame = callback;
    return 1;
  });
  const createCanvas = t.mock.fn(() => ({ getContext: () => ({ drawImage() {}, getImageData }) }));
  const timers = new Map();
  let timeoutId = 0;
  const expireFrame = () => {
    assert.equal(timers.size, 1);
    const [id, callback] = timers.entries().next().value;
    timers.delete(id);
    callback();
  };
  const getUserMedia = t.mock.fn(async () => stream);
  replaceGlobal(t, "navigator", { mediaDevices: { getUserMedia } });
  replaceGlobal(t, "window", {
    setInterval,
    clearInterval,
    setTimeout(callback, delay) {
      assert.equal(delay, 4000);
      timers.set(++timeoutId, callback);
      return timeoutId;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  replaceGlobal(t, "document", { createElement: createCanvas });
  const supportedFormats = t.mock.fn(async () => ["qr_code"]);
  replaceGlobal(t, "BarcodeDetector", class {
    static getSupportedFormats = supportedFormats;
    detect = detect;
  });
  replaceGlobal(t, "Worker", class {
    postMessage = postFrame;
    terminate = terminateWorker;
  });

  const video = { videoWidth: 4000, videoHeight: 3000, readyState: 1, play: async () => {} };
  const scan = new AbortController();
  t.after(() => scan.abort());
  const found = [];
  const handle = await startLiveQrScan(video, (payload) => found.push(payload), scan.signal);
  assert.equal(video.srcObject, stream);
  assert.equal(await handle.setTorch(true), null);
  await frame();
  assert.equal(createCanvas.mock.callCount(), 0);
  video.readyState = 2;
  const pendingFrame = frame();
  const firstCanvas = detect.mock.calls[0].arguments[0];
  assert.deepEqual([firstCanvas.width, firstCanvas.height], [1280, 960]);
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

  // A new session survives the previous cancellation, then bounds both missing replies.
  const timedOutNative = Promise.withResolvers();
  detect.mock.mockImplementation(() => timedOutNative.promise);
  softwareStarted = Promise.withResolvers();
  const onDecoderError = t.mock.fn();
  const afterTimeout = [];
  await startLiveQrScan(video, (payload) => afterTimeout.push(payload), new AbortController().signal, onDecoderError);
  const addAbortListener = t.mock.method(AbortSignal.prototype, "addEventListener");
  const pendingNativeTimeout = frame();
  const sessionSignal = addAbortListener.mock.calls[0].this;
  assert.equal(getEventListeners(sessionSignal, "abort").length, 1);
  expireFrame();
  assert.equal(getEventListeners(sessionSignal, "abort").length, 0);
  addAbortListener.mock.restore();
  await pendingNativeTimeout;
  const capturesBeforeFallback = createCanvas.mock.callCount();
  holdSoftwareFrame = false;
  const fallbackFrame = frame();
  await softwareStarted.promise;
  assert.equal(createCanvas.mock.callCount(), capturesBeforeFallback + 1);
  timedOutNative.reject(failure);
  await fallbackFrame;
  assert.deepEqual(afterTimeout, [text]);
  holdSoftwareFrame = true;
  const stalledFrame = frame();
  const stalledWorker = postFrame.mock.calls.at(-1).this;
  const lateReply = stalledWorker.onmessage;
  expireFrame();
  await stalledFrame;
  assert.equal(onDecoderError.mock.callCount(), 1);
  assert.equal(track.stop.mock.callCount(), 2);
  assert.equal(terminateWorker.mock.callCount(), 2);
  assert.equal(terminateWorker.mock.calls.at(-1).this, stalledWorker);
  assert.equal(stalledWorker.onmessage, null);
  assert.equal(video.srcObject, null);
  assert.equal(timers.size, 0);

  const previousReads = getImageData.mock.callCount();
  const previousPosts = postFrame.mock.callCount();
  await frame();
  assert.equal(postFrame.mock.callCount(), previousPosts);
  const nativeResponse = Promise.withResolvers();
  detect.mock.mockImplementation(() => nativeResponse.promise);
  const canceled = await startLiveQrScan(video, () => assert.fail("Unexpected QR payload"), new AbortController().signal);
  const pendingNative = frame();
  canceled.stop();
  await pendingNative;
  nativeResponse.resolve([{ format: "qr_code", rawValue: nativeQr }]);
  await Promise.resolve();
  assert.equal(getImageData.mock.callCount(), previousReads);
  assert.equal(postFrame.mock.callCount(), previousPosts);

  const received = [];
  detect.mock.mockImplementation(async () => { throw failure; });
  softwareStarted = Promise.withResolvers();
  const restarted = await startLiveQrScan(video, (payload) => received.push(payload), new AbortController().signal);
  const nextFrame = frame();
  await softwareStarted.promise;
  assert.notEqual(postFrame.mock.calls.at(-1).this, stalledWorker);
  lateReply({ data: "stale worker reply" });
  await Promise.resolve();
  assert.deepEqual(received, []);
  replyToWorker({ data: text });
  await nextFrame;
  assert.deepEqual(received, [text]);
  restarted.stop();

  const cloneError = new DOMException("Invalid frame", "DataCloneError");
  const recovered = [];
  supportedFormats.mock.mockImplementation(async () => []);
  holdSoftwareFrame = false;
  const failTransfer = () => { throw cloneError; };
  const nextPost = postFrame.mock.callCount();
  postFrame.mock.mockImplementationOnce(failTransfer, nextPost);
  postFrame.mock.mockImplementationOnce(function () { this.onmessage({ data: null }); }, nextPost + 1);
  postFrame.mock.mockImplementationOnce(failTransfer, nextPost + 2);
  const recovering = await startLiveQrScan(video, (payload) => recovered.push(payload), new AbortController().signal, onDecoderError);
  for (let tick = 0; tick < 3; tick++) {
    await frame();
    assert.equal(video.srcObject, stream);
    assert.deepEqual(recovered, []);
  }
  await frame();
  assert.deepEqual(recovered, [text]);
  assert.equal(onDecoderError.mock.callCount(), 1);
  recovering.stop();

  const lastNativeCallCount = detect.mock.callCount();
  postFrame.mock.mockImplementation(() => { throw cloneError; });
  const probeStarted = Promise.withResolvers();
  const pendingFormats = new Promise(() => {});
  for (const formats of [[], failure, pendingFormats]) {
    supportedFormats.mock.mockImplementation(async () => {
      if (formats instanceof Error) throw formats;
      if (formats === pendingFormats) probeStarted.resolve();
      return formats;
    });
    const scan = startLiveQrScan(video, () => assert.fail("Unexpected QR payload"), new AbortController().signal, onDecoderError);
    if (formats === pendingFormats) {
      await probeStarted.promise;
      expireFrame();
    }
    await scan;
    await frame();
    assert.equal(video.srcObject, stream);
    await frame();
    assert.equal(video.srcObject, null);
  }
  assert.equal(detect.mock.callCount(), lastNativeCallCount);
  assert.equal(onDecoderError.mock.callCount(), 4);
  assert.equal(timers.size, 0);

  const closing = new AbortController();
  track.getCapabilities = () => { closing.abort(); return {}; };
  supportedFormats.mock.mockImplementation(async () => []);
  const intervalsBeforeClose = setInterval.mock.callCount();
  await assert.rejects(startLiveQrScan(video, () => {}, closing.signal), { name: "AbortError" });
  assert.equal(setInterval.mock.callCount(), intervalsBeforeClose);
  assert.equal(video.srcObject, null);

  const opening = new AbortController();
  const probeReached = Promise.withResolvers();
  const delayedProbe = Promise.withResolvers();
  supportedFormats.mock.mockImplementation(() => {
    probeReached.resolve();
    return delayedProbe.promise;
  });
  const pendingStartup = startLiveQrScan(video, () => {}, opening.signal);
  await probeReached.promise;
  opening.abort();
  await assert.rejects(pendingStartup, { name: "AbortError" });
  delayedProbe.resolve(["qr_code"]);
  assert.equal(setInterval.mock.callCount(), intervalsBeforeClose);
  assert.equal(timers.size, 0);
  assert.equal(video.srcObject, null);

  supportedFormats.mock.mockImplementation(async () => ["qr_code"]);
  detect.mock.mockImplementation(() => new Promise(() => {}));
  const first = await startLiveQrScan(video, () => {}, new AbortController().signal);
  const firstWait = frame();
  const secondTrack = { stop: t.mock.fn() };
  const secondStream = { getTracks: () => [secondTrack], getVideoTracks: () => [secondTrack] };
  const secondVideo = { ...video };
  getUserMedia.mock.mockImplementationOnce(async () => secondStream);
  const second = await startLiveQrScan(secondVideo, () => {}, new AbortController().signal);
  const secondWait = frame();
  assert.equal(timers.size, 2);
  first.stop();
  await firstWait;
  assert.equal(timers.size, 1);
  assert.equal(secondVideo.srcObject, secondStream);
  second.stop();
  await secondWait;
  assert.equal(timers.size, 0);
  assert.equal(secondTrack.stop.mock.callCount(), 1);
});

test("camera permission denial rejects before a stream can attach", async (t) => {
  const error = new DOMException("Permission denied", "NotAllowedError");
  replaceGlobal(t, "navigator", { mediaDevices: { getUserMedia: async () => { throw error; } } });
  const video = { play: t.mock.fn(), srcObject: null };
  await assert.rejects(startLiveQrScan(video, () => {}, new AbortController().signal), error);
  assert.equal(video.play.mock.callCount(), 0);
  assert.equal(video.srcObject, null);
});

test("a stream without a video track is released before playback", async (t) => {
  const stop = t.mock.fn();
  const stream = { getTracks: () => [{ stop }], getVideoTracks: () => [] };
  replaceGlobal(t, "navigator", { mediaDevices: { getUserMedia: async () => stream } });
  const video = { play: t.mock.fn(), srcObject: null };
  await assert.rejects(startLiveQrScan(video, () => {}, new AbortController().signal), { name: "NotFoundError" });
  assert.equal(stop.mock.callCount(), 1);
  assert.equal(video.play.mock.callCount(), 0);
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

for (const [failureMode, testName] of [
  ["rejection", "failed playback releases the stream"],
  ["throw", "a synchronous playback error preserves the cause and releases the stream"],
  ["abort", "closing settles startup even when playback is stalled"],
  ["timeout", "playback that times out releases the stream"],
]) {
  test(testName, async (t) => {
    const track = { stop: t.mock.fn() };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    const playing = Promise.withResolvers();
    const playback = Promise.withResolvers();
    const error = new DOMException("Playback failed", "NotAllowedError");
    replaceGlobal(t, "BarcodeDetector", undefined);
    replaceGlobal(t, "navigator", { mediaDevices: { getUserMedia: async () => stream } });
    const setInterval = t.mock.fn();
    const clearTimeout = t.mock.fn();
    let expirePlayback;
    replaceGlobal(t, "window", {
      setTimeout(callback, delay) {
        assert.equal(delay, 4000);
        expirePlayback = callback;
        return 1;
      },
      clearTimeout,
      setInterval,
    });
    const video = {
      srcObject: null,
      play() {
        playing.resolve();
        if (failureMode === "throw") throw error;
        return playback.promise;
      },
    };
    const scan = new AbortController();
    const pending = startLiveQrScan(video, () => assert.fail("Unexpected QR payload"), scan.signal);
    await playing.promise;
    assert.equal(video.srcObject, stream);

    if (failureMode === "abort") {
      scan.abort();
      await assert.rejects(pending, { name: "AbortError" });
      playback.reject(error);
    } else if (failureMode === "timeout") {
      expirePlayback();
      await assert.rejects(pending, { message: "Could not play the camera preview" });
      playback.resolve();
    } else {
      if (failureMode === "rejection") playback.reject(error);
      await assert.rejects(pending, (failure) => failure.cause === error);
    }
    assert.deepEqual(clearTimeout.mock.calls.map(({ arguments: args }) => args), [[1]]);
    assert.equal(setInterval.mock.callCount(), 0);
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
  replaceGlobal(t, "window", { setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {} });
  const scan = new AbortController();
  try {
    const handle = await startLiveQrScan({ play: async () => {} }, () => {}, scan.signal);
    assert.equal(handle.torchAvailable, true);
    assert.deepEqual(await handle.setTorch(true), { requested: true, reported: undefined });
    assert.deepEqual(track.applyConstraints.mock.calls[0].arguments, [{ advanced: [{ torch: true }] }]);
    const readSettings = track.getSettings;
    track.getSettings = undefined;
    assert.deepEqual(await handle.setTorch(true), { requested: true, reported: undefined });
    track.getSettings = () => { throw error; };
    assert.deepEqual(await handle.setTorch(true), { requested: true, reported: undefined });
    track.getSettings = readSettings;
    torchSetting = false;
    assert.deepEqual(await handle.setTorch(true), { requested: true, reported: false });
    torchSetting = true;
    assert.deepEqual(await handle.setTorch(true), { requested: true, reported: true });
    track.applyConstraints.mock.mockImplementation(() => { throw error; });
    assert.equal(await handle.setTorch(false), null);
    track.applyConstraints.mock.mockImplementation(async () => { throw error; });
    assert.equal(await handle.setTorch(false), null);
    track.applyConstraints.mock.mockImplementation(async () => undefined);
    torchSetting = false;
    assert.deepEqual(await handle.setTorch(false), { requested: false, reported: false });
    const change = Promise.withResolvers();
    track.applyConstraints.mock.mockImplementation(() => change.promise);
    const pending = handle.setTorch(true);
    handle.stop();
    change.resolve();
    assert.equal(await pending, null);
    assert.equal(track.stop.mock.callCount(), 1);
  } finally {
    scan.abort();
  }
});

test("live frame decoding checks an absolute deadline before each ZXing pass", (t) => {
  const width = 320;
  const height = 480;
  const frame = { gray: receiptPixels(width, height), width, height };
  const decodeAt = (pixels, ...times) => {
    const now = t.mock.method(Date, "now", () => times.shift() ?? 10_201);
    try {
      const result = qr.decodeReceiptQrFrame(pixels, { budgetMs: 200 });
      assert.equal(times.length, 0);
      return result;
    } finally {
      now.mock.restore();
    }
  };
  assert.equal(decodeAt(frame, 10_000, 10_199), text);
  assert.equal(decodeAt(frame, 10_000, 10_201), null);
  const blank = { ...frame, gray: new Uint8ClampedArray(width * height) };
  assert.equal(decodeAt(blank, 10_000, 10_199, 10_201), null);
});

test("grayscale reuses storage only when it fits the current pixels", () => {
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
  const { gray } = qr.rgbaToGray(rgba, 2, 1);
  assert.deepEqual([...gray], [76, 150]);
  assert.equal(qr.rgbaToGray(rgba, 1, 2, gray).gray, gray);
  assert.equal(qr.rgbaToGray(rgba, 1, 1, gray).gray.length, 1);
});
