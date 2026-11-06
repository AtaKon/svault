import dns from "node:dns/promises";
import net from "node:net";

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
      addresses = (await dns.lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
    } catch {
      throw new OutboundBlockedError(`${label} could not be resolved`);
    }
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new OutboundBlockedError(
      `${label} points to a private or local network address, which this server does not allow`,
    );
  }
}
