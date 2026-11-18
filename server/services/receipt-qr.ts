import { matchReceiptQrLink, type ReceiptQrIssuer, type ReceiptQrLink } from "../../shared/receipt-qr-links.js";
import type { ReceiptDraft } from "../../shared/types.js";
import { outboundFetch } from "../lib/outbound.js";
import { parseEntersoftInvoiceHtml } from "./receipt-entersoft.js";

/**
 * Server-side retrieval of digital receipts behind known issuer QR links.
 *
 * Only exact https routes on the two supported issuers are fetched; every
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

export interface ReceiptQrFetchResult {
  status: ReceiptQrStatus;
  issuer: ReceiptQrIssuer | null;
  /** Draft and rendition on "ok"; null otherwise. */
  draft: ReceiptDraft | null;
  text: string | null;
  /** Fee rows excluded from the lines but still part of the printed total. */
  excludedCharges: number;
  /** User-facing message, safe for logs and the review UI (no URL inside). */
  message: string | null;
}

type QrFetch = (url: string, signal: AbortSignal) => Promise<Response>;
type EntersoftRef = NonNullable<ReceiptQrLink["entersoft"]>;

const EPSILON_HOST = "epsilondigital-sklavenitis.epsilonnet.gr";
const ENTERSOFT_HOST = "e-invoicing.gr";

const EPSILON_FD_PATH = /^\/fd\/[0-9a-f]{32}:\d{1,10}$/i;
const EPSILON_DOCVIEWER_PATH =
  /^\/DocViewer\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTERSOFT_VIEWINVOICE_PATH =
  /^\/edocuments\/ViewInvoice\/-?\d{1,4}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[A-Za-z0-9]{8}$/i;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
export const RECEIPT_QR_BUDGET_MS = 12000;

/** Cloudflare Turnstile and the generic challenge script host. */
const CHALLENGE_MARKERS = /challenges\.cloudflare\.com|cf-turnstile/i;
const USER_AGENT = "Mozilla/5.0 (compatible; SVault receipt import)";

const EPSILON_CHALLENGE_MESSAGE =
  "The issuer's receipt page needs verification in your browser before the digital receipt can be opened. Open the link in your browser, download the receipt PDF and add it to this scan.";
const EPSILON_UNAVAILABLE_MESSAGE =
  "The digital receipt could not be read from the issuer's site automatically. Open the link in your browser, download the receipt PDF and add it to this scan.";
const ENTERSOFT_EXPIRED_MESSAGE = "The digital receipt link has expired or is no longer available from the issuer.";
const ENTERSOFT_CHALLENGE_MESSAGE =
  "Entersoft requires browser verification. Open the digital receipt to verify it, or continue with the photo scan.";
const ENTERSOFT_UNAVAILABLE_MESSAGE =
  "The digital receipt could not be read automatically. The photo scan and AI re-read remain available.";
const UNSUPPORTED_MESSAGE = "That QR code or link is not from a supported digital receipt issuer.";
const GENERIC_UNAVAILABLE_MESSAGE = "The digital receipt could not be fetched from the issuer.";

/** Injected in tests; production goes through the SSRF-guarded outbound fetch. */
let testFetch: QrFetch | null = null;

export function configureReceiptQrFetcherForTests(fetch: QrFetch | null): void {
  testFetch = fetch;
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
    public readonly reason: "network" | "redirect" | "large" | "status" | "content-type",
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
  const cancel = () => { void reader.cancel().catch(() => undefined); };
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
    const prefix = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    const declaration = /charset\s*=\s*["']?(windows-1253|iso-8859-7)\b/i;
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
  deadline: number,
): Promise<{ url: URL; html: string }> {
  let current: URL;
  try {
    current = new URL(startUrl);
  } catch {
    throw new IssuerPageError("redirect");
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new IssuerPageError("network");
    if (!allowed(current) || current.username || current.password || current.port || current.hash) {
      throw new IssuerPageError("redirect");
    }
    const signal = AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remainingMs));
    const response = await issuerFetch(current.toString(), signal);
    signal.throwIfAborted();
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
    const html = decodeHtmlBytes(await readBounded(response, signal), contentType);
    return { url: current, html };
  }
  throw new IssuerPageError("redirect");
}

function result(
  issuer: ReceiptQrIssuer,
  status: ReceiptQrStatus,
  message: string | null,
  draft: ReceiptDraft | null = null,
  text: string | null = null,
  excludedCharges = 0,
): ReceiptQrFetchResult {
  return { status, issuer, message, draft, text, excludedCharges };
}

/** Epsilon Digital (Sklavenitis): /fd/… redirects to a Blazor DocViewer that renders Cloudflare Turnstile before the PDF. */
async function fetchEpsilon(link: ReceiptQrLink, deadline: number): Promise<ReceiptQrFetchResult> {
  const allowed = (url: URL) =>
    url.protocol === "https:" &&
    url.hostname === EPSILON_HOST &&
    !url.search && (EPSILON_FD_PATH.test(url.pathname) || EPSILON_DOCVIEWER_PATH.test(url.pathname));
  const page = await fetchPage(link.url, allowed, deadline);
  if (CHALLENGE_MARKERS.test(page.html)) {
    return result(link.issuer, "challenge", EPSILON_CHALLENGE_MESSAGE);
  }
  // Without a challenge the page is still a dynamic Blazor viewer whose static
  // HTML carries no receipt content; nothing else is fetched from it.
  return result(link.issuer, "unavailable", EPSILON_UNAVAILABLE_MESSAGE);
}

