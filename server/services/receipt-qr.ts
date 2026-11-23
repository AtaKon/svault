import { matchReceiptQrLink, type ReceiptQrIssuer, type ReceiptQrLink } from "../../shared/receipt-qr-links.js";
import type { ReceiptDraft } from "../../shared/types.js";
import { outboundFetch } from "../lib/outbound.js";
import { limiters } from "../rate-limit.js";
import { parseEntersoftInvoiceHtml } from "./receipt-entersoft.js";
import { parseImpactReceiptHtml } from "./receipt-impact.js";

/**
 * Server-side retrieval of digital receipts behind known issuer QR links.
 *
 * Only exact https routes on the three supported issuers are fetched; every
 * redirect hop is re-validated against the same allowlist before it is
 * followed. Responses are bounded in time and size, no cookies or SVault
 * credentials are ever sent (Node's fetch has no cookie jar and none is added),
 * and the bearer links themselves never appear in messages, warnings or logs —
 * issuer label and status only. Cloudflare Turnstile and similar challenges
 * stop the automated fetch: they are reported to the client so the user can
 * verify in their own browser and import the downloaded PDF. No challenge or
 * access control is bypassed or executed.
 */

export type ReceiptQrStatus = "ok" | "challenge" | "unsupported" | "unavailable";

type ReceiptQrFailure = {
  status: Exclude<ReceiptQrStatus, "ok">;
  issuer: ReceiptQrIssuer | null;
  message: string;
};

export type ReceiptQrFetchResult = ReceiptQrFailure | {
  status: "ok";
  issuer: ReceiptQrIssuer;
  draft: ReceiptDraft;
  text: string;
  excludedCharges: number;
  message: null;
};

type QrFetch = (url: string, signal: AbortSignal) => Promise<Response>;
type EpsilonLink = Extract<ReceiptQrLink, { issuer: "epsilon-sklavenitis" }>;
type EntersoftLink = Extract<ReceiptQrLink, { issuer: "entersoft" }>;
type EntersoftRef = EntersoftLink["entersoft"];
type ImpactLink = Extract<ReceiptQrLink, { issuer: "impact" }>;

const EPSILON_HOST = "epsilondigital-sklavenitis.epsilonnet.gr";
const ENTERSOFT_HOST = "e-invoicing.gr";

const ENTERSOFT_VIEWINVOICE_PATH =
  /^\/edocuments\/ViewInvoice\/-?\d{1,4}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[A-Za-z0-9]{8}$/i;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const RECEIPT_QR_BUDGET_MS = 12000;

/** Cloudflare's Turnstile script host and widget class, independent of issuer. */
const TURNSTILE_MARKERS = /challenges\.cloudflare\.com|cf-turnstile/i;
const USER_AGENT = "Mozilla/5.0 (compatible; SVault receipt import)";

const EPSILON_CHALLENGE_MESSAGE =
  "The issuer's receipt page needs verification in your browser before the digital receipt can be opened. Open the link in your browser, download the receipt PDF and add it to this scan.";
const EPSILON_UNAVAILABLE_MESSAGE =
  "The digital receipt could not be read from the issuer's site automatically. Open the link in your browser, download the receipt PDF and add it to this scan.";
const ENTERSOFT_EXPIRED_MESSAGE = "The digital receipt link has expired or is no longer available from the issuer.";
const ENTERSOFT_CHALLENGE_MESSAGE =
  "Entersoft requires browser verification. Open the digital receipt to verify it, or continue with the photo scan.";
const DIGITAL_UNAVAILABLE_MESSAGE =
  "The digital receipt could not be read automatically. The photo scan and AI re-read remain available.";
const DIGITAL_INCOMPLETE_MESSAGE =
  "The digital receipt contains an incomplete product line. Use a photo to read the full receipt.";
const IMPACT_CHALLENGE_MESSAGE =
  "IMPACT requires browser verification. Open the digital receipt to verify it, or continue with the photo scan.";
const IMPACT_REDIRECT_MESSAGE =
  "IMPACT redirected the receipt link. Open the digital receipt in your browser, or continue with the photo scan.";
const IMPACT_UNAVAILABLE_MESSAGE =
  "The IMPACT receipt could not be read automatically. Open the digital receipt in your browser, or continue with the photo scan.";
