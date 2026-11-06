import type { ReceiptReconciliation } from "./types.js";

/**
 * Check that the product lines of a receipt add up to the printed total.
 *
 * Sign conventions follow the parsers:
 *  - Templates (Lidl, Sklavenitis, custom) subtract a product's discount from
 *    its own line, so `lineTotal` is already net and `discount` only records
 *    how much was taken off. `savings` is the sum of those discounts.
 *  - The generic parser skips discount lines entirely: lines stay gross and
 *    the discounts only appear in `savings`.
 *  - AI drafts may do either.
 *
 * Savings that are not attributed to a line are therefore subtracted once.
 * When a line carries a discount but the line total may still be gross (an AI
 * draft), the variant that subtracts every saving is tried too and the closer
 * one wins.
 */
export interface ReconcileLine {
  quantity?: number | null;
  unitPrice?: number | null;
  lineTotal?: number | null;
  discount?: number | null;
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function reconciliationTolerance(printedTotal: number): number {
  return Math.max(0.05, Math.abs(printedTotal) * 0.02);
}

export function reconcileReceipt(input: {
  total: number | null | undefined;
  savings: number | null | undefined;
  lines: ReconcileLine[];
}): ReceiptReconciliation {
  let linesTotal = 0;
  let lineDiscounts = 0;
  for (const line of input.lines) {
    const quantity = finite(line.quantity) ?? 1;
    const lineTotal = finite(line.lineTotal);
    const unitPrice = finite(line.unitPrice);
    linesTotal += lineTotal ?? (unitPrice != null ? unitPrice * quantity : 0);
    lineDiscounts += Math.abs(finite(line.discount) ?? 0);
  }
  linesTotal = money(linesTotal);
  lineDiscounts = money(lineDiscounts);
  const printedSavings = finite(input.savings);
  const savings = money(Math.max(0, printedSavings ?? lineDiscounts));
  const printedTotal = finite(input.total);

  // Savings already folded into the line totals vs. a receipt-level discount.
  const unattributed = Math.max(0, savings - lineDiscounts);
  const expected = money(linesTotal - unattributed);
  const expectedGross = money(linesTotal - savings);

  if (printedTotal == null) {
    return { linesTotal, savings, printedTotal: null, difference: null, ok: false };
  }
  const primary = money(printedTotal - expected);
  const alternative = money(printedTotal - expectedGross);
  const difference = lineDiscounts > 0 && Math.abs(alternative) < Math.abs(primary) ? alternative : primary;
  return {
    linesTotal,
    savings,
    printedTotal: money(printedTotal),
    difference,
    ok: Math.abs(difference) <= reconciliationTolerance(printedTotal),
  };
}

/** Smaller is better; an unknown total never beats a known one. */
export function reconciliationGap(value: ReceiptReconciliation | null | undefined): number {
  if (!value || value.difference == null) return Number.POSITIVE_INFINITY;
  return Math.abs(value.difference);
}
