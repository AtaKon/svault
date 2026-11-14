import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";

type ResolvedAddress = { address: string; family: number };
type Resolver = (host: string) => Promise<ResolvedAddress[]>;

const systemResolver: Resolver = (host) => dns.lookup(host, { all: true, verbatim: true });
let resolveHost: Resolver = systemResolver;
let blockedForTests: ((address: string) => boolean) | null = null;

/**
 * Tests swap the resolver to simulate DNS rebinding, and may override which
 * connect-time addresses count as private so the pinned path can reach a local
 * test server. Call with no arguments to restore both.
 */
export function setOutboundResolverForTests(resolver?: Resolver, blocked?: (address: string) => boolean): void {
  resolveHost = resolver ?? systemResolver;
  blockedForTests = blocked ?? null;
}

function blockedAtConnect(address: string): boolean {
  return blockedForTests ? blockedForTests(address) : isPrivateAddress(address);
}

/**
 * Outbound requests to URLs that house admins configure (AI providers,
 * reminder channels). Private and loopback targets are allowed by default
 * because a LAN Ollama or ntfy server is a common setup; set
 * SV_OUTBOUND_ALLOW_PRIVATE=false on shared instances to stop house admins
 * from probing the server's own network.
 */
export function outboundAllowPrivate(): boolean {
  return (process.env.SV_OUTBOUND_ALLOW_PRIVATE ?? "true").trim().toLowerCase() !== "false";
}

/** `redirect` mode for fetch: a public host must not bounce us to a private one. */
export function outboundRedirectMode(): RequestRedirect {
  return outboundAllowPrivate() ? "follow" : "error";
}

/** How many redirect hops a user-supplied link may take. */
const MAX_REDIRECTS = 5;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch a URL that came from a user and re-validate every redirect hop.
 *
 * `redirect: "follow"` would let a public URL bounce to a private address after
 * the guard on the first URL already passed, so hops are followed by hand here
 * and each one goes through `assertOutboundUrl`. With private targets refused,
 * the connection itself goes through `outboundFetch`, which re-checks the
 * addresses it actually connects to, so DNS rebinding cannot slip past.
 */
export async function fetchOutbound(
  rawUrl: string,
  init: RequestInit & { label: string },
): Promise<{ response: Response; url: string }> {
  let current = new URL(rawUrl);
  const { label, ...requestInit } = init;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertOutboundUrl(current.toString(), label);
    const response = await outboundFetch(current, { ...requestInit, redirect: "manual" });
    if (!REDIRECT_STATUS.has(response.status)) return { response, url: current.toString() };
    const location = response.headers.get("location");
    if (!location) return { response, url: current.toString() };
    if (hop === MAX_REDIRECTS) {
      await response.body?.cancel();
      throw new OutboundBlockedError(`${label} redirects too many times`);
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      await response.body?.cancel();
      throw new OutboundBlockedError(`${label} redirects to an invalid address`);
    }
    await response.body?.cancel();
    current = next;
  }
  throw new OutboundBlockedError(`${label} redirects too many times`);
}

export class OutboundBlockedError extends Error {}

function ipv4Private(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && parts[2] === 0) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

/** True for loopback, private, link-local, unique-local and other non-public addresses. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").split("%")[0];
  const kind = net.isIP(ip);
  if (kind === 4) return ipv4Private(ip);
  if (kind !== 6) return true;
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  const mapped = lower.match(/^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/) ?? lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Private(mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(lower)) {
    const [hi, lo] = lower.slice(7).split(":").map((part) => parseInt(part, 16));
    return ipv4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = parseInt(lower.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xffc0) === 0xfec0 || // deprecated site-local
    (first & 0xff00) === 0xff00 || // multicast
    lower.startsWith("64:ff9b:") // NAT64 can reach IPv4 private ranges
  );
}

/**
 * Validate a house-configured URL before the server calls it. Always requires
 * http(s); with SV_OUTBOUND_ALLOW_PRIVATE=false it also resolves the host and
 * refuses loopback/private/link-local targets.
 */
