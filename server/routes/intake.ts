import { Router } from "express";
import { z } from "zod";
import { AI_ENV } from "../config.js";
import { get, newId, now, parseJson, run, tx } from "../db.js";
import { requireAuth } from "../auth.js";
import { ApiError, handler, parseBody, requireHouse } from "../http.js";
import { aiParseReceipt, resolveAi } from "../ai.js";
import { heuristicReceipt, normaliseReceiptDraft } from "../services/receipt-local.js";
import { selectReceiptTemplate } from "../services/receipt-templates.js";
import { suggestProductMatches } from "../services/product-match.js";
import { fetchOffProduct, getCachedOffProduct } from "../services/openfoodfacts.js";
import { canonicalVendor, detectCatalogVendor } from "../services/vendors.js";
import { addStock, afterStockChange } from "../services/stock.js";
import { ITEM_SELECT, barcodesForItem, serializeItem } from "../serialize.js";
import { uploader } from "../upload.js";
import { loadVisionImages, rememberUpload, skippedImagesWarning } from "../services/receipt-scans.js";
import { UNITS, convert } from "../units.js";
import type { IntakeParseResult, IntakeRow } from "../../shared/types.js";

export const intakeRoutes = Router();
intakeRoutes.use(requireAuth);

const UNIT_SET = new Set(UNITS.map((unit) => unit.toLowerCase()));

async function purchaseCountry(houseId: string) {
  const house = await get<any>("SELECT settings FROM houses WHERE id = ?", [houseId]);
  const settings = parseJson<Record<string, any>>(house?.settings, {});
  return String(settings?.purchases?.country ?? "GR").toUpperCase();
}

async function itemByBarcode(houseId: string, code: string) {
  return await get<any>(
    `SELECT i.* FROM items i JOIN item_barcodes b ON b.item_id = i.id WHERE b.house_id = ? AND b.code = ? LIMIT 1`,
    [houseId, code],
  );
}

async function candidatesFor(houseId: string, vendorId: string | null, text: string): Promise<IntakeRow["candidates"]> {
  return (await suggestProductMatches(houseId, vendorId, text, 3)).map((entry) => ({
    itemId: entry.itemId,
    name: entry.itemName,
    unit: entry.unit,
    score: entry.score,
    source: entry.source,
  }));
}

async function parseBarcodes(houseId: string, codes: string[]): Promise<IntakeParseResult> {
  const rows: IntakeRow[] = [];
  const seen = new Set<string>();
  for (const raw of codes.slice(0, 100)) {
    const code = raw.trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const item = await itemByBarcode(houseId, code);
    if (item) {
      rows.push({
        description: item.name,
        rawDescription: code,
        quantity: 1,
        unit: item.unit,
        unitPrice: null,
        lineTotal: null,
        barcode: code,
        itemId: item.id,
        itemName: item.name,
        itemUnit: item.unit,
        candidates: await candidatesFor(houseId, null, item.name),
        offCode: item.off_code ?? null,
        offName: null,
        offBrand: null,
        offImage: null,
        action: "update",
      });
      continue;
    }
    const product = await fetchOffProduct(code);
    rows.push({
      description: product?.name || `Barcode ${code}`,
      rawDescription: code,
      quantity: 1,
      unit: null,
      unitPrice: null,
      lineTotal: null,
      barcode: code,
      itemId: null,
      itemName: null,
      itemUnit: null,
      candidates: product ? await candidatesFor(houseId, null, product.name) : [],
      offCode: product?.code ?? code,
      offName: product?.name ?? null,
      offBrand: product?.brand ?? null,
      offImage: product?.image ?? null,
      action: "create",
    });
  }
  return {
    provider: "barcode",
    warning: rows.length ? null : "No barcodes were supplied.",
    vendorName: null,
    purchasedAt: null,
    currency: null,
    rows,
  };
}

intakeRoutes.post(
  "/:houseId/intake/upload",
  uploader("receipts").single("image"),
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    if (!req.file) throw new ApiError(400, "No image uploaded");
    const path = `/uploads/receipts/${req.file.filename}`;
    rememberUpload(path, houseId);
    res.status(201).json({ path });
  }),
);

