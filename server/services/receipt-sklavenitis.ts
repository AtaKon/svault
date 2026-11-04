import type { ReceiptDraft } from "../../shared/types.js";
import { detectDate, parseAmount, parseQuantity } from "./receipt-local.js";

/**
 * Sklavenitis Greece receipt template.
 *
 * The layout is consistent across the chain's registers:
 *   header (ΕΛΛΗΝΙΚΕΣ ΥΠΕΡΑΓΟΡΕΣ / ΣΚΛΑΒΕΝΙΤΗΣ Α.Ε.Ε. / SUPER MARKETS)
 *   ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ ΠΩΛΗΣΗΣ
 *   optional barcode line
 *   product name with total and VAT rate, or the name alone
 *   optional "<qty> [x] <unit price> [total] [VAT%]" follow-up line
 *   optional "ΕΚΠΤΩΣΗ <product> -amount VAT%"
 *   ΣΥΝΟΛΟ <total> ΕΥΡΩ
 *
 * Unlike Lidl, Sklavenitis prints the item barcode before each product, so the
 * barcode is kept on the draft line and can be used when importing to stock.
 */

const BARCODE_LINE = /^\d{6,14}$/;

const COMPACT_PRODUCT =
  /^(?!ΕΚΠΤΩΣΗ)(?<name>[\p{L}].*?)\s+(?<total>-?\d{1,4}[.,]\d{2})\s*(?:€|EUR)?(?:\s+(?<rate>\d{1,2}(?:[.,]\d+)?)\s*%)?(?:\s*[A-ZΑ-Ω])?\s*$/iu;

