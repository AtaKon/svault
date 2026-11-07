import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { handler, parseBody, requireHouse } from "../http.js";
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
