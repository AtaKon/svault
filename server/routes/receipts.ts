import { Router } from "express";
import { z } from "zod";
import { AI_ENV } from "../config.js";
import { all, get, newId, now, parseJson, run, tx } from "../db.js";
import { requireAuth, memberRole, roleAtLeast } from "../auth.js";
import { ApiError, handler, intParam, parseBody, requireHouse } from "../http.js";
import { aiParseReceipt, fileToDataUrl, resolveAi } from "../ai.js";
import { heuristicReceipt, normaliseReceiptDraft } from "../services/receipt-local.js";
import { addStock, afterStockChange } from "../services/stock.js";
import { receiptLinesFor, serializeReceipt, serializeVendor } from "../serialize.js";
import { uploader, uploadPath } from "../upload.js";
import { convert, round } from "../units.js";
import {
  CATALOG_COUNTRIES,
  canonicalVendor,
  catalogById,
  catalogCountries,
  catalogEntries,
  detectCatalogVendor,
  normalizeVendorName,
} from "../services/vendors.js";
import { selectReceiptTemplate } from "../services/receipt-templates.js";
import { findProductAlias, learnProductAlias } from "../services/product-aliases.js";
import { suggestProductMatches } from "../services/product-match.js";
import { fetchOffProduct, getCachedOffProduct, linkItemToOff } from "../services/openfoodfacts.js";
import { findCatalogMapping, learnCatalogMapping } from "../services/product-catalog.js";

export const receiptRoutes = Router();
export const singleReceiptRoutes = Router();

receiptRoutes.use(requireAuth);
singleReceiptRoutes.use(requireAuth);

/* -------------------------------------------------------------------- vendors */

const vendorBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  kind: z.string().trim().max(30).optional(),
  note: z.string().trim().max(300).nullish(),
  catalogId: z.string().max(60).optional(),
});

async function housePurchaseCountry(houseId: string): Promise<string> {
  const house = await get<any>("SELECT settings FROM houses WHERE id = ?", [houseId]);
  const settings = parseJson<Record<string, any>>(house?.settings, {});
  const country = String(settings?.purchases?.country ?? "GR").toUpperCase();
  return CATALOG_COUNTRIES[country] ? country : "GR";
}

async function vendorRow(houseId: string, vendorId: string) {
  return await get<any>("SELECT * FROM vendors WHERE id = ? AND house_id = ?", [vendorId, houseId]);
}

receiptRoutes.get(
  "/:houseId/vendors",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    const rows = await all<any>(
      `SELECT v.*, (SELECT COUNT(*) FROM stock_lots l WHERE l.vendor_id = v.id) AS purchase_count
       FROM vendors v WHERE v.house_id = ? ORDER BY lower(v.name)`,
      [houseId],
    );
    res.json(rows.map(serializeVendor));
  }),
);

receiptRoutes.post(
  "/:houseId/vendors",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(vendorBody, req.body);
    const catalog = body.catalogId ? await catalogById(body.catalogId) : null;
    if (body.catalogId && !catalog) throw new ApiError(400, "That suggested shop does not exist");
    const name = catalog?.name ?? body.name;
    if (!name) throw new ApiError(400, "A shop name is required");
    const existing = await all<any>("SELECT * FROM vendors WHERE house_id = ?", [houseId]);
    const canonicalIds = catalog
      ? new Set(
          (
            await Promise.all(existing.map(async (vendor) => (await canonicalVendor(vendor.name))?.id))
          ).filter(Boolean),
        )
      : null;
    const duplicate =
      existing.find((vendor) => normalizeVendorName(vendor.name) === normalizeVendorName(name)) ||
      (catalog && canonicalIds?.has(catalog.id));
    if (duplicate) throw new ApiError(409, "That shop already exists");
    const id = newId("vnd");
    await run("INSERT INTO vendors (id, house_id, name, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
      id,
      houseId,
      name,
      catalog?.kind ?? body.kind ?? "shop",
      body.note ?? null,
      now(),
    ]);
    res.status(201).json(serializeVendor(await get<any>("SELECT * FROM vendors WHERE id = ?", [id])));
  }),
);

