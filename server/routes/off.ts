import { Router } from "express";
import { requireAuth } from "../auth.js";
import { ApiError, handler } from "../http.js";
import { fetchOffProduct, getCachedOffPayload } from "../services/openfoodfacts.js";
import { isOffProjectId, offProjectList } from "../services/off/projects.js";
import type { OffProjectId } from "../../shared/types.js";

/**
 * Multi-project Open Food Facts reads.
 *
 * `/api/catalog/*` stays for existing clients. These routes are the forward
 * surface: they expose the project registry and a lookup that can route to
 * whichever database owns the barcode.
 */

export const offRoutes = Router();
offRoutes.use(requireAuth);

function projectParam(value: unknown): OffProjectId | "all" {
  const text = String(value ?? "").trim();
  if (text === "all") return "all";
  return isOffProjectId(text) ? text : "all";
}

offRoutes.get(
  "/projects",
  handler(async (_req, res) => {
    res.json({ projects: offProjectList() });
  }),
);

offRoutes.get(
  "/lookup/:code",
  handler(async (req, res) => {
    const code = String(req.params.code ?? "").trim();
    if (!code) throw new ApiError(400, "Missing barcode");
    const project = projectParam(req.query.project);
    const product = await fetchOffProduct(code, { project });
    if (!product) throw new ApiError(404, "Product not found on OpenFoodFacts");
    res.json({ product, project: product.project });
  }),
);

offRoutes.get(
  "/product/:project/:code",
  handler(async (req, res) => {
    const project = projectParam(req.params.project);
    if (project === "all") throw new ApiError(400, "Choose a project for a full product read");
    const code = String(req.params.code ?? "").trim();
    if (!code) throw new ApiError(400, "Missing barcode");
    const product = await fetchOffProduct(code, { project });
    if (!product) throw new ApiError(404, "Product not found on OpenFoodFacts");
    const full = String(req.query.full ?? "") === "1";
    res.json(full ? { ...product, payload: await getCachedOffPayload(product.code, product.project) } : product);
  }),
);