intakeRoutes.post(
  "/:houseId/intake/parse",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(
      z.object({
        text: z.string().max(50000).optional(),
        image: z.string().max(300).optional(),
        barcodes: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
      }),
      req.body,
    );
    if (body.barcodes?.length) {
      res.json(await parseBarcodes(houseId, body.barcodes));
      return;
    }

    const rawText = (body.text ?? "").trim();
    if (!rawText && !body.image) throw new ApiError(400, "Provide receipt text, an image or barcodes");
    const house = (await get<any>("SELECT * FROM houses WHERE id = ?", [houseId]))!;
    const settings = parseJson<Record<string, any>>(house.settings, {});
    const cfg = resolveAi(settings);
    const hasVisionModel = Boolean(settings?.ai?.visionModel || AI_ENV.visionModel);

    const template = await selectReceiptTemplate(rawText, houseId);
    let draft = heuristicReceipt(rawText, house.currency ?? null);
    let provider: "ai" | "local" | "template" = "local";
    let warning: string | null = null;

    if (template) {
      const templated = template.parse(rawText, house.currency ?? null);
      if (templated.lines.length) {
        draft = templated;
        provider = "template";
      } else {
        warning = `${template.name} layout detected, but no product lines were read — using the generic parser.`;
      }
    }

    if (provider !== "template") {
      if (cfg.enabled && (rawText || (body.image && hasVisionModel))) {
        try {
          const vision = body.image && hasVisionModel ? await loadVisionImages([body.image]) : { images: [], skipped: 0 };
          const images = vision.images;
          const imageWarning = skippedImagesWarning(vision.skipped, 1);
          const aiDraft = await aiParseReceipt(cfg, rawText, images, {
            operation: "receipt.intake",
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
          provider = "ai";
          warning = imageWarning;
        } catch (err) {
          warning = `AI cleanup failed, kept the locally parsed version. ${err instanceof Error ? err.message : ""}`.trim();
        }
      } else if (cfg.enabled) {
        warning = "No text was recognised. Add a vision model in Settings → AI, or paste the receipt text.";
      } else {
        warning = "No AI provider configured — parsed locally. Check the rows before adding them to your inventory.";
      }
    }

    const country = await purchaseCountry(houseId);
    const catalogVendor = await canonicalVendor(draft.vendorName, country) ?? await detectCatalogVendor(rawText, country);
    if (catalogVendor) draft.vendorName = catalogVendor.name;
    const vendor = draft.vendorName
      ? await get<any>("SELECT * FROM vendors WHERE house_id = ? AND lower(name) = lower(?)", [houseId, draft.vendorName])
      : null;

    const rows: IntakeRow[] = await Promise.all(draft.lines.map(async (line) => {
      const text = line.rawDescription ?? line.description;
      const candidates = await candidatesFor(houseId, vendor?.id ?? null, text);
      const top = candidates[0];
      const product = line.offCode ? await getCachedOffProduct(line.offCode) : null;
      return {
        description: line.description,
        rawDescription: line.rawDescription ?? null,
        quantity: line.quantity ?? 1,
        unit: line.unit ?? null,
        unitPrice: line.unitPrice ?? null,
        lineTotal: line.lineTotal ?? null,
        barcode: line.barcode ?? null,
        itemId: top?.itemId ?? null,
        itemName: top?.name ?? null,
        itemUnit: top?.unit ?? null,
        candidates,
        offCode: line.offCode ?? null,
        offName: product?.name ?? null,
        offBrand: product?.brand ?? null,
        offImage: product?.image ?? null,
        action: top ? "update" : "create",
      };
    }));

    if (!rows.length) {
      warning = [warning, "Could not find any product lines in this text."].filter(Boolean).join(" ");
    }

    res.json({
      provider,
      warning,
      vendorName: draft.vendorName ?? null,
      purchasedAt: draft.purchasedAt ?? null,
      currency: draft.currency ?? house.currency ?? null,
      rows,
    } satisfies IntakeParseResult);
  }),
);

const commitRow = z.object({
  description: z.string().trim().min(1).max(160),
  quantity: z.number().positive().max(1e9),
  unit: z.string().max(10).nullish(),
  unitPrice: z.number().min(0).max(1e9).nullish(),
  barcode: z.string().max(80).nullish(),
  itemId: z.string().max(60).nullish(),
  locationId: z.string().max(60).nullish(),
  action: z.enum(["create", "update", "skip"]).default("update"),
});