receiptRoutes.patch(
  "/:houseId/vendors/:vendorId",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const current = await vendorRow(houseId, String(req.params.vendorId));
    if (!current) throw new ApiError(404, "Shop not found");
    const body = parseBody(vendorBody.partial(), req.body);
    if (body.name) {
      const other = await all<any>("SELECT * FROM vendors WHERE house_id = ? AND id <> ?", [houseId, current.id]);
      const catalog = await canonicalVendor(body.name);
      let duplicate = other.find((vendor) => normalizeVendorName(vendor.name) === normalizeVendorName(body.name!));
      if (!duplicate && catalog) {
        for (const vendor of other) {
          if ((await canonicalVendor(vendor.name))?.id === catalog.id) {
            duplicate = vendor;
            break;
          }
        }
      }
      if (duplicate) throw new ApiError(409, "That shop already exists");
    }
    await run("UPDATE vendors SET name = ?, kind = ?, note = ? WHERE id = ?", [
      body.name ?? current.name,
      body.kind ?? current.kind,
      body.note === undefined ? current.note : body.note,
      current.id,
    ]);
    res.json(serializeVendor(await get<any>("SELECT * FROM vendors WHERE id = ?", [current.id])));
  }),
);

receiptRoutes.get(
  "/:houseId/vendor-suggestions",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    const requested = String(req.query.country ?? "").toUpperCase();
    const country = CATALOG_COUNTRIES[requested] ? requested : await housePurchaseCountry(houseId);
    const q = normalizeVendorName(String(req.query.q ?? ""));
    const existing = await all<any>("SELECT name FROM vendors WHERE house_id = ?", [houseId]);
    const existingNames = new Set(existing.map((vendor) => normalizeVendorName(vendor.name)));
    const canonicalIds = await Promise.all(
      existing.map(async (vendor) => (await canonicalVendor(vendor.name, country))?.id),
    );
    const existingCanonical = new Set(canonicalIds.filter((id): id is string => Boolean(id)));
    const entries = (await catalogEntries(country))
      .filter((entry) => !q || normalizeVendorName(`${entry.name} ${entry.aliases.join(" ")}`).includes(q))
      .map((entry) => ({
        id: entry.id,
        country: entry.country,
        name: entry.name,
        kind: entry.kind,
        added: existingNames.has(normalizeVendorName(entry.name)) || existingCanonical.has(entry.id),
      }));
    res.json({ country, countries: await catalogCountries(), entries });
  }),
);

receiptRoutes.delete(
  "/:houseId/vendors/:vendorId",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "admin");
    await run("DELETE FROM vendors WHERE id = ? AND house_id = ?", [req.params.vendorId, houseId]);
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------- receipts */

async function receiptRow(houseId: string, receiptId: string) {
  return await get<any>(
    `SELECT r.*, COALESCE(v.name, r.vendor_name) AS vendor_name,
       (SELECT COUNT(*) FROM receipt_lines rl WHERE rl.receipt_id = r.id) AS line_count
     FROM receipts r LEFT JOIN vendors v ON v.id = r.vendor_id
     WHERE r.id = ? AND r.house_id = ?`,
    [receiptId, houseId],
  );
}

async function receiptDetail(houseId: string, receiptId: string) {
  const row = await receiptRow(houseId, receiptId);
  if (!row) throw new ApiError(404, "Receipt not found");
  return serializeReceipt(row, await receiptLinesFor(receiptId));
}

async function resolveVendor(houseId: string, vendorId: string | null | undefined, vendorName: string | null | undefined) {
  if (vendorId) {
    const vendor = await vendorRow(houseId, vendorId);
    if (!vendor) throw new ApiError(400, "Shop does not exist in this house");
    return vendor;
  }
  const name = (vendorName ?? "").trim();
  if (!name) return null;
  const country = await housePurchaseCountry(houseId);
  const catalog = await canonicalVendor(name, country);
  const existing = await all<any>("SELECT * FROM vendors WHERE house_id = ?", [houseId]);
  const nameMatch = existing.find((vendor) => normalizeVendorName(vendor.name) === normalizeVendorName(name));
  if (nameMatch) return nameMatch;
  if (catalog) {
    for (const vendor of existing) {
      if ((await canonicalVendor(vendor.name, country))?.id === catalog.id) return vendor;
    }
  }
  const id = newId("vnd");
  await run("INSERT INTO vendors (id, house_id, name, kind, note, created_at) VALUES (?, ?, ?, ?, NULL, ?)", [
    id,
    houseId,
    (catalog?.name ?? name).slice(0, 80),
    catalog?.kind ?? "shop",
    now(),
  ]);
  return await get<any>("SELECT * FROM vendors WHERE id = ?", [id]);
}

