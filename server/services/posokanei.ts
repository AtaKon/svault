import type { ExternalShoppingOffer } from "../../shared/types.js";
import { RateLimitError, limiters } from "../rate-limit.js";
import { Impit, type RequestInit as ImpitRequestInit } from "impit";

const API_BASE = "https://api.posokanei.gov.gr";
const CACHE_MS = 30 * 60_000;
const MAX_BODY_BYTES = 1_000_000;
const TIMEOUT_MS = 6_000;
const browserClient = new Impit({ browser: "chrome", timeout: TIMEOUT_MS, followRedirects: false });
const POSOKANEI_HEADERS = {
  accept: "application/json",
  "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
  origin: "https://posokanei.gov.gr",
  referer: "https://posokanei.gov.gr/",
  "x-app-version": "1.0.0",
  "x-platform": "flutter-web",
};

// Impit supplies Chrome's TLS and HTTP fingerprint. Adapt its streaming
// response to the Fetch API so the existing size and timeout checks apply.
const browserFetch: typeof fetch = async (input, init) => {
  const response = await browserClient.fetch(input, init as ImpitRequestInit);
  const body = [204, 205, 304].includes(response.status) ? null : response.body;
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};

interface CachedLookup {
  expiresAt: number;
  offers: ExternalShoppingOffer[];
}

export class PosoKaneiUnavailableError extends Error {
  constructor(message: string, readonly retryAfterSeconds?: number) {
    super(message);
  }
}

export interface PosoKaneiProduct {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
  unit: string | null;
  quantity: number | null;
  offers: ExternalShoppingOffer[];
}

function finitePositive(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1_000_000 ? parsed : null;
}

function safeString(value: unknown, max = 120): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function parseOffers(payload: unknown, fetchedAt: string): ExternalShoppingOffer[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PosoKaneiUnavailableError("PosoKanei returned an unexpected response");
  }
  const product = payload as Record<string, unknown>;
  const productId = safeString(product.id, 64);
  const productName = safeString(product.name, 180);
  if (!productId || !productName || !Array.isArray(product.retailer_prices)) {
    throw new PosoKaneiUnavailableError("PosoKanei returned an unexpected product");
  }
  const unit = safeString(product.unit, 20);
  const offers: ExternalShoppingOffer[] = [];
  for (const raw of product.retailer_prices.slice(0, 100)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (String(row.country ?? "").toUpperCase() !== "GR") continue;
    const retailer = safeString(row.retailer_display_name ?? row.retailer_name ?? row.retailer);
    const price = finitePositive(row.price);
    if (!retailer || price == null) continue;
    const discountPercent = row.discount_percentage == null ? null : Number(row.discount_percentage);
    const rawUpdatedAt = safeString(row.last_updated, 40);
    const parsedUpdatedAt = rawUpdatedAt ? Date.parse(rawUpdatedAt) : Number.NaN;
    const updatedAt = Number.isFinite(parsedUpdatedAt) ? new Date(parsedUpdatedAt).toISOString() : null;
    offers.push({
      source: "PosoKanei",
      productId,
      productName,
      unit,
      retailer,
      price,
      unitPrice: finitePositive(row.price_normalized),
      currency: "EUR",
      discount: row.is_discount === true,
      discountPercent:
        discountPercent != null && Number.isFinite(discountPercent) && discountPercent >= 0 && discountPercent <= 100
          ? discountPercent
          : null,
      updatedAt,
      fetchedAt,
    });
  }
  return offers.sort((a, b) => (a.unitPrice ?? a.price) - (b.unitPrice ?? b.price)).slice(0, 20);
}

async function readBoundedBody(response: Response, timeoutSignal: AbortSignal): Promise<string> {
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > MAX_BODY_BYTES) {
    await cancelBody(response);
    throw new PosoKaneiUnavailableError("PosoKanei response was too large");
  }
  if (!response.body) throw new PosoKaneiUnavailableError("PosoKanei returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await readWithTimeout(reader, timeoutSignal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new PosoKaneiUnavailableError("PosoKanei response was too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* A stream may already have released its lock after a read failure. */
    }
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}

async function cancelBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    /* A body may already be closed by the upstream client. */
  }
}

function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutSignal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    if (timeoutSignal.aborted) {
      reject(new PosoKaneiUnavailableError("PosoKanei response timed out"));
      return;
    }
    let settled = false;
    const cleanup = () => timeoutSignal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new PosoKaneiUnavailableError("PosoKanei response timed out"));
    };
    timeoutSignal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function retryAfter(response: Response): number {
  const raw = response.headers.get("retry-after");
  if (!raw) return 15 * 60;
  const seconds = Number(raw);
  const result = Number.isFinite(seconds) ? seconds : (Date.parse(raw) - Date.now()) / 1000;
  if (!Number.isFinite(result)) return 15 * 60;
  return Math.max(1, Math.min(60 * 60, Math.ceil(result)));
}

type ReleaseRateLimit = (() => void) | void;
type ConsumeRateLimit = (userId: string) => ReleaseRateLimit;
type ConsumeGlobalRateLimit = () => ReleaseRateLimit;

