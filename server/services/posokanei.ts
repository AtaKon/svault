import type { ExternalShoppingOffer } from "../../shared/types.js";
import { RateLimitError, limiters } from "../rate-limit.js";

const API_BASE = "https://api.posokanei.gov.gr";
const CACHE_MS = 30 * 60_000;
const MAX_BODY_BYTES = 1_000_000;
const TIMEOUT_MS = 6_000;

interface CachedLookup {
  expiresAt: number;
  offers: ExternalShoppingOffer[];
}

export class PosoKaneiUnavailableError extends Error {
  constructor(message: string, readonly retryAfterSeconds?: number) {
    super(message);
  }
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

async function readBoundedBody(response: Response): Promise<string> {
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
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new PosoKaneiUnavailableError("PosoKanei response was too large");
      }
      chunks.push(value);
    }
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
  fetcher: typeof fetch = fetch,
  consumeRateLimit: ConsumeRateLimit = consumeDefaultRateLimit,
  consumeGlobalRateLimit: ConsumeGlobalRateLimit = consumeDefaultGlobalRateLimit,
) {
  const cache = new Map<string, CachedLookup>();
  const inFlight = new Map<string, Promise<ExternalShoppingOffer[]>>();
  let upstreamBlockedUntil = 0;

  const cacheResult = (code: string, entry: CachedLookup) => {
    cache.delete(code);
    cache.set(code, entry);
    if (cache.size <= 500) return;
    const now = Date.now();
    for (const [key, value] of cache) if (value.expiresAt <= now) cache.delete(key);
    // FIFO by write time; cache reads do not refresh eviction order.
    while (cache.size > 500) cache.delete(cache.keys().next().value!);
  };

  /** Fetch a product only by an exact barcode. The destination is a fixed,
   * HTTPS-only upstream; callers cannot provide URLs, query strings or headers. */
  async function lookupPosoKaneiBarcode(barcode: string, userId: string): Promise<ExternalShoppingOffer[]> {
    const code = barcode.trim();
    if (!/^\d{8,14}$/.test(code)) return [];
    const now = Date.now();
    const cached = cache.get(code);
    if (cached && cached.expiresAt > now) return cached.offers;
    if (upstreamBlockedUntil > now) {
      throw new PosoKaneiUnavailableError(
        "PosoKanei asked SVault to slow down. Try again later.",
        Math.ceil((upstreamBlockedUntil - now) / 1000),
      );
    }
    const existing = inFlight.get(code);
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
        const url = new URL(`/products/barcode/${encodeURIComponent(code)}`, API_BASE);
        url.searchParams.set("countries", "GR");
        const response = await fetcher(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            "user-agent": "SVault/1.2 (self-hosted household inventory; https://github.com/AtaKon/svault)",
          },
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (response.status === 404) {
          const offers: ExternalShoppingOffer[] = [];
          await cancelBody(response);
          cacheResult(code, { expiresAt: Date.now() + 10 * 60_000, offers });
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
          payload = JSON.parse(await readBoundedBody(response));
        } catch (error) {
          if (error instanceof PosoKaneiUnavailableError) throw error;
          throw new PosoKaneiUnavailableError("PosoKanei returned an invalid response body");
        }
        const fetchedAt = new Date().toISOString();
        const offers = parseOffers(payload, fetchedAt);
        cacheResult(code, { expiresAt: Date.now() + CACHE_MS, offers });
        return offers;
      } catch (error) {
        const normalizedError = error instanceof PosoKaneiUnavailableError
          ? error
          : new PosoKaneiUnavailableError("PosoKanei could not be reached. Try again later.");
        if (!upstreamRateLimited) {
          releaseUserLimit?.();
          releaseGlobalLimit?.();
          upstreamBlockedUntil = Math.max(upstreamBlockedUntil, Date.now() + 15_000);
        }
        throw normalizedError;
      }
    }).finally(() => inFlight.delete(code));
    inFlight.set(code, request);
    return request;
  }

  return { lookupPosoKaneiBarcode };
}

const defaultClient = createPosoKaneiClient();
export const lookupPosoKaneiBarcode = defaultClient.lookupPosoKaneiBarcode;