function looseName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|g|gr|mg|l|lt|ml|cl|dl|pcs|pc|pack|packs|box|bag|bottle|can|jar|tub|roll)s?\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Small concurrency pool for OpenFoodFacts lookups during a receipt import. */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function matchItem(houseId: string, line: { description: string; itemId?: string | null; barcode?: string | null }) {
  if (line.itemId) {
    const item = await get<any>("SELECT * FROM items WHERE id = ? AND house_id = ?", [line.itemId, houseId]);
    if (!item) throw new ApiError(400, "One of the chosen items is not in this house");
    return item;
  }
  if (line.barcode) {
    const item = await get<any>(
      `SELECT i.* FROM items i JOIN item_barcodes b ON b.item_id = i.id
       WHERE i.house_id = ? AND b.code = ?`,
      [houseId, line.barcode],
    );
    if (item) return item;
  }
  const exact = await get<any>("SELECT * FROM items WHERE house_id = ? AND archived = 0 AND LOWER(name) = LOWER(?)", [
    houseId,
    line.description,
  ]);
  if (exact) return exact;

  const wanted = looseName(line.description);
  if (wanted.length < 3) return null;
  const candidates = await all<any>("SELECT * FROM items WHERE house_id = ? AND archived = 0", [houseId]);
  let best: { item: any; score: number } | null = null;
  for (const candidate of candidates) {
    const name = looseName(String(candidate.name));
    if (!name || name.length < 3) continue;
    if (name === wanted) return candidate;
    if (wanted.includes(name) || name.includes(wanted)) {
      const score = Math.min(name.length, wanted.length) / Math.max(name.length, wanted.length);
      if (score >= 0.6 && (!best || score > best.score)) best = { item: candidate, score };
    }
  }
  return best?.item ?? null;
}

const boundedNumber = (min: number, max: number) =>
  z.number().finite().transform((value) => Math.min(max, Math.max(min, value)));
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .transform((value) => value.slice(0, max) || null)
    .nullish();

const lineInput = z.object({
  description: z.string().trim().min(1).transform((value) => value.slice(0, 160)),
  rawDescription: optionalText(200),
  quantity: z
    .number()
    .finite()
    .transform((value) => (value > 0 ? Math.min(value, 1e9) : 1))
    .default(1),
  unit: optionalText(10),
  unitPrice: boundedNumber(0, 1e9).nullish(),
  lineTotal: boundedNumber(0, 1e9).nullish(),
  taxRate: boundedNumber(0, 100).nullish(),
  discount: boundedNumber(0, 1e9).nullish(),
  itemId: z.string().max(60).nullish(),
  locationId: z.string().max(60).nullish(),
  barcode: optionalText(80),
  offCode: optionalText(80),
});

const importBody = z.object({
  vendorId: z.string().max(60).nullish(),
  vendorName: optionalText(80),
  purchasedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .nullish(),
  currency: optionalText(3),
  total: boundedNumber(0, 1e9).nullish(),
  subtotal: boundedNumber(0, 1e9).nullish(),
  tax: boundedNumber(0, 1e9).nullish(),
  taxBreakdown: z
    .array(
      z.object({
        rate: boundedNumber(0, 100).nullish(),
        net: boundedNumber(0, 1e9),
        tax: boundedNumber(0, 1e9),
        gross: boundedNumber(0, 1e9).nullish(),
      }),
    )
    .max(20)
    .optional(),
  image: optionalText(300),
  ocrText: optionalText(50000),
  notes: optionalText(500),
  templateId: optionalText(60),
  templateConfidence: boundedNumber(0, 1).nullish(),
  provider: z.enum(["ai", "local", "template"]).nullish(),
  aiCost: boundedNumber(0, 1e9).nullish(),
  savings: boundedNumber(0, 1e9).nullish(),
  lines: z.array(lineInput).min(1).max(200),
});

