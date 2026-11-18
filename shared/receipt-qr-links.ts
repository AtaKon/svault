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

export type ReceiptQrIssuer = "epsilon-sklavenitis" | "entersoft";

export type ReceiptQrLink = {
  /** The parsed and validated HTTPS URL used for retrieval. */
  url: string;
} & (
  | { issuer: "epsilon-sklavenitis"; viewerPath: string }
  | { issuer: "entersoft"; entersoft: { ofenm: string; uuid: string; token: string } }
);

const EPSILON_HOST = "epsilondigital-sklavenitis.epsilonnet.gr";
const ENTERSOFT_HOST = "e-invoicing.gr";

/** Epsilon Digital (Sklavenitis): /fd/{32 hex}:{register digits} */
const EPSILON_PATH = /^\/fd\/([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12}):\d{1,10}$/i;
/** Entersoft: /edocuments/ViewInvoice/{ofenm}/{uuid}_{8 alphanumeric} */
const ENTERSOFT_PATH =
  /^\/edocuments\/ViewInvoice\/(-?\d{1,4})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9]{8})$/i;

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
  // No credentials, nondefault ports, query strings or fragments: the issuers'
  // QR links are bare paths and anything else is unexpected.
  if (url.username || url.password || url.port || url.search || url.hash) return null;
  if (url.protocol !== "https:") return null;

  const epsilon = EPSILON_PATH.exec(url.pathname);
  if (url.hostname === EPSILON_HOST && epsilon) {
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
  return null;
}
