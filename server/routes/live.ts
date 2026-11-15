import { Router } from "express";
import { memberRole, requireAuth } from "../auth.js";
import { handler, requireHouse } from "../http.js";
import { LIVE_UPDATES, LiveLimitError, subscribeLive } from "../services/live.js";
import type { LiveEvent } from "../../shared/types.js";

/**
 * Server-Sent Events feed for one house.
 *
 * One connection carries invalidations for every data area in the house; the
 * client filters by `type`. Membership is checked again on a timer so removing
 * someone from a house closes their stream within a minute instead of waiting
 * for the next request. API tokens are read-only automation credentials and are
 * not accepted here: a live stream is a browser session feature.
 */
export const liveRoutes = Router();
liveRoutes.use(requireAuth);

const positive = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const HEARTBEAT_MS = positive(process.env.LIVE_HEARTBEAT_MS, 25_000);
const MEMBERSHIP_CHECK_MS = positive(process.env.LIVE_MEMBERSHIP_CHECK_MS, 60_000);
const RETRY_MS = positive(process.env.LIVE_RETRY_MS, 5_000);

let eventSequence = 0;

liveRoutes.get(
  "/:houseId/events",
  handler(async (req, res) => {
    if (!LIVE_UPDATES) {
      res.status(404).json({ error: "Live updates are disabled" });
      return;
    }
    if (req.apiTokenReadOnly) {
      res.status(403).json({ error: "Live updates need a signed-in session" });
      return;
    }
    const { houseId } = await requireHouse(req);
    const userId = req.user!.id;

    let subscription;
    try {
      subscription = subscribeLive({
        houseId,
        userId,
        onEvent: (event: LiveEvent) => {
          if (res.writableEnded) return;
          eventSequence += 1;
          res.write(`id: ${eventSequence}\ndata: ${JSON.stringify(event)}\n\n`);
        },
      });
    } catch (error) {
      if (error instanceof LiveLimitError) {
        res.setHeader("Retry-After", "30");
        res.status(429).json({
          error:
            error.scope === "user"
              ? "Too many live update tabs are open for this account"
              : "Too many live update connections for this house",
        });
        return;
      }
      throw error;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    // no-transform also asks proxies not to gzip the stream, which would
    // buffer events until the compression window flushes.
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(`retry: ${RETRY_MS}\n\n`);
    res.write(": connected\n\n");

    let closed = false;
    let heartbeat: NodeJS.Timeout | undefined;
    let membership: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      subscription.close();
      if (heartbeat) clearInterval(heartbeat);
      if (membership) clearInterval(membership);
      if (!res.writableEnded && !res.destroyed) res.end();
    };

    heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(": heartbeat\n\n");
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    membership = setInterval(() => {
      if (closed) return;
      void memberRole(userId, houseId)
        .then((role) => {
          if (!role && !closed) {
            cleanup();
          }
        })
        .catch(() => {
          /* A transient database error must not drop a valid stream. */
        });
    }, MEMBERSHIP_CHECK_MS);
    membership.unref?.();

    req.on("close", cleanup);
    res.on("close", cleanup);
  }),
);
