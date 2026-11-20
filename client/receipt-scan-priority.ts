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
export function collectReceiptQrLinks(payloads: ReadonlyArray<string | null>): {
  links: ReceiptQrLink[];
  /** True when the payloads carry more than one distinct receipt link. */
  conflict: boolean;
} {
  const links = new Map<string, ReceiptQrLink>();
  for (const payload of payloads) {
    const link = payload ? matchReceiptQrLink(payload) : null;
    if (link) links.set(link.url, link);
  }
  return { links: [...links.values()], conflict: links.size > 1 };
}

/**
 * A scan response counts as a usable digital receipt only with QR provenance
 * and product lines to show for it. Anything else — an unavailable issuer, a
 * challenge page, an empty draft — falls back to reading the photos.
 */
export function isUsableDigitalReceipt(data: ReceiptScanResponse): boolean {
  return data.provider === "qr" && data.qr?.status === "ok" && data.draft.lines.length > 0;
}

/**
 * Photo OCR is the fallback: it runs only when no digital receipt was
 * applied by this scan and the workspace does not already hold one.
 */
export function shouldRunPhotoOcr(
  existingDraft: { provider: ReceiptProvider | null; lines: readonly unknown[] },
  digitalApplied: boolean,
): boolean {
  const hasUsableDigitalDraft = existingDraft.provider === "qr" && existingDraft.lines.length > 0;
  return !hasUsableDigitalDraft && !digitalApplied;
}
