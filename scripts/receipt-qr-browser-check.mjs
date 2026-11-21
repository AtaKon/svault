// Run against a seeded, throwaway instance. Uses a simulated camera and issuer.
// Set SV_BROWSER_CHANNEL=msedge to use Edge instead of Chrome.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import zxing from "@zxing/library";

const base = (process.argv[2] ?? "http://localhost:4201").replace(/\/$/, "");
const qr = "https://e-invoicing.gr/edocuments/ViewInvoice/-1/12345678-1234-1234-1234-123456789abc_testAB12";
const bitmap = new zxing.QRCodeWriter().encode(qr, zxing.BarcodeFormat.QR_CODE, 0, 0, new Map());
const modules = Array.from({ length: bitmap.getHeight() }, (_, y) =>
  Array.from({ length: bitmap.getWidth() }, (_, x) => bitmap.get(x, y)));
const browser = await chromium.launch({
  channel: process.env.SV_BROWSER_CHANNEL ?? "chrome",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
try {
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.addInitScript(({ text, modules }) => {
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
      // Feed a printed-code fixture through the actual decoder worker.
      const canvas = document.createElement("canvas");
      const scale = 5;
      canvas.width = canvas.height = modules.length * scale;
      const context = canvas.getContext("2d");
      context.fillStyle = "white";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "black";
      modules.forEach((row, y) => row.forEach((dark, x) => {
        if (dark) context.fillRect(x * scale, y * scale, scale, scale);
      }));
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      return postFrame.call(this, image, [image.data.buffer]);
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
      return new Promise((resolve) => {
        // Allow a result to arrive even when the completion was already queued at cancellation.
        qrRequests.push({ signal: init.signal, qr: JSON.parse(init.body).qr, resolve });
      });
    };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (globalThis.denyCamera) throw new DOMException("Denied for test", "NotAllowedError");
      const stream = await getUserMedia(constraints);
      globalThis.lastQrCamera = stream;
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
  }, { text: qr, modules });

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
  const reset = page.getByRole("button", { name: "Start over" });
  const vendor = page.locator('input[list="receipt-vendor-options"]');
  const waitForRequest = (count) => page.waitForFunction((expected) => qrRequests.length === expected, count);
  const resolve = (index, body) => page.evaluate(([i, json]) => qrRequests[i].resolve(Response.json(json)), [index, body]);
  const digital = (name) => ({
    provider: "qr", selectedText: "Receipt test line 1.25",
    draft: { vendorName: name, currency: "EUR", total: 1.25, lines: [{ description: "Receipt test line", quantity: 1, total: 1.25, unit: "ea" }] },
  });

  await scan.click();
  const retry = page.getByRole("button", { name: "Retry", exact: true });
  await retry.waitFor();
  assert.equal(await page.evaluate(() => lastQrCamera.getTracks().every((track) => track.readyState === "ended")), true);
  await page.evaluate(() => { globalThis.detectedQr = "https://example.com/menu"; });
  await retry.click();
  await page.getByRole("dialog").getByText("This QR code is not a receipt link.").waitFor();
  await page.locator('input[accept^="application/pdf"]').setInputFiles({ name: "competing.pdf", mimeType: "application/pdf", buffer: Buffer.from("test") });
  await page.waitForFunction(() => Boolean(globalThis.finishCompetingPdf));
  await page.evaluate((text) => { globalThis.detectedQr = text; }, qr);
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
  await page.locator('input[accept^="application/pdf"]').setInputFiles({ name: "receipt.pdf", mimeType: "application/pdf", buffer: Buffer.from("test") });
  await page.locator('input[capture="environment"]').setInputFiles({ name: "receipt.jpg", mimeType: "image/jpeg", buffer: Buffer.from("test") });
  console.log("PASS: Retry starts a new camera and a two-code frame imports one receipt");
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
  console.log("PASS: reset aborts an initial QR import and a late result cannot unlock or populate the second import");

  await vendor.fill("Edited merchant");
  await page.getByRole("button", { name: "Scan code", exact: true }).click();
  await waitForRequest(3);
  await resolve(2, digital("Replacement"));
  await page.getByRole("status").filter({ hasText: "Your edits were kept. Start over to import the digital receipt." }).waitFor();
  assert.equal(await vendor.inputValue(), "Edited merchant");
  assert.equal(await page.getByRole("link", { name: "Open digital receipt" }).getAttribute("href"), qr);
  console.log("PASS: retained edits have both a notification and an issuer link");

  await reset.click();
  await scan.click();
  await waitForRequest(4);
  await resolve(3, { provider: "local", qr: { message: "Issuer unavailable" }, draft: { lines: [] } });
  await page.getByText("Issuer unavailable", { exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Open digital receipt" }).getAttribute("href"), qr);
  assert.equal(await vendor.inputValue(), "");
  console.log("PASS: failed live import exposes the issuer link and photo workspace");

  await page.evaluate(() => { globalThis.holdDetector = true; });
  await page.getByRole("button", { name: "Scan code", exact: true }).click();
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
  console.log("PASS: resetting while a frame is decoding sends no QR request");

  const choosePhoto = async () => {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("button", { name: "Photograph instead" }).click(),
    ]);
    assert.equal(await chooser.element().getAttribute("capture"), "environment");
    await page.locator("dialog").waitFor({ state: "detached" });
  };
  await page.evaluate(() => { globalThis.holdDetector = false; globalThis.detectedQr = "https://example.com/menu"; });
  await scan.click();
  await choosePhoto();
  assert.equal(await page.evaluate(() => lastQrCamera.getTracks().every((track) => track.readyState === "ended")), true);
  await page.evaluate(() => { globalThis.forceSoftware = true; });
  await scan.click();
  await waitForRequest(5);
  assert.equal(await page.evaluate(() => qrRequests[4].qr), qr);
  await resolve(4, digital("Software decoded"));
  await vendor.waitFor();
  assert.equal(await vendor.inputValue(), "Software decoded");
  console.log("PASS: the built worker decodes the QR when native detection fails");

  await reset.click();
  await page.evaluate(() => { globalThis.failReadback = true; });
  await scan.click();
  await page.getByText("Could not scan the QR code.").waitFor();
  assert.equal(await page.evaluate(() => lastQrCamera.getTracks().every((track) => track.readyState === "ended")), true);
  await choosePhoto();
  await page.evaluate(() => { globalThis.failReadback = false; globalThis.denyCamera = true; });
  await scan.click();
  await choosePhoto();
  console.log("PASS: the photo chooser opens during scanning and after camera or frame-read failure");
} finally {
  await browser.close();
}
