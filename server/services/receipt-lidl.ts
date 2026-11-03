import type { ReceiptDraft, TaxBreakdownEntry } from "../../shared/types.js";
import { detectDate, parseAmount, parseQuantity } from "./receipt-local.js";

/**
 * Lidl Greece receipt template.
 *
 * The layout is stable enough to parse deterministically:
 *   product name + line total + VAT rate
 *   optional "2 x 1.99" or "0.984 kg x 1.19 EUR/kg" follow-up
 *   optional "έκπτωση Lidl Plus" + negative amount
 *   ΣΥΝΟΛΟ / ΚΑΡΤΑ / VAT table at the bottom
 */

const PRODUCT_LINE = /^(?<name>.+?)\s+(?<total>-?\d{1,4}[.,]\d{2})\s+(?<rate>\d{1,2}(?:[.,]\d+)?)\s*%\s*$/;
const QUANTITY_LINE = /^(?<qty>\d+(?:[.,]\d+)?)\s*[x×]\s*(?<unitPrice>\d+[.,]\d{2})\s*$/i;
const WEIGHT_LINE =
  /^(?<qty>\d+(?:[.,]\d+)?)\s*(?<unit>kg|g|l|ml)\s*[x×]\s*(?<unitPrice>\d+[.,]\d{2})(?:\s*(?:EUR|€)\s*\/\s*(?:kg|g|l|ml))?\s*$/i;
const DISCOUNT_LINE = /κπτωση|discount/i;
const AMOUNT_LINE = /^-?\d+[.,]\d{2}$/;
const NON_PRODUCT_LINE =
  /^(?:ΤΣ\.?Π\.?ΧΡ|ΣΑΚΟΥ|ΠΕΡΙΒΑΝ\.?ΤΕΛΟΣ|ΧΑΡΤΟΣΑΚΟΥΛ|ΕΝΟΙΚΙΑΣΗ|ΕΓΓΥΗΣΗ)/i;
const MONEY = /-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|-?\d+[.,]\d{2}/g;