const PRODUCT_NAME_ONLY = /^(?!ΕΚΠΤΩΣΗ)(?<name>[\p{L}][\p{L}\p{N} .,%/&+*()'\-–]*?)\s*$/iu;

const TOTAL_RATE_ONLY =
  /^(?<total>-?\d{1,4}[.,]\d{2})\s*(?:€|EUR)?(?:\s+(?<rate>\d{1,2}(?:[.,]\d+)?)\s*%)?\s*$/iu;

const QUANTITY_LINE =
  /^(?<qty>\d+(?:[.,]\d+)?)\s*(?<unit>kg|g|l|ml)?\s*(?:[x×Χχ*]\s*)?(?<unitPrice>\d+[.,]\d{2})(?:\s+(?<total>\d+[.,]\d{2}))?(?:\s+(?<rate>\d{1,2}(?:[.,]\d+)?)\s*%)?\s*$/iu;

const DISCOUNT_LINE = /^ΕΚΠΤΩΣΗ(?:\s|$)/i;
const SAVINGS_LINE =
  /^(?:ΣΥΝΟΛΟ\s+ΕΚΠΤΩΣΕΩΝ|ΣΥΝΟΛΙΚΗ\s+ΕΚΠΤΩΣΗ|ΕΞΟΙΚΟΝΟΜΗΣ(?:Η|ΑΤΕ|ΗΚΕ)|YOU\s+SAVED|TOTAL\s+DISCOUNT)(?:\s|:|$)/i;

/** Fold look-alike Latin characters so OCR'd totals still match ΣΥΝΟΛΟ. */
function isTotalLine(text: string): boolean {
  const folded = text
    .trim()
    .replace(/^[^\p{L}\d]+/u, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/Y/g, "Υ")
    .replace(/[O0]/g, "Ο")
    .replace(/N/g, "Ν")
    .replace(/S/g, "Σ");
  return /^ΣΥΝΟΛΟ(?!\s+(?:ΕΚΠΤΩΣΕΩΝ|ΕΙΔΩΝ|ΠΟΣΟΤΗΤ|ΤΕΜΑΧΙ))(?=$|[\s:.\d])/u.test(folded);
}
const SECTION_START = /ΑΠΟΔΕΙΞΗ\s+ΛΙΑΝΙΚΗΣ\s+ΠΩΛΗΣΗΣ/i;
const NON_PRODUCT =
  /^(?:ΕΛΛΗΝΙΚΕΣ|ΣΚΛΑΒΕΝΙΤΗΣ|SUPER|Υ\/Α|ΑΦΜ|ΤΑΜΕΙΟ|ΑΠΟΔΕΙΞΗ|ΗΜΕΡ|ΩΡΑ|Α\/Α|ΣΕΙΡΑ|ΠΩΛΗΘΕΝΤΑ|EFT|ΜΕΤΡΗΤΑ|ΚΑΡΤΑ|ΠΑΡΟΧΟΣ|URL|UID|ΑΔΕΙΑ|ΝΟΜΙΜΗ|ΡΕΣΤΑ|ΠΛΗΡΩΜ|ΦΠΑ|Φ\.Π\.Α|ΣΥΝΟΛΟ|ΕΚΠΤΩΣ|ΕΞΟΙΚΟΝΟΜ|VISA|MASTERCARD)/i;
const PHONE_LINE = /ΤΗΛ\.?\s*[:.]?\s*\d/i;
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
  barcode: string | null;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Repair common Tesseract confusions in numeric columns without touching words. */
function normalizeOcrLine(line: string): string {
  return line
    .replace(/(?<![\p{L}])[ΘθΟοO0](?=[,.]\d|\d)/gu, "0")
    .replace(/(?<![\p{L}])[Ββ](?=[,.]\d|\d)/gu, "8")
    .replace(/(?<=[\d,.])[ΘθΟοO]+(?=[,.\d%]|$)/gu, (match) => "0".repeat(match.length))
    .replace(/(?<=[\d,.])[Ββ](?=[,.\d%]|$)/gu, "8")
    .replace(/(?<=[\d,.])[Il|](?=[,.\d])/g, "1")
    .replace(/(?<=\d)([.,])\s+(\d)/g, "$1$2");
}

function moneyTokens(text: string): number[] {
  return [...text.matchAll(new RegExp(MONEY, "g"))]
    .map((match) => parseAmount(match[0]))
    .filter((value): value is number => value != null && Number.isFinite(value));
}

/** Discount/savings amount on a line, ignoring a trailing VAT percentage. */
function lineAmount(line: string): number | null {
  const withoutRate = line.replace(/\d{1,2}(?:[.,]\d+)?\s*%\s*$/, "");
  const tokens = moneyTokens(withoutRate);
  return tokens.find((value) => value < 0) ?? tokens.pop() ?? null;
}

function cleanName(raw: string): string {
  return raw
    .replace(/^[*#\-\s]+/, "")
    .replace(/\s+/g, " ")
    .replace(/\s*\*+\s*$/, "")
    .replace(/[.;,:]+$/, "")
    .trim()
    .slice(0, 160);
}

function applyDiscount(line: DraftProductLine, amount: number) {
  const value = Math.abs(amount);
  line.discount = round(line.discount + value, 2);
  const total = line.lineTotal ?? (line.unitPrice != null ? line.unitPrice * line.quantity : null);
  if (total == null) return;
  line.lineTotal = round(Math.max(0, total - value), 2);
  if (line.quantity > 0) line.unitPrice = round(line.lineTotal / line.quantity, 4);
}

export function sklavenitisConfidence(text: string): number {
  const value = String(text ?? "");
  let score = 0;
  if (/ΣΚΛΑΒΕΝΙΤΗΣ/i.test(value)) score += 0.5;
  if (/ΕΛΛΗΝΙΚΕΣ\s+ΥΠΕΡΑΓΟΡΕΣ/i.test(value)) score += 0.35;
  if (/ΑΠΟΔΕΙΞΗ\s+ΛΙΑΝΙΚΗΣ\s+ΠΩΛΗΣΗΣ/i.test(value)) score += 0.35;
  if (/SUPER\s+MARKETS/i.test(value)) score += 0.1;
  return Math.min(0.99, score);
}

export function parseSklavenitisReceipt(rawText: string, fallbackCurrency: string | null = null): ReceiptDraft {
  const lines = String(rawText ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const headerIndex = lines.findIndex((line) => SECTION_START.test(line));
  const superMarketsIndex = lines.findIndex((line) => /SUPER\s+MARKETS/i.test(line));
  const productStart = headerIndex >= 0 ? headerIndex + 1 : superMarketsIndex >= 0 ? superMarketsIndex + 1 : 0;
  let productEnd = lines.findIndex((line, index) => index >= productStart && isTotalLine(line));
  if (productEnd < 0) productEnd = lines.length;

  const products: DraftProductLine[] = [];
  let current: DraftProductLine | null = null;
  let pendingBarcode: string | null = null;
  let pendingDiscount = false;
  let lineSavings = 0;
  let summarySavings = 0;

  for (let index = productStart; index < productEnd; index++) {
    const rawLine = lines[index].trim();
    const line = normalizeOcrLine(rawLine);
    if (!line || /^-{2,}$/.test(line)) continue;

    if (BARCODE_LINE.test(line)) {
      pendingBarcode = line;
      continue;
    }

    if (SAVINGS_LINE.test(line)) {
      const amount = lineAmount(line);
      if (amount != null) summarySavings = round(summarySavings + Math.abs(amount), 2);
      pendingDiscount = false;
      continue;
    }

    if (DISCOUNT_LINE.test(line)) {
      const amount = lineAmount(line);
      if (amount != null) {
        lineSavings = round(lineSavings + Math.abs(amount), 2);
        if (current) applyDiscount(current, amount);
        pendingDiscount = false;
      } else {
        pendingDiscount = true;
      }
      continue;
    }

    if (pendingDiscount) {
      const amount = moneyTokens(line).find((value) => value < 0) ?? (/^-?\d+[.,]\d{2}$/.test(line) ? parseAmount(line) : null);
      if (amount != null) {
        lineSavings = round(lineSavings + Math.abs(amount), 2);
        if (current) applyDiscount(current, amount);
        pendingDiscount = false;
        continue;
      }
    }

    // A quantity/weight follow-up can end in a price too; it belongs to the
    // previous product rather than starting a new one.
    const followUp = QUANTITY_LINE.test(line);
    const compact = followUp ? null : line.match(COMPACT_PRODUCT);
    if (compact?.groups) {
      const name = String(compact.groups.name ?? "").trim();
      const parsedTotal = parseAmount(compact.groups.total ?? "");
      const lineTotal = parsedTotal != null ? Math.max(0, parsedTotal) : null;
      const taxRate = parseAmount(compact.groups.rate ?? "");
      current = {
        description: cleanName(name),
        rawDescription: name.slice(0, 200),
        quantity: 1,
        unit: null,
        unitPrice: lineTotal,
        lineTotal,
        taxRate,
        discount: 0,
        barcode: pendingBarcode,
      };
      products.push(current);
      pendingBarcode = null;
      pendingDiscount = false;
      continue;
    }

    if (current) {
      const totalRate = line.match(TOTAL_RATE_ONLY);
      if (totalRate?.groups) {
        const total = parseAmount(totalRate.groups.total ?? "");
        const rate = parseAmount(totalRate.groups.rate ?? "");
        if (total != null && total < 0) {
          // A discount whose "ΕΚΠΤΩΣΗ" label was lost by OCR still belongs to the previous line.
          lineSavings = round(lineSavings + Math.abs(total), 2);
          applyDiscount(current, total);
          continue;
        }
        if (total != null) current.lineTotal = total;
        if (rate != null) current.taxRate = rate;
        if (current.unitPrice == null && current.lineTotal != null && current.quantity > 0) {
          current.unitPrice = round(current.lineTotal / current.quantity, 4);
        }
        continue;
      }

      const quantityLine = line.match(QUANTITY_LINE);
      if (quantityLine?.groups) {
        const qtyRaw = quantityLine.groups.qty ?? "";
        const qty = parseQuantity(qtyRaw) ?? 1;
        current.quantity = qty > 0 ? qty : 1;
        const unitPrice = parseAmount(quantityLine.groups.unitPrice ?? "");
        if (unitPrice != null) current.unitPrice = unitPrice;
        const total = parseAmount(quantityLine.groups.total ?? "");
        if (total != null) current.lineTotal = total;
        else if (current.lineTotal == null && current.unitPrice != null) {
          current.lineTotal = round(current.unitPrice * current.quantity, 2);
        }
        const rate = parseAmount(quantityLine.groups.rate ?? "");
        if (rate != null) current.taxRate = rate;
        const unit = quantityLine.groups.unit?.toLowerCase();
        current.unit = unit ?? (/[.,]/.test(qtyRaw) ? "kg" : current.unit);
        if (current.unitPrice == null && current.lineTotal != null && current.quantity > 0) {
          current.unitPrice = round(current.lineTotal / current.quantity, 4);
        }
        continue;
      }
    }

    const nameOnly = line.match(PRODUCT_NAME_ONLY);
    if (nameOnly?.groups) {
      const name = String(nameOnly.groups.name ?? "").trim();
      if (!name || NON_PRODUCT.test(name) || PHONE_LINE.test(name)) {
        current = null;
        pendingDiscount = false;
        continue;
      }
      // A wrapped product name (for example "... ΝΩΠΟ" / "ΣΤΙΚΕΡ") arrives without a new barcode.
      if (!pendingBarcode && current && current.lineTotal == null && current.unitPrice == null && current.quantity === 1) {
        current.description = `${current.description} ${cleanName(name)}`.trim().slice(0, 160);
        current.rawDescription = `${current.rawDescription} ${name}`.trim().slice(0, 200);
        continue;
      }
      current = {
        description: cleanName(name),
        rawDescription: name.slice(0, 200),
        quantity: 1,
        unit: null,
        unitPrice: null,
        lineTotal: null,
        taxRate: null,
        discount: 0,
        barcode: pendingBarcode,
      };
      products.push(current);
      pendingBarcode = null;
      pendingDiscount = false;
      continue;
    }
  }

  // Savings summaries such as "ΣΥΝΟΛΙΚΗ ΕΚΠΤΩΣΗ" are often printed below the total.
  for (let index = productEnd; index < lines.length; index++) {
    const line = normalizeOcrLine(lines[index]);
    if (!SAVINGS_LINE.test(line)) continue;
    const amount = lineAmount(line);
    if (amount != null) summarySavings = round(summarySavings + Math.abs(amount), 2);
  }

  let total: number | null = null;
  if (productEnd < lines.length) {
    total = moneyTokens(normalizeOcrLine(lines[productEnd])).find((value) => value >= 0) ?? null;
    if (total == null && productEnd + 1 < lines.length) {
      total = moneyTokens(normalizeOcrLine(lines[productEnd + 1])).find((value) => value >= 0) ?? null;
    }
  }

  return {
    vendorName: "Σκλαβενίτης",
    purchasedAt: detectDate(rawText),
    currency: /€|EUR/i.test(rawText) ? "EUR" : fallbackCurrency,
    total,
    subtotal: null,
    tax: null,
    taxBreakdown: [],
    savings: summarySavings > 0 ? summarySavings : lineSavings > 0 ? lineSavings : null,
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
        barcode: line.barcode,
      })),
  };
}
