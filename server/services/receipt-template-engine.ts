import type { ReceiptDraft, ReceiptTemplateRules, TaxBreakdownEntry } from "../../shared/types.js";
import { detectDate, parseAmount, parseQuantity } from "./receipt-local.js";

const MONEY = /-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|-?\d+[.,]\d{2}/g;

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeOcrLine(line: string): string {
  return line
    .replace(/(?<![\p{L}])[ΘθΟοΒβ](?=[,.\d])/gu, "0")
    .replace(/(?<=[\d,.])[ΘθΟο]/gu, "0")
    .replace(/(?<=\d)([.,])\s+(\d)/g, "$1$2");
}

function normalizeLooseDecimals(line: string): string {
  return line.replace(/(\d{1,3})\s+(\d{2})(?!\d)/g, "$1.$2");
}

function moneyTokens(text: string): number[] {
  return [...text.matchAll(new RegExp(MONEY, "g"))]
    .map((match) => parseAmount(match[0]))
    .filter((value): value is number => value != null && Number.isFinite(value));
}

function compile(pattern: string, errors: string[], label: string): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, "iu");
  } catch (error) {
    errors.push(`${label}: ${error instanceof Error ? error.message : "invalid regular expression"}`);
    return null;
  }
}

function groupValue(groups: Record<string, string | undefined> | undefined, ...names: string[]): string | null {
  if (!groups) return null;
  for (const name of names) {
    const value = groups[name];
    if (value != null && value !== "") return value;
  }
  return null;
}

export interface CompiledTemplateRules {
  rules: ReceiptTemplateRules;
  product: RegExp | null;
  ignore: RegExp[];
  quantity: RegExp[];
  weight: RegExp[];
  discount: RegExp[];
  savings: RegExp[];
  sectionStart: RegExp[];
  sectionEnd: RegExp[];
  taxStart: RegExp[];
  taxRow: RegExp | null;
  taxSummary: RegExp | null;
  totalPattern: RegExp | null;
  errors: string[];
}