const UNSUPPORTED_MESSAGE = "That QR code or link is not from a supported digital receipt issuer.";
const GENERIC_UNAVAILABLE_MESSAGE = "The digital receipt could not be fetched from the issuer.";
const RATE_LIMIT_MESSAGE = "Too many digital receipt requests. Try again in a few minutes or scan the photo.";

/** Injected in tests; production goes through the SSRF-guarded outbound fetch. */
let testFetch: QrFetch | null = null;

export function configureReceiptQrFetcherForTests(fetch: QrFetch | null): void {
  testFetch = fetch;
}

/**
 * Injected in tests to pin how routes handle results the current issuers
 * never emit (an "ok" draft with no product lines); production never sets it.
 */
let testScanResult: ReceiptQrFetchResult | null = null;

export function configureReceiptQrScanResultForTests(result: ReceiptQrFetchResult | null): void {
  testScanResult = result;
}

async function issuerFetch(url: string, signal: AbortSignal): Promise<Response> {
  if (testFetch) return testFetch(url, signal);
  return outboundFetch(url, {
    method: "GET",
    redirect: "manual",
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
    signal,
  });
}

class IssuerPageError extends Error {
  constructor(
    public readonly reason: "network" | "redirect" | "large" | "status" | "content-type" | "encoding",
    public readonly status = 0,
  ) {
    super(reason);
  }
}

async function readBounded(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) cancel();
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        cancel();
        throw new IssuerPageError("large");
      }
      chunks.push(value);
    }
  } finally {
    if (signal.aborted) cancel();
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The documents claim utf-16 in a meta tag while the bytes are usually UTF-8. */
function decodeHtmlBytes(bytes: Uint8Array, contentType: string): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const prefix = new TextDecoder("windows-1252").decode(bytes.subarray(0, 2048));
    const declaration = /charset\s*=\s*["']?(windows-1253|windows-1252|iso-8859-7|iso-8859-1)\b/i;
    const charset = contentType.match(declaration)?.[1] ?? prefix.match(declaration)?.[1];
    if (!charset) throw error;
    return new TextDecoder(charset).decode(bytes);
  }
}

/**
 * Fetch one issuer page by hand: every hop (including the first URL) must pass
 * `allowed`, responses are time- and size-bounded and only HTML is accepted.
 */
async function fetchPage(
  startUrl: string,
  allowed: (url: URL) => boolean,
  scanSignal: AbortSignal,
): Promise<{ url: URL; html: string }> {
  let current: URL;
  try {
    current = new URL(startUrl);
  } catch {
    throw new IssuerPageError("redirect");
  }
  const visited = new Set<string>();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (scanSignal.aborted) throw new IssuerPageError("network");
    if (!allowed(current) || current.username || current.password || current.port || current.hash || visited.has(current.href)) {
      throw new IssuerPageError("redirect");
    }
    visited.add(current.href);
    const signal = AbortSignal.any([scanSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    let response: Response;
    try {
      response = await issuerFetch(current.toString(), signal);
      signal.throwIfAborted();
    } catch {
      throw new IssuerPageError("network");
    }
    if (REDIRECT_STATUS.has(response.status)) {
      const location = response.headers.get("location");
      void response.body?.cancel().catch(() => undefined);
      if (!location || hop === MAX_REDIRECTS) throw new IssuerPageError("redirect");
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new IssuerPageError("redirect");
      }
      if (!allowed(next)) throw new IssuerPageError("redirect");
      current = next;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      void response.body?.cancel().catch(() => undefined);
      throw new IssuerPageError("status", response.status);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/html/i.test(contentType)) {
      void response.body?.cancel().catch(() => undefined);
      throw new IssuerPageError("content-type");
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBounded(response, signal);
    } catch (error) {
      if (error instanceof IssuerPageError) throw error;
      throw new IssuerPageError("network");
    }
    try {
      return { url: current, html: decodeHtmlBytes(bytes, contentType) };
    } catch {
      throw new IssuerPageError("encoding");
    }
  }
  throw new IssuerPageError("redirect");
}

function result(
  issuer: ReceiptQrIssuer | null,
  status: ReceiptQrFailure["status"],
  message: string,
): ReceiptQrFailure {
  return { status, issuer, message };
}

