/**
 * Scan decision rules for the receipt flow, pure of the decoder, camera and
 * network: which decoded payloads carry a receipt link, when the live
 * scanner's link may start an import, when a scan or intake response counts
 * as a usable digital receipt, whether the photos still need to be OCR'd,
 * and what bulk intake's QR-first flow and its explicit AI re-read send.
 * Each rule can be tested on its own (see
 * scripts/receipt-scan-priority.test.mjs).
 */

import { matchReceiptQrLink, type ReceiptQrLink } from "@shared/receipt-qr-links";
import type { IntakeParseResult, ReceiptProvider, ReceiptScanResponse } from "@shared/types";

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
 * A live scan may start an import only on the workspace revision its
 * scanner opened with (a Start over in between makes the detected code
 * stale) and only while the scan flow is free to run. A stale or busy
 * workspace rejects the link without starting a request.
 */
export function canAcceptLiveQrLink(scanRevision: number, workspaceRevision: number, scanAvailable: boolean): boolean {
  return scanRevision === workspaceRevision && scanAvailable;
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
 * An intake parse response counts as a usable digital receipt only with QR
 * provenance and review rows to show for it. Anything else — an unavailable
 * issuer, a challenge page, an empty draft — falls back to reading the photo.
 * Each row must hold the shape the review table renders: the description
 * feeds an Input value and the candidates list is mapped over for the item
 * picker, so a malformed value there would throw while rendering.
 */
export function isUsableDigitalIntake(data: IntakeParseResult | null | undefined): boolean {
  // An empty response body resolves to null or undefined instead of a parse.
  if (!data) return false;
  const rows = data.rows;
  return data.provider === "qr" && Array.isArray(rows) && rows.length > 0 &&
    rows.every((row) => typeof row?.description === "string" && Array.isArray(row?.candidates));
}

/**
 * Bulk intake reads the photo's QR before anything else: a usable digital
 * receipt from that link replaces the photo entirely, so nothing is
 * uploaded or OCR'd. An import that failed or came back unusable — and a
 * photo with no receipt QR at all — reads the photo as before.
 */
export function digitalIntakeReplacesPhoto(link: ReceiptQrLink | null | undefined, intake: IntakeParseResult | null | undefined): boolean {
  return Boolean(link) && isUsableDigitalIntake(intake);
}

/**
 * The bulk-intake parse body for receipt mode: the reviewed text, the
 * attached photo and the OCR candidates while the text is still the raw
 * reading. It never carries the QR link — only the photo flow attempts a
 * QR — so an explicit AI re-read parses the reviewed text instead of
 * re-fetching the issuer.
 */
export function intakeReceiptParseBody(
  { text, image, ocrText = "", ocrCandidates = [], preferAi = false }: {
    text: string;
    image?: string | null;
    ocrText?: string;
    ocrCandidates?: string[];
    preferAi?: boolean;
  },
): { text?: string; image?: string; candidates?: string[]; preferAi?: true } {
  return {
    text: text.trim() || undefined,
    image: image ?? undefined,
    ...(text === ocrText && ocrCandidates.length ? { candidates: ocrCandidates } : {}),
    ...(preferAi ? { preferAi: true } : {}),
  };
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
