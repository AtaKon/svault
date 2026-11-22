/**
 * Scan priority for the receipt photo flow: the issuer QR is looked for
 * first, and the photos are OCR'd only when no usable digital receipt comes
 * out of it. The rules live here, pure of the decoder, camera and network,
 * so the ordering they encode can be tested on its own (see
 * scripts/receipt-scan-priority.test.mjs).
 */

import { matchReceiptQrLink, type ReceiptQrLink } from "@shared/receipt-qr-links";
import type { ReceiptProvider, ReceiptScanResponse } from "@shared/types";

/**
 * The receipt links decoded from a batch of photos. Two distinct links mean
 * two different receipts, which the scan refuses before reading any page.
 * Payloads without a receipt link are ignored, not treated as conflicts.
 */
export function addReceiptQrPayload(links: Map<string, ReceiptQrLink>, payload: string | null): boolean {
  const link = payload ? matchReceiptQrLink(payload) : null;
  if (link) links.set(link.url, link);
  return links.size > 1;
}

/**
 * The applier prints the draft's amounts with String(), so only primitive
 * values survive that step. A malformed object there would throw partway
 * through applying the draft, after some fields have already been written.
 */
function printableAmount(value: unknown): boolean {
  return value == null || typeof value === "number" || typeof value === "string";
}

/**
 * The applier and its rendering trim, print or index into the draft's text
 * fields, and compare or print its number fields. Only a value of the
 * declared type (or nothing at all) survives those steps.
 */
function textOrNull(value: unknown): boolean {
  return value == null || typeof value === "string";
}

function numberOrNull(value: unknown): boolean {
  return value == null || typeof value === "number";
}

/**
 * Every rendered tax entry is indexed into for its rate, and that rate is
 * printed inside a template literal. A null entry or a non-number rate
 * would throw while rendering the applied draft.
 */
function usableTaxBreakdown(entries: unknown): boolean {
  return entries == null || (Array.isArray(entries) &&
    entries.every((entry) => typeof entry === "object" && entry !== null && numberOrNull(entry.rate)));
}

/**
 * A scan response counts as a usable digital receipt only with QR provenance
 * and product lines to show for it. Anything else — an unavailable issuer, a
 * challenge page, an empty draft — falls back to reading the photos. The
 * draft's text, number, line and tax-breakdown fields must also hold their
 * declared shapes: the applier and the rendering that follows it trim, print
 * or map over each one, so a malformed value would throw partway through
 * applying the draft.
 */
export function isUsableDigitalReceipt(data: ReceiptScanResponse | null | undefined): boolean {
  // An empty response body resolves to null or undefined instead of a scan.
  if (!data) return false;
  const lines = data.draft?.lines;
  return data.provider === "qr" && Array.isArray(lines) && lines.length > 0 &&
    textOrNull(data.draft?.vendorName) && textOrNull(data.draft?.purchasedAt) &&
    textOrNull(data.draft?.currency) && textOrNull(data.draft?.templateId) &&
    printableAmount(data.draft?.total) && printableAmount(data.draft?.subtotal) &&
    printableAmount(data.draft?.tax) && printableAmount(data.draft?.savings) &&
    usableTaxBreakdown(data.draft?.taxBreakdown) &&
    lines.every((line) =>
      typeof line?.description === "string" && textOrNull(line?.rawDescription) && textOrNull(line?.unit) &&
      numberOrNull(line?.taxRate) && numberOrNull(line?.discount) &&
      printableAmount(line?.quantity) && printableAmount(line?.unitPrice) && printableAmount(line?.lineTotal));
}

/**
 * Photo OCR is the fallback: it runs only when no digital receipt was
 * applied by this scan and the workspace's existing provider is not QR.
 * Provider provenance matches the prior scan behavior even if the user has
 * since removed all lines from an existing QR draft.
 */
export function shouldRunPhotoOcr(existingProvider: ReceiptProvider | null, digitalApplied: boolean): boolean {
  return existingProvider !== "qr" && !digitalApplied;
}