/** Epsilon Digital (Sklavenitis): /fd/… redirects to a Blazor DocViewer that renders Cloudflare Turnstile before the PDF. */
async function fetchEpsilon(link: EpsilonLink, signal: AbortSignal): Promise<ReceiptQrFetchResult> {
  const receiptPath = new URL(link.url).pathname.toLowerCase();
  // The shared matcher derives the viewer path from the validated 32 hex digits.
  const allowed = (url: URL) =>
    url.protocol === "https:" &&
    url.hostname === EPSILON_HOST &&
    !url.search && [receiptPath, link.viewerPath].includes(url.pathname.toLowerCase());
  const page = await fetchPage(link.url, allowed, signal);
  if (TURNSTILE_MARKERS.test(page.html)) {
    return result(link.issuer, "challenge", EPSILON_CHALLENGE_MESSAGE);
  }
  // Without a challenge the page is still a dynamic Blazor viewer whose static
  // HTML carries no receipt content; nothing else is fetched from it.
  return result(link.issuer, "unavailable", EPSILON_UNAVAILABLE_MESSAGE);
}

/** Entersoft: the viewer page frames /api/GetInvoice with the document reference. */
function invoiceParams(ref: EntersoftRef): URLSearchParams {
  return new URLSearchParams({
    contentType: "PEPPOL",
    intRefDocID: ref.uuid,
    hashToken: ref.token,
    ofenm: ref.ofenm,
    isPreview: "True",
  });
}

function matchesPinnedInvoice(url: URL, ref: EntersoftRef): boolean {
  if (url.origin !== `https://${ENTERSOFT_HOST}` || url.pathname !== "/api/GetInvoice" ||
      url.username || url.password || url.hash) return false;
  const expected = invoiceParams(ref);
  return url.searchParams.size === expected.size && [...expected].every(([key, value]) => {
    const values = url.searchParams.getAll(key);
    return values.length === 1 && (key === "intRefDocID" ? values[0].toLowerCase() : values[0]) === value;
  });
}

