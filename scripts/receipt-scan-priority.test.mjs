import assert from "node:assert/strict";
import { test } from "node:test";
import { addReceiptQrPayload, isUsableDigitalReceipt, shouldRunPhotoOcr } from "../client/receipt-scan-priority.js";

const entersoft = "https://e-invoicing.gr/edocuments/ViewInvoice/-1/12345678-1234-1234-1234-123456789abc_tEsTaB12";
const epsilon = "https://epsilondigital-sklavenitis.epsilonnet.gr/fd/12345678123412341234123456789abc:12";
const otherEpsilon = "https://epsilondigital-sklavenitis.epsilonnet.gr/fd/fedcba9876543210fedcba9876543210:34";
const impact = `https://einvoice.impact.gr/p/EL123456789/${"1".repeat(40)}/${"2".repeat(32)}`;

const scan = (provider, lines) => ({ provider, draft: { lines } });

test("collects one receipt link for a batch of photos of the same receipt", () => {
  const links = new Map();
  assert.equal(addReceiptQrPayload(links, entersoft), false);
  assert.equal(addReceiptQrPayload(links, entersoft), false);
  assert.equal(links.size, 1);
  assert.equal(links.values().next().value.issuer, "entersoft");
});

test("collects a single IMPACT receipt link like any other issuer", () => {
  const links = new Map();
  assert.equal(addReceiptQrPayload(links, impact), false);
  assert.equal(addReceiptQrPayload(links, impact), false);
  assert.equal(links.size, 1);
  assert.equal(links.values().next().value.issuer, "impact");
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
  const impactWithAnother = new Map();
  assert.equal(addReceiptQrPayload(impactWithAnother, impact), false);
  assert.equal(addReceiptQrPayload(impactWithAnother, entersoft), true);
});

test("a scan response is a usable digital receipt only with QR provenance and product lines", () => {
  assert.equal(isUsableDigitalReceipt(scan("qr", [{ description: "Milk" }])), true);
  assert.equal(isUsableDigitalReceipt(scan("qr", [])), false);
  assert.equal(isUsableDigitalReceipt({ provider: "qr" }), false);
  assert.equal(isUsableDigitalReceipt(scan("qr", [null])), false);
  assert.equal(isUsableDigitalReceipt(scan("qr", [{}])), false);
  assert.equal(isUsableDigitalReceipt(scan("qr", [{ description: 42 }])), false);
  assert.equal(isUsableDigitalReceipt(scan("local", [{ description: "Milk" }])), false);
  assert.equal(isUsableDigitalReceipt(scan("template", [{ description: "Milk" }])), false);
  assert.equal(isUsableDigitalReceipt(scan("ai", [{ description: "Milk" }])), false);
});

test("a malformed draft the applier would crash on is not usable", () => {
  const poison = { toString: null };
  assert.equal(isUsableDigitalReceipt(scan("qr", [{ description: "Milk", quantity: poison }])), false);
  assert.equal(isUsableDigitalReceipt(scan("qr", [{ description: "Milk", unitPrice: poison }])), false);
  assert.equal(isUsableDigitalReceipt(scan("qr", [{ description: "Milk", lineTotal: poison }])), false);
  for (const field of ["total", "subtotal", "tax", "savings"]) {
    assert.equal(isUsableDigitalReceipt({ provider: "qr", draft: { lines: [{ description: "Milk" }], [field]: poison } }), false);
  }
  // toDraftLines maps over the lines before anything else, so a draft whose
  // lines are not an array, or a line whose description is not a string,
  // would throw on the first mapped line.
  assert.equal(isUsableDigitalReceipt({ provider: "qr", draft: { lines: "not an array" } }), false);
  assert.equal(isUsableDigitalReceipt({ provider: "qr", draft: { lines: { length: 1, 0: { description: "Milk" } } } }), false);
  assert.equal(isUsableDigitalReceipt(scan("qr", [{ description: poison }])), false);
  // Printable amounts, including absent ones, stay usable.
  assert.equal(isUsableDigitalReceipt(scan("qr", [{ description: "Milk", quantity: 2, unitPrice: 1.25, lineTotal: 2.5 }])), true);
});

test("draft text fields the applier or its rendering would crash on are not usable", () => {
  const poison = { toString: null };
  const line = { description: "Milk" };
  for (const field of ["vendorName", "purchasedAt", "currency", "templateId"]) {
    assert.equal(isUsableDigitalReceipt({ provider: "qr", draft: { lines: [line], [field]: poison } }), false);
  }
  // Text fields holding their declared shape, including absent ones, stay usable.
  assert.equal(isUsableDigitalReceipt(scan("qr", [line])), true);
  assert.equal(
    isUsableDigitalReceipt({ provider: "qr", draft: { lines: [line], vendorName: "Store", purchasedAt: "2026-01-02", currency: "EUR", templateId: "lidl-gr" } }),
    true,
  );
});

test("a tax breakdown the rendering would crash on is not usable", () => {
  const line = { description: "Milk" };
  // A string or a length-carrying object passes the truthiness check on
  // taxBreakdown.length but has no map for the render and the save to call.
  for (const taxBreakdown of ["24", { length: 1, 0: {} }, [null], [{ rate: { toString: null } }]]) {
    assert.equal(isUsableDigitalReceipt({ provider: "qr", draft: { lines: [line], taxBreakdown } }), false);
  }
  assert.equal(
    isUsableDigitalReceipt({ provider: "qr", draft: { lines: [line], taxBreakdown: [{ rate: 24, net: 1, tax: 0.24, gross: 1.24 }] } }),
    true,
  );
});

test("malformed line metadata the rendering would crash on is not usable", () => {
  const poison = { toString: null };
  for (const field of ["rawDescription", "unit", "taxRate", "discount"]) {
    assert.equal(isUsableDigitalReceipt(scan("qr", [{ description: "Milk", [field]: poison }])), false);
  }
  assert.equal(
    isUsableDigitalReceipt(scan("qr", [{ description: "Milk", rawDescription: "Milk 1l", unit: "l", taxRate: 24, discount: 0.5 }])),
    true,
  );
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
