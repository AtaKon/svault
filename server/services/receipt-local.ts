import type { ReceiptDraft, TaxBreakdownEntry } from "../../shared/types.js";

/**
 * A small, deliberately conservative receipt parser. Browser OCR is noisy, so
 * this only trusts lines that look like "name ... price" and leaves the rest to
 * the user (or to an AI cleanup pass when one is configured).
 */

const UNIT_ALIASES: Record<string, string> = {
  g: "g",
  gr: "g",
  gram: "g",
  grams: "g",
  kg: "kg",
  kilo: "kg",
  kilos: "kg",
  kilogram: "kg",
  kilograms: "kg",
  mg: "mg",
  l: "l",
  lt: "l",
  ltr: "l",
  litre: "l",
  litres: "l",
  liter: "l",
  liters: "l",
  ml: "ml",
  milliliter: "ml",
  milliliters: "ml",
  cl: "cl",
  dl: "dl",
  gal: "gal",
  gallon: "gal",
  gallons: "gal",
  floz: "floz",
  pint: "pint",
  pints: "pint",
  qt: "qt",
  quart: "qt",
  quarts: "qt",
  pcs: "pcs",
  pc: "pcs",
  piece: "pcs",
  pieces: "pcs",
  unit: "pcs",
  units: "pcs",
  pack: "pack",
  packs: "pack",
  packet: "pack",
  packets: "pack",
  box: "box",
  boxes: "box",
  bag: "bag",
  bags: "bag",
  bottle: "bottle",
  bottles: "bottle",
  can: "can",
  cans: "can",
  tin: "can",
  tins: "can",
  jar: "jar",
  jars: "jar",
  tub: "tub",
  tubs: "tub",
  roll: "roll",
  rolls: "roll",
  // Greek units, with and without accents (OCR output varies).
  γρ: "g",
  γραμμάριο: "g",
  γραμμαριο: "g",
  γραμμάρια: "g",
  γραμμαρια: "g",
  κιλό: "kg",
  κιλο: "kg",
  κιλά: "kg",
  κιλα: "kg",
  λίτρο: "l",
  λιτρο: "l",
  λίτρα: "l",
  λιτρα: "l",
  λ: "l",
  χιλιοστόλιτρο: "ml",
  χιλιοστολιτρο: "ml",
  χιλιοστόλιτρα: "ml",
  χιλιοστολιτρα: "ml",
  τεμάχιο: "pcs",
  τεμαχιο: "pcs",
  τεμάχια: "pcs",
  τεμαχια: "pcs",
  τεμ: "pcs",
  φέτα: "slice",
  φετα: "slice",
  φέτες: "slice",
  φετες: "slice",
  σκελίδα: "clove",
  σκελιδα: "clove",
  σκελίδες: "clove",
  σκελιδες: "clove",
  κουτί: "box",
  κουτι: "box",
  κουτιά: "box",
  κουτια: "box",
  σακούλα: "bag",
  σακουλα: "bag",
  σακούλες: "bag",
  σακουλες: "bag",
  μπουκάλι: "bottle",
  μπουκαλι: "bottle",
  μπουκάλια: "bottle",
  μπουκαλια: "bottle",
  κονσέρβα: "can",
  κονσερβα: "can",
  κονσέρβες: "can",
  κονσερβες: "can",
  πακέτο: "pack",
  πακετο: "pack",
  πακέτα: "pack",
  πακετα: "pack",
  ρολό: "roll",
  ρολο: "roll",
  ρολά: "roll",
  ρολα: "roll",
};

