import assert from "node:assert/strict";
import { test } from "node:test";
import { collectReceiptQrLinks, isUsableDigitalReceipt, shouldRunPhotoOcr } from "../client/receipt-scan-priority.js";

const entersoft = "https://e-invoicing.gr/edocuments/ViewInvoice/-1/12345678-1234-1234-1234-123456789abc_tEsTaB12";
const epsilon = "https://epsilondigital-sklavenitis.epsilonnet.gr/fd/12345678123412341234123456789abc:12";
const otherEpsilon = "https://epsilondigital-sklavenitis.epsilonnet.gr/fd/fedcba9876543210fedcba9876543210:34";

const scan = (provider, lines, status = "ok") => ({ provider, qr: { status }, draft: { lines } });

test("collects one receipt link for a batch of photos of the same receipt", () => {
  const { links, conflict } = collectReceiptQrLinks([entersoft, entersoft]);
  assert.equal(links.length, 1);
  assert.equal(links[0].issuer, "entersoft");
  assert.equal(conflict, false);
});

test("photos without a receipt QR yield no link", () => {
  assert.deepEqual(collectReceiptQrLinks([]), { links: [], conflict: false });
  assert.deepEqual(collectReceiptQrLinks([null, "", "hello", "https://example.com/receipt"]).links, []);
});

test("flags two distinct receipt links as different receipts", () => {
  const mixed = collectReceiptQrLinks([entersoft, "not a link", epsilon]);
  assert.equal(mixed.links.length, 2);
  assert.equal(mixed.conflict, true);
  const secondBatch = collectReceiptQrLinks([entersoft, otherEpsilon]);
  assert.equal(secondBatch.conflict, true);
  assert.equal(collectReceiptQrLinks([entersoft]).conflict, false);
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
