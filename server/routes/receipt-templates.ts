import { Router } from "express";
import { z } from "zod";
import { get, newId, now, run } from "../db.js";
import { requireAuth } from "../auth.js";
import { ApiError, handler, parseBody, requireHouse } from "../http.js";
import {
  builtInTemplates,
  listCustomTemplates,
  serializeTemplateRow,
} from "../services/receipt-templates.js";
import {
  parseWithTemplateRules,
  templateDetectionScore,
  validateTemplateRules,
} from "../services/receipt-template-engine.js";
import type { ReceiptTemplateRules } from "../../shared/types.js";

export const receiptTemplateRoutes = Router();
receiptTemplateRoutes.use(requireAuth);

const templateBody = z.object({
  name: z.string().trim().min(1).max(80),
  country: z.string().trim().min(2).max(2).default("GR"),
  vendorName: z.string().trim().max(80).nullish(),
  active: z.boolean().optional(),
  rules: z.record(z.string(), z.any()),
});

async function templateRow(houseId: string, templateId: string) {
  return await get<any>("SELECT * FROM receipt_templates WHERE id = ? AND house_id = ?", [templateId, houseId]);
}

function validateRules(rules: ReceiptTemplateRules) {
  if (JSON.stringify(rules).length > 20000) {
    throw new ApiError(400, "Template rules are too large (20 KB maximum)");
  }
  const errors = validateTemplateRules(rules);
  if (errors.length) throw new ApiError(400, errors.join("; "), errors);
}

receiptTemplateRoutes.get(
  "/:houseId/receipt-templates",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    res.json([...builtInTemplates(), ...await listCustomTemplates(houseId)]);
  }),
);

receiptTemplateRoutes.post(
  "/:houseId/receipt-templates",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "admin");
    const body = parseBody(templateBody, req.body);
    validateRules(body.rules as ReceiptTemplateRules);
    if (await get("SELECT id FROM receipt_templates WHERE house_id = ? AND lower(name) = lower(?)", [houseId, body.name])) {
      throw new ApiError(409, "A template with that name already exists");
    }
    const id = newId("tpl");
    await run(
      `INSERT INTO receipt_templates (id, house_id, name, country, vendor_name, active, version, rules, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [
        id,
        houseId,
        body.name,
        body.country.toUpperCase(),
        body.vendorName ?? null,
        body.active === false ? 0 : 1,
        JSON.stringify(body.rules),
        req.user!.id,
        now(),
        now(),
      ],
    );
    res.status(201).json(serializeTemplateRow(await templateRow(houseId, id)));
  }),
);

receiptTemplateRoutes.patch(
  "/:houseId/receipt-templates/:templateId",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "admin");
    const current = await templateRow(houseId, String(req.params.templateId));
    if (!current) throw new ApiError(404, "Template not found");
    const body = parseBody(templateBody.partial(), req.body);
    const rules = (body.rules ?? JSON.parse(current.rules)) as ReceiptTemplateRules;
    validateRules(rules);
    if (body.name) {
      const duplicate = await get<any>(
        "SELECT id FROM receipt_templates WHERE house_id = ? AND lower(name) = lower(?) AND id <> ?",
        [houseId, body.name, current.id],
      );
      if (duplicate) throw new ApiError(409, "A template with that name already exists");
    }
    await run(
      `UPDATE receipt_templates SET name = ?, country = ?, vendor_name = ?, active = ?, version = version + 1,
         rules = ?, updated_at = ? WHERE id = ?`,
      [
        body.name ?? current.name,
        (body.country ?? current.country).toUpperCase(),
        body.vendorName === undefined ? current.vendor_name : body.vendorName,
        body.active === undefined ? current.active : body.active ? 1 : 0,
        JSON.stringify(rules),
        now(),
        current.id,
      ],
    );
    res.json(serializeTemplateRow(await templateRow(houseId, current.id)));
  }),
);

receiptTemplateRoutes.delete(
  "/:houseId/receipt-templates/:templateId",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "admin");
    await run("DELETE FROM receipt_templates WHERE id = ? AND house_id = ?", [req.params.templateId, houseId]);
    res.json({ ok: true });
  }),
);

receiptTemplateRoutes.post(
  "/:houseId/receipt-templates/test",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "admin");
    const body = parseBody(
      z.object({
        rules: z.record(z.string(), z.any()),
        text: z.string().min(1).max(50000),
        name: z.string().max(80).optional(),
        vendorName: z.string().max(80).nullish(),
      }),
      req.body,
    );
    void houseId;
    const rules = body.rules as ReceiptTemplateRules;
    validateRules(rules);
    const confidence = templateDetectionScore(rules, body.text);
    const draft = parseWithTemplateRules(body.text, rules, {
      id: "preview",
      name: body.name ?? "Preview",
      confidence,
      vendorName: body.vendorName ?? null,
    });
    res.json({
      draft,
      template: { id: "preview", name: body.name ?? "Preview", confidence },
      errors: [],
    });
  }),
);
