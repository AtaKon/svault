import { all, parseJson } from "../db.js";
import type { ReceiptDraft, ReceiptTemplate, ReceiptTemplateRules } from "../../shared/types.js";
import { LIDL_TEMPLATE_RULES, SKLAVENITIS_TEMPLATE_RULES } from "../../shared/receipt-template-example.js";
import { lidlConfidence, parseLidlReceipt } from "./receipt-lidl.js";
import { parseSklavenitisReceipt, sklavenitisConfidence } from "./receipt-sklavenitis.js";
import { parseWithTemplateRules, templateDetectionScore, validateTemplateRules } from "./receipt-template-engine.js";

export interface SelectedReceiptTemplate extends ReceiptTemplate {
  confidence: number;
  parse: (text: string, currency: string | null) => ReceiptDraft;
}

export function serializeTemplateRow(row: any): ReceiptTemplate {
  return {
    id: row.id,
    name: row.name,
    country: row.country,
    vendorName: row.vendor_name ?? null,
    active: row.active === 1 || row.active === true,
    builtIn: false,
    version: Number(row.version ?? 1),
    rules: parseJson<ReceiptTemplateRules>(row.rules, { keywords: [], product: { pattern: "" } }),
    updatedAt: row.updated_at,
  };
}

export async function listCustomTemplates(houseId: string): Promise<ReceiptTemplate[]> {
  return (await all<any>("SELECT * FROM receipt_templates WHERE house_id = ? ORDER BY lower(name)", [houseId])).map(
    serializeTemplateRow,
  );
}

export function builtInTemplates(): ReceiptTemplate[] {
  return [
    {
      id: "lidl-gr",
      name: "Lidl Greece",
      country: "GR",
      vendorName: "Lidl",
      active: true,
      builtIn: true,
      version: 1,
      rules: LIDL_TEMPLATE_RULES,
      updatedAt: new Date(0).toISOString(),
    },
    {
      id: "sklavenitis-gr",
      name: "Sklavenitis Greece",
      country: "GR",
      vendorName: "Σκλαβενίτης",
      active: true,
      builtIn: true,
      version: 1,
      rules: SKLAVENITIS_TEMPLATE_RULES,
      updatedAt: new Date(0).toISOString(),
    },
  ];
}

export async function selectReceiptTemplate(rawText: string, houseId: string): Promise<SelectedReceiptTemplate | null> {
  const candidates: SelectedReceiptTemplate[] = [];
  const builtIns = builtInTemplates();

  const lidl = builtIns.find((template) => template.id === "lidl-gr");
  if (lidl) {
    const confidence = lidlConfidence(rawText);
    if (confidence >= (LIDL_TEMPLATE_RULES.threshold ?? 0.7)) {
      candidates.push({
        ...lidl,
        confidence,
        parse: (text, currency) => ({
          ...parseLidlReceipt(text, currency),
          templateId: "lidl-gr",
          templateConfidence: confidence,
        }),
      });
    }
  }

  const sklavenitis = builtIns.find((template) => template.id === "sklavenitis-gr");
  if (sklavenitis) {
    const confidence = sklavenitisConfidence(rawText);
    if (confidence >= (SKLAVENITIS_TEMPLATE_RULES.threshold ?? 0.7)) {
      candidates.push({
        ...sklavenitis,
        confidence,
        parse: (text, currency) => ({
          ...parseSklavenitisReceipt(text, currency),
          templateId: "sklavenitis-gr",
          templateConfidence: confidence,
        }),
      });
    }
  }

  for (const template of await listCustomTemplates(houseId)) {
    if (!template.active) continue;
    const errors = validateTemplateRules(template.rules);
    if (errors.length) continue;
    const confidence = templateDetectionScore(template.rules, rawText);
    if (confidence < (template.rules.threshold ?? 0.7)) continue;
    candidates.push({
      ...template,
      confidence,
      parse: (text, currency) =>
        parseWithTemplateRules(text, template.rules, {
          id: template.id,
          name: template.name,
          confidence,
          vendorName: template.vendorName,
          currency,
        }),
    });
  }

  return candidates.sort((a, b) => b.confidence - a.confidence)[0] ?? null;
}
