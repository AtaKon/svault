import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import { sendNotification, setVapidDetails } from "web-push";
import { webPushConfig } from "../config.js";
import { all, get, newId, now, run } from "../db.js";
import { ApiError } from "../http.js";
import { isPrivateAddress } from "../lib/outbound.js";

/**
 * Web Push delivery for reminder channels.
 *
 * Subscriptions belong to a user, not a house: the same phone can follow two
 * houses, and removing someone from a house must not delete their device. The
 * house membership check happens at delivery time in `subscriptionsForHouse`.
 */

/** A device may follow the instance from a handful of browsers, not hundreds. */
export const MAX_SUBSCRIPTIONS_PER_USER = 20;

export interface PushSubscriptionRecord {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: string;
}

/** Deliberately minimal: the click target is a path, never item data. */
export interface PushPayload {
  title: string;
  body: string;
  /** In-app path to open when the notification is tapped, e.g. `/items/itm_1`. */
  url: string;
}

export interface PushDeliveryResult {
  ok: boolean;
  statusCode: number | null;
  /** The push service reported 404/410, so the subscription is dead. */
  expired: boolean;
  error: string | null;
}

type PushSender = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
) => Promise<PushDeliveryResult>;

let senderOverride: PushSender | null = null;

/** Tests replace the network call; pass nothing to restore the real sender. */
export function setPushSenderForTests(sender?: PushSender | null): void {
  senderOverride = sender ?? null;
}

function truncate(value: string, max: number): string {
  return String(value ?? "").slice(0, max);
}

/**
 * Push endpoints are chosen by any signed-in user, not by a house admin, so the
 * SV_OUTBOUND_ALLOW_PRIVATE setting that lets admins point a reminder channel
 * at a LAN ntfy server must NOT apply here: a real push service (FCM, Mozilla,
 * Apple, WNS) is always a public HTTPS host. Without this, any account could
 * make the server send requests to addresses on its own network.
 *
 * This is the cheap, offline part (used when subscribing): scheme, credentials
 * and literal private addresses. Names are resolved at send time.
 */
export function pushEndpointProblem(url: URL): string | null {
  if (url.protocol !== "https:") return "The push endpoint must use https";
  if (url.username || url.password) return "The push endpoint must not contain credentials";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return "The push endpoint must be a public address";
  if (net.isIP(host) && isPrivateAddress(host)) return "The push endpoint must be a public address";
  return null;
}

/** Full check before a send: the shape rules plus every resolved address must be public. */
export async function publicEndpointProblem(raw: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "The push endpoint is not a valid URL";
  }
  const shape = pushEndpointProblem(url);
  if (shape) return shape;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return null;
  try {
    const addresses = await dnsPromises.lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
      return "The push endpoint must be a public address";
    }
  } catch {
    return "The push endpoint could not be resolved";
  }
  return null;
}

/**
 * Connect-time guard. The pre-check above resolves the name once; this agent
 * re-checks the address the socket actually uses, so DNS rebinding between the
 * check and the connection cannot reach a private address.
 */
const publicOnlyAgent = new https.Agent({
  lookup: ((hostname: string, options: any, callback: (...args: any[]) => void) => {
    dns.lookup(hostname, options, (error: NodeJS.ErrnoException | null, address: any, family: any) => {
      if (error) return callback(error, address, family);
      const list: string[] = Array.isArray(address) ? address.map((entry: { address: string }) => entry.address) : [address];
      if (list.some((entry) => isPrivateAddress(entry))) {
        return callback(new Error("The push endpoint must be a public address"), address, family);
      }
      callback(null, address, family);
    });
  }) as any,
});

/** web-push signs the request with the VAPID key pair and encrypts the body. */
async function networkSender(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
): Promise<PushDeliveryResult> {
  const config = webPushConfig();
  if (!config.enabled) return { ok: false, statusCode: null, expired: false, error: "Web Push is not configured" };
  const problem = await publicEndpointProblem(subscription.endpoint);
  if (problem) return { ok: false, statusCode: null, expired: false, error: problem };
  try {
    setVapidDetails(config.subject, config.publicKey, config.privateKey);
    const response = await sendNotification(subscription, payload, { TTL: 60 * 60, timeout: 10_000, agent: publicOnlyAgent });
    return { ok: true, statusCode: response.statusCode ?? 201, expired: false, error: null };
  } catch (error: any) {
    const statusCode = Number(error?.statusCode ?? 0) || null;
    const body = typeof error?.body === "string" ? error.body.slice(0, 300) : "";
    return {
      ok: false,
      statusCode,
      expired: statusCode === 404 || statusCode === 410,
      error: body || (error instanceof Error ? error.message : "Push delivery failed"),
    };
  }
}

export function pushEnabled(): boolean {
  return webPushConfig().enabled;
}

export function pushPublicKey(): string | null {
  const config = webPushConfig();
  return config.enabled ? config.publicKey : null;
}

function serializeSubscription(row: any): PushSubscriptionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    userAgent: row.user_agent ?? null,
    createdAt: row.created_at,
  };
}