receiptRoutes.get(
  "/:houseId/receipts",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    const limit = intParam(req.query.limit, 50, 300);
    const vendorId = req.query.vendorId ? String(req.query.vendorId) : null;
    const q = String(req.query.q ?? "").trim();
    const where = ["r.house_id = ?"];
    const params: unknown[] = [houseId];
    if (vendorId) {
      where.push("r.vendor_id = ?");
      params.push(vendorId);
    }
    if (q) {
      where.push(
        `(lower(COALESCE(v.name, r.vendor_name)) LIKE lower(?) OR EXISTS (SELECT 1 FROM receipt_lines rl WHERE rl.receipt_id = r.id AND lower(rl.description) LIKE lower(?)))`,
      );
      params.push(`%${q}%`, `%${q}%`);
    }
    const rows = await all<any>(
      `SELECT r.*, COALESCE(v.name, r.vendor_name) AS vendor_name,
         (SELECT COUNT(*) FROM receipt_lines rl WHERE rl.receipt_id = r.id) AS line_count
       FROM receipts r LEFT JOIN vendors v ON v.id = r.vendor_id
       WHERE ${where.join(" AND ")}
       ORDER BY COALESCE(r.purchased_at, r.created_at) DESC, r.created_at DESC LIMIT ?`,
      [...params, limit],
    );
    res.json(rows.map((row) => serializeReceipt(row)));
  }),
);

receiptRoutes.post(
  "/:houseId/receipts/upload",
  uploader("receipts").single("image"),
  handler(async (req, res) => {
    await requireHouse(req, "member");
    if (!req.file) throw new ApiError(400, "No image uploaded");
    res.status(201).json({ path: `/uploads/receipts/${req.file.filename}` });
  }),
);

async function localImageToDataUrl(image: string): Promise<string | null> {
  if (!image.startsWith("/uploads/receipts/")) return Promise.resolve(null);
  const filename = image.split("/").pop()!;
  return await fileToDataUrl(uploadPath("receipts", filename), "image/jpeg");
}

receiptRoutes.post(
  "/:houseId/receipts/scan",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(
      z.object({
        text: z.string().max(50000).optional(),
        image: z.string().max(300).optional(),
      }),
      req.body,
    );
    const rawText = (body.text ?? "").trim();
    if (!rawText && !body.image) throw new ApiError(400, "Provide receipt text or a scan image");

    const house = (await get<any>("SELECT * FROM houses WHERE id = ?", [houseId]))!;
    const settings = parseJson<Record<string, any>>(house.settings, {});
    const cfg = resolveAi(settings);
    const hasVisionModel = Boolean(settings?.ai?.visionModel || AI_ENV.visionModel);

    const template = await selectReceiptTemplate(rawText, houseId);
    let draft = heuristicReceipt(rawText, house.currency ?? null);
    let provider: "ai" | "local" | "template" = "local";
    let aiCost: number | null = null;
    let warning: string | null = null;

    if (template) {
      const templated = template.parse(rawText, house.currency ?? null);
      if (templated.lines.length) {
        templated.templateId = template.id;
        templated.templateConfidence = template.confidence;
        draft = templated;
        provider = "template";
        warning = null;
      } else {
        warning = `${template.name} layout detected, but no product lines were read — using the generic parser.`;
      }
    }

    if (provider !== "template") {
      if (cfg.enabled && (rawText || (body.image && hasVisionModel))) {
        try {
          const images =
            body.image && hasVisionModel
              ? [await localImageToDataUrl(body.image)].filter((value): value is string => !!value)
              : [];
          const aiDraft = await aiParseReceipt(cfg, rawText, images, {
            operation: "receipt.scan",
            houseId,
            userId: req.user!.id,
            metadata: {
              hasImage: Boolean(body.image),
              hasVisionModel,
              ocrChars: rawText.length,
              lineCount: draft.lines.length,
            },
          });
          draft = normaliseReceiptDraft(aiDraft.data, house.currency ?? null);
          aiCost = aiDraft.usage.cost;
          provider = "ai";
        } catch (err) {
          warning = `AI cleanup failed, kept the locally parsed version. ${err instanceof Error ? err.message : ""}`.trim();
        }
      } else if (cfg.enabled) {
        warning =
          "No text was recognised in the scan. Add a vision-capable model in Settings → AI to let AI read the photo, or correct the text before importing.";
      } else {
        warning = "No AI provider configured — parsed locally. Check the lines before adding them to your inventory.";
      }
    }

    // Resolve the merchant against the shop catalogue so receipt variants such
    // as "LIDL HELLAS" or "ΣΚΛΑΒΕΝΙΤΗΣ" become the same familiar shop.
    const country = await housePurchaseCountry(houseId);
    const catalogVendor = await canonicalVendor(draft.vendorName, country) ?? await detectCatalogVendor(rawText, country);
    if (catalogVendor) draft.vendorName = catalogVendor.name;

    const knownVendor = draft.vendorName
      ? await get<any>("SELECT * FROM vendors WHERE house_id = ? AND lower(name) = lower(?)", [houseId, draft.vendorName])
      : null;
    draft.lines = await Promise.all(draft.lines.map(async (line) => {
      const suggestions = await suggestProductMatches(
        houseId,
        knownVendor?.id ?? null,
        line.rawDescription ?? line.description,
        3,
      );
      const top = suggestions[0];
      const mapping = await findCatalogMapping({
        country,
        vendorName: draft.vendorName,
        rawDescription: line.rawDescription ?? line.description,
      });
      const offCode = line.barcode || mapping?.offCode || null;
      const product = offCode ? await getCachedOffProduct(offCode) : null;
      return {
        ...line,
        suggestedItemId: top?.itemId ?? null,
        suggestedItemName: top?.itemName ?? null,
        suggestedItemUnit: top?.unit ?? null,
        suggestedItemScore: top?.score ?? null,
        suggestedItemSource: top?.source ?? null,
        offCode,
        offName: product?.name || mapping?.name || null,
        offBrand: product?.brand || mapping?.brand || null,
        offImage: product?.image ?? null,
        offQuantity: product?.quantity || mapping?.unit || null,
        offScore: product ? (line.barcode ? 1 : (mapping?.confidence ?? 0.7)) : (mapping?.confidence ?? null),
      };
    }));

    if (!draft.lines.length && !draft.vendorName) {
      warning = [warning, "Could not find any product lines in this text."].filter(Boolean).join(" ");
    }

    res.json({ provider, warning, aiCost, draft });
  }),
);

