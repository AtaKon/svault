import { Router } from "express";
import { z } from "zod";
import { all, get } from "../db.js";
import { requireAuth } from "../auth.js";
import { ApiError, handler, intParam, parseBody } from "../http.js";
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

function requireInstanceAdmin(req: any) {
  if (!req.user?.isAdmin) throw new ApiError(403, "Requires the instance administrator");
}

function localProducts(query: string, limit: number) {
  const q = String(query ?? "").trim();
  if (!q) return [];
  const rows = all<any>(
    `SELECT * FROM catalog_products
     WHERE name LIKE ? OR brand LIKE ? OR code LIKE ?
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
    const cached = localProducts(q, limit);
    let products = cached;
    let warning: string | null = null;
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
        warning = "Nothing found on OpenFoodFacts. Check the name or paste a barcode.";
      }
    }

    const result: OffSearchResult = { products: products as any, online: usedOnline, warning };
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
    res.json(full ? { ...product, payload: getCachedOffPayload(product.code) } : product);
  }),
);

catalogRoutes.get(
  "/mappings",
  handler((req, res) => {
    requireInstanceAdmin(req);
    const limit = intParam(req.query.limit, 100, 500);
    res.json(listCatalogMappings(String(req.query.q ?? ""), limit));
  }),
);

catalogRoutes.get(
  "/stats",
  handler((req, res) => {
    requireInstanceAdmin(req);
    res.json(catalogStats());
  }),
);

catalogRoutes.get(
  "/export",
  handler((req, res) => {
    requireInstanceAdmin(req);
    const data = exportCatalogMappings();
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
  handler((req, res) => {
    requireInstanceAdmin(req);
    const body = parseBody(importBody, req.body);
    res.json(importCatalogMappings(body));
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
  handler((req, res) => {
    const raw = String(req.query.raw ?? "").trim();
    if (!raw) throw new ApiError(400, "Missing raw text");
    const mapping = get<any>(
      `SELECT * FROM catalog_mappings
       WHERE raw_key = ? OR raw_text = ? ORDER BY uses DESC LIMIT 1`,
      [productAliasKey(raw), raw],
    );
    if (!mapping) {
      res.json({ mapping: null });
      return;
    }
    const product = mapping.off_code ? get<any>("SELECT * FROM catalog_products WHERE code = ?", [mapping.off_code]) : null;
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
