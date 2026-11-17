import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { get, parseJson } from "../db.js";
import { handler, parseBody, requireHouse } from "../http.js";
import {
  deletePosoKaneiRetailer,
  listPosoKaneiRetailerSettings,
  upsertPosoKaneiRetailer,
} from "../services/posokanei-retailers.js";

export const posoKaneiRoutes = Router();
posoKaneiRoutes.use(requireAuth);

async function houseSettings(houseId: string): Promise<Record<string, any>> {
  const house = await get<any>("SELECT settings FROM houses WHERE id = ?", [houseId]);
  return parseJson<Record<string, any>>(house?.settings, {});
}

const retailerBody = z.object({
  retailer: z.string().trim().min(1).max(120),
  vendorId: z.string().trim().min(1).max(60).nullish(),
});

posoKaneiRoutes.get(
  "/:houseId/posokanei/retailers",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    // Settings remain accessible while lookups are disabled so an admin can
    // review and prepare existing shop mappings before enabling the feature.
    res.json(await listPosoKaneiRetailerSettings(houseId, await houseSettings(houseId)));
  }),
);

posoKaneiRoutes.put(
  "/:houseId/posokanei/retailers",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "admin");
    const body = parseBody(retailerBody, req.body);
    res.json({
      retailer: await upsertPosoKaneiRetailer(houseId, body.retailer, body.vendorId ?? null),
    });
  }),
);

posoKaneiRoutes.delete(
  "/:houseId/posokanei/retailers/:retailerKey",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "admin");
    await deletePosoKaneiRetailer(houseId, String(req.params.retailerKey));
    res.json({ ok: true });
  }),
);
