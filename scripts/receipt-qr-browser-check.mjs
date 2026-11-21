// Run against a seeded, throwaway instance. Uses a simulated camera and issuer.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const base = (process.argv[2] ?? "http://localhost:4201").replace(/\/$/, "");
const qr = "https://e-invoicing.gr/edocuments/ViewInvoice/-1/12345678-1234-1234-1234-123456789abc_testAB12";
const browser = await chromium.launch({
  channel: process.env.SV_BROWSER_CHANNEL ?? "chrome",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
try {
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.addInitScript((text) => {
    Object.assign(globalThis, { qrRequests: [], holdDetector: false, denyCamera: false, failNextPlayback: true });
    globalThis.detectedQr = text;
    globalThis.BarcodeDetector = class {
      static async getSupportedFormats() { return ["qr_code"]; }
      async detect() {
        if (globalThis.holdDetector) {
          await new Promise((resolve) => { globalThis.resolveDetection = resolve; });
        }
        return [{ format: "qr_code", rawValue: globalThis.detectedQr }];
      }
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
  }, qr);

  await page.goto(base + "/login");
  await page.getByLabel("Email or username").fill("demo@svault.local");
  await page.locator('input[type="password"]').fill("demo1234");
  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes("login")),
    page.locator('button[type="submit"]').click(),
  ]);
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
  await page.evaluate((text) => { globalThis.detectedQr = text; }, qr);
  await waitForRequest(1);
  assert.equal(await page.evaluate(() => lastQrCamera.getTracks().every((track) => track.readyState === "ended")), true);
  assert.equal(await scan.isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Import receipt PDF", exact: true }).isDisabled(), true);
  console.log("PASS: a playback failure releases the camera and Retry starts a new scan");
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

  await page.evaluate(() => { globalThis.denyCamera = true; });
  await scan.click();
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Photograph instead" }).click(),
  ]);
  assert.equal(await chooser.element().getAttribute("capture"), "environment");
  await page.locator("dialog").waitFor({ state: "detached" });
  console.log("PASS: camera denial fallback opens the receipt photo chooser");
} finally {
  await browser.close();
}