receiptRoutes.post(
  "/:houseId/receipts",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(importBody, req.body);

    const vendor = await resolveVendor(houseId, body.vendorId, body.vendorName);
    for (const line of body.lines) {
      if (line.locationId && !await get("SELECT id FROM locations WHERE id = ? AND house_id = ?", [line.locationId, houseId])) {
        throw new ApiError(400, "One of the chosen places is not in this house");
      }
    }

    const receiptId = newId("rct");
    const touchedItems = new Set<string>();
    const house = await get<any>("SELECT currency FROM houses WHERE id = ?", [houseId]);
    const currency = (body.currency ?? house?.currency ?? "EUR").toUpperCase().slice(0, 3);
    const taxBreakdown = (body.taxBreakdown ?? []).map((entry) => ({
      rate: entry.rate ?? null,
      net: round(entry.net, 2),
      tax: round(entry.tax, 2),
      gross: round(entry.gross ?? entry.net + entry.tax, 2),
    }));
    const tax = body.tax ?? (taxBreakdown.length ? round(taxBreakdown.reduce((sum, entry) => sum + entry.tax, 0), 2) : null);
    const subtotal =
      body.subtotal ??
      (taxBreakdown.length
        ? round(taxBreakdown.reduce((sum, entry) => sum + entry.net, 0), 2)
        : body.total != null && tax != null
          ? round(body.total - tax, 2)
          : null);
    const lineSavings = round(body.lines.reduce((sum, line) => sum + Math.abs(line.discount ?? 0), 0), 2);
    const savings = body.savings != null ? round(Math.max(0, body.savings), 2) : lineSavings > 0 ? lineSavings : null;

    // Resolve OpenFoodFacts before the transaction: product fetches are network
    // calls and must never hold the SQLite write lock.
    const country = await housePurchaseCountry(houseId);
    const enriched = await mapWithLimit(body.lines, 4, async (line) => {
      const rawDescription = line.rawDescription ?? line.description;
      const mapping = await findCatalogMapping({
        country,
        vendorName: vendor?.name ?? body.vendorName,
        rawDescription,
      });
      const wanted = line.offCode || line.barcode || mapping?.offCode || null;
      const product = wanted ? await fetchOffProduct(wanted) : null;
      return { line, rawDescription, mapping, offCode: product?.code ?? wanted, product };
    });

    await tx(async () => {
      await run(
        `INSERT INTO receipts
          (id, house_id, vendor_id, vendor_name, purchased_at, currency, total, subtotal, tax, tax_breakdown,
           template_id, template_confidence, provider, ai_cost, savings, image, ocr_text, source, notes, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          receiptId,
          houseId,
          vendor?.id ?? null,
          vendor?.name ?? body.vendorName ?? null,
          body.purchasedAt ?? now().slice(0, 10),
          currency,
          body.total ?? null,
          subtotal,
          tax,
          JSON.stringify(taxBreakdown),
          body.templateId ?? null,
          body.templateConfidence ?? null,
          body.provider ?? null,
          body.aiCost ?? null,
          savings,
          body.image ?? null,
          body.ocrText ?? null,
          body.image ? "scan" : "manual",
          body.notes ?? null,
          req.user!.id,
          now(),
        ],
      );

      for (const [index, { line, rawDescription, mapping, offCode, product }] of enriched.entries()) {
        const alias =
          !line.itemId && rawDescription ? await findProductAlias(houseId, vendor?.id ?? null, rawDescription) : null;
        let item = alias?.item ?? await matchItem(houseId, line);
        const unit = line.unit ? line.unit.toLowerCase() : null;

        if (!item) {
          item = await createItemForLine(houseId, req.user!.id, line, unit);
        }

        // Link scanned/receipt products only when the item has no link yet. A
        // different existing link is a deliberate user choice and is kept.
        if (product && !item.off_code) {
          try {
            const linked = await linkItemToOff({
              item,
              product,
              source: line.barcode ? "barcode" : "receipt",
            });
            item = linked.item;
          } catch {
            // A product can already belong to another item in this house. The
            // receipt still imports; the OFF lookup is only an enrichment.
          }
        }

        // Learn after enrichment so the alias captures the final unit/category.
        await learnProductAlias({ houseId, vendorId: vendor?.id ?? null, rawDescription, item });

        if (product) {
          await learnCatalogMapping({
            country,
            vendorName: vendor?.name ?? body.vendorName,
            rawDescription,
            offCode: product.code,
            name: product.name || item.name,
            brand: product.brand || item.brand,
            unit: product.quantity || item.unit,
            category: product.categories?.[0] ?? null,
            confidence: line.offCode ? 0.95 : line.barcode ? 1 : (mapping?.confidence ?? 0.7),
          });
        } else if (item.off_code) {
          // A corrected/pinned line for an item that is already linked to OFF
          // still teaches the shared catalogue the shop’s printed name.
          await learnCatalogMapping({
            country,
            vendorName: vendor?.name ?? body.vendorName,
            rawDescription,
            offCode: item.off_code,
            name: item.name,
            brand: item.brand,
            unit: item.unit,
            confidence: 0.6,
          });
        }

        const quantity = line.quantity;
        const fromUnit = unit ?? item.unit;
        if (convert(quantity, fromUnit, item.unit) == null) {
          throw new ApiError(
            400,
            `Cannot add “${line.description}” in ${fromUnit} to an item stocked in ${item.unit}. Pick another unit or item.`,
          );
        }

        const unitPrice =
          line.unitPrice != null ? line.unitPrice : line.lineTotal != null ? round(line.lineTotal / quantity, 4) : null;

        await addStock({
          itemId: item.id,
          houseId,
          userId: req.user!.id,
          quantity,
          unit: fromUnit,
          unitPrice,
          currency,
          locationId: line.locationId ?? null,
          purchasedAt: body.purchasedAt ?? now().slice(0, 10),
          note: body.notes ?? null,
          reason: vendor ? `Receipt · ${vendor.name}` : "Receipt",
          vendorId: vendor?.id ?? null,
          receiptId,
        });
        touchedItems.add(item.id);

        await run(
          `INSERT INTO receipt_lines
            (id, receipt_id, house_id, description, raw_description, quantity, unit, unit_price, line_total,
             tax_rate, discount, item_id, location_id, barcode, off_code, sort)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newId("rln"),
            receiptId,
            houseId,
            line.description,
            rawDescription,
            quantity,
            unit,
            unitPrice,
            line.lineTotal ?? (unitPrice != null ? round(unitPrice * quantity, 2) : null),
            line.taxRate ?? null,
            line.discount ?? null,
            item.id,
            line.locationId ?? null,
            line.barcode ?? null,
            product?.code ?? offCode ?? null,
            index,
          ],
        );
      }

      if (body.total == null) {
        const sum = await get<{ total: number | null }>(
          "SELECT SUM(COALESCE(line_total, 0)) AS total FROM receipt_lines WHERE receipt_id = ?",
          [receiptId],
        );
        const finalTotal = sum?.total == null ? null : round(Number(sum.total), 2);
        const finalSubtotal = subtotal ?? (finalTotal != null && tax != null ? round(finalTotal - tax, 2) : null);
        await run("UPDATE receipts SET total = ?, subtotal = ? WHERE id = ?", [finalTotal, finalSubtotal, receiptId]);
      }
    });

    for (const itemId of touchedItems) await afterStockChange(itemId);
    res.status(201).json(await receiptDetail(houseId, receiptId));
  }),
);

