import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { ApiError, handler, parseBody, requireHouse } from "../http.js";
import { limitRequests, limiters, userOrIp } from "../rate-limit.js";
import { all, get, lockHouseholdLedger, newId, now, parseJson, tx } from "../db.js";
import { lookupPosoKaneiBarcode, PosoKaneiUnavailableError } from "../services/posokanei.js";
import { shoppingRow } from "../services/shopping.js";
import {
  householdInsight,
  priceAlerts,
  saveInsightSettings,
  scanPriceAlerts,
  shoppingPriceHints,
  spendInsight,
  useItUp,
  wasteInsight,
} from "../services/insights.js";

export const insightRoutes = Router();
insightRoutes.use(requireAuth);

export function posoKaneiUnavailableApiError(
  error: PosoKaneiUnavailableError,
  res: Pick<Response, "setHeader">,
): ApiError {
  if (error.retryAfterSeconds) res.setHeader("Retry-After", String(error.retryAfterSeconds));
  return new ApiError(
    502,
    "External price lookup is unavailable. Try again later.",
    error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : undefined,
  );
}

export function createShoppingOffersHandler(
  lookup: typeof lookupPosoKaneiBarcode = lookupPosoKaneiBarcode,
) {
  return handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const house = await get<any>("SELECT settings FROM houses WHERE id = ?", [houseId]);
    if (!house) throw new ApiError(404, "House not found");
    const settings = parseJson<Record<string, any>>(house?.settings, {});
    if (settings.priceLookup?.enabled !== true) throw new ApiError(404, "External price lookup is disabled");

    const line = await shoppingRow(houseId, String(req.params.lineId));
    if (!line || line.checked) throw new ApiError(404, "Open shopping line not found");
    if (!line.item_id) throw new ApiError(400, "Link this shopping line to an inventory item first");
    const item = await get<any>(
      "SELECT id FROM items WHERE id = ? AND house_id = ? AND archived = 0",
      [line.item_id, houseId],
    );
    if (!item) throw new ApiError(404, "Inventory item not found");
    const barcodes = await all<any>(
      "SELECT code FROM item_barcodes WHERE item_id = ? AND house_id = ? ORDER BY created_at, id",
      [item.id, houseId],
    );
    const validCodes = barcodes
      .map((row: any) => String(row.code ?? "").trim())
      .filter((code: string) => /^\d{8,14}$/.test(code));
    if (!validCodes.length) throw new ApiError(400, "Add a valid barcode to this inventory item first");

    try {
      const offers = await lookup(validCodes[0], req.user!.id);
      res.json({ barcode: validCodes[0], offers });
    } catch (error) {
      if (error instanceof PosoKaneiUnavailableError) {
        throw posoKaneiUnavailableApiError(error, res);
      }
      throw error;
    }
  });
}

const settingsBody = z.object({
  monthlyBudget: z.number().min(0).max(1e9).optional(),
  priceAlertPercent: z.number().min(1).max(500).optional(),
  useItUpDays: z.number().int().min(1).max(60).optional(),
});

const settlementBody = z.object({
  idempotencyKey: z.string().uuid(),
  fromUserId: z.string().min(1).max(60),
  toUserId: z.string().min(1).max(60),
  amount: z.number().finite().positive().max(1e9).refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
    "Enter an amount in whole cents",
  ),
});

insightRoutes.get(
  "/:houseId/insights/spend",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    res.json(await spendInsight(houseId, Number(req.query.months ?? 6)));
  }),
);

