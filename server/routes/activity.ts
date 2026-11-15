import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { ApiError, handler, parseBody, requireHouse } from "../http.js";
import {
  ACTIVITY_KINDS,
  activityBound,
  decodeActivityCursor,
  houseActivity,
} from "../services/activity.js";
import type { ActivityKind } from "../../shared/types.js";

export const activityRoutes = Router();
activityRoutes.use(requireAuth);

/**
 * Query strings arrive as strings (or an array when a key repeats). `kind` also
 * accepts a comma-separated list, so `?kind=stock.add,receipt.saved` and
 * `?kind=stock.add&kind=receipt.saved` mean the same thing.
 */
const activityQuery = z.object({
  before: z.string().trim().max(200).optional(),
  limit: z.string().trim().max(12).optional(),
  member: z.string().trim().max(60).optional(),
  kind: z.union([z.string().max(400), z.array(z.string().max(80))]).optional(),
  itemId: z.string().trim().max(60).optional(),
  locationId: z.string().trim().max(60).optional(),
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
});

function limitParam(value: string | undefined): number {
  if (value === undefined || value === "") return 30;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ApiError(400, "limit must be a number");
  return Math.min(Math.max(Math.floor(parsed), 1), 100);
}

function requestedKinds(value: string | string[] | undefined): ActivityKind[] | null {
  const raw = value === undefined ? [] : Array.isArray(value) ? value : value.split(",");
  const kinds = [...new Set(raw.map((entry) => entry.trim()).filter(Boolean))];
  if (!kinds.length) return null;
  const unknown = kinds.filter((kind) => !(ACTIVITY_KINDS as string[]).includes(kind));
  if (unknown.length) throw new ApiError(400, "Unknown activity kind", { kinds: unknown });
  return kinds as ActivityKind[];
}

function optionalId(value: string | undefined): string | null {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 60) : null;
}

activityRoutes.get(
  "/:houseId/activity",
  handler(async (req, res) => {
    // Viewers may read the timeline; it is read-only and never exposes another
    // house's rows because every source is filtered by house_id.
    const { houseId } = await requireHouse(req, "viewer");
    const query = parseBody(activityQuery, req.query);
    res.json(
      await houseActivity({
        houseId,
        limit: limitParam(query.limit),
        memberId: optionalId(query.member),
        kinds: requestedKinds(query.kind),
        itemId: optionalId(query.itemId),
        locationId: optionalId(query.locationId),
        from: activityBound(query.from, false),
        to: activityBound(query.to, true),
        cursor: decodeActivityCursor(query.before),
      }),
    );
  }),
);
