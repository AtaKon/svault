import type { ReceiptDraft } from "../../shared/types.js";
import { reconcileReceipt } from "../../shared/receipt-reconcile.js";
import { lidlExcludedCharges } from "./receipt-lidl.js";
import type { SelectedReceiptTemplate } from "./receipt-templates.js";

function evidence(draft: ReceiptDraft, text: string, templateId: string) {
  const check = reconcileReceipt({ total: draft.total, savings: draft.savings, lines: draft.lines });
  const charges = templateId === "lidl-gr" ? lidlExcludedCharges(text) : 0;
  const gap = check.difference == null ? Infinity : Math.abs(check.difference - charges);
  const priced = draft.lines.filter((line) => line.lineTotal != null || line.unitPrice != null).length;
  const barcodes = draft.lines.flatMap((line) => line.barcode ? [line.barcode] : []);
  const inconsistent = draft.lines.filter((line) => {
    if (line.lineTotal == null || line.unitPrice == null || line.quantity <= 0) return false;
    return Math.abs(line.quantity * line.unitPrice - line.lineTotal) > 0.03;
  }).length;
  return { gap, priced, barcodes, inconsistent };
}

/** Select an alternative only when it has stronger arithmetic and no loss of known lines or barcodes. */
export function selectOcrCandidate(
  original: string,
  alternatives: string[],
  template: SelectedReceiptTemplate,
  currency: string | null,
): { text: string; draft: ReceiptDraft; changed: boolean } {
  let text = original;
  let draft = template.parse(original, currency);
  let best = evidence(draft, text, template.id);
  // A total from the original pass anchors comparisons; never replace a
  // manually supplied or incomplete reading merely because it looks longer.
  if (draft.total == null || !draft.lines.length || !Number.isFinite(best.gap)) return { text, draft, changed: false };
  const anchorTotal = draft.total;
  for (const candidate of alternatives) {
    const parsed = template.parse(candidate, currency);
    if (parsed.total == null || Math.abs(parsed.total - anchorTotal) > 0.001) continue;
    const next = evidence(parsed, candidate, template.id);
    const remaining = [...next.barcodes];
    const keepsBarcodes = best.barcodes.every((barcode) => {
      const index = remaining.indexOf(barcode);
      if (index < 0) return false;
      remaining.splice(index, 1);
      return true;
    });
    if (parsed.lines.length < draft.lines.length || next.priced < best.priced || !keepsBarcodes ||
        next.inconsistent > best.inconsistent || next.gap + 0.009 >= best.gap) continue;
    text = candidate;
    draft = parsed;
    best = next;
  }
  return { text, draft, changed: text !== original };
}

/** Flag conflicting numeric readings even when the preferred one balances. */
export function hasOcrNumericDisagreement(draft: ReceiptDraft, alternatives: string[], template: SelectedReceiptTemplate, currency: string | null): boolean {
  const signature = (value: ReceiptDraft) => JSON.stringify(value.lines.map((line) => [line.quantity, line.unitPrice, line.lineTotal, line.barcode]));
  const original = signature(draft);
  return alternatives.some((text) => {
    const other = template.parse(text, currency);
    return other.lines.length > 0 && other.total != null && draft.total != null &&
      Math.abs(other.total - draft.total) < 0.001 && signature(other) !== original;
  });
}
