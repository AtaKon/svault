// Run against a seeded, throwaway instance. Uses a simulated camera and issuer.
// Set SV_BROWSER_CHANNEL=msedge to use Edge instead of Chrome.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import zxing from "@zxing/library";

const base = (process.argv[2] ?? "http://localhost:4201").replace(/\/$/, "");
const qr = "https://e-invoicing.gr/edocuments/ViewInvoice/-1/12345678-1234-1234-1234-123456789abc_testAB12";
const side = 180;
const bitmap = new zxing.QRCodeWriter().encode(qr, zxing.BarcodeFormat.QR_CODE, side, side, new Map());
const pixels = Array.from({ length: side * side }, (_, i) => bitmap.get(i % side, Math.floor(i / side)) ? 0 : 255);
const browser = await chromium.launch({
  channel: process.env.SV_BROWSER_CHANNEL ?? "chrome",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
try {
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.addInitScript(({ text, side, pixels }) => {
    Object.assign(globalThis, { qrRequests: [], holdDetector: false, denyCamera: false, failNextPlayback: true });
    globalThis.detectedQr = text;
    globalThis.BarcodeDetector = class {
      static async getSupportedFormats() { return ["qr_code"]; }
      async detect() {
        if (globalThis.forceSoftware) throw new Error("Native scanner unavailable for test");
        if (globalThis.holdDetector) {
          await new Promise((resolve) => { globalThis.resolveDetection = resolve; });
        }
        const codes = [{ format: "qr_code", rawValue: globalThis.detectedQr }];
        if (globalThis.detectedQr === text) codes.push({ format: "qr_code", rawValue: text.replace("testAB12", "testCD34") });
        return codes;
      }
    };
    const postFrame = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (frame, transfer) {
      if (!globalThis.forceSoftware || !(frame instanceof ImageData)) return postFrame.call(this, frame, transfer);
      const fault = globalThis.workerFaults?.shift();
      if (fault === "post") {
        throw new DOMException("Test frame could not be transferred", "DataCloneError");
      }
      if (fault === "error") {
        const onError = this.onmessageerror;
        queueMicrotask(() => onError?.call(this, new MessageEvent("messageerror")));
        return;
      }
      if (fault === "invalid") {
        return postFrame.call(this, { width: 1, height: 1, data: new Uint8ClampedArray(3) });
      }
      if (fault === "invalid-reply") {
        const onReply = this.onmessage;
        queueMicrotask(() => onReply?.call(this, new MessageEvent("message", { data: 42 })));
        return;
      }
      if (fault === "stall") return;
      // Feed a printed-code fixture through the actual decoder worker.
      const rgba = new Uint8ClampedArray(pixels.length * 4).fill(255);
      pixels.forEach((value, i) => rgba.fill(value, i * 4, i * 4 + 3));
      return postFrame.call(this, new ImageData(rgba, side), [rgba.buffer]);
    };
    const readCanvas = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      if (globalThis.failReadback) throw new DOMException("Unreadable frame", "SecurityError");
      return readCanvas.apply(this, args);
    };
    const readFile = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (this.name !== "competing.pdf") return readFile.call(this);
      return new Promise((_, reject) => {
        globalThis.finishCompetingPdf = () => reject(new Error("Test PDF read finished"));
      });
    };
    const realFetch = window.fetch.bind(window);
    window.fetch = (resource, init) => {
      if (!String(resource).endsWith("/receipts/scan") || init?.method !== "POST") return realFetch(resource, init);
      return new Promise((resolve, reject) => {
        const request = { signal: init.signal, qr: JSON.parse(init.body).qr, resolve, reject };
        if (globalThis.rejectOnAbort) init.signal.addEventListener("abort", () => {
          request.rejectedOnAbort = init.signal.reason.name;
          reject(init.signal.reason);
        }, { once: true });
        // The other cases deliberately allow a result to arrive after cancellation.
        qrRequests.push(request);
      });
    };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (globalThis.denyCamera) throw new DOMException("Denied for test", "NotAllowedError");
      const stream = await getUserMedia(constraints);
      if (globalThis.torchRequests) {
        const [track] = stream.getVideoTracks();
        const readState = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, "readyState").get;
        Object.defineProperty(track, "readyState", { get() {
          if (globalThis.failTorchStatus) {
            globalThis.failTorchStatus = false;
            throw new Error("Test camera status failed");
          }
          return readState.call(this);
        } });
        track.getCapabilities = () => ({ torch: true });
        track.getSettings = () => ({});
        track.applyConstraints = async ({ advanced }) => {
          globalThis.torchRequests.push(advanced[0].torch);
          if (globalThis.rejectTorchChange) throw new Error("Test torch request failed");
        };
      }
      globalThis.lastQrCamera = stream;
      if (globalThis.holdCamera) await new Promise((resolve) => { globalThis.releaseCamera = resolve; });
      return stream;
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this.closest("dialog") && globalThis.failNextPlayback) {
        globalThis.failNextPlayback = false;
        return Promise.reject(new Error("Camera playback failed for test"));
      }
      return play.call(this);
    };
  }, { text: qr, side, pixels });

  await page.goto(base + "/login");
  await page.getByLabel("Email or username").fill("demo@svault.local");
  await page.locator('input[type="password"]').fill("demo1234");
  const [login] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/auth/login") && response.request().method() === "POST"),
    page.locator('button[type="submit"]').click(),
  ]);
  assert.equal(login.ok(), true, "Seed the throwaway SVault instance with the demo account before running this check");
  await page.waitForURL((url) => !url.pathname.includes("login"));
  await page.goto(base + "/receipts/scan");
  const scan = page.getByRole("button", { name: "Scan receipt code", exact: true });
  const scanCode = page.getByRole("button", { name: "Scan code", exact: true });
  const reset = page.getByRole("button", { name: "Start over" });
  const pdfInput = page.locator('input[accept^="application/pdf"]');
  const vendor = page.locator('input[list="receipt-vendor-options"]');
  const waitForRequest = (count) => page.waitForFunction((expected) => qrRequests.length === expected, count);
  const setFixture = (values) => page.evaluate((settings) => { Object.assign(globalThis, settings); }, values);
  const resolve = (index, body, status = 200) => page.evaluate(([i, json, status]) => {
    qrRequests[i].resolve(Response.json(json, { status }));
  }, [index, body, status]);
  const digital = (name) => ({
    provider: "qr", selectedText: "Receipt test line 1.25",
    draft: { vendorName: name, currency: "EUR", total: 1.25, lines: [{ description: "Receipt test line", quantity: 1, total: 1.25, unit: "ea" }] },
  });

  await scan.click();
  const retry = page.getByRole("button", { name: "Retry", exact: true });
  await retry.waitFor();
  assert.equal(await page.evaluate(() => lastQrCamera.getTracks().every((track) => track.readyState === "ended")), true);
  await setFixture({ detectedQr: "https://example.com/menu" });
  await retry.click();
  await page.getByRole("dialog").getByText("This QR code is not a receipt link.").waitFor();
  await pdfInput.setInputFiles({ name: "competing.pdf", mimeType: "application/pdf", buffer: Buffer.from("test") });
  await page.waitForFunction(() => Boolean(globalThis.finishCompetingPdf));
  await setFixture({ detectedQr: qr });
  await page.getByRole("dialog").getByText("Wait for the current receipt operation to finish.").waitFor();
  assert.equal(await page.evaluate(() => qrRequests.length), 0);
  await page.evaluate(() => globalThis.finishCompetingPdf());
  await waitForRequest(1);
  await page.locator("dialog").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => qrRequests.length), 1);
  assert.equal(await page.evaluate(() => qrRequests[0].signal.aborted), false);
  assert.equal(await page.evaluate(() => lastQrCamera.getTracks().every((track) => track.readyState === "ended")), true);
  assert.equal(await scan.isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Import receipt PDF", exact: true }).isDisabled(), true);
  await pdfInput.setInputFiles({ name: "receipt.pdf", mimeType: "application/pdf", buffer: Buffer.from("test") });
  await page.locator('input[capture="environment"]').setInputFiles({ name: "receipt.jpg", mimeType: "image/jpeg", buffer: Buffer.from("test") });
  await reset.click();
  assert.equal(await page.evaluate(() => qrRequests[0].signal.aborted), true);
  await scan.click();
  await waitForRequest(2);
  assert.equal(await page.evaluate(() => qrRequests[0].qr), qr);
  await resolve(0, digital("Stale result"));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await scan.isDisabled(), true);
  assert.equal(await vendor.count(), 0);
  await resolve(1, digital("Fresh result"));
  await vendor.waitFor();
  assert.equal(await vendor.inputValue(), "Fresh result");
  assert.equal(await scanCode.isEnabled(), true);

  await vendor.fill("Edited merchant");
  await scanCode.click();
  await waitForRequest(3);
  await resolve(2, digital("Replacement"));
  await page.getByRole("alert").filter({ hasText: "Your edits were kept. Start over to import the digital receipt." }).waitFor();
  assert.equal(await vendor.inputValue(), "Edited merchant");
  assert.equal(await page.getByRole("link", { name: "Open digital receipt" }).getAttribute("href"), qr);

  await reset.click();
  await scan.click();
  await waitForRequest(4);
  await resolve(3, { provider: "local", draft: { lines: [] }, qr: { message: "The issuer is unavailable." } });
  await page.getByRole("alert").filter({ hasText: "The issuer is unavailable." }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Open digital receipt" }).getAttribute("href"), qr);
  assert.equal(await vendor.inputValue(), "");

  await setFixture({ holdDetector: true });
  await scanCode.click();
  await page.waitForFunction(() => Boolean(globalThis.resolveDetection));
  await page.evaluate(() => {
    const reset = Array.from(document.querySelectorAll("button")).find((button) => button.textContent.trim() === "Start over");
    reset.click();
    globalThis.resolveDetection();
  });
  await page.locator("dialog").waitFor({ state: "detached" });
  await page.waitForFunction(() => lastQrCamera.getTracks().every((track) => track.readyState === "ended"));
  assert.equal(await page.evaluate(() => qrRequests.length), 4);
  assert.equal(await scan.isDisabled(), false);

  await page.getByRole("button", { name: "Type or paste the receipt" }).click();
  await setFixture({ finishCompetingPdf: null });
  await pdfInput.setInputFiles({ name: "competing.pdf", mimeType: "application/pdf", buffer: Buffer.from("test") });
  await page.waitForFunction(() => Boolean(globalThis.finishCompetingPdf));
  await reset.click();
  assert.equal(await scan.isDisabled(), true);
  await page.evaluate(() => globalThis.finishCompetingPdf());

  const choosePhoto = async () => {
    await page.locator('input[capture="environment"]').evaluate((input) => {
      input.addEventListener("click", () => {
        globalThis.photoUserActivation = navigator.userActivation.isActive;
      }, { once: true });
    });
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("button", { name: "Photograph instead" }).click(),
    ]);
    assert.equal(await chooser.element().getAttribute("capture"), "environment");
    assert.equal(await page.evaluate(() => photoUserActivation), true);
    await page.locator("dialog").waitFor({ state: "detached" });
  };
  await setFixture({ holdCamera: true });
  await scan.click();
  await page.waitForFunction(() => Boolean(globalThis.releaseCamera));
  await choosePhoto();
  await page.evaluate(() => globalThis.releaseCamera());
  await page.waitForFunction(() => lastQrCamera.getTracks().every((track) => track.readyState === "ended"));
  await setFixture({ holdCamera: false });
  await setFixture({ holdDetector: false, detectedQr: "https://example.com/menu", torchRequests: [] });
  await scan.click();
  const light = page.getByRole("button", { name: "Light", exact: true });
  await light.click();
  await page.locator('button[aria-label="Light"][aria-pressed="mixed"]:enabled').waitFor();
  await setFixture({ rejectTorchChange: true });
  await light.click();
  await page.locator('button[aria-label="Light"][aria-pressed="mixed"]:enabled').waitFor();
  await setFixture({ rejectTorchChange: false });
  await setFixture({ failTorchStatus: true });
  await light.click();
  await page.waitForFunction(() => !globalThis.failTorchStatus);
  await page.locator('button[aria-label="Light"][aria-pressed="mixed"]:enabled').waitFor();
  await light.click();
  assert.deepEqual(await page.evaluate(() => torchRequests), [true, false, false]);
  await choosePhoto();
  assert.equal(await page.evaluate(() => lastQrCamera.getTracks().every((track) => track.readyState === "ended")), true);
  await setFixture({
    forceSoftware: true,
    workerFaults: ["post", "invalid", "error", "invalid", "invalid-reply", "invalid", "stall"],
    torchRequests: null,
  });
  await scan.click();
  await waitForRequest(5);
  assert.equal(await page.evaluate(() => qrRequests[4].qr), qr);
  await resolve(4, digital("Software decoded"));
  await vendor.waitFor();
  assert.equal(await vendor.inputValue(), "Software decoded");

  await reset.click();
  await scan.click();
  await waitForRequest(6);
  await resolve(5, { error: "Test server error" }, 500);
  assert.equal(await page.getByRole("link", { name: "Open digital receipt" }).getAttribute("href"), qr);
  await page.getByRole("alert").filter({ hasText: "The digital receipt could not be loaded." }).waitFor();
  assert.equal(await page.getByText("The digital receipt could not be loaded. Photograph the receipt instead.", { exact: true }).count(), 1);

  await reset.click();
  await setFixture({ rejectOnAbort: true });
  await scan.click();
  await waitForRequest(7);
  await reset.click();
  await page.waitForFunction(() => qrRequests[6].rejectedOnAbort === "AbortError");
  assert.equal(await scan.isDisabled(), false);

  await setFixture({ rejectOnAbort: false });
  await scan.click();
  await waitForRequest(8);
  await reset.click();
  assert.equal(await page.evaluate(() => qrRequests[7].signal.aborted), true);
  assert.equal(await scan.isEnabled(), true);
  // Leave this canceled fetch pending for the rest of the browser check.
  await scan.click();
  await waitForRequest(9);
  await reset.click();
  await page.evaluate(() => qrRequests[8].reject(new TypeError("Network failed after reset")));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByRole("link", { name: "Open digital receipt" }).count(), 0);
  assert.equal(await scan.isEnabled(), true);

  await scan.click();
  await waitForRequest(10);
  await page.evaluate(() => qrRequests[9].reject(new TypeError("Network unavailable for test")));
  await page.getByRole("alert").filter({ hasText: "The digital receipt could not be loaded." }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Open digital receipt" }).getAttribute("href"), qr);
  assert.equal(await scanCode.isEnabled(), true);
  await reset.click();

  await setFixture({ workerFaults: ["post", "error"] });
  await scan.click();
  await page.getByText("Could not scan the QR code.").waitFor();
  await retry.waitFor();
  assert.deepEqual(await page.evaluate(() => workerFaults), []);
  assert.equal(await page.evaluate(() => lastQrCamera.getTracks().every((track) => track.readyState === "ended")), true);
  await choosePhoto();

  await setFixture({ workerFaults: ["stall", "post"] });
  await scan.click();
  await retry.waitFor();
  assert.equal(await page.evaluate(() => lastQrCamera.getTracks().every((track) => track.readyState === "ended")), true);
  await retry.click();
  await waitForRequest(11);
  await resolve(10, {
    provider: "qr",
    draft: { vendorName: "Malformed receipt", lines: [{ description: "Milk", quantity: { toString: null } }] },
  });
  await page.getByRole("alert").filter({ hasText: "The digital receipt could not be loaded." }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Open digital receipt" }).getAttribute("href"), qr);
  assert.equal(await vendor.inputValue(), "");
  assert.equal(await scanCode.isEnabled(), true);
  await reset.click();

  await setFixture({ failReadback: true });
  await scan.click();
  await page.getByText("Could not scan the QR code.").waitFor();
  assert.equal(await page.evaluate(() => lastQrCamera.getTracks().every((track) => track.readyState === "ended")), true);
  await choosePhoto();
  await setFixture({ failReadback: false, forceSoftware: false, detectedQr: "https://example.com/menu", torchRequests: [] });
  await scan.click();
  await page.getByRole("dialog").getByText("This QR code is not a receipt link.").waitFor();
  await light.waitFor();
  await page.evaluate(() => {
    const [track] = lastQrCamera.getVideoTracks();
    track.stop();
    track.dispatchEvent(new Event("ended"));
  });
  await retry.waitFor();
  assert.equal(await light.count(), 0);
  await choosePhoto();

  await setFixture({ denyCamera: true });
  await scan.click();
  await choosePhoto();
  assert.deepEqual(pageErrors, []);
  console.log("Receipt QR browser check passed.");
} finally {
  await browser.close();
}