intakeRoutes.post(
  "/:houseId/intake/commit",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(
      z.object({
        rows: z.array(commitRow).min(1).max(200),
        currency: z.string().max(3).nullish(),
        purchasedAt: z.string().max(10).nullish(),
        vendorId: z.string().max(60).nullish(),
      }),
      req.body,
    );
    if (body.vendorId && !await get("SELECT id FROM vendors WHERE id = ? AND house_id = ?", [body.vendorId, houseId])) {
      throw new ApiError(400, "Shop does not exist in this house");
    }

    const seenBarcodes = new Map<string, number>();
    const errors: { index: number; errors: string[] }[] = [];
    const prepared = await Promise.all(body.rows.map(async (row, index) => {
      const rowErrors: string[] = [];
      let item: any = null;
      if (row.action !== "skip") {
        if (row.itemId) {
          item = await get<any>("SELECT * FROM items WHERE id = ? AND house_id = ?", [row.itemId, houseId]);
          if (!item) rowErrors.push("The chosen item does not exist in this house");
        } else if (row.barcode) {
          item = await itemByBarcode(houseId, row.barcode);
        }
        if (!item && row.action === "update") {
          item = await get<any>("SELECT * FROM items WHERE house_id = ? AND archived = 0 AND LOWER(name) = LOWER(?)", [
            houseId,
            row.description,
          ]);
          if (!item) rowErrors.push("No matching item for an update row; choose an existing item or create one");
        }
        const unit = (row.unit ?? item?.unit ?? "pcs").toLowerCase();
        if (row.action === "create" && !UNIT_SET.has(unit)) rowErrors.push(`Unknown unit "${unit}"`);
        if (item && row.unit && convert(1, row.unit, item.unit) == null) {
          rowErrors.push(`Cannot convert ${row.unit} to ${item.unit}`);
        }
        if (row.barcode) {
          const previous = seenBarcodes.get(row.barcode);
          if (previous != null) rowErrors.push(`Barcode ${row.barcode} also appears on row ${previous + 1}`);
          else seenBarcodes.set(row.barcode, index);
          const owner = await itemByBarcode(houseId, row.barcode);
          if (owner && owner.id !== item?.id) rowErrors.push(`Barcode ${row.barcode} is already linked to ${owner.name}`);
        }
        if (row.locationId && !await get("SELECT id FROM locations WHERE id = ? AND house_id = ?", [row.locationId, houseId])) {
          rowErrors.push("The chosen place does not exist in this house");
        }
      }
      if (rowErrors.length) errors.push({ index, errors: rowErrors });
      return { row, item };
    }));

    if (errors.length) {
      throw new ApiError(400, "Fix the highlighted rows before committing", { rows: errors });
    }

    const created: string[] = [];
    const updated: string[] = [];
    const touched = new Set<string>();
    const currency = (body.currency ?? (await get<any>("SELECT currency FROM houses WHERE id = ?", [houseId]))?.currency ?? "EUR")
      .toUpperCase()
      .slice(0, 3);

    await tx(async () => {
      for (const { row, item } of prepared) {
        if (row.action === "skip") continue;
        let target = item;
        if (row.action === "create" && !target) {
          target = await get<any>("SELECT * FROM items WHERE house_id = ? AND LOWER(name) = LOWER(?)", [
            houseId,
            row.description,
          ]);
        }
        if (row.action === "create" && !target) {
          const id = newId("itm");
          await run(
            `INSERT INTO items (id, house_id, name, description, brand, category_id, unit, reorder_point, target_stock,
               attributes, tags, image, archived, created_by, created_at, updated_at)
             VALUES (?, ?, ?, NULL, NULL, NULL, ?, 0, NULL, '{}', '[]', NULL, 0, ?, ?, ?)`,
            [
              id,
              houseId,
              row.description.slice(0, 120),
              (row.unit ?? "pcs").toLowerCase().slice(0, 10),
              req.user!.id,
              now(),
              now(),
            ],
          );
          if (row.barcode) {
            await run("INSERT INTO item_barcodes (id, item_id, house_id, code, format, created_at) VALUES (?, ?, ?, ?, 'intake', ?)", [
              newId("bar"),
              id,
              houseId,
              row.barcode,
              now(),
            ]);
          }
          target = await get<any>("SELECT * FROM items WHERE id = ?", [id]);
          created.push(id);
        } else if (target) {
          if (row.barcode && !await itemByBarcode(houseId, row.barcode)) {
            await run("INSERT INTO item_barcodes (id, item_id, house_id, code, format, created_at) VALUES (?, ?, ?, ?, 'intake', ?)", [
              newId("bar"),
              target.id,
              houseId,
              row.barcode,
              now(),
            ]);
          }
          updated.push(target.id);
        }
        await addStock({
          itemId: target.id,
          houseId,
          userId: req.user!.id,
          quantity: row.quantity,
          unit: row.unit ?? target.unit,
          unitPrice: row.unitPrice,
          currency,
          locationId: row.locationId ?? null,
          purchasedAt: body.purchasedAt ?? now().slice(0, 10),
          reason: "Bulk intake",
          vendorId: body.vendorId ?? null,
        });
        touched.add(target.id);
      }
    });

    for (const itemId of touched) await afterStockChange(itemId);
    const serialize = async (id: string) => {
      const row = await get<any>(`${ITEM_SELECT} WHERE i.id = ?`, [id]);
      return row ? serializeItem(row, await barcodesForItem(id)) : null;
    };
    const createdRows = await Promise.all(created.map(serialize));
    const updatedRows = await Promise.all([...new Set(updated)].map(serialize));
    res.json({
      created: createdRows.filter(Boolean),
      updated: updatedRows.filter(Boolean),
      skipped: body.rows.filter((row) => row.action === "skip").length,
    });
  }),
);
