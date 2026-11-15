import { Router } from "express";
import { requireAuth } from "../auth.js";
import { handler, requireHouse } from "../http.js";
import { recipeCostSummaries } from "../services/recipe-cost.js";

/**
 * Cost-per-portion for the recipe list. The breakdown per ingredient stays on
 * the recipe detail response, so this endpoint returns one compact row per
 * recipe and one set of price queries for the whole house.
 */
export const recipeCostRoutes = Router();
recipeCostRoutes.use(requireAuth);

recipeCostRoutes.get(
  "/:houseId/recipes/costs",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    res.json(await recipeCostSummaries(houseId, req.query.basis));
  }),
);