receiptRoutes.get(
  "/:houseId/purchases/analytics",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    const from = req.query.from ? String(req.query.from).slice(0, 10) : null;
    const to = req.query.to ? String(req.query.to).slice(0, 10) : null;
    const where = ["r.house_id = ?"];
    const params: unknown[] = [houseId];
    if (from) {
      where.push("COALESCE(r.purchased_at, substr(r.created_at, 1, 10)) >= ?");
      params.push(from);
    }
    if (to) {
      where.push("COALESCE(r.purchased_at, substr(r.created_at, 1, 10)) <= ?");
      params.push(to);
    }

    const rows = await all<any>(
      `SELECT r.id, r.vendor_id, COALESCE(v.name, r.vendor_name) AS vendor_name, r.purchased_at, r.created_at,
         r.total, r.subtotal, r.tax, r.savings, r.tax_breakdown
       FROM receipts r LEFT JOIN vendors v ON v.id = r.vendor_id
       WHERE ${where.join(" AND ")}
       ORDER BY COALESCE(r.purchased_at, r.created_at) ASC`,
      params,
    );

    const netOf = (row: any) =>
      row.subtotal != null
        ? Number(row.subtotal)
        : row.total != null
          ? Number(row.total) - Number(row.tax ?? 0)
          : 0;
    const taxOf = (row: any) => (row.tax != null ? Number(row.tax) : 0);
    const totalOf = (row: any) => (row.total != null ? Number(row.total) : netOf(row) + taxOf(row));

    let total = 0;
    let net = 0;
    let tax = 0;
    let savings = 0;
    const vendorMap = new Map<string, { vendorId: string | null; vendorName: string; receipts: number; total: number; net: number; tax: number }>();
    const monthMap = new Map<string, { month: string; receipts: number; total: number; net: number; tax: number }>();
    const rateMap = new Map<string, { rate: number | null; net: number; tax: number; gross: number }>();

    for (const row of rows) {
      const rowTotal = totalOf(row);
      const rowNet = netOf(row);
      const rowTax = taxOf(row);
      total += rowTotal;
      net += rowNet;
      tax += rowTax;
      savings += row.savings == null ? 0 : Number(row.savings);

      const vendorKey = row.vendor_id ?? `name:${row.vendor_name ?? ""}`;
      const vendor = vendorMap.get(vendorKey) ?? {
        vendorId: row.vendor_id ?? null,
        vendorName: row.vendor_name ?? "Unknown shop",
        receipts: 0,
        total: 0,
        net: 0,
        tax: 0,
      };
      vendor.receipts += 1;
      vendor.total += rowTotal;
      vendor.net += rowNet;
      vendor.tax += rowTax;
      vendorMap.set(vendorKey, vendor);

      const month = String(row.purchased_at ?? row.created_at ?? "").slice(0, 7) || "unknown";
      const bucket = monthMap.get(month) ?? { month, receipts: 0, total: 0, net: 0, tax: 0 };
      bucket.receipts += 1;
      bucket.total += rowTotal;
      bucket.net += rowNet;
      bucket.tax += rowTax;
      monthMap.set(month, bucket);

      for (const entry of parseJson<any[]>(row.tax_breakdown, [])) {
        const rate = entry?.rate == null ? null : Number(entry.rate);
        const key = rate == null ? "unknown" : String(rate);
        const rateEntry = rateMap.get(key) ?? { rate, net: 0, tax: 0, gross: 0 };
        rateEntry.net += Number(entry?.net ?? 0);
        rateEntry.tax += Number(entry?.tax ?? 0);
        rateEntry.gross += Number(entry?.gross ?? Number(entry?.net ?? 0) + Number(entry?.tax ?? 0));
        rateMap.set(key, rateEntry);
      }
    }

    const categoryRows = await all<any>(
      `SELECT c.id AS category_id, COALESCE(c.name, 'Uncategorised') AS category_name,
         SUM(COALESCE(rl.line_total, 0)) AS total
       FROM receipt_lines rl
       JOIN receipts r ON r.id = rl.receipt_id
       LEFT JOIN items i ON i.id = rl.item_id
       LEFT JOIN categories c ON c.id = i.category_id
       WHERE ${where.join(" AND ")}
       GROUP BY c.id, c.name, COALESCE(c.name, 'Uncategorised')
       ORDER BY total DESC`,
      params,
    );

    const money = (value: number) => round(value, 2);
    res.json({
      range: { from, to },
      totals: {
        receipts: rows.length,
        total: money(total),
        net: money(net),
        tax: money(tax),
        savings: money(savings),
        average: rows.length ? money(total / rows.length) : 0,
      },
      byVendor: [...vendorMap.values()]
        .map((vendor) => ({
          ...vendor,
          total: money(vendor.total),
          net: money(vendor.net),
          tax: money(vendor.tax),
        }))
        .sort((a, b) => b.total - a.total),
      monthly: [...monthMap.values()]
        .map((bucket) => ({
          ...bucket,
          total: money(bucket.total),
          net: money(bucket.net),
          tax: money(bucket.tax),
        }))
        .sort((a, b) => a.month.localeCompare(b.month)),
      taxRates: [...rateMap.values()]
        .map((entry) => ({
          rate: entry.rate,
          net: money(entry.net),
          tax: money(entry.tax),
          gross: money(entry.gross),
        }))
        .sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0)),
      byCategory: categoryRows.map((row) => ({
        categoryId: row.category_id ?? null,
        categoryName: row.category_name ?? "Uncategorised",
        total: money(Number(row.total ?? 0)),
      })),
    });
  }),
);