export async function assertOutboundUrl(raw: string, label: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundBlockedError(`${label} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OutboundBlockedError(`${label} must start with http:// or https://`);
  }
  if (outboundAllowPrivate()) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await resolveHost(host)).map((entry) => entry.address);
    } catch {
      throw new OutboundBlockedError(`${label} could not be resolved`);
    }
  }
  if (!addresses.length || addresses.some(blockedAtConnect)) {
    throw new OutboundBlockedError(
      `${label} points to a private or local network address, which this server does not allow`,
    );
  }
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * `lookup` for node:http that refuses private answers. Validating the URL and
 * then letting fetch resolve the host again leaves a DNS-rebinding window (a
 * short-TTL name can answer public first and 127.0.0.1 second); checking the
 * answer that the socket will actually use closes it. IP literals skip lookup
 * and are already checked by `assertOutboundUrl`.
 */
function guardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number | string } | number | undefined,
  callback: (error: Error | null, address?: string | ResolvedAddress[], family?: number) => void,
): void {
  resolveHost(hostname).then(
    (entries) => {
      if (!entries.length || entries.some((entry) => blockedAtConnect(entry.address))) {
        callback(new OutboundBlockedError("The address resolved to a private or local network address, which this server does not allow"));
        return;
      }
      // Honour a requested address family (4 or 6) like dns.lookup does.
      const wanted = typeof options === "number" ? options : Number(typeof options === "object" ? options?.family ?? 0 : 0);
      const usable = wanted === 4 || wanted === 6 ? entries.filter((entry) => entry.family === wanted) : entries;
      if (!usable.length) {
        callback(Object.assign(new Error(`No IPv${wanted} address for ${hostname}`), { code: "ENOTFOUND" }));
        return;
      }
      if (typeof options === "object" && options?.all) callback(null, usable);
      else callback(null, usable[0].address, usable[0].family);
    },
    (error) => callback(error instanceof Error ? error : new Error(String(error))),
  );
}

function pinnedRequest(url: URL, init: RequestInit): Promise<Response> {
  const client = url.protocol === "https:" ? https : http;
  const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
  const method = (init.method ?? "GET").toUpperCase();
  const body = init.body;
  if (body !== undefined && body !== null && typeof body !== "string") {
    return Promise.reject(new TypeError("outboundFetch only sends string bodies"));
  }
  // Send a fixed length rather than chunked encoding, which some endpoints refuse.
  if (typeof body === "string") headers["content-length"] = String(Buffer.byteLength(body));
  if (init.signal?.aborted) return Promise.reject(init.signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      { method, headers, lookup: guardedLookup as never, signal: init.signal ?? undefined },
      (incoming) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) value.forEach((entry) => responseHeaders.append(name, entry));
          else responseHeaders.set(name, String(value));
        }
        const status = incoming.statusCode ?? 502;
        const empty = NULL_BODY_STATUS.has(status) || method === "HEAD";
        if (empty) incoming.resume();
        resolve(
          new Response(empty ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), {
            status,
            statusText: incoming.statusMessage,
            headers: responseHeaders,
          }),
        );
      },
    );
    request.on("error", reject);
    if (typeof body === "string") request.write(body);
    request.end();
  });
}

/**
 * `fetch` for house-configured or user-supplied URLs. While private targets are
 * allowed (the default) it is plain `fetch`. Otherwise the request is made over
 * a connection whose resolved address is checked, and redirects are either
 * returned (`manual`) or rejected, never followed blindly.
 */
export async function outboundFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  if (outboundAllowPrivate()) return fetch(input, init);
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OutboundBlockedError("Only http:// and https:// addresses are allowed");
  }
  // IP literals never reach the lookup hook, so check them here.
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(literal) && blockedAtConnect(literal)) {
    throw new OutboundBlockedError("The address is a private or local network address, which this server does not allow");
  }
  const response = await pinnedRequest(url, init);
  if (init.redirect !== "manual" && REDIRECT_STATUS.has(response.status)) {
    await response.body?.cancel();
    throw new OutboundBlockedError("The address redirected, which this server does not follow for private-network protection");
  }
  return response;
}
