/**
 * Digital receipt links carried by the QR codes printed on Greek retail
 * receipts and e-invoices.
 *
 * The patterns are deliberately exact — a known https host, a known route
 * shape, no credentials, nondefault port, query or fragment — because the server fetches
 * whatever matches without user interaction. Both the client (classifying
 * decoded QR payloads and pasted links) and the server (validating before the
 * fetch) share this module, so the two sides can never disagree about what is
 * fetchable.
 */

export type ReceiptQrIssuer = "epsilon-sklavenitis" | "entersoft" | "impact";

export type ReceiptQrLink = {
  /** The parsed and validated HTTPS URL used for retrieval. */
  url: string;
} & (
  | { issuer: "epsilon-sklavenitis"; viewerPath: string }
  | { issuer: "entersoft"; entersoft: { ofenm: string; uuid: string; token: string } }
  | { issuer: "impact" }
);

const EPSILON_HOST = "epsilondigital-sklavenitis.epsilonnet.gr";
const ENTERSOFT_HOST = "e-invoicing.gr";
const IMPACT_HOST = "einvoice.impact.gr";

/** Epsilon Digital (Sklavenitis): /fd/{32 hex}:{register digits} */
const EPSILON_PATH = /^\/fd\/([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12}):\d{1,10}$/i;
/** Entersoft: /edocuments/ViewInvoice/{ofenm}/{uuid}_{8 alphanumeric} */
const ENTERSOFT_PATH =
  /^\/edocuments\/ViewInvoice\/(-?\d{1,4})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9]{8})$/i;
/** The scanned IMPACT QR used uppercase EL. Hex accepts either case and is sent as printed in the path. */
const IMPACT_PATH = /^\/p\/EL\d{9}\/[0-9a-fA-F]{40}\/[0-9a-fA-F]{32}$/;

/**
 * Match a QR payload or pasted text against the supported issuer links.
 * Returns null for anything else — other URLs are never fetched.
 */
export function matchReceiptQrLink(payload: string): ReceiptQrLink | null {
  const trimmed = String(payload ?? "").trim();
  if (!trimmed || /\s/.test(trimmed) || !/^https:\/\//i.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  // URL normalizes the HTTPS default port. Reject other ports, credentials,
  // queries and fragments before matching the issuer's receipt path.
  if (url.username || url.password || url.port || url.search || url.hash) return null;
  if (url.protocol !== "https:") return null;

  const epsilon = EPSILON_PATH.exec(url.pathname);
  if (url.hostname === EPSILON_HOST && epsilon) {
    url.pathname = url.pathname.toLowerCase();
    return {
      issuer: "epsilon-sklavenitis",
      url: url.href,
      viewerPath: "/docviewer/" + epsilon.slice(1).join("-").toLowerCase(),
    };
  }
  const entersoft = ENTERSOFT_PATH.exec(url.pathname);
  if (url.hostname === ENTERSOFT_HOST && entersoft) {
    return {
      issuer: "entersoft",
      url: url.href,
      entersoft: {
        ofenm: entersoft[1],
        uuid: entersoft[2].toLowerCase(),
        token: entersoft[3],
      },
    };
  }
  // Keep the IMPACT path case and reject even empty query or fragment markers.
  if (url.hostname === IMPACT_HOST && IMPACT_PATH.test(url.pathname) && url.href === url.origin + url.pathname) {
    return { issuer: "impact", url: url.href };
  }
  return null;
}