function consumeDefaultRateLimit(userId: string) {
  const key = `user:${userId}`;
  const userWait = limiters.posokanei.hit(key);
  if (userWait) {
    throw new RateLimitError(userWait, "Price lookup limit reached. Try again later.");
  }
  return () => limiters.posokanei.refund(key);
}

function consumeDefaultGlobalRateLimit() {
  const globalWait = limiters.posokaneiGlobal.hit("all");
  if (globalWait) {
    throw new RateLimitError(globalWait, "Price lookup limit reached. Try again later.");
  }
  return () => limiters.posokaneiGlobal.refund("all");
}

/** A factory keeps the HTTP client deterministic and lets unit tests supply a
 * fake fetcher without changing process-wide network behavior. */
export function createPosoKaneiClient(
  fetcher: typeof fetch = browserFetch,
  consumeRateLimit: ConsumeRateLimit = consumeDefaultRateLimit,
  consumeGlobalRateLimit: ConsumeGlobalRateLimit = consumeDefaultGlobalRateLimit,
  timeoutMs = TIMEOUT_MS,
) {
  const cache = new Map<string, CachedLookup>();
  const inFlight = new Map<string, Promise<ExternalShoppingOffer[]>>();
  let upstreamBlockedUntil = 0;
  const barcodeBlockedUntil = new Map<string, number>();

  const cacheResult = (key: string, entry: CachedLookup) => {
    cache.delete(key);
    cache.set(key, entry);
    if (cache.size <= 500) return;
    const now = Date.now();
    for (const [key, value] of cache) if (value.expiresAt <= now) cache.delete(key);
    // FIFO by write time; cache reads do not refresh eviction order.
    while (cache.size > 500) cache.delete(cache.keys().next().value!);
  };

  const pauseBarcode = (code: string, until: number) => {
    const now = Date.now();
    for (const [key, expiresAt] of barcodeBlockedUntil) {
      if (expiresAt <= now) barcodeBlockedUntil.delete(key);
    }
    barcodeBlockedUntil.delete(code);
    barcodeBlockedUntil.set(code, until);
    while (barcodeBlockedUntil.size > 500) barcodeBlockedUntil.delete(barcodeBlockedUntil.keys().next().value!);
  };

  /** Fetch a product only by an exact barcode. The destination is a fixed,
   * HTTPS-only upstream; callers cannot provide URLs, query strings or headers. */
  async function lookupProduct(value: string, userId: string, mode: "barcode" | "product"): Promise<ExternalShoppingOffer[]> {
    const code = value.trim();
    if (mode === "barcode" ? !/^\d{8,14}$/.test(code) : !/^[a-zA-Z0-9_-]{1,64}$/.test(code)) return [];
    const now = Date.now();
    const requestKey = JSON.stringify([userId, mode, code]);
    const cached = cache.get(requestKey);
    if (cached && cached.expiresAt > now) return cached.offers;
    if (upstreamBlockedUntil > now) {
      throw new PosoKaneiUnavailableError(
        "PosoKanei asked SVault to slow down. Try again later.",
        Math.ceil((upstreamBlockedUntil - now) / 1000),
      );
    }
    const barcodeWaitUntil = barcodeBlockedUntil.get(code) ?? 0;
    if (barcodeWaitUntil > now) {
      throw new PosoKaneiUnavailableError(
        "PosoKanei could not complete this barcode lookup. Try again later.",
        Math.ceil((barcodeWaitUntil - now) / 1000),
      );
    }
    if (barcodeWaitUntil) barcodeBlockedUntil.delete(code);
    // Share only within one user so another account cannot get a lookup result
    // without reserving its own per-user request slot.
    const existing = inFlight.get(requestKey);
    if (existing) return existing;

    const request = Promise.resolve().then(async () => {
      const releaseUserLimit = consumeRateLimit(userId);
      let releaseGlobalLimit: ReleaseRateLimit;
      let upstreamRateLimited = false;
      try {
        releaseGlobalLimit = consumeGlobalRateLimit();
      } catch (error) {
        releaseUserLimit?.();
        throw error;
      }

      try {
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const url = new URL(mode === "barcode" ? `/products/barcode/${encodeURIComponent(code)}` : `/products/${encodeURIComponent(code)}`, API_BASE);
        url.searchParams.set("countries", "GR");
        const response = await fetcher(url, {
          method: "GET",
          headers: POSOKANEI_HEADERS,
          redirect: "error",
          signal: timeoutSignal,
        });
        if (response.status === 404) {
          const offers: ExternalShoppingOffer[] = [];
          await cancelBody(response);
          cacheResult(requestKey, { expiresAt: Date.now() + 10 * 60_000, offers });
          return offers;
        }
        if (response.status === 429) {
          upstreamRateLimited = true;
          const wait = retryAfter(response);
          upstreamBlockedUntil = Date.now() + wait * 1000;
          await cancelBody(response);
          throw new PosoKaneiUnavailableError("PosoKanei asked SVault to slow down. Try again later.", wait);
        }
        if (!response.ok) {
          await cancelBody(response);
          throw new PosoKaneiUnavailableError(`PosoKanei returned HTTP ${response.status}`);
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("application/json")) {
          await cancelBody(response);
          throw new PosoKaneiUnavailableError("PosoKanei returned a non-JSON response");
        }
        let payload: unknown;
        try {
          payload = JSON.parse(await readBoundedBody(response, timeoutSignal));
        } catch (error) {
          if (error instanceof PosoKaneiUnavailableError) throw error;
          throw new PosoKaneiUnavailableError("PosoKanei returned an invalid response body");
        }
        if (mode === "product" && (!payload || typeof payload !== "object" || (payload as Record<string, unknown>).id !== code)) {
          throw new PosoKaneiUnavailableError("PosoKanei returned an unexpected product");
        }
        const fetchedAt = new Date().toISOString();
        const offers = parseOffers(payload, fetchedAt);
        cacheResult(requestKey, { expiresAt: Date.now() + CACHE_MS, offers });
        return offers;
      } catch (error) {
        const normalizedError = error instanceof PosoKaneiUnavailableError
          ? error
          : new PosoKaneiUnavailableError("PosoKanei could not be reached. Try again later.");
        if (!upstreamRateLimited) {
          releaseUserLimit?.();
          releaseGlobalLimit?.();
          pauseBarcode(code, Date.now() + 15_000);
        }
        throw normalizedError;
      }
    }).finally(() => inFlight.delete(requestKey));
    inFlight.set(requestKey, request);
    return request;
  }

  const lookupPosoKaneiBarcode = (barcode: string, userId: string) => lookupProduct(barcode, userId, "barcode");
  const lookupPosoKaneiProduct = (id: string, userId: string) => lookupProduct(id, userId, "product");

  async function searchPosoKanei(query: string, page: number, userId: string): Promise<{ products: PosoKaneiProduct[]; hasNext: boolean }> {
    if (upstreamBlockedUntil > Date.now()) throw new PosoKaneiUnavailableError("PosoKanei asked SVault to slow down. Try again later.", Math.ceil((upstreamBlockedUntil - Date.now()) / 1000));
    const userKey = `user:${userId}`;
    const userWait = limiters.posokaneiSearch.hit(userKey);
    if (userWait) throw new RateLimitError(userWait, "Price lookup limit reached. Try again later.");
    const globalWait = limiters.posokaneiSearchGlobal.hit("all");
    if (globalWait) { limiters.posokaneiSearch.refund(userKey); throw new RateLimitError(globalWait, "Price lookup limit reached. Try again later."); }
    let throttled = false;
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const response = await fetcher(new URL("/products/search", API_BASE), {
        method: "POST",
        headers: { ...POSOKANEI_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ title: query, page, page_size: 20, sort_by: "name", sort_order: "asc" }),
        redirect: "error", signal: timeoutSignal,
      });
      if (response.status === 429) {
        throttled = true;
        const wait = retryAfter(response);
        upstreamBlockedUntil = Date.now() + wait * 1000;
        await cancelBody(response);
        throw new PosoKaneiUnavailableError("PosoKanei asked SVault to slow down. Try again later.", wait);
      }
      if (!response.ok || !(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
        await cancelBody(response);
        throw new PosoKaneiUnavailableError("PosoKanei returned an unexpected response");
      }
      const payload = JSON.parse(await readBoundedBody(response, timeoutSignal));
      if (!payload || !Array.isArray(payload.products)) throw new PosoKaneiUnavailableError("PosoKanei returned an unexpected response");
      const fetchedAt = new Date().toISOString();
      const products: PosoKaneiProduct[] = payload.products.slice(0, 20).flatMap((raw: any) => {
        if (!raw || typeof raw !== "object" || !/^[a-zA-Z0-9_-]{1,64}$/.test(raw.id ?? "") || !safeString(raw.name, 180)) return [];
        return [{ id: raw.id, name: safeString(raw.name, 180)!, brand: safeString(raw.brand), category: safeString(raw.category), unit: safeString(raw.unit, 20), quantity: finitePositive(raw.unit_quantity), offers: Array.isArray(raw.retailer_prices) ? parseOffers(raw, fetchedAt).slice(0, 3) : [] }];
      });
      return { products, hasNext: payload.has_next === true };
    } catch (error) {
      if (!throttled) { limiters.posokaneiSearch.refund(userKey); limiters.posokaneiSearchGlobal.refund("all"); }
      if (error instanceof PosoKaneiUnavailableError) throw error;
      throw new PosoKaneiUnavailableError("PosoKanei could not be reached. Try again later.");
    }
  }

  return { lookupPosoKaneiBarcode, lookupPosoKaneiProduct, searchPosoKanei };
}

const defaultClient = createPosoKaneiClient();
export const lookupPosoKaneiBarcode = defaultClient.lookupPosoKaneiBarcode;
export const lookupPosoKaneiProduct = defaultClient.lookupPosoKaneiProduct;
export const searchPosoKanei = defaultClient.searchPosoKanei;