async function createItemForLine(
  houseId: string,
  userId: string,
  line: z.infer<typeof lineInput>,
  unit: string | null,
) {
  const name = line.description.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!name) throw new ApiError(400, "Every receipt line needs a product name");
  const itemId = newId("itm");
  await run(
    `INSERT INTO items (id, house_id, name, description, brand, category_id, unit, reorder_point, target_stock,
       attributes, tags, image, archived, created_by, created_at, updated_at)
     VALUES (?, ?, ?, NULL, NULL, NULL, ?, 0, NULL, '{}', '[]', NULL, 0, ?, ?, ?)`,
    [itemId, houseId, name, (unit ?? "pcs").toLowerCase().slice(0, 10), userId, now(), now()],
  );
  if (line.barcode) {
    const existing = await get<any>(
      `SELECT i.name FROM item_barcodes b JOIN items i ON i.id = b.item_id WHERE b.house_id = ? AND b.code = ?`,
      [houseId, line.barcode],
    );
    if (!existing) {
      await run("INSERT INTO item_barcodes (id, item_id, house_id, code, format, created_at) VALUES (?, ?, ?, ?, 'receipt', ?)", [
        newId("bar"),
        itemId,
        houseId,
        line.barcode,
        now(),
      ]);
    }
  }
  return await get<any>("SELECT * FROM items WHERE id = ?", [itemId]);
}

/* --------------------------------------------------------------- single receipt */

async function receiptAccess(req: any, minRole: "viewer" | "member" = "viewer") {
  const receipt = await get<any>("SELECT * FROM receipts WHERE id = ?", [req.params.receiptId]);
  if (!receipt) throw new ApiError(404, "Receipt not found");
  const role = await memberRole(req.user!.id, receipt.house_id);
  if (!role) throw new ApiError(404, "Receipt not found");
  if (!roleAtLeast(role, minRole)) throw new ApiError(403, `Requires ${minRole} access`);
  return { receipt, houseId: receipt.house_id as string };
}

singleReceiptRoutes.get(
  "/:receiptId",
  handler(async (req, res) => {
    const { houseId, receipt } = await receiptAccess(req);
    res.json(await receiptDetail(houseId, receipt.id));
  }),
);

singleReceiptRoutes.delete(
  "/:receiptId",
  handler(async (req, res) => {
    const { receipt } = await receiptAccess(req, "member");
    await run("DELETE FROM receipts WHERE id = ?", [receipt.id]);
    res.json({ ok: true });
  }),
);