export function compileTemplateRules(rules: ReceiptTemplateRules): CompiledTemplateRules {
  const errors: string[] = [];
  const compileList = (patterns: string[] | undefined, label: string) =>
    (patterns ?? []).map((pattern, index) => compile(pattern, errors, `${label} ${index + 1}`)).filter((value): value is RegExp => value != null);

  const product = compile(rules.product?.pattern ?? "", errors, "Product pattern");
  if (!rules.product?.pattern) errors.push("Product pattern is required");
  if (product) {
    const groups = rules.product.pattern.match(/\(\?<([A-Za-z][A-Za-z0-9_]*)>/g)?.map((entry) => entry.slice(3, -1)) ?? [];
    if (!groups.includes("name")) errors.push("Product pattern needs a (?<name>...) group");
  }
  if (!rules.keywords?.length) errors.push("At least one detection keyword is required");

  return {
    rules,
    product,
    ignore: compileList(rules.product?.ignore, "Ignore pattern"),
    quantity: compileList(rules.quantity, "Quantity pattern"),
    weight: compileList(rules.weight, "Weight pattern"),
    discount: compileList(rules.discount?.patterns, "Discount pattern"),
    savings: compileList(rules.savings?.patterns, "Savings pattern"),
    sectionStart: compileList(rules.sections?.start, "Section start"),
    sectionEnd: compileList(rules.sections?.end, "Section end"),
    taxStart: compileList(rules.tax?.start, "Tax start"),
    taxRow: compile(rules.tax?.rowPattern ?? "", errors, "Tax row pattern"),
    taxSummary: compile(rules.tax?.summaryPattern ?? "", errors, "Tax summary pattern"),
    totalPattern: compile(rules.total?.pattern ?? "", errors, "Total pattern"),
    errors,
  };
}

export function validateTemplateRules(rules: ReceiptTemplateRules): string[] {
  return compileTemplateRules(rules).errors;
}

export function templateDetectionScore(rules: ReceiptTemplateRules, text: string): number {
  const haystack = String(text ?? "").toUpperCase();
  const matches = (rules.keywords ?? []).filter((keyword) => haystack.includes(keyword.toUpperCase())).length;
  if (!matches) return 0;
  return Math.min(0.98, 0.72 + matches * 0.05);
}

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

function applyDiscount(line: DraftProductLine, amount: number) {
  const value = Math.abs(amount);
  line.discount = round(line.discount + value, 2);
  const total = line.lineTotal ?? (line.unitPrice != null ? line.unitPrice * line.quantity : 0);
  line.lineTotal = round(Math.max(0, total - value), 2);
  if (line.quantity > 0) line.unitPrice = round(line.lineTotal / line.quantity, 4);
}

function discountAmount(line: string, match: RegExpExecArray | null): number | null {
  if (!match) return null;
  const withoutRate = line.replace(/\d{1,2}(?:[.,]\d+)?\s*%\s*$/, "");
  const tokens = moneyTokens(withoutRate);
  return (
    parseAmount(groupValue(match.groups, "amount") ?? "") ??
    tokens.find((value) => value < 0) ??
    tokens.pop() ??
    null
  );
}

function reconcileUnitPrice(line: DraftProductLine) {
  if (line.lineTotal == null || line.quantity <= 0) return;
  const effective = line.lineTotal / line.quantity;
  if (line.unitPrice == null || Math.abs(line.unitPrice - effective) > Math.max(0.02, effective * 0.1)) {
    line.unitPrice = round(effective, 4);
  }
}

export function parseWithTemplateRules(
  rawText: string,
  rules: ReceiptTemplateRules,
  meta: { id: string; name: string; confidence: number; vendorName?: string | null; currency?: string | null },
): ReceiptDraft {
  const compiled = compileTemplateRules(rules);
  if (compiled.errors.length || !compiled.product) {
    throw new Error(compiled.errors.join("; ") || "Template is not valid");
  }

  const lines = String(rawText ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const startIndex = compiled.sectionStart.length
    ? Math.max(0, lines.findIndex((line) => compiled.sectionStart.some((pattern) => pattern.test(line))))
    : 0;
  let endIndex = compiled.sectionEnd.length
    ? lines.findIndex((line, index) => index > startIndex && compiled.sectionEnd.some((pattern) => pattern.test(line)))
    : -1;
  if (endIndex < 0) endIndex = lines.length;

  let total: number | null = null;
  if (compiled.totalPattern) {
    for (let index = startIndex; index <= endIndex && index < lines.length; index++) {
      const match = compiled.totalPattern.exec(normalizeOcrLine(lines[index]));
      if (!match) continue;
      const grouped = parseAmount(groupValue(match.groups, "total") ?? "");
      total = grouped ?? moneyTokens(lines[index].slice(match[0].length))[0] ?? null;
      break;
    }
  }
  if (total == null && endIndex < lines.length) total = moneyTokens(lines[endIndex])[0] ?? null;

  const products: DraftProductLine[] = [];
  let current: DraftProductLine | null = null;
  let pendingDiscount = false;
  let lineSavings = 0;
  let summarySavings = 0;

  for (let index = startIndex; index < endIndex; index++) {
    const line = normalizeOcrLine(lines[index]);
    if (!line || /^-{2,}$/.test(line)) continue;

    const savingsMatch = compiled.savings.map((pattern) => pattern.exec(line)).find(Boolean);
    if (savingsMatch) {
      const amount = discountAmount(line, savingsMatch);
      if (amount != null) summarySavings = round(summarySavings + Math.abs(amount), 2);
      pendingDiscount = false;
      continue;
    }

    const discountMatch = compiled.discount.map((pattern) => pattern.exec(line)).find(Boolean);
    if (discountMatch) {
      const amount = discountAmount(line, discountMatch);
      if (amount != null) {
        if (current) applyDiscount(current, amount);
        lineSavings = round(lineSavings + Math.abs(amount), 2);
        pendingDiscount = false;
      } else {
        pendingDiscount = true;
      }
      continue;
    }

    if (pendingDiscount && /^-?\d+[.,]\d{2}$/.test(line)) {
      const amount = parseAmount(line);
      if (amount != null) {
        if (current) applyDiscount(current, amount);
        lineSavings = round(lineSavings + Math.abs(amount), 2);
      }
      pendingDiscount = false;
      continue;
    }

    const productMatch = compiled.product.exec(line);
    if (productMatch?.groups) {
      const name = String(groupValue(productMatch.groups, "name") ?? "").trim();
      if (!name) continue;
      if (compiled.ignore.some((pattern) => pattern.test(line) || pattern.test(name))) {
        current = null;
        pendingDiscount = false;
        continue;
      }
      const lineTotal =
        parseAmount(groupValue(productMatch.groups, "total") ?? "") ??
        moneyTokens(line.slice(productMatch[0].length))[0] ??
        null;
      if (lineTotal != null && lineTotal < 0) {
        if (current) applyDiscount(current, lineTotal);
        lineSavings = round(lineSavings + Math.abs(lineTotal), 2);
        pendingDiscount = false;
        continue;
      }
      const rateRaw = groupValue(productMatch.groups, "rate", "taxRate", "vat");
      current = {
        description: name.replace(/\s{2,}/g, " ").trim(),
        rawDescription: name,
        quantity: 1,
        unit: groupValue(productMatch.groups, "unit"),
        unitPrice: lineTotal,
        lineTotal,
        taxRate: rateRaw ? parseAmount(rateRaw) : null,
        discount: 0,
        barcode: null,
      };
      products.push(current);
      pendingDiscount = false;
      continue;
    }

    if (!current) continue;

    let followUp = false;
    for (const pattern of compiled.weight) {
      const match = pattern.exec(line);
      if (!match) continue;
      const quantity = parseQuantity(groupValue(match.groups, "qty", "quantity") ?? "") ?? 1;
      current.quantity = quantity > 0 ? quantity : 1;
      current.unit = groupValue(match.groups, "unit")?.toLowerCase() ?? current.unit;
      const unitPrice = parseAmount(groupValue(match.groups, "unitPrice", "price") ?? "");
      if (unitPrice != null) current.unitPrice = unitPrice;
      if (current.lineTotal == null && current.unitPrice != null) current.lineTotal = round(current.quantity * current.unitPrice, 2);
      reconcileUnitPrice(current);
      followUp = true;
      break;
    }
    if (followUp) continue;

    for (const pattern of compiled.quantity) {
      const match = pattern.exec(line);
      if (!match) continue;
      const quantity = parseQuantity(groupValue(match.groups, "qty", "quantity") ?? "") ?? 1;
      current.quantity = quantity > 0 ? quantity : 1;
      const unitPrice = parseAmount(groupValue(match.groups, "unitPrice", "price") ?? "");
      if (unitPrice != null) current.unitPrice = unitPrice;
      if (current.lineTotal == null && unitPrice != null) current.lineTotal = round(current.quantity * unitPrice, 2);
      reconcileUnitPrice(current);
      followUp = true;
      break;
    }
    if (followUp) continue;

    if (/^(συνολική|συνολικα|με το lidl plus|εξοικονομήθηκαν|εξοικονομηθηκαν)/i.test(line)) {
      pendingDiscount = false;
    }
  }

  // Savings summaries such as "You saved €3.20" are often printed after the total.
  if (compiled.savings.length) {
    for (let index = endIndex; index < lines.length; index++) {
      const line = normalizeOcrLine(lines[index]);
      const savingsMatch = compiled.savings.map((pattern) => pattern.exec(line)).find(Boolean);
      if (!savingsMatch) continue;
      const amount = discountAmount(line, savingsMatch);
      if (amount != null) summarySavings = round(summarySavings + Math.abs(amount), 2);
    }
  }

  let inTax = false;
  let summaryNet: number | null = null;
  let summaryTax: number | null = null;
  let summaryGross: number | null = null;
  const taxBreakdown: TaxBreakdownEntry[] = [];

  for (let index = endIndex; index < lines.length; index++) {
    const line = normalizeLooseDecimals(normalizeOcrLine(lines[index]));
    if (!line) continue;
    const startsTax =
      compiled.taxStart.length > 0
        ? compiled.taxStart.some((pattern) => pattern.test(line))
        : /ΦΠΑ|VAT|TAX/i.test(line);
    if (startsTax) {
      inTax = true;
      continue;
    }
    if (!inTax) continue;

    if (compiled.taxSummary) {
      const match = compiled.taxSummary.exec(line);
      if (match) {
        const amounts = moneyTokens(line.slice(match[0].length));
        summaryNet = parseAmount(groupValue(match.groups, "net", "subtotal") ?? "") ?? amounts[0] ?? null;
        summaryTax = parseAmount(groupValue(match.groups, "tax", "vat") ?? "") ?? amounts[1] ?? null;
        summaryGross = parseAmount(groupValue(match.groups, "gross", "total") ?? "") ?? amounts[2] ?? null;
        continue;
      }
    }

    if (!compiled.taxRow) continue;
    const match = compiled.taxRow.exec(line);
    if (!match) continue;
    const rate = parseAmount(groupValue(match.groups, "rate") ?? "") ?? null;
    const amounts = moneyTokens(line.slice(match[0].length));
    const net = parseAmount(groupValue(match.groups, "net") ?? "") ?? amounts[0] ?? null;
    const tax = parseAmount(groupValue(match.groups, "tax", "vat") ?? "") ?? amounts[1] ?? null;
    const gross = parseAmount(groupValue(match.groups, "gross") ?? "") ?? amounts[2] ?? null;
    if (net == null && tax == null) continue;
    taxBreakdown.push({
      rate,
      net: net ?? 0,
      tax: tax ?? 0,
      gross: gross ?? round((net ?? 0) + (tax ?? 0), 2),
    });
  }

  const breakdownNet = taxBreakdown.length ? round(taxBreakdown.reduce((sum, entry) => sum + entry.net, 0), 2) : null;
  const breakdownTax = taxBreakdown.length ? round(taxBreakdown.reduce((sum, entry) => sum + entry.tax, 0), 2) : null;
  const tax = summaryTax ?? breakdownTax;
  const subtotal = summaryNet ?? breakdownNet ?? (total != null && tax != null ? round(total - tax, 2) : null);

  return {
    vendorName: meta.vendorName ?? null,
    purchasedAt: detectDate(rawText),
    currency: /€|EUR/i.test(rawText) ? "EUR" : (meta.currency ?? null),
    total: total ?? summaryGross,
    subtotal,
    tax,
    taxBreakdown,
    templateId: meta.id,
    templateConfidence: meta.confidence,
    savings: summarySavings > 0 ? summarySavings : lineSavings > 0 ? lineSavings : null,
    notes: null,
    lines: products.map((line) => ({
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
