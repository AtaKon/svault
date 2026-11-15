import { Router } from "express";
import { z } from "zod";
import { handler, intParam, parseBody, requireHouse } from "../http.js";
import { requireAuth } from "../auth.js";
import { dismissDuplicatePair, findDuplicateGroups } from "../services/item-duplicates.js";
import { mergeItems, previewItemMerge } from "../services/item-merge.js";

export const itemMergeRoutes = Router();
itemMergeRoutes.use(requireAuth);

const pairBody = z.object({
  pairs: z
    .array(
      z.object({
        a: z.string().trim().min(1).max(60),
        b: z.string().trim().min(1).max(60),
      }),
    )
    .min(1)
    .max(50),
});

itemMergeRoutes.get(
  "/:houseId/items/duplicates",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    const limit = intParam(req.query.limit, 60, 200);
    res.json(await findDuplicateGroups(houseId, { limit }));
  }),
);

itemMergeRoutes.post(
  "/:houseId/items/duplicates/dismiss",
  handler(async (req, res) => {
    // Suggestions are house-wide, so dismissing one changes what everyone sees.
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(pairBody, req.body);
    const dismissed: { itemA: string; itemB: string }[] = [];
    for (const pair of body.pairs) {
      dismissed.push(
        await dismissDuplicatePair({
          houseId,
          itemId: pair.a,
          otherItemId: pair.b,
          userId: req.user!.id,
        }),
      );
    }
    res.json({ dismissed });
  }),
);

itemMergeRoutes.post(
  "/:houseId/items/:targetId/merge",
  handler(async (req, res) => {
    // Same rule as editing an item: members and above.
    const { houseId } = await requireHouse(req, "member");
    const targetId = String(req.params.targetId);
    const body = parseBody(
      z.object({
        sourceIds: z.array(z.string().trim().min(1).max(60)).min(1).max(20),
        dryRun: z.boolean().optional(),
      }),
      req.body,
    );
    const sourceIds = [...new Set(body.sourceIds)];
    if (body.dryRun) {
      res.json(await previewItemMerge(houseId, targetId, sourceIds));
      return;
    }
    res.json(await mergeItems({ houseId, targetId, sourceIds, userId: req.user!.id }));
  }),
);