/** Only the iframe named iframeContent is honoured; its parameters must match the link. */
function iframeMatchesPinnedSource(html: string, ref: EntersoftRef): boolean {
  for (const [tag] of html.matchAll(/<iframe\b[^>]*>/gi)) {
    if (!/\sid\s*=\s*(["'])iframeContent\1/i.test(tag)) continue;
    const src = tag.match(/\ssrc\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!src) return false;
    try {
      const decoded = src.replace(/&(?:amp|#0*38|#x0*26);/gi, "&");
      return matchesPinnedInvoice(new URL(decoded, `https://${ENTERSOFT_HOST}`), ref);
    } catch {
      return false;
    }
  }
  return false;
}

async function fetchEntersoft(link: EntersoftLink, signal: AbortSignal): Promise<ReceiptQrFetchResult> {
  const ref = link.entersoft;
  const allowed = (url: URL) =>
    url.protocol === "https:" && url.hostname === ENTERSOFT_HOST &&
    !url.search && ENTERSOFT_VIEWINVOICE_PATH.test(url.pathname);
  const page = await fetchPage(link.url, allowed, signal);
  if (TURNSTILE_MARKERS.test(page.html)) {
    return result(link.issuer, "challenge", ENTERSOFT_CHALLENGE_MESSAGE);
  }
  // The document URL is pinned to the QR link's own reference: the iframe only
  // confirms the page is the expected viewer. Anything else on the page (such
  // as the issuer's ΑΑΔΕ link) is never fetched.
  if (!iframeMatchesPinnedSource(page.html, ref)) {
    return result(link.issuer, "unavailable", DIGITAL_UNAVAILABLE_MESSAGE);
  }
  const documentUrl = `https://${ENTERSOFT_HOST}/api/GetInvoice?${invoiceParams(ref)}`;
  const document = await fetchPage(documentUrl, (url) => matchesPinnedInvoice(url, ref), signal);
  if (TURNSTILE_MARKERS.test(document.html)) {
    return result(link.issuer, "challenge", ENTERSOFT_CHALLENGE_MESSAGE);
  }
  const parsed = parseEntersoftInvoiceHtml(document.html);
  if (parsed.status === "incomplete") {
    return result(link.issuer, "unavailable", DIGITAL_INCOMPLETE_MESSAGE);
  }
  if (parsed.status !== "ok" || !parsed.draft.lines.length || !parsed.text.trim()) {
    return result(link.issuer, "unavailable", DIGITAL_UNAVAILABLE_MESSAGE);
  }
  return { ...parsed, issuer: link.issuer, message: null };
}

/**
 * IMPACT eInvoicing renders the receipt server-side at the QR's own route, so
 * one bounded fetch is enough. The shared fetcher rejects every redirect,
 * because the only allowed URL has already been visited.
 */
async function fetchImpact(link: ImpactLink, signal: AbortSignal): Promise<ReceiptQrFetchResult> {
  // matchReceiptQrLink stores URL.href, so parsing it again in fetchPage
  // yields the same canonical string before the initial GET.
  const page = await fetchPage(link.url, (url) => url.href === link.url, signal);
  // Recognize known Turnstile markup. Unrecognized pages also give the user
  // the original link and photo scan options.
  if (TURNSTILE_MARKERS.test(page.html)) {
    return result(link.issuer, "challenge", IMPACT_CHALLENGE_MESSAGE);
  }
  const parsed = parseImpactReceiptHtml(page.html);
  if (parsed.status === "incomplete") {
    return result(link.issuer, "unavailable", DIGITAL_INCOMPLETE_MESSAGE);
  }
  if (parsed.status !== "ok" || !parsed.draft.lines.length || !parsed.text.trim()) {
    return result(link.issuer, "unavailable", IMPACT_UNAVAILABLE_MESSAGE);
  }
  return { ...parsed, issuer: link.issuer, message: null };
}

function messageForError(issuer: ReceiptQrIssuer, error: IssuerPageError): string {
  if (issuer === "epsilon-sklavenitis") return EPSILON_UNAVAILABLE_MESSAGE;
  if (issuer === "impact") return error.reason === "redirect" ? IMPACT_REDIRECT_MESSAGE : IMPACT_UNAVAILABLE_MESSAGE;
  if (issuer === "entersoft" && error.reason === "status" && error.status === 404) return ENTERSOFT_EXPIRED_MESSAGE;
  return DIGITAL_UNAVAILABLE_MESSAGE;
}

/**
 * Fetch the digital receipt behind a QR payload. Never throws: unsupported
 * links and every failure mode come back as a status with a safe message, so
 * the scan flow can fall back to the photo scan honestly.
 */
export function fetchQrReceiptDraft(
  payload: string,
  timeoutMs = RECEIPT_QR_BUDGET_MS,
): Promise<ReceiptQrFetchResult> {
  const link = matchReceiptQrLink(payload);
  if (!link) return Promise.resolve(result(null, "unsupported", UNSUPPORTED_MESSAGE));
  return fetchWithinBudget(link, timeoutMs);
}

async function fetchIssuerReceipt(link: ReceiptQrLink, signal: AbortSignal): Promise<ReceiptQrFetchResult> {
  try {
    switch (link.issuer) {
      case "epsilon-sklavenitis":
        return await fetchEpsilon(link, signal);
      case "entersoft":
        return await fetchEntersoft(link, signal);
      case "impact":
        return await fetchImpact(link, signal);
    }
  } catch (error) {
    if (error instanceof IssuerPageError) {
      return result(link.issuer, "unavailable", messageForError(link.issuer, error));
    }
    // Unexpected errors must not surface the bearer link; keep the message generic.
    return result(link.issuer, "unavailable", GENERIC_UNAVAILABLE_MESSAGE);
  }
}

/** One deadline covers the issuer's viewer, invoice and redirect hops. */
async function fetchWithinBudget(link: ReceiptQrLink, timeoutMs: number): Promise<ReceiptQrFetchResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ReceiptQrFetchResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(result(link.issuer, "unavailable", messageForError(link.issuer, new IssuerPageError("network"))));
    }, timeoutMs);
  });
  try {
    // The race observes both promises even if the issuer settles after abort.
    return await Promise.race([fetchIssuerReceipt(link, controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve one allowlisted link for an authorized household. */
export async function readQrReceiptScan(
  houseId: string,
  payload: string,
  timeoutMs = RECEIPT_QR_BUDGET_MS,
): Promise<ReceiptQrFetchResult> {
  if (testScanResult) return testScanResult;
  const link = matchReceiptQrLink(payload);
  if (!link) return result(null, "unsupported", UNSUPPORTED_MESSAGE);
  if (limiters.receiptQr.blocked(houseId) || limiters.receiptQrGlobal.blocked("all")) {
    return result(link.issuer, "unavailable", RATE_LIMIT_MESSAGE);
  }
  limiters.receiptQr.hit(houseId);
  limiters.receiptQrGlobal.hit("all");
  return fetchWithinBudget(link, timeoutMs);
}