insightRoutes.post(
  "/:houseId/insights/settlements",
  limitRequests(limiters.insights, userOrIp, "Too many settlement requests. Try again later."),
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(settlementBody, req.body);
    const amount = body.amount;
    if (body.fromUserId === body.toUserId) throw new ApiError(400, "Choose two different household members");
    const result = await tx(async (session) => {
      // Lock the house before reading. Receipt, bill, membership, and other
      // settlement writes use the same lock before changing the household ledger.
      if (!await lockHouseholdLedger(session, houseId)) throw new ApiError(404, "House not found");
      const amountCents = Math.round(amount * 100);
      const prior = await session.get<{
        from_user_id: string;
        to_user_id: string;
        amount_cents: number;
        created_by: string;
      }>(
        `SELECT from_user_id, to_user_id, amount_cents, created_by
         FROM household_settlement_requests WHERE house_id = ? AND idempotency_key = ?`,
        [houseId, body.idempotencyKey],
      );
      if (prior) {
        if (prior.from_user_id !== body.fromUserId || prior.to_user_id !== body.toUserId ||
            Number(prior.amount_cents) !== amountCents || prior.created_by !== req.user!.id) {
          throw new ApiError(409, "This idempotency key was already used for a different payment");
        }
        return { insight: await householdInsight(houseId, session), replayed: true };
      }
      const memberIds = new Set((await session.all<{ user_id: string }>(
        "SELECT user_id FROM house_members WHERE house_id = ?",
        [houseId],
      )).map((row) => row.user_id));
      if (!memberIds.has(body.fromUserId) || !memberIds.has(body.toUserId)) {
        throw new ApiError(400, "Both people must be members of this house");
      }
      const current = await householdInsight(houseId, session);
      const suggested = current.settlements.find(
        (entry) => entry.fromUserId === body.fromUserId && entry.toUserId === body.toUserId,
      );
      if (!suggested) {
        throw new ApiError(400, "There is no outstanding payment between these people");
      }
      const suggestedAmountCents = Math.round(suggested.amount * 100);
      if (amountCents > suggestedAmountCents) {
        throw new ApiError(400, "The payment cannot be greater than the current amount to settle");
      }
      const settlementId = newId("hst");
      await session.run(
        `INSERT INTO household_settlements (id, house_id, from_user_id, to_user_id, amount, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [settlementId, houseId, body.fromUserId, body.toUserId, amountCents / 100, req.user!.id, now()],
      );
      await session.run(
        `INSERT INTO household_settlement_requests
         (house_id, idempotency_key, settlement_id, from_user_id, to_user_id, amount_cents, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [houseId, body.idempotencyKey, settlementId, body.fromUserId, body.toUserId, amountCents, req.user!.id, now()],
      );
      return { insight: await householdInsight(houseId, session), replayed: false };
    }, { writeLock: true });
    res.status(result.replayed ? 200 : 201).json(result.insight);
  }),
);

insightRoutes.get(
  "/:houseId/insights/waste",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    res.json(await wasteInsight(houseId, Number(req.query.months ?? 6)));
  }),
);

insightRoutes.get(
  "/:houseId/insights/price-alerts",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    res.json({ alerts: await priceAlerts(houseId) });
  }),
);

insightRoutes.post(
  "/:houseId/insights/price-alerts/scan",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    res.json({ created: await scanPriceAlerts(houseId), alerts: await priceAlerts(houseId) });
  }),
);

insightRoutes.get(
  "/:houseId/insights/use-it-up",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    res.json(await useItUp(houseId, req.query.days == null ? undefined : Number(req.query.days)));
  }),
);

insightRoutes.get(
  "/:houseId/insights/shopping-prices",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    res.json({ hints: await shoppingPriceHints(houseId) });
  }),
);

insightRoutes.get(
  "/:houseId/insights/shopping-offers/:lineId",
  limitRequests(limiters.posokaneiRequests, userOrIp, "Too many price lookup requests. Try again later."),
  createShoppingOffersHandler(),
);

insightRoutes.get(
  "/:houseId/insights/household",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    res.json(await householdInsight(houseId));
  }),
);

insightRoutes.patch(
  "/:houseId/insights/settings",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "admin");
    const body = parseBody(settingsBody, req.body ?? {});
    res.json(await saveInsightSettings(houseId, body));
  }),
);
