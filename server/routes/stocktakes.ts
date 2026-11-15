import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { handler, intParam, parseBody, requireHouse } from "../http.js";
import {
  cancelStocktake,
  commitStocktake,
  createStocktake,
  listStocktakes,
  stocktakeDetail,
  updateStocktakeLine,
} from "../services/stocktake.js";

export const stocktakeRoutes = Router();
stocktakeRoutes.use(requireAuth);

const createBody = z.object({
  locationId: z.string().trim().min(1).max(60).nullish(),
  categoryId: z.string().trim().min(1).max(60).nullish(),
  note: z.string().trim().max(300).nullish(),
});

const lineBody = z
  .object({
    countedQty: z.number().min(0).max(1e9).nullish(),
    note: z.string().trim().max(300).nullish(),
  })
  .refine((body) => body.countedQty !== undefined || body.note !== undefined, {
    message: "Nothing to update",
  });

const commitBody = z.object({
  lineIds: z.array(z.string().min(1).max(60)).max(5000).optional(),
  confirmChangedLineIds: z.array(z.string().min(1).max(60)).max(5000).optional(),
});

stocktakeRoutes.get(
  "/:houseId/stocktakes",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    res.json({ stocktakes: await listStocktakes(houseId, intParam(req.query.limit, 50, 200)) });
  }),
);

stocktakeRoutes.get(
  "/:houseId/stocktakes/:stocktakeId",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    res.json({ stocktake: await stocktakeDetail(houseId, String(req.params.stocktakeId)) });
  }),
);

stocktakeRoutes.post(
  "/:houseId/stocktakes",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(createBody, req.body ?? {});
    const stocktakeId = await createStocktake({
      houseId,
      userId: req.user!.id,
      locationId: body.locationId ?? null,
      categoryId: body.categoryId ?? null,
      note: body.note ?? null,
    });
    res.status(201).json({ stocktake: await stocktakeDetail(houseId, stocktakeId) });
  }),
);

stocktakeRoutes.patch(
  "/:houseId/stocktakes/:stocktakeId/lines/:lineId",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(lineBody, req.body ?? {});
    res.json({
      line: await updateStocktakeLine({
        houseId,
        stocktakeId: String(req.params.stocktakeId),
        lineId: String(req.params.lineId),
        userId: req.user!.id,
        countedQty: body.countedQty,
        note: body.note,
      }),
    });
  }),
);

stocktakeRoutes.post(
  "/:houseId/stocktakes/:stocktakeId/commit",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(commitBody, req.body ?? {});
    res.json(
      await commitStocktake({
        houseId,
        stocktakeId: String(req.params.stocktakeId),
        userId: req.user!.id,
        lineIds: body.lineIds,
        confirmChangedLineIds: body.confirmChangedLineIds,
      }),
    );
  }),
);

stocktakeRoutes.post(
  "/:houseId/stocktakes/:stocktakeId/cancel",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    await cancelStocktake({ houseId, stocktakeId: String(req.params.stocktakeId) });
    res.json({ stocktake: await stocktakeDetail(houseId, String(req.params.stocktakeId)) });
  }),
);