/** Entersoft: the viewer page frames /api/GetInvoice with the document reference. */
function pinnedGetInvoiceUrl(ref: EntersoftRef): string {
  const params = new URLSearchParams({
    contentType: "PEPPOL",
    intRefDocID: ref.uuid,
    hashToken: ref.token,
    ofenm: ref.ofenm,
    isPreview: "True",
  });
  return `https://${ENTERSOFT_HOST}/api/GetInvoice?${params.toString()}`;
}

function matchesPinnedInvoice(url: URL, ref: EntersoftRef): boolean {
  if (url.origin !== `https://${ENTERSOFT_HOST}` || url.pathname !== "/api/GetInvoice" ||
      url.username || url.password || url.hash || url.searchParams.size !== 5) return false;
  return (
    url.searchParams.get("contentType") === "PEPPOL" &&
    (url.searchParams.get("intRefDocID") ?? "").toLowerCase() === ref.uuid &&
    url.searchParams.get("hashToken") === ref.token &&
    url.searchParams.get("ofenm") === ref.ofenm &&
    url.searchParams.get("isPreview") === "True"
  );
}

/** Only the iframe named iframeContent is honoured; its parameters must match the link. */
function iframeMatchesPinnedSource(html: string, ref: EntersoftRef): boolean {
  for (const [tag] of html.matchAll(/<iframe\b[^>]*>/gi)) {
    if (!/\sid\s*=\s*(["'])iframeContent\1/i.test(tag)) continue;
    const src = tag.match(/\ssrc\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!src) return false;
    try {
      return matchesPinnedInvoice(new URL(src.replace(/&amp;/gi, "&"), `https://${ENTERSOFT_HOST}`), ref);
    } catch {
      return false;
    }
  }
  return false;
}

async function fetchEntersoft(link: ReceiptQrLink, deadline: number): Promise<ReceiptQrFetchResult> {
  const ref = link.entersoft!;
  const allowed = (url: URL) =>
    url.protocol === "https:" && url.hostname === ENTERSOFT_HOST &&
    !url.search && ENTERSOFT_VIEWINVOICE_PATH.test(url.pathname);
  const page = await fetchPage(link.url, allowed, deadline);
  if (CHALLENGE_MARKERS.test(page.html)) {
    return result(link.issuer, "challenge", ENTERSOFT_CHALLENGE_MESSAGE);
  }
  // The document URL is pinned to the QR link's own reference: the iframe only
  // confirms the page is the expected viewer. Anything else on the page (such
  // as the issuer's ΑΑΔΕ link) is never fetched.
  if (!iframeMatchesPinnedSource(page.html, ref)) {
    return result(link.issuer, "unavailable", ENTERSOFT_UNAVAILABLE_MESSAGE);
  }
  const documentUrl = pinnedGetInvoiceUrl(ref);
  const document = await fetchPage(documentUrl, (url) => matchesPinnedInvoice(url, ref), deadline);
  if (CHALLENGE_MARKERS.test(document.html)) {
    return result(link.issuer, "challenge", ENTERSOFT_CHALLENGE_MESSAGE);
  }
  const parsed = parseEntersoftInvoiceHtml(document.html);
  if (!parsed || (!parsed.draft.lines.length && parsed.draft.total == null)) {
    return result(link.issuer, "unavailable", ENTERSOFT_UNAVAILABLE_MESSAGE);
  }
  return result(link.issuer, "ok", null, parsed.draft, parsed.text, parsed.excludedCharges);
}

function messageForError(issuer: ReceiptQrIssuer, error: IssuerPageError): string {
  if (issuer === "epsilon-sklavenitis") return EPSILON_UNAVAILABLE_MESSAGE;
  if (error.reason === "status" && error.status === 404) return ENTERSOFT_EXPIRED_MESSAGE;
  return ENTERSOFT_UNAVAILABLE_MESSAGE;
}

/**
 * Fetch the digital receipt behind a QR payload. Never throws: unsupported
 * links and every failure mode come back as a status with a safe message, so
 * the scan flow can fall back to the photo scan honestly.
 */
export async function fetchQrReceiptDraft(
  payload: string,
  deadline = Date.now() + RECEIPT_QR_BUDGET_MS,
): Promise<ReceiptQrFetchResult> {
  const link = matchReceiptQrLink(payload);
  if (!link) {
    return { status: "unsupported", issuer: null, message: UNSUPPORTED_MESSAGE, draft: null, text: null, excludedCharges: 0 };
  }
  try {
    return link.issuer === "epsilon-sklavenitis"
      ? await fetchEpsilon(link, deadline)
      : await fetchEntersoft(link, deadline);
  } catch (error) {
    if (error instanceof IssuerPageError) {
      return result(link.issuer, "unavailable", messageForError(link.issuer, error));
    }
    // Unexpected errors must not surface the bearer link; keep the message generic.
    return result(link.issuer, "unavailable", GENERIC_UNAVAILABLE_MESSAGE);
  }
}
