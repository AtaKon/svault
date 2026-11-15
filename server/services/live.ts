import type { RequestHandler, Response } from "express";
import { afterCommit, get } from "../db.js";
import type { LiveEvent, LiveEventType } from "../../shared/types.js";

/**
 * In-process live-update bus and the small write hooks that feed it.
 *
 * SVault has always run as one process, so a broker would be an extra service
 * to deploy. Subscribers are connected browsers; publishers are the stock
 * service and a handful of router middleware. Keeping the surface to
 * `publishLive` / `subscribeLive` means a future PostgreSQL LISTEN/NOTIFY
 * backend can replace the fan-out without changing a single route.
 *
 * Events are deliberately minimal invalidation hints: `type`, an optional
 * entity `id`, `actorUserId` and `at`. No names, quantities or other household
 * data cross this channel; clients refetch through the normal authorized API.
 */

const positiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

/** `LIVE_UPDATES=off` disables the stream and the bus entirely. */
export const LIVE_UPDATES = (process.env.LIVE_UPDATES ?? "on").trim().toLowerCase() !== "off";
export const LIVE_MAX_PER_USER = positiveInt(process.env.LIVE_MAX_PER_USER, 5);
export const LIVE_MAX_PER_HOUSE = positiveInt(process.env.LIVE_MAX_PER_HOUSE, 100);

export class LiveLimitError extends Error {
  scope: "user" | "house";
  constructor(scope: "user" | "house") {
    super(
      scope === "user"
        ? "Too many live update connections for this account"
        : "Too many live update connections for this house",
    );
    this.scope = scope;
  }
}

export interface LiveSubscriberOptions {
  houseId: string;
  userId: string;
  onEvent: (event: LiveEvent) => void;
}

export interface LiveSubscription {
  close: () => void;
}

interface Subscriber extends LiveSubscriberOptions {
  id: number;
}

const subscribers = new Set<Subscriber>();
let nextSubscriberId = 1;

/** Current subscriber count, optionally for one user, used by tests and diagnostics. */
export function liveSubscriberCount(userId?: string): number {
  if (!userId) return subscribers.size;
  let count = 0;
  for (const subscriber of subscribers) {
    if (subscriber.userId === userId) count += 1;
  }
  return count;
}

export function subscribeLive(options: LiveSubscriberOptions): LiveSubscription {
  const existing = [...subscribers].filter((subscriber) => subscriber.userId === options.userId).length;
  if (existing >= LIVE_MAX_PER_USER) throw new LiveLimitError("user");
  const inHouse = [...subscribers].filter((subscriber) => subscriber.houseId === options.houseId).length;
  if (inHouse >= LIVE_MAX_PER_HOUSE) throw new LiveLimitError("house");

  const subscriber: Subscriber = { ...options, id: nextSubscriberId++ };
  subscribers.add(subscriber);
  return {
    close: () => {
      subscribers.delete(subscriber);
    },
  };
}

export interface PublishLiveInput {
  type: LiveEventType;
  id?: string | null;
  actorUserId: string;
  /** ISO timestamp; normally filled in by the bus. */
  at?: string;
}

/**
 * Publish after the current transaction commits, or immediately outside one.
 * A rolled-back write therefore never tells other members to refetch.
 */
export function publishLive(houseId: string, input: PublishLiveInput): void {
  if (!LIVE_UPDATES || !houseId) return;
  const event: LiveEvent = {
    type: input.type,
    ...(input.id ? { id: input.id } : {}),
    actorUserId: input.actorUserId,
    at: input.at ?? new Date().toISOString(),
  };
  afterCommit(() => {
    for (const subscriber of subscribers) {
      if (subscriber.houseId !== houseId) continue;
      try {
        subscriber.onEvent(event);
      } catch (error) {
        console.error("Live update subscriber failed:", error);
      }
    }
  });
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function emitAfterResponse(
  res: Response,
  houseId: string,
  actorUserId: string,
  type: LiveEventType,
): void {
  res.once("finish", () => {
    if (res.statusCode >= 400) return;
    publishLive(houseId, { type, actorUserId });
  });
}

/**
 * Mount on a house-scoped path such as `/api/houses/:houseId/shopping`.
 * Every successful write emits one invalidation event; reads stay silent.
 */
export function liveWriteEvents(type: LiveEventType): RequestHandler {
  return (req, res, next) => {
    if (!LIVE_UPDATES || READ_METHODS.has(req.method)) {
      next();
      return;
    }
    const houseId = String(req.params.houseId ?? "");
    if (!houseId || !req.user) {
      next();
      return;
    }
    emitAfterResponse(res, houseId, req.user.id, type);
    next();
  };
}

const RECORD_TABLES = {
  items: "items",
  recipes: "recipes",
  receipts: "receipts",
  bills: "bills",
} as const;

/**
 * For routers addressed by a single record (`/api/items/:itemId`) rather than
 * a house. The owning house is resolved before the handler so a delete still
 * knows which members to notify.
 */
export function liveRecordEvents(
  type: LiveEventType,
  options: { param: string; table: keyof typeof RECORD_TABLES },
): RequestHandler {
  return async (req, res, next) => {
    if (!LIVE_UPDATES || READ_METHODS.has(req.method) || !req.user) {
      next();
      return;
    }
    const id = String(req.params[options.param] ?? "");
    if (!id) {
      next();
      return;
    }
    try {
      const row = await get<{ house_id: string }>(
        `SELECT house_id FROM ${RECORD_TABLES[options.table]} WHERE id = ?`,
        [id],
      );
      if (row?.house_id) emitAfterResponse(res, row.house_id, req.user.id, type);
    } catch {
      // A missing record is the route's problem to report; it must not break
      // the request here.
    }
    next();
  };
}