const NOISE_LINE =
  /^(total|sub\s*-?\s*total|amount(\s+due)?|to\s+pay|balance|change|cash|card|visa|mastercard|maestro|amex|debit|credit|contactless|tax|vat|gst|hst|tip|service|discount|savings?|coupon|loyalty|points|invoice|receipt|order|date|time|cashier|till|terminal|auth|ref(erence)?|thank|welcome|www\.|https?:|tel|phone|address|store\s*#|shop\s*#|items? sold|qty\s+price|σύνολο|συνολο|υποσύνολο|υποσυνολο|πληρωτέο|πληρωτεο|πληρωμή|πληρωμη|μετρητά|μετρητα|κάρτα|καρτα|ρέστα|ρεστα|έκπτωση|εκπτωση|φπα|αφα|αξία|αξια|ποσό|ποσο|τζίρος|τζιρος|τεμάχια|τεμαχια|ταμείο|ταμειο|απόδειξη|αποδειξη|ημερομηνία|ημερομηνια|ώρα|ωρα|ευχαριστούμε|ευχαριστουμε|παρακαλώ|παρακαλω|δελτίο|δελτιο|τιμολόγιο|τιμολογιο)/i;

const NOISE_CONTAINS =
  /\b(vat|tax id|receipt no|order no|invoice no|cashier|terminal|card ending|barcode|thank you for shopping|keep your receipt)\b|(φπα|αφμ|γέμη|γεμη|ταμείο|ταμειο|απόδειξη|αποδειξη|μετρητά|μετρητα|κάρτα|καρτα|υποσύνολο|υποσυνολο|πληρωτέο|πληρωτεο)/i;

const MONEY = String.raw`-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|-?\d+[.,]\d{2}|-?\d+`;

/** Parse "1.234,56", "1,234.56", "12,50" or "3" into a number. */
export function parseAmount(raw: string): number | null {
  const cleaned = String(raw ?? "").replace(/[^\d.,-]/g, "");
  if (!cleaned) return null;
  const negative = cleaned.startsWith("-");
  const body = cleaned.replace(/-/g, "");
  const lastDot = body.lastIndexOf(".");
  const lastComma = body.lastIndexOf(",");
  let normalized: string;

  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? "." : ",";
    normalized = decimal === "." ? body.replace(/,/g, "") : body.replace(/\./g, "").replace(",", ".");
  } else {
    const separator = lastDot >= 0 ? "." : lastComma >= 0 ? "," : "";
    if (!separator) {
      normalized = body;
    } else {
      const parts = body.split(separator);
      if (parts.length > 2) {
        normalized = `${parts.slice(0, -1).join("")}.${parts[parts.length - 1]}`;
      } else if (parts[1].length === 2) {
        normalized = `${parts[0]}.${parts[1]}`;
      } else if (parts[1].length === 3 && parts[0].length <= 3) {
        normalized = parts.join("");
      } else {
        normalized = `${parts[0]}.${parts[1]}`;
      }
    }
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Quantities treat a lone comma as a decimal separator (1,234 kg = 1.234), unlike prices. */
export function parseQuantity(raw: string): number | null {
  const cleaned = String(raw ?? "").replace(/[^\d.,-]/g, "");
  if (!cleaned) return null;
  if (cleaned.includes(",") && !cleaned.includes(".")) {
    const negative = cleaned.startsWith("-");
    const value = Number(cleaned.replace(/-/g, "").replace(",", "."));
    if (!Number.isFinite(value)) return null;
    return negative ? -value : value;
  }
  return parseAmount(cleaned);
}

function detectCurrency(text: string): string | null {
  if (/€/.test(text)) return "EUR";
  if (/£/.test(text)) return "GBP";
  if (/¥/.test(text)) return "JPY";
  const code = text.match(/\b(EUR|USD|GBP|CHF|SEK|NOK|DKK|PLN|CZK|CAD|AUD|JPY)\b/i);
  return code ? code[1].toUpperCase() : null;
}

function toIsoDate(year: number, month: number, day: number): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const fullYear = year < 100 ? (year > 70 ? 1900 + year : 2000 + year) : year;
  const date = new Date(Date.UTC(fullYear, month - 1, day));
  if (date.getUTCFullYear() !== fullYear || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  if (fullYear < 2000 || fullYear > 2100) return null;
  return `${fullYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function detectDate(text: string): string | null {
  const iso = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) return toIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const short = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/);
  if (short) {
    const first = Number(short[1]);
    const second = Number(short[2]);
    // Day-first unless one side can only be a month.
    if (first > 12) return toIsoDate(Number(short[3]), second, first);
    if (second > 12) return toIsoDate(Number(short[3]), first, second);
    return toIsoDate(Number(short[3]), second, first);
  }

  const months = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
  const named = text.match(new RegExp(String.raw`\b(\d{1,2})\s+(${months})[a-z]*\.?\s+(20\d{2})\b`, "i"));
  if (named) {
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(
      named[2].toLowerCase(),
    ) + 1;
    return toIsoDate(Number(named[3]), month, Number(named[1]));
  }
  return null;
}

function detectTotal(lines: string[]): number | null {
  let best: number | null = null;
  for (const line of lines) {
    const hasTotal =
      /\b(total|amount\s*due|balance\s*due|to\s*pay|grand\s*total)\b/i.test(line) ||
      /(σύνολο|συνολο|πληρωτέο|πληρωτεο|πληρωμή|πληρωμη|τζίρος|τζιρος)/i.test(line);
    if (!hasTotal) continue;
    if (/\b(vat|tax)\b/i.test(line) || /(φπα|φ\.π\.α|φόρος|φορος)/i.test(line)) continue;
    if (/\b(sub\s*-?\s*total|total\s+items|total\s+savings)\b/i.test(line) || /(υποσύνολο|υποσυνολο)/i.test(line)) continue;
    if (/(έκπτωσ|εκπτωσ|discount|savings?|εξοικονομ)/i.test(line)) continue;
    const amounts = [...line.matchAll(new RegExp(MONEY, "g"))]
      .map((match) => parseAmount(match[0]))
      .filter((value): value is number => value != null && value >= 0);
    if (amounts.length) best = amounts[amounts.length - 1];
  }
  return best;
}

function looksLikeVendor(line: string): boolean {
  if (!line || line.length < 2 || line.length > 60) return false;
  if (NOISE_LINE.test(line) || NOISE_CONTAINS.test(line)) return false;
  if (/^[\d\s.,/#-]+$/.test(line)) return false;
  if (/\d{2,}/.test(line.replace(/\b(20\d{2})\b/g, ""))) return false;
  if ((line.match(/\d/g)?.length ?? 0) / line.length > 0.3) return false;
  if (!/[a-zα-ωά-ώ]/i.test(line)) return false;
  return true;
}

function tidyVendor(line: string): string {
  let name = line
    .replace(/^welcome\s+to\s+/i, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N})'&.\- ]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length > 3 && name === name.toUpperCase()) {
    name = name
      .toLowerCase()
      .split(" ")
      .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
      .join(" ");
  }
  return name.slice(0, 80);
}

function detectSubtotal(lines: string[]): number | null {
  for (const line of lines) {
    if (
      !/(sub\s*-?\s*total|net\s+(?:total|value)|καθαρ[ήη]\s*αξ[ίι]α|αξ[ίι]α\s*προ\s*φπα|προ\s*φπα)/i.test(line)
    ) {
      continue;
    }
    const amounts = [...line.matchAll(new RegExp(MONEY, "g"))]
      .map((match) => parseAmount(match[0]))
      .filter((value): value is number => value != null && value >= 0);
    if (amounts.length) return amounts[amounts.length - 1];
  }
  return null;
}

function detectTax(lines: string[]): { tax: number | null; breakdown: TaxBreakdownEntry[] } {
  let taxTotal = 0;
  const rates = new Map<number, TaxBreakdownEntry>();
  for (const line of lines) {
    const looksLikeTax = /\b(vat|tax)\b/i.test(line) || /(φπα|φ\.π\.α|φόρος|φορος)/i.test(line);
    if (!looksLikeTax || /(sub\s*-?\s*total|net\s+value|καθαρ[ήη]\s*αξ[ίι]α)/i.test(line)) continue;
    const rateMatch = line.match(/(\d{1,2}(?:[.,]\d+)?)\s*%/);
    const rate = rateMatch ? parseAmount(rateMatch[1]) : null;
    const withoutRates = line.replace(/\d{1,2}(?:[.,]\d+)?\s*%/g, " ");
    const amounts = [...withoutRates.matchAll(new RegExp(MONEY, "g"))]
      .map((match) => parseAmount(match[0]))
      .filter((value): value is number => value != null && value >= 0);
    if (!amounts.length) continue;
    const amount = amounts[amounts.length - 1];
    if (!(amount > 0)) continue;
    taxTotal += amount;
    if (rate != null && rate > 0 && rate < 100) {
      const net = round(amount / (rate / 100), 2);
      const existing = rates.get(rate);
      if (existing) {
        existing.net = round(existing.net + net, 2);
        existing.tax = round(existing.tax + amount, 2);
        existing.gross = round(existing.gross + net + amount, 2);
      } else {
        rates.set(rate, { rate, net, tax: round(amount, 2), gross: round(net + amount, 2) });
      }
    }
  }
  return {
    tax: taxTotal > 0 ? round(taxTotal, 2) : null,
    breakdown: [...rates.values()].sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0)),
  };
}

function detectSavings(lines: string[]): number | null {
  let lineTotal = 0;
  let summaryTotal = 0;
  for (const line of lines) {
    if (!/(έκπτωση|εκπτωση|discount|savings?|εξοικονομ)/i.test(line)) continue;
    const withoutRate = line.replace(/\d{1,2}(?:[.,]\d+)?\s*%\s*$/, "");
    const amounts = [...withoutRate.matchAll(new RegExp(MONEY, "g"))]
      .map((match) => parseAmount(match[0]))
      .filter((value): value is number => value != null);
    const amount = amounts.find((value) => value < 0) ?? amounts[amounts.length - 1];
    if (amount == null) continue;
    if (/(συνολικ|συνολο|total|you\s+saved|savings)/i.test(line)) summaryTotal += Math.abs(amount);
    else lineTotal += Math.abs(amount);
  }
  const total = summaryTotal > 0 ? summaryTotal : lineTotal;
  return total > 0 ? round(total, 2) : null;
}

function detectVendor(lines: string[]): string | null {
  for (const line of lines.slice(0, 8)) {
    if (!looksLikeVendor(line)) continue;
    const candidate = tidyVendor(line);
    if (candidate.length >= 2) return candidate;
  }
  return null;
}

function tidyDescription(raw: string): string {
  return raw
    .replace(/\s+\*+\s*$/, "")
    .replace(/^[*#\-\s]+/, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+[A-ZΑ-Ω]{1,3}$/, "") // trailing tax class letter (A/B/…, Greek Α/Β/Γ)
    .replace(/[.,;:_-]+$/, "")
    .trim()
    .slice(0, 120);
}

function extractUnit(name: string): { name: string; quantity: number | null; unit: string | null } {
  // Multiplier: "2 x Milk", "3 × Bread"
  const multi = name.match(/^(\d+(?:[.,]\d+)?)\s*[x×*@]\s+(.+)$/i);
  if (multi) return { name: multi[2], quantity: parseQuantity(multi[1]), unit: null };

  // Prefix: "1.5 l Milk", "500 g Flour"
  const prefix = name.match(/^(\d+(?:[.,]\d+)?)\s*([a-zA-Zα-ωά-ώΑ-ΩΆ-Ώ]+)\.?\s+(.+)$/);
  if (prefix) {
    const unit = UNIT_ALIASES[prefix[2].toLowerCase()];
    if (unit) return { name: prefix[3], quantity: parseQuantity(prefix[1]), unit };
  }
  // Suffix: "Milk 1.5 l", "Eggs (12 pcs)"
  const suffix = name.match(/^(.*?)\s*[\(\[]?\s*(\d+(?:[.,]\d+)?)\s*([a-zA-Zα-ωά-ώΑ-ΩΆ-Ώ]+)\s*[\)\]]?$/);
  if (suffix) {
    const unit = UNIT_ALIASES[suffix[3].toLowerCase().replace(/\.$/, "")];
    if (unit) return { name: suffix[1], quantity: parseQuantity(suffix[2]), unit };
  }
  return { name, quantity: null, unit: null };
}

interface ParsedLine {
  description: string;
  quantity: number;
  unit: string | null;
  unitPrice: number | null;
  lineTotal: number | null;
  taxRate?: number | null;
  discount?: number | null;
  barcode: string | null;
}

function parseItemLine(rawLine: string): ParsedLine | null {
  let line = rawLine
    .replace(/\r/g, "")
    .replace(/^[\s|¦•·*\-–—]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!line || line.length < 3 || line.length > 180) return null;
  if (NOISE_LINE.test(line) || NOISE_CONTAINS.test(line)) return null;
  if (/(έκπτωσ|εκπτωσ|discount|savings?|εξοικονομ)/i.test(line)) return null;
  if (/^\d{8,14}$/.test(line)) return null; // standalone barcode
  if (!/[a-zα-ωά-ώ]/i.test(line)) return null;

  const multiplier = line.match(
    new RegExp(String.raw`^(?<qty>\d+(?:[.,]\d+)?)\s*[x×*@]\s*(?<name>.+?)\s+(?<unitPrice>${MONEY})\s+(?<total>${MONEY})$`, "i"),
  );
  if (multiplier?.groups) {
    const description = tidyDescription(multiplier.groups.name);
    if (!description) return null;
    const quantity = parseQuantity(multiplier.groups.qty) ?? 1;
    const total = parseAmount(multiplier.groups.total);
    const unitPrice = parseAmount(multiplier.groups.unitPrice);
    return {
      description,
      quantity: quantity > 0 ? quantity : 1,
      unit: null,
      unitPrice: unitPrice ?? (total != null && quantity > 0 ? round(total / quantity) : null),
      lineTotal: total,
      barcode: null,
    };
  }

  const unitPriceTimesQuantity = line.match(
    new RegExp(String.raw`^(?<name>.+?)\s+(?<unitPrice>${MONEY})\s*[x×*@]\s*(?<qty>\d+(?:[.,]\d+)?)$`, "i"),
  );
  if (unitPriceTimesQuantity?.groups) {
    const description = tidyDescription(unitPriceTimesQuantity.groups.name);
    const quantity = parseQuantity(unitPriceTimesQuantity.groups.qty) ?? 1;
    const unitPrice = parseAmount(unitPriceTimesQuantity.groups.unitPrice);
    if (!description) return null;
    return {
      description,
      quantity: quantity > 0 ? quantity : 1,
      unit: null,
      unitPrice,
      lineTotal: unitPrice != null ? round(unitPrice * quantity, 2) : null,
      barcode: null,
    };
  }

  // "MILK 1,5% 2 x 1,19 2,38 A" and "BANANAS 1,234 kg x 1,49 1,84"
  const quantityTimesUnitPrice = line.match(
    new RegExp(
      String.raw`^(?<name>.+?)\s+(?<qty>\d+(?:[.,]\d+)?)\s*(?<unitWord>[a-zA-Zα-ωά-ώΑ-ΩΆ-Ώ]{1,8})?\s*[x×*@]\s*(?<unitPrice>${MONEY})\s+(?<total>${MONEY})\s*(?:[A-ZΑ-Ω]{1,3})?$`,
      "i",
    ),
  );
  if (quantityTimesUnitPrice?.groups) {
    const description = tidyDescription(quantityTimesUnitPrice.groups.name);
    const quantity = parseQuantity(quantityTimesUnitPrice.groups.qty) ?? 1;
    const unit = quantityTimesUnitPrice.groups.unitWord
      ? UNIT_ALIASES[quantityTimesUnitPrice.groups.unitWord.toLowerCase().replace(/\.$/, "")] ?? null
      : null;
    if (!description) return null;
    const total = parseAmount(quantityTimesUnitPrice.groups.total);
    const unitPrice = parseAmount(quantityTimesUnitPrice.groups.unitPrice);
    return {
      description,
      quantity: quantity > 0 ? quantity : 1,
      unit,
      unitPrice: unitPrice ?? (total != null && quantity > 0 ? round(total / quantity) : null),
      lineTotal: total,
      barcode: null,
    };
  }

  const trailingPrice = line.match(new RegExp(String.raw`^(?<name>.+?)\s+(?<total>${MONEY})\s*(?:[A-ZΑ-Ω]{1,3})?$`, "i"));
  if (!trailingPrice?.groups) return null;
  const total = parseAmount(trailingPrice.groups.total);
  if (total == null) return null;

  const extracted = extractUnit(trailingPrice.groups.name);
  const description = tidyDescription(extracted.name);
  if (!description || description.length < 2) return null;

  const quantity = extracted.quantity && extracted.quantity > 0 ? extracted.quantity : 1;
  return {
    description,
    quantity,
    unit: extracted.unit,
    unitPrice: round(total / quantity),
    lineTotal: total,
    barcode: null,
  };
}

export function heuristicReceipt(rawText: string, fallbackCurrency: string | null = null): ReceiptDraft {
  const lines = String(rawText ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const items: ParsedLine[] = [];
  for (const line of lines) {
    const parsed = parseItemLine(line);
    if (!parsed) continue;
    const duplicate = items.some(
      (entry) =>
        entry.description.toLowerCase() === parsed.description.toLowerCase() &&
        entry.lineTotal === parsed.lineTotal &&
        entry.quantity === parsed.quantity,
    );
    if (!duplicate) items.push(parsed);
  }

  const currency = detectCurrency(rawText) ?? fallbackCurrency;
  const total = detectTotal(lines) ?? (items.length ? round(items.reduce((sum, item) => sum + (item.lineTotal ?? 0), 0), 2) : null);
  const detectedTax = detectTax(lines);
  const detectedSubtotal = detectSubtotal(lines);
  const tax = detectedTax.tax ?? (total != null && detectedSubtotal != null ? round(total - detectedSubtotal, 2) : null);
  const subtotal = detectedSubtotal ?? (total != null && tax != null ? round(total - tax, 2) : null);

  return {
    vendorName: detectVendor(lines),
    purchasedAt: detectDate(rawText),
    currency,
    total,
    subtotal,
    tax,
    taxBreakdown: detectedTax.breakdown,
    savings: detectSavings(lines),
    notes: null,
    lines: items.slice(0, 200),
  };
}

/** Coerce AI output (or a client-submitted draft) into the shape the importer expects. */
export function normaliseReceiptDraft(raw: Record<string, any>, fallbackCurrency: string | null = null): ReceiptDraft {
  const num = (value: unknown): number | null => {
    if (value == null || value === "") return null;
    const parsed = typeof value === "number" ? value : parseAmount(String(value));
    return parsed != null && Number.isFinite(parsed) ? parsed : null;
  };
  const qtyNum = (value: unknown): number | null => {
    if (value == null || value === "") return null;
    const parsed = typeof value === "number" ? value : parseQuantity(String(value));
    return parsed != null && Number.isFinite(parsed) ? parsed : null;
  };

  const rawLines = Array.isArray(raw.lines) ? raw.lines : [];
  const lines = rawLines
    .map((entry: any): ParsedLine | null => {
      const description = tidyDescription(String(entry?.description ?? entry?.name ?? ""));
      if (!description) return null;
      const quantity = qtyNum(entry?.quantity);
      const unitPrice = num(entry?.unitPrice ?? entry?.price);
      const lineTotal = num(entry?.lineTotal ?? entry?.total);
      const unitWord = entry?.unit ? String(entry.unit).toLowerCase().replace(/\.$/, "") : "";
      const resolved = quantity == null ? extractUnit(description) : { name: description, quantity, unit: null };
      const unit = UNIT_ALIASES[unitWord] ?? resolved.unit ?? null;
      const finalQuantity = quantity && quantity > 0 ? quantity : resolved.quantity && resolved.quantity > 0 ? resolved.quantity : 1;
      const finalTotal = lineTotal ?? (unitPrice != null ? round(unitPrice * finalQuantity, 2) : null);
      const taxRate = num(entry?.taxRate ?? entry?.vatRate);
      const discount = num(entry?.discount);
      return {
        description: tidyDescription(resolved.name) || description,
        quantity: finalQuantity,
        unit,
        unitPrice: unitPrice ?? (finalTotal != null ? round(finalTotal / finalQuantity) : null),
        lineTotal: finalTotal,
        taxRate: taxRate != null && taxRate >= 0 && taxRate <= 100 ? taxRate : null,
        discount: discount != null && discount >= 0 ? discount : null,
        barcode: entry?.barcode ? String(entry.barcode).replace(/\D/g, "").slice(0, 20) || null : null,
      };
    })
    .filter((entry): entry is ParsedLine => entry != null)
    .slice(0, 200);

  const lineSavings = round(lines.reduce((sum, line) => sum + Math.abs(line.discount ?? 0), 0), 2);

  const dateRaw = raw.purchasedAt ?? raw.date;
  const purchasedAt =
    typeof dateRaw === "string" && /^\d{4}-\d{2}-\d{2}/.test(dateRaw)
      ? dateRaw.slice(0, 10)
      : typeof dateRaw === "string"
        ? detectDate(dateRaw)
        : null;

  const currencyRaw = raw.currency ? String(raw.currency).toUpperCase() : "";
  const currency = /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : fallbackCurrency;

  const total = num(raw.total) ?? (lines.length ? round(lines.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0), 2) : null);

  const rawBreakdown = Array.isArray(raw.taxBreakdown) ? raw.taxBreakdown : [];
  const taxBreakdown = rawBreakdown
    .map((entry: any): TaxBreakdownEntry | null => {
      const rate = num(entry?.rate);
      let tax = num(entry?.tax ?? entry?.vat);
      let net = num(entry?.net ?? entry?.subtotal);
      let gross = num(entry?.gross ?? entry?.total);
      if (gross != null && tax == null && net != null) tax = round(gross - net, 2);
      if (gross == null && net != null && tax != null) gross = round(net + tax, 2);
      if (net == null && gross != null && tax != null) net = round(gross - tax, 2);
      if (net == null && gross != null && rate != null && rate > 0 && rate < 100) {
        net = round(gross / (1 + rate / 100), 2);
        tax = round(gross - net, 2);
      }
      if (net == null || tax == null) return null;
      return {
        rate: rate != null && rate > 0 && rate < 100 ? rate : null,
        net: round(net, 2),
        tax: round(tax, 2),
        gross: round(gross ?? net + tax, 2),
      };
    })
    .filter((entry): entry is TaxBreakdownEntry => entry != null)
    .slice(0, 20);

  const tax = num(raw.tax) ?? (taxBreakdown.length ? round(taxBreakdown.reduce((sum, entry) => sum + entry.tax, 0), 2) : null);
  const subtotal =
    num(raw.subtotal ?? raw.net) ??
    (taxBreakdown.length
      ? round(taxBreakdown.reduce((sum, entry) => sum + entry.net, 0), 2)
      : total != null && tax != null
        ? round(total - tax, 2)
        : null);

  return {
    vendorName: raw.vendorName || raw.vendor || raw.store ? tidyVendor(String(raw.vendorName ?? raw.vendor ?? raw.store)) : null,
    purchasedAt,
    currency,
    total,
    subtotal,
    tax,
    taxBreakdown,
    savings: num(raw.savings) ?? (lineSavings > 0 ? lineSavings : null),
    notes: raw.notes ? String(raw.notes).slice(0, 500) : null,
    lines,
  };
}
