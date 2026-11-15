import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { ApiError, handler, parseBody } from "../http.js";
import {
  DEFAULT_PUSH_URL,
  listSubscriptions,
  pushEnabled,
  pushPublicKey,
  sendPushToUser,
  subscribeUser,
  unsubscribeUser,
} from "../services/web-push.js";

/**
 * Web Push endpoints. Subscription changes are per signed-in user: every route
 * here needs a session, and a user can only see or change their own devices.
 * Push itself is only sent by the reminder delivery channel, never by a client
 * telling the server to notify someone else.
 */
export const pushRoutes = Router();
pushRoutes.use(requireAuth);

const subscriptionSchema = z
  .object({
    endpoint: z.string().trim().min(1).max(2000),
    keys: z.object({
      p256dh: z.string().trim().min(1).max(200),
      auth: z.string().trim().min(1).max(100),
    }),
  })
  .strict();

/** Push services are always HTTPS. A local http:// endpoint is not a real one. */
function httpsEndpoint(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ApiError(400, "The push endpoint is not a valid URL");
  }
  if (parsed.protocol !== "https:") throw new ApiError(400, "The push endpoint must use https");
  return parsed.toString();
}

function requirePushEnabled(): void {
  if (!pushEnabled()) throw new ApiError(400, "Web Push is not configured on this server");
}

pushRoutes.get(
  "/",
  handler(async (req, res) => {
    const subscriptions = await listSubscriptions(req.user!.id);
    res.json({
      enabled: pushEnabled(),
      publicKey: pushPublicKey(),
      subscriptions: subscriptions.map((subscription) => ({
        id: subscription.id,
        createdAt: subscription.createdAt,
        userAgent: subscription.userAgent,
      })),
    });
  }),
);

pushRoutes.post(
  "/subscribe",
  handler(async (req, res) => {
    requirePushEnabled();
    const body = parseBody(subscriptionSchema, req.body ?? {});
    const subscription = await subscribeUser({
      userId: req.user!.id,
      endpoint: httpsEndpoint(body.endpoint),
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      userAgent: req.get("user-agent") ?? null,
    });
    res.status(201).json({
      subscription: { id: subscription.id, createdAt: subscription.createdAt, userAgent: subscription.userAgent },
    });
  }),
);

pushRoutes.post(
  "/unsubscribe",
  handler(async (req, res) => {
    const body = parseBody(z.object({ endpoint: z.string().trim().min(1).max(2000) }), req.body ?? {});
    // Match what subscribing stored: the normalised URL form when it parses.
    let endpoint = body.endpoint;
    try {
      endpoint = new URL(body.endpoint).toString();
    } catch {
      /* keep the raw value; it is matched literally */
    }
    const removed = await unsubscribeUser(req.user!.id, endpoint);
    res.json({ ok: true, removed });
  }),
);

pushRoutes.post(
  "/test",
  handler(async (req, res) => {
    requirePushEnabled();
    const result = await sendPushToUser(req.user!.id, {
      title: "SVault test",
      body: "Push reminders are working. Low stock and expiring items will arrive here.",
      url: DEFAULT_PUSH_URL,
    });
    if (!result.total) throw new ApiError(400, "Enable push on a device first");
    const ok = result.sent > 0;
    res.status(ok ? 200 : 502).json({
      ok,
      sent: result.sent,
      failed: result.failed,
      removed: result.removed,
      error: ok ? null : (result.error ?? "No device accepted the push"),
    });
  }),
);
