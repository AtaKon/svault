/**
 * Printing QR labels for items and places.
 *
 * A label never carries household data: the QR code holds a plain link to an
 * in-app route (`/items/:itemId` or `/items?location=:id`) plus the house it
 * belongs to, so a scan lands on the same page a bookmark would.
 *
 * The functions here are shared between the client (build the link, recognise
 * a scanned label) and the tests, which is why there is no React or DOM access
 * beyond the optional `window.location.origin` fallback.
 */

export type LabelKind = "item" | "place";

export interface LabelTarget {
  kind: LabelKind;
  /** `itm_...` for an item, `loc_...` for a place. */
  id: string;
  /** The house the label was printed for, used to switch house after a scan. */
  houseId: string | null;
  /** In-app path (router-ready) carrying the same query parameters. */
  path: string;
}

const ID_PATTERN: Record<LabelKind, RegExp> = {
  item: /^itm_[a-z0-9]+$/,
  place: /^loc_[a-z0-9]+$/,
};
const HOUSE_PATTERN = /^hse_[a-z0-9]+$/;

/**
 * Turn a configured public URL into a `scheme://host[:port][/path]` prefix.
 * Trailing slashes are dropped so `${base}${path}` never doubles a slash.
 * Anything that is not a plain http(s) URL (or that carries credentials) is
 * rejected, because it would end up printed on a label.
 */
export function normalisePublicBase(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password) return "";
    if (url.search || url.hash) return "";
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function browserOrigin(): string {
  try {
    return typeof window !== "undefined" && window.location?.origin ? window.location.origin : "";
  } catch {
    return "";
  }
}

/** Configured public URL when the operator set one, otherwise this browser's origin. */
export function resolvePublicBase(configured?: string | null): string {
  return normalisePublicBase(configured) || browserOrigin();
}

function houseQuery(houseId: string | null | undefined): string {
  return houseId && HOUSE_PATTERN.test(houseId) ? `house=${encodeURIComponent(houseId)}` : "";
}

/** In-app path for a label, with the house so a scan can select it. */
export function labelPath(kind: LabelKind, id: string, houseId?: string | null): string {
  const house = houseQuery(houseId);
  if (kind === "item") {
    const path = `/items/${encodeURIComponent(id)}`;
    return house ? `${path}?${house}` : path;
  }
  const path = `/items?location=${encodeURIComponent(id)}`;
  return house ? `${path}&${house}` : path;
}

/** Absolute link printed into a QR label. */
export function labelUrl(input: {
  kind: LabelKind;
  id: string;
  houseId?: string | null;
  /** `PUBLIC_URL` from the server; empty falls back to the browser origin. */
  publicBase?: string | null;
}): string {
  return `${resolvePublicBase(input.publicBase)}${labelPath(input.kind, input.id, input.houseId)}`;
}

/**
 * Read a scanned QR payload. Only links that point at this SVault instance and
 * at a label route are accepted; `javascript:`, `data:` and foreign origins are
 * rejected before the router ever sees them.
 */
export function parseLabelScan(text: string, publicBase?: string | null): LabelTarget | null {
  const raw = String(text ?? "").trim();
  if (!raw || raw.length > 2048) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;

  const base = resolvePublicBase(publicBase);
  if (!base) return null;
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    return null;
  }
  if (url.origin !== baseUrl.origin) return null;

  let path = url.pathname;
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  if (basePath) {
    if (path === basePath) path = "/";
    else if (path.startsWith(`${basePath}/`)) path = path.slice(basePath.length);
    else return null;
  }

  const rawHouse = url.searchParams.get("house");
  const houseId = rawHouse && HOUSE_PATTERN.test(rawHouse) ? rawHouse : null;

  const itemMatch = /^\/items\/([^/]+)\/?$/.exec(path);
  if (itemMatch) {
    let id: string;
    try {
      id = decodeURIComponent(itemMatch[1]);
    } catch {
      return null;
    }
    if (!ID_PATTERN.item.test(id)) return null;
    return { kind: "item", id, houseId, path: labelPath("item", id, houseId) };
  }

  if (/^\/items\/?$/.test(path)) {
    const locationId = url.searchParams.get("location");
    if (!locationId || !ID_PATTERN.place.test(locationId)) return null;
    return { kind: "place", id: locationId, houseId, path: labelPath("place", locationId, houseId) };
  }

  return null;
}
