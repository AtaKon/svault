import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { handler, parseBody, requireHouse } from "../http.js";
import { freezerView } from "../services/freezer.js";
import { syncHouseExpiry } from "../services/notifications.js";
import { afterStockChange, freezeStock, takeOutPortions, thawStock } from "../services/stock.js";

export const freezerRoutes = Router();
freezerRoutes.use(requireAuth);

const target = z.object({
  itemId: z.string().trim().min(1).max(60),
  lotId: z.string().trim().min(1).max(60),
});

const date = z.iso.date();

/** What is in the freezer, grouped by place on the client and ordered by eat-by. */
freezerRoutes.get(
  "/:houseId/freezer",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    res.json(await freezerView(houseId));
  }),
);

/**
 * Freeze all or part of a batch. A partial freeze splits it, so the unfrozen
 * remainder keeps its own place and printed date.
 */
freezerRoutes.post(
  "/:houseId/freezer/freeze",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(
      target.extend({
        portions: z.number().positive().max(1e6).nullish(),
        locationId: z.string().trim().min(1).max(60).nullish(),
        frozenOn: date.optional(),
      }),
      req.body,
    );
    const lotId = await freezeStock({
      itemId: body.itemId,
      houseId,
      userId: req.user!.id,
      lotId: body.lotId,
      portions: body.portions,
      locationId: body.locationId,
      frozenOn: body.frozenOn,
    });
    await afterStockChange(body.itemId);
    await syncHouseExpiry(houseId);
    res.json({ ok: true, lotId });
  }),
);

/** Mark a frozen batch thawed: expiry switches to the short thaw window. */
freezerRoutes.post(
  "/:houseId/freezer/thaw",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(
      target.extend({
        thawedOn: date.optional(),
        locationId: z.string().trim().min(1).max(60).nullish(),
      }),
      req.body,
    );
    await thawStock({
      itemId: body.itemId,
      houseId,
      userId: req.user!.id,
      lotId: body.lotId,
      thawedOn: body.thawedOn,
      locationId: body.locationId,
    });
    await afterStockChange(body.itemId);
    await syncHouseExpiry(houseId);
    res.json({ ok: true, lotId: body.lotId });
  }),
);

/** Take one portion (or more) out of the freezer through the stock service. */
freezerRoutes.post(
  "/:houseId/freezer/take-out",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(
      target.extend({
        portions: z.number().positive().max(1e6).optional(),
        thaw: z.boolean().optional(),
      }),
      req.body,
    );
    await takeOutPortions({
      itemId: body.itemId,
      houseId,
      userId: req.user!.id,
      lotId: body.lotId,
      portions: body.portions,
      thaw: body.thaw,
    });
    await afterStockChange(body.itemId);
    await syncHouseExpiry(houseId);
    res.json({ ok: true, lotId: body.lotId });
  }),
);
