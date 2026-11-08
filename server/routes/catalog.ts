import { Router } from "express";
import { z } from "zod";
import { all, get } from "../db.js";
import { memberRole, requireAuth } from "../auth.js";
import { ApiError, handler, intParam, parseBody, requireInstanceAdmin } from "../http.js";
import {
  fetchOffProduct,
  getCachedOffPayload,
  offProductFromRow,
  searchOffProducts,
} from "../services/openfoodfacts.js";
import {
  catalogStats,
  exportCatalogMappings,
  importCatalogMappings,
  listCatalogMappings,
  syncProductCatalog,
} from "../services/product-catalog.js";
import { productAliasKey } from "../services/product-aliases.js";
import type { OffSearchResult } from "../../shared/types.js";

export const catalogRoutes = Router();
catalogRoutes.use(requireAuth);

async function localProducts(query: string, limit: number) {
  const q = String(query ?? "").trim();
  if (!q) return [];
  const rows = await all<any>(
    `SELECT * FROM catalog_products
     WHERE lower(name) LIKE lower(?) OR lower(brand) LIKE lower(?) OR lower(code) LIKE lower(?)
     ORDER BY updated_at DESC LIMIT ?`,
    [`%${q}%`, `%${q}%`, `%${q}%`, Math.min(limit, 20)],
  );
  return rows.map(offProductFromRow).filter(Boolean);
}

/**
 * Search the shared cache first, then OpenFoodFacts by name. The picker sets
 * `online=0` when it only wants instant local results.
 */
catalogRoutes.get(
  "/search",
  handler(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    const online = String(req.query.online ?? "1") !== "0";
    const limit = intParam(req.query.limit, 8, 20);
    const cached = await localProducts(q, limit);
    let products = cached;
    let warning: string | null = null;
    let warningCode: OffSearchResult["warningCode"] = null;
    let usedOnline = false;

    if (online && q.length >= 3) {
      const remote = await searchOffProducts(q, limit);
      usedOnline = remote.length > 0;
      if (remote.length) {
        const byCode = new Map<string, any>();
        for (const product of [...cached, ...remote]) {
          if (product?.code && !byCode.has(product.code)) byCode.set(product.code, product);
        }
        products = [...byCode.values()].slice(0, limit);
      } else if (!cached.length) {
        // Preserve the legacy display text for API consumers; clients localize warningCode.
        warning = "Nothing found on OpenFoodFacts. Check the name or paste a barcode.";
        warningCode = "NOTHING_FOUND";
      }
    }

    const result: OffSearchResult = { products: products as any, online: usedOnline, warning, warningCode };
    res.json(result);
  }),
);

catalogRoutes.get(
  "/product/:code",
  handler(async (req, res) => {
    const code = String(req.params.code ?? "").trim();
    if (!code) throw new ApiError(400, "Missing barcode");
    const product = await fetchOffProduct(code);
    if (!product) throw new ApiError(404, "Product not found on OpenFoodFacts");
    const full = String(req.query.full ?? "") === "1";
    res.json(full ? { ...product, payload: await getCachedOffPayload(product.code) } : product);
  }),
);

catalogRoutes.get(
  "/mappings",
  handler(async (req, res) => {
    requireInstanceAdmin(req);
    const limit = intParam(req.query.limit, 100, 500);
    res.json(await listCatalogMappings(String(req.query.q ?? ""), limit));
  }),
);

catalogRoutes.get(
  "/stats",
  handler(async (req, res) => {
    requireInstanceAdmin(req);
    res.json(await catalogStats());
  }),
);

catalogRoutes.get(
  "/export",
  handler(async (req, res) => {
    requireInstanceAdmin(req);
    const data = await exportCatalogMappings();
    res.setHeader("content-disposition", 'attachment; filename="svault-openfoodfacts-catalog.json"');
    res.json(data);
  }),
);

const importBody = z.object({
  version: z.number().optional(),
  generatedAt: z.string().max(40).optional(),
  mappings: z.array(z.record(z.string(), z.any())).max(20000),
});

catalogRoutes.post(
  "/import",
  handler(async (req, res) => {
    requireInstanceAdmin(req);
    const body = parseBody(importBody, req.body);
    res.json(await importCatalogMappings(body));
  }),
);

catalogRoutes.post(
  "/sync",
  handler(async (req, res) => {
    requireInstanceAdmin(req);
    const body = parseBody(
      z.object({
        url: z.string().trim().url().max(500).optional(),
      }),
      req.body ?? {},
    );
    try {
      const result = await syncProductCatalog(body.url);
      res.json(result);
    } catch (error) {
      throw new ApiError(502, error instanceof Error ? error.message : "Catalogue sync failed");
    }
  }),
);

/** Resolve one raw receipt line, used by clients that want to preview a match. */
catalogRoutes.get(
  "/resolve",
  handler(async (req, res) => {
    const raw = String(req.query.raw ?? "").trim();
    if (!raw) throw new ApiError(400, "Missing raw text");
    // Shared rows for everyone; a house's learned rows only for its members.
    const houseId = typeof req.query.houseId === "string" ? req.query.houseId : "";
    const member = houseId ? Boolean(await memberRole(req.user!.id, houseId)) : false;
    const mapping = await get<any>(
      `SELECT * FROM catalog_mappings
       WHERE (raw_key = ? OR raw_text = ?) AND house_id IN ('', ?)
       ORDER BY CASE WHEN house_id = '' THEN 1 ELSE 0 END, uses DESC LIMIT 1`,
      [productAliasKey(raw), raw, member ? houseId : ""],
    );
    if (!mapping) {
      res.json({ mapping: null });
      return;
    }
    const product = mapping.off_code ? await get<any>("SELECT * FROM catalog_products WHERE code = ?", [mapping.off_code]) : null;
    res.json({
      mapping: {
        country: mapping.country,
        vendor: mapping.vendor_label,
        offCode: mapping.off_code,
        name: mapping.name,
        brand: mapping.brand,
        unit: mapping.unit,
        source: mapping.source,
        confidence: Number(mapping.confidence ?? 0),
        uses: Number(mapping.uses ?? 0),
      },
      product: product ? offProductFromRow(product) : null,
    });
  }),
);