export async function listSubscriptions(userId: string): Promise<PushSubscriptionRecord[]> {
  const rows = await all<any>(
    "SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at",
    [userId],
  );
  return rows.map(serializeSubscription);
}

/**
 * Store (or refresh) a browser subscription. The endpoint is unique in the
 * instance, so signing in as another user on the same browser moves the
 * subscription to that account instead of keeping a stale owner. Moving it
 * requires the same keys (see below); otherwise it is refused with 409.
 */
export async function subscribeUser(opts: {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}): Promise<PushSubscriptionRecord> {
  const endpoint = truncate(opts.endpoint, 2000);
  const timestamp = now();
  const existing = await get<any>("SELECT * FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
  if (existing) {
    // The endpoint is a secret only its browser knows. A row may change owner
    // (signing in as someone else on the same browser) only when the caller
    // presents the same keys, so a leaked endpoint string alone cannot redirect
    // another account's device.
    if (existing.user_id !== opts.userId && (existing.p256dh !== opts.p256dh || existing.auth !== opts.auth)) {
      throw new ApiError(409, "This device is already registered to another account");
    }
    await run(
      "UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ?, user_agent = ?, created_at = ? WHERE id = ?",
      [opts.userId, truncate(opts.p256dh, 200), truncate(opts.auth, 100), truncate(opts.userAgent ?? "", 300) || null, timestamp, existing.id],
    );
  } else {
    await run(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        newId("psub"),
        opts.userId,
        endpoint,
        truncate(opts.p256dh, 200),
        truncate(opts.auth, 100),
        truncate(opts.userAgent ?? "", 300) || null,
        timestamp,
      ],
    );
  }
  // Keep only the newest devices, on insert and on a move alike; an abandoned
  // browser (or moved rows) must not grow a user's list without bound.
  const owned = await all<{ id: string }>(
    "SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC",
    [opts.userId],
  );
  for (const stale of owned.slice(MAX_SUBSCRIPTIONS_PER_USER)) {
    await run("DELETE FROM push_subscriptions WHERE id = ?", [stale.id]);
  }
  const row = await get<any>("SELECT * FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
  return serializeSubscription(row!);
}

export async function unsubscribeUser(userId: string, endpoint: string): Promise<boolean> {
  const result = await run("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?", [userId, truncate(endpoint, 2000)]);
  return Number(result.changes ?? 0) > 0;
}

export async function deleteSubscription(id: string): Promise<void> {
  await run("DELETE FROM push_subscriptions WHERE id = ?", [id]);
}

/** Subscriptions of people who still belong to the house, however they joined. */
export async function subscriptionsForHouse(houseId: string): Promise<PushSubscriptionRecord[]> {
  const rows = await all<any>(
    `SELECT s.* FROM push_subscriptions s
       JOIN house_members m ON m.user_id = s.user_id
      WHERE m.house_id = ? ORDER BY s.created_at`,
    [houseId],
  );
  return rows.map(serializeSubscription);
}

export interface PushFanout {
  total: number;
  sent: number;
  failed: number;
  /** Dead subscriptions deleted after a 404/410 from the push service. */
  removed: number;
  statusCode: number | null;
  error: string | null;
}

/** Send one payload to every subscription and drop the ones the service retired. */
export async function sendPushToSubscriptions(
  subscriptions: PushSubscriptionRecord[],
  payload: PushPayload,
): Promise<PushFanout> {
  const send = senderOverride ?? networkSender;
  const body = JSON.stringify({
    title: truncate(payload.title, 120),
    body: truncate(payload.body, 240),
    url: /^\/(?![\/\\])/.test(payload.url) ? truncate(payload.url, 300) : "/notifications",
  });
  let sent = 0;
  let failed = 0;
  let removed = 0;
  let statusCode: number | null = null;
  let error: string | null = null;
  for (const subscription of subscriptions) {
    let result: PushDeliveryResult;
    try {
      result = await send(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        body,
      );
    } catch (failure) {
      result = { ok: false, statusCode: null, expired: false, error: failure instanceof Error ? failure.message : "Push delivery failed" };
    }
    if (result.ok) {
      sent += 1;
      statusCode = result.statusCode ?? statusCode;
      await run("UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?", [now(), subscription.id]);
      continue;
    }
    failed += 1;
    statusCode = result.statusCode ?? statusCode;
    error ??= result.error;
    if (result.expired) {
      await deleteSubscription(subscription.id);
      removed += 1;
    }
  }
  return { total: subscriptions.length, sent, failed, removed, statusCode, error };
}

/** Catch-all redirect for reminders that do not point at a single item. */
export const DEFAULT_PUSH_URL = "/notifications";

export async function sendPushToUser(userId: string, payload: PushPayload): Promise<PushFanout> {
  return await sendPushToSubscriptions(await listSubscriptions(userId), payload);
}

export async function sendPushToHouse(houseId: string, payload: PushPayload): Promise<PushFanout> {
  return await sendPushToSubscriptions(await subscriptionsForHouse(houseId), payload);
}