interface DraftProductLine {
  description: string;
  rawDescription: string;
  quantity: number;
  unit: string | null;
  unitPrice: number | null;
  lineTotal: number | null;
  taxRate: number | null;
  discount: number;
  barcode: null;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Repair common Tesseract confusions in numeric columns without touching words. */
function normalizeOcrLine(line: string): string {
  return line
    .replace(/(?<![\p{L}])[ΘθΟοΒβ](?=[,.\d])/gu, "0")
    .replace(/(?<=[\d,.])[ΘθΟο]/gu, "0")
    .replace(/(?<=\d)([.,])\s+(\d)/g, "$1$2");
}

/** Tax tables often lose the decimal separator: "24 87" means 24.87. */
function normalizeLooseDecimals(line: string): string {
  return line.replace(/(\d{1,3})\s+(\d{2})(?!\d)/g, "$1.$2");
}

function moneyTokens(text: string): number[] {
  return [...text.matchAll(new RegExp(MONEY, "g"))]
    .map((match) => parseAmount(match[0]))
    .filter((value): value is number => value != null && Number.isFinite(value));
}

function cleanProductName(raw: string): string {
  return raw
    .replace(/\s+-?\d{6,}\s*$/, "") // Lidl article numbers such as -0523350
    .replace(/\s+\*+\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function applyDiscount(line: DraftProductLine, amount: number) {
  const value = Math.abs(amount);
  line.discount = round(line.discount + value, 2);
  const total = line.lineTotal ?? (line.unitPrice != null ? line.unitPrice * line.quantity : 0);
  line.lineTotal = round(Math.max(0, total - value), 2);
  if (line.quantity > 0) line.unitPrice = round(line.lineTotal / line.quantity, 4);
}

export function lidlConfidence(text: string): number {
  const value = String(text ?? "");
  let score = 0;
  if (/\bLIDL\b/i.test(value)) score += 0.5;
  if (/ΛΙΝΤΑ\s+ΕΛΛΑΣ/i.test(value)) score += 0.5;
  if (/LIDL\s*PLUS|lidlplus/i.test(value)) score += 0.1;
  if (/ΦΟΡΟΛΟΓΙΚΗ\s+ΑΠΟΔΕΙΞΗ/i.test(value)) score += 0.1;
  if (/ΦΤΙΑΞ/i.test(value)) score += 0.1;
  return Math.min(0.99, score);
}

export function parseLidlReceipt(rawText: string, fallbackCurrency: string | null = null): ReceiptDraft {
  const lines = String(rawText ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const headerIndex = lines.findIndex((line) => /ΦΟΡΟΛΟΓΙΚΗ\s+ΑΠΟΔΕΙΞΗ/i.test(line));
  const productStart = headerIndex >= 0 ? headerIndex + 1 : 0;
  let productEnd = lines.findIndex(
    (line, index) => index >= productStart && /^ΣΥΝΟΛΟ(?!\s+ΕΚΠΤΩΣΕΩΝ)(?:\s|$)/i.test(line),
  );
  if (productEnd < 0) productEnd = lines.length;

  const total = productEnd < lines.length ? moneyTokens(lines[productEnd])[0] ?? null : null;

  const products: DraftProductLine[] = [];
  let current: DraftProductLine | null = null;
  let pendingDiscount = false;
  let savings = 0;

  for (let i = productStart; i < productEnd; i++) {
    const rawLine = lines[i].trim();
    const line = normalizeOcrLine(rawLine);
    if (!line || /^-{2,}$/.test(line)) continue;

    const productMatch = line.match(PRODUCT_LINE);
    if (productMatch?.groups) {
      if (NON_PRODUCT_LINE.test(productMatch.groups.name)) {
        current = null;
        pendingDiscount = false;
        continue;
      }
      const lineTotal = parseAmount(productMatch.groups.total);
      const taxRate = parseAmount(productMatch.groups.rate);
      current = {
        description: cleanProductName(productMatch.groups.name),
        rawDescription: productMatch.groups.name.trim(),
        quantity: 1,
        unit: null,
        unitPrice: lineTotal,
        lineTotal,
        taxRate,
        discount: 0,
        barcode: null,
      };
      products.push(current);
      pendingDiscount = false;
      continue;
    }

    if (!current) continue;

    const weightMatch = line.match(WEIGHT_LINE);
    if (weightMatch?.groups) {
      const quantity = parseQuantity(weightMatch.groups.qty) ?? 1;
      current.quantity = quantity > 0 ? quantity : 1;
      current.unit = weightMatch.groups.unit.toLowerCase();
      current.unitPrice = parseAmount(weightMatch.groups.unitPrice);
      if (current.lineTotal == null && current.unitPrice != null) {
        current.lineTotal = round(current.quantity * current.unitPrice, 2);
      } else if (current.lineTotal != null && current.quantity > 0) {
        const effective = current.lineTotal / current.quantity;
        if (current.unitPrice == null || Math.abs(current.unitPrice - effective) > Math.max(0.02, effective * 0.1)) {
          current.unitPrice = round(effective, 4);
        }
      }
      continue;
    }

    const quantityMatch = line.match(QUANTITY_LINE);
    if (quantityMatch?.groups) {
      const quantity = parseQuantity(quantityMatch.groups.qty) ?? 1;
      current.quantity = quantity > 0 ? quantity : 1;
      const unitPrice = parseAmount(quantityMatch.groups.unitPrice);
      current.unitPrice = unitPrice;
      if (current.lineTotal == null && unitPrice != null) {
        current.lineTotal = round(current.quantity * unitPrice, 2);
      } else if (current.lineTotal != null && current.quantity > 0) {
        const effective = current.lineTotal / current.quantity;
        if (unitPrice == null || Math.abs(unitPrice - effective) > Math.max(0.02, effective * 0.1)) {
          current.unitPrice = round(effective, 4);
        }
      }
      continue;
    }

    if (DISCOUNT_LINE.test(line)) {
      const amount = moneyTokens(line).pop();
      if (amount != null) {
        savings = round(savings + Math.abs(amount), 2);
        applyDiscount(current, amount);
        pendingDiscount = false;
      } else {
        pendingDiscount = true;
      }
      continue;
    }

    if (pendingDiscount && AMOUNT_LINE.test(line)) {
      const amount = parseAmount(line);
      if (amount != null) {
        savings = round(savings + Math.abs(amount), 2);
        applyDiscount(current, amount);
      }
      pendingDiscount = false;
      continue;
    }

    if (/^(συνολική|συνολικα|με το lidl plus|εξοικονομήθηκαν|εξοικονομηθηκαν)/i.test(line)) {
      pendingDiscount = false;
    }
  }

  let inTax = false;
  let summaryNet: number | null = null;
  let summaryTax: number | null = null;
  let summaryGross: number | null = null;
  const taxBreakdown: TaxBreakdownEntry[] = [];

  for (let i = productEnd; i < lines.length; i++) {
    const line = normalizeLooseDecimals(normalizeOcrLine(lines[i].trim()));
    if (!line) continue;
    if (/^(?:ΦΠΑ|Φ\.Π\.Α)/i.test(line)) {
      inTax = true;
      continue;
    }
    if (!inTax) continue;
    if (/^ΣΥΝΟΛΟ(?!\s+ΕΚΠΤΩΣΕΩΝ)(?:\s|$)/i.test(line)) {
      const amounts = moneyTokens(line);
      if (amounts.length >= 3) {
        summaryNet = amounts[0];
        summaryTax = amounts[1];
        summaryGross = amounts[2];
      } else if (amounts.length === 1 && summaryGross == null) {
        summaryGross = amounts[0];
      }
      continue;
    }
    const rateMatch = line.match(/^[A-ZΑ-Ω]\s+(?<rate>\d{1,2}(?:[.,]\d+)?)\s*%/i);
    if (!rateMatch?.groups) continue;
    const rate = parseAmount(rateMatch.groups.rate);
    const amounts = moneyTokens(line.slice(rateMatch[0].length));
    if (amounts.length >= 3) {
      taxBreakdown.push({ rate, net: amounts[0], tax: amounts[1], gross: amounts[2] });
    } else if (amounts.length === 2) {
      taxBreakdown.push({ rate, net: amounts[0], tax: amounts[1], gross: round(amounts[0] + amounts[1], 2) });
    }
  }

  const breakdownNet = taxBreakdown.length ? round(taxBreakdown.reduce((sum, entry) => sum + entry.net, 0), 2) : null;
  const breakdownTax = taxBreakdown.length ? round(taxBreakdown.reduce((sum, entry) => sum + entry.tax, 0), 2) : null;
  const tax = summaryTax ?? breakdownTax;
  const subtotal =
    summaryNet ?? breakdownNet ?? (total != null && tax != null ? round(total - tax, 2) : null);

  return {
    vendorName: "Lidl",
    purchasedAt: detectDate(rawText),
    currency: /€|EUR/i.test(rawText) ? "EUR" : fallbackCurrency,
    total: total ?? summaryGross,
    subtotal,
    tax,
    taxBreakdown,
    savings: savings > 0 ? savings : null,
    notes: null,
    lines: products
      .filter((line) => line.description.length >= 2)
      .map((line) => ({
        description: line.description,
        rawDescription: line.rawDescription,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
        taxRate: line.taxRate,
        discount: line.discount,
        barcode: null,
      })),
  };
}
