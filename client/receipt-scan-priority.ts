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
 * A scan response counts as a usable digital receipt only with QR provenance
 * and product lines to show for it. Anything else — an unavailable issuer, a
 * challenge page, an empty draft — falls back to reading the photos.
 */
export function isUsableDigitalReceipt(data: ReceiptScanResponse): boolean {
  const lines = data.draft?.lines;
  return data.provider === "qr" && Array.isArray(lines) && lines.length > 0 &&
    printableAmount(data.draft?.total) && printableAmount(data.draft?.subtotal) &&
    printableAmount(data.draft?.tax) && printableAmount(data.draft?.savings) &&
    lines.every((line) =>
      typeof line?.description === "string" &&
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
