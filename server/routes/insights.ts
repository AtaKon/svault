import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { ApiError, handler, parseBody, requireHouse } from "../http.js";
import { limitRequests, limiters, userOrIp } from "../rate-limit.js";
import { all, get, parseJson } from "../db.js";
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

insightRoutes.get(
  "/:houseId/insights/spend",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    res.json(await spendInsight(houseId, Number(req.query.months ?? 6)));
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
