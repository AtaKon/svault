import assert from "node:assert/strict";
import { test } from "node:test";
import { addReceiptQrPayload, isUsableDigitalReceipt, shouldRunPhotoOcr } from "../client/receipt-scan-priority.js";

const entersoft = "https://e-invoicing.gr/edocuments/ViewInvoice/-1/12345678-1234-1234-1234-123456789abc_tEsTaB12";
const epsilon = "https://epsilondigital-sklavenitis.epsilonnet.gr/fd/12345678123412341234123456789abc:12";
const otherEpsilon = "https://epsilondigital-sklavenitis.epsilonnet.gr/fd/fedcba9876543210fedcba9876543210:34";

const scan = (provider, lines, status = "ok") => ({ provider, qr: { status }, draft: { lines } });

test("collects one receipt link for a batch of photos of the same receipt", () => {
  const links = new Map();
  assert.equal(addReceiptQrPayload(links, entersoft), false);
  assert.equal(addReceiptQrPayload(links, entersoft), false);
  assert.equal(links.size, 1);
  assert.equal(links.values().next().value.issuer, "entersoft");
});

test("photos without a receipt QR yield no link", () => {
  const links = new Map();
  assert.equal(addReceiptQrPayload(links, null), false);
  assert.equal(addReceiptQrPayload(links, ""), false);
  assert.equal(addReceiptQrPayload(links, "hello"), false);
  assert.equal(addReceiptQrPayload(links, "https://example.com/receipt"), false);
  assert.equal(links.size, 0);
});

test("flags a second distinct receipt QR immediately", () => {
  const links = new Map();
  assert.equal(addReceiptQrPayload(links, entersoft), false);
  assert.equal(addReceiptQrPayload(links, "not a link"), false);
  // The second photo's payload is added to the same accumulator before conflict is returned.
  assert.equal(addReceiptQrPayload(links, epsilon), true);
  assert.equal(links.size, 2);
  const otherIssuerReceipt = new Map();
  assert.equal(addReceiptQrPayload(otherIssuerReceipt, entersoft), false);
  assert.equal(addReceiptQrPayload(otherIssuerReceipt, otherEpsilon), true);
});

test("a scan response is a usable digital receipt only with QR provenance and product lines", () => {
  assert.equal(isUsableDigitalReceipt(scan("qr", [{ description: "Milk" }])), true);
  assert.equal(isUsableDigitalReceipt(scan("qr", [])), false);
  assert.equal(isUsableDigitalReceipt(scan("qr", [{ description: "Milk" }], "unavailable")), false);
  assert.equal(isUsableDigitalReceipt(scan("local", [{ description: "Milk" }])), false);
  assert.equal(isUsableDigitalReceipt(scan("template", [{ description: "Milk" }])), false);
  assert.equal(isUsableDigitalReceipt(scan("ai", [{ description: "Milk" }])), false);
});

test("photo OCR is the fallback: it runs only without a digital receipt to use", () => {
  // No QR decoded, or the issuer import was unusable, challenged or unavailable.
  assert.equal(shouldRunPhotoOcr("local", false), true);
  assert.equal(shouldRunPhotoOcr("template", false), true);
  // A digital receipt was applied by this scan, or the workspace already holds one.
  assert.equal(shouldRunPhotoOcr("local", true), false);
  // Preserve existing behavior for QR provenance, including an empty edited draft.
  assert.equal(shouldRunPhotoOcr("qr", false), false);
  assert.equal(shouldRunPhotoOcr("qr", true), false);
});
