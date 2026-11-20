import type { ReceiptDraft, TaxBreakdownEntry } from "../../shared/types.js";
import { detectDate, parseAmount, parseQuantity } from "./receipt-local.js";

/**
 * Parser for the receipt page IMPACT eInvoicing's public viewer serves
 * (`https://einvoice.impact.gr/p/EL…/…/…`, fully server-rendered HTML).
 *
 * The document is machine-generated bootstrap markup: a product table whose
 * header and body cells carry `field-*` class tokens (Περιγραφή, Ποσότητα,
 * Συνολική Αξία…), each value nested in `<span class="field …"><span
 * class="inner"><span class="value">…</span></span></span>`, a summary whose
 * rows carry the total/net/VAT/currency tokens, and an optional VAT
 * breakdown. The page also renders unrelated tables (including the myDATA
 * `InvoiceLineTable` in a separate tab), so only a table whose header cells
 * carry the product field tokens and whose rows nest value spans is parsed;
 * anything else is ignored. Product and VAT tables are scoped to the viewer's
 * `.section-details` and `.section-taxes` blocks. The merchant field is in `.company-info`,
 * while issue date and invoice number appear in the receipt identity fields.
 * Metadata is best effort. Missing metadata does not prevent importing lines.
 *
 * Sign conventions follow the existing receipt parsers: `lineTotal` is the
 * VAT-inclusive amount actually charged (the `field-Total` cell) and
 * `unitPrice` is recomputed as `lineTotal / quantity` (four decimals), so
 * stock and purchase history see the same value a paper receipt of the same
 * shop would produce. Missing, unparseable or negative product rows make the
 * whole page `incomplete`, which the caller reports so the photo scan and AI
 * re-read take over instead of silently dropping lines.
 */

export type ImpactReceiptParse = { status: "incomplete" | "unavailable" } | {
  status: "ok";
  draft: ReceiptDraft;
  /** Plain-text rendition of the receipt, for provenance and vendor detection. */
  text: string;
  /** IMPACT receipts carry no known fee rows, so nothing is excluded. */
  excludedCharges: number;
};

interface ImpactRow {
  code: string | null;
  description: string | null;
  unit: string | null;
  quantity: string | null;
  net: string | null;
  vatCategory: string | null;
  vat: string | null;
  total: string | null;
}

type ImpactProduct = Omit<ImpactRow, "description" | "quantity" | "total"> & {
  description: string;
  quantity: number;
  lineTotal: number;
};

/** Product cell class tokens observed on IMPACT receipt pages. */
const CELL_TO_ROW: Record<string, keyof ImpactRow> = {
  Code: "code",
  Description1: "description",
  Quantity: "quantity",
  MeasurementUnit: "unit",
  NetTotal: "net",
  VatCategory: "vatCategory",
  VATTotal: "vat",
  Total: "total",
};

/** Unit-of-measure cells mapped to SVault base units; pieces stay unit-less. */
const UNIT_MAP: Record<string, string> = {
  ΚΙΛΟ: "kg",
  ΓΡΑΜΜΑΡΙΟ: "g",
  ΛΙΤΡΟ: "l",
  ΧΙΛΙΟΣΤΟΛΙΤΡΟ: "ml",
};

// The Greek viewer uses decimal commas and optional dots between thousands.
const PRINTED_NUMBER = /^-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/;
const NAMED_ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parsePrintedAmount(raw: string | null): number | null {
  return raw != null && PRINTED_NUMBER.test(raw) ? parseAmount(raw) : null;
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:(nbsp|amp|lt|gt|quot|apos)|#(\d+)|#x([\da-f]+));/gi, (_entity, name, decimal, hex) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()];
    const code = decimal ? Number(decimal) : Number.parseInt(hex, 16);
    if ((code > 0 && code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)) return " ";
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
      ? String.fromCodePoint(code)
      : "\uFFFD";
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** The value of a tag's class attribute, exactly as printed. */
function classAttr(openTag: string): string | null {
  const match = openTag.match(/\sclass\s*=\s*(["'])([\s\S]*?)\1/i);
  return match ? match[2] : null;
}

/** Read one viewer section, keeping nested layout divs inside the section. */
function divSection(html: string, className: string): string {
  let start = 0;
  let depth = 0;
  for (const { 0: tag, index } of html.matchAll(/<!--[\s\S]*?-->|<\/?div\b[^>]*>/gi)) {
    if (tag.startsWith("<!--")) continue;
    if (depth === 0) {
      if (tag.startsWith("</") || !classAttr(tag)?.split(/\s+/).includes(className)) continue;
      start = index + tag.length;
      depth = 1;
    } else if (tag.startsWith("</")) {
      if (--depth === 0) return html.slice(start, index);
    } else {
      depth++;
    }
  }
  return "";
}

/** The value nested in `<span class="value">`, falling back to the cell text. */
function cellValue(innerHtml: string): string | null {
  const value = innerHtml.match(/<span\b[^>]*\sclass\s*=\s*(["'])[^"']*\bvalue\b[^"']*\1[^>]*>([\s\S]*?)<\/span>/i);
  return (value ? stripTags(value[2]) : stripTags(innerHtml)) || null;
}

/**
 * The value of the first `<span class="field field-…">` carrying the given
 * field token, from its nested value span. This follows the observed markup.
 * Metadata stays optional if IMPACT changes the nesting.
 */
function fieldSpanValue(source: string, field: string): string | null {
  const fields = /<span\b([^>]*)>\s*<span\b[^>]*>\s*(?:<span\b[^>]*>[^<]*<\/span>\s*)?<span\b([^>]*)>([^<]*)<\/span>/gi;
  for (const match of source.matchAll(fields)) {
    if (!classAttr(match[1])?.split(/\s+/).includes(`field-${field}`)) continue;
    if (!classAttr(match[2])?.split(/\s+/).includes("value")) return null;
    return stripTags(match[3]) || null;
  }
  return null;
}

/** The value cell of the first summary row carrying the field token. */
function summaryValue(html: string, field: string): string | null {
  const row = html.match(new RegExp(String.raw`<tr\b[^>]*\sclass\s*=\s*(["'])[^"']*\bfield-${field}\b[^"']*\1[^>]*>([\s\S]*?)<\/tr>`, "i"));
  if (!row) return null;
  const value = row[2].match(/<td\b[^>]*\sclass\s*=\s*(["'])[^"']*\bvalue\b[^"']*\1[^>]*>([\s\S]*?)<\/td>/i);
  return value ? stripTags(value[2]) || null : null;
}

/**
 * Ignore empty product table shells inside the viewer's details section.
 * A table with malformed product data, or a section with only empty shells,
 * is incomplete and falls back to photo OCR.
 */
function parseProductTable(html: string): ImpactProduct[] | "incomplete" | null {
  let foundProductHeader = false;
  for (const [, attrs, content] of html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)) {
    if (classAttr(attrs)?.split(/\s+/).includes("InvoiceLineTable")) continue;
    const thead = content.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i)?.[1] ?? "";
    const headerTokens = new Set<string>();
    for (const th of thead.matchAll(/<th\b([^>]*)>/gi)) {
      for (const token of classAttr(th[1])?.trim().split(/\s+/) ?? []) headerTokens.add(token);
    }
    if (!headerTokens.has("field-Description1") || !headerTokens.has("field-Total") || !headerTokens.has("field-Quantity")) continue;
    foundProductHeader = true;
    const tbody = content.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1];
    if (!tbody) continue;
    const products: ImpactProduct[] = [];
    for (const rowMatch of tbody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const row: ImpactRow = {
        code: null,
        description: null,
        unit: null,
        quantity: null,
        net: null,
        vatCategory: null,
        vat: null,
        total: null,
      };
      let recognized = false;
      for (const cell of rowMatch[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)) {
        const attr = classAttr(cell[1]);
        if (!attr) continue;
        const token = attr.trim().split(/\s+/)
          .find((candidate) => candidate.startsWith("field-") && CELL_TO_ROW[candidate.slice("field-".length)]);
        if (!token) continue;
        recognized = true;
        row[CELL_TO_ROW[token.slice("field-".length)]] = cellValue(cell[2]);
      }
      // Rows without product cells (spacers, column echoes) are skipped.
      if (!recognized || !Object.values(row).some(Boolean)) continue;
      // Missing, unparseable or negative product lines go back to photo OCR.
      const printedQuantity = row.quantity ?? "";
      const quantity = PRINTED_NUMBER.test(printedQuantity) ? parseQuantity(printedQuantity) : null;
      const total = parsePrintedAmount(row.total);
      if (!row.description || quantity == null || quantity <= 0 || total == null || total < 0) return "incomplete";
      products.push({
        code: row.code,
        description: row.description,
        unit: row.unit,
        quantity,
        net: row.net,
        vatCategory: row.vatCategory,
        vat: row.vat,
        lineTotal: total,
      });
    }
    if (products.length) return products;
  }
  return foundProductHeader ? "incomplete" : null;
}

/**
 * Accept valid VAT rows within one cent of each available summary total.
 * Prefer an exact match when both exact and rounded candidates are present.
 */
function parseTaxBreakdown(html: string, subtotal: number | null, tax: number | null): TaxBreakdownEntry[] {
  let closest: TaxBreakdownEntry[] = [];
  let bestDifference = Infinity;
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const entries: TaxBreakdownEntry[] = [];
    let invalid = false;
    for (const rowMatch of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = new Map<string, string>();
      for (const cell of rowMatch[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)) {
        const attr = classAttr(cell[1]);
        const token = attr?.trim().split(/\s+/)
          .find((candidate) => candidate === "field-Percentage" || candidate === "field-UnderlyingValue" || candidate === "field-VatAmount");
        if (token) cells.set(token, cellValue(cell[2]) ?? "");
      }
      if (!cells.size) continue;
      const rateText = cells.get("field-Percentage")?.replace(/\s*%$/, "") ?? "";
      const rate = PRINTED_NUMBER.test(rateText) ? parseQuantity(rateText) : null;
      const net = parsePrintedAmount(cells.get("field-UnderlyingValue") ?? null);
      const tax = parsePrintedAmount(cells.get("field-VatAmount") ?? null);
      if (rate == null || rate < 0 || rate > 100 || net == null || net < 0 || tax == null || tax < 0) {
        invalid = true;
        break;
      }
      entries.push({ rate, net, tax, gross: round(net + tax, 2) });
    }
    if (invalid || !entries.length) continue;
    const netCents = Math.round(entries.reduce((sum, entry) => sum + entry.net, 0) * 100);
    const taxCents = Math.round(entries.reduce((sum, entry) => sum + entry.tax, 0) * 100);
    const netDifference = subtotal == null ? 0 : Math.abs(netCents - Math.round(subtotal * 100));
    const taxDifference = tax == null ? 0 : Math.abs(taxCents - Math.round(tax * 100));
    if (netDifference > 1 || taxDifference > 1) continue;
    const difference = netDifference + taxDifference;
    if (difference === 0) return entries;
    if (difference < bestDifference) {
      closest = entries;
      bestDifference = difference;
    }
  }
  return closest;
}

function mapUnit(raw: string | null): string | null {
  if (!raw) return null;
  return UNIT_MAP[raw.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[\s.]+/g, "")] ?? null;
}

/** VAT is optional. Keep the product and charged amount when its rate cannot be verified. */
function lineVatRate(row: ImpactProduct, breakdown: TaxBreakdownEntry[]): number | null {
  const category = row.vatCategory;
  if (!category || !/^\d{1,3}(?:[.,]\d{1,2})?\s*%?$/.test(category)) return null;
  const rate = Number(category.replace(",", ".").replace(/\s*%$/, ""));
  // A bare number can be a category code, and cent rounding can make several
  // percentages fit the same line. The breakdown confirms the rate is in use.
  if (rate > 100 || (!category.endsWith("%") && !breakdown.some((entry) => entry.rate === rate))) return null;
  const net = parsePrintedAmount(row.net);
  const vat = parsePrintedAmount(row.vat);
  if (net == null || net <= 0 || vat == null || vat < 0) return null;
  // Different issuer rounding can leave the rate unverified. The printed
  // amounts still import with the rest of the line.
  return round(net * rate / 100) === vat ? rate : null;
}

/**
 * Parse an IMPACT receipt page. Recognized tables with missing, unparseable
 * or negative product rows get a distinct result so the caller can explain
 * why photo OCR is needed.
 */
export function parseImpactReceiptHtml(html: string): ImpactReceiptParse {
  const source = String(html ?? "");
  if (!source.trim()) return { status: "unavailable" };
  const rows = parseProductTable(divSection(source, "section-details"));
  if (!rows) return { status: "unavailable" };
  if (rows === "incomplete") return { status: "incomplete" };

  const vendorName = fieldSpanValue(divSection(source, "company-info"), "RegisteredName");
  const issuedAt = fieldSpanValue(source, "DateIssued");
  const purchasedAt = issuedAt ? detectDate(issuedAt) : null;
  const identifier = fieldSpanValue(source, "IssuerFormatedInvoiceSeriesNumber");

  const totalRaw = summaryValue(source, "TotalGrossValue");
  const total = totalRaw ? parseAmount(totalRaw) : null;
  const subtotalRaw = summaryValue(source, "TotalNetAmount");
  const subtotal = subtotalRaw ? parseAmount(subtotalRaw) : null;
  const taxRaw = summaryValue(source, "TotalVATAmount");
  const taxAmount = taxRaw ? parseAmount(taxRaw) : null;
  const currencyRaw = summaryValue(source, "CurrencyCode");
  const currency = currencyRaw && /^[A-Za-z]{3}$/.test(currencyRaw.trim()) ? currencyRaw.trim().toUpperCase() : null;
  const taxBreakdown = parseTaxBreakdown(divSection(source, "section-taxes"), subtotal, taxAmount);

  const lines: ReceiptDraft["lines"] = [];
  const textLines: string[] = [];
  for (const row of rows) {
    const description = row.description.slice(0, 160).replace(/[\uD800-\uDBFF]$/, "");
    const { quantity, lineTotal } = row;
    // Effective VAT-inclusive unit price from the charged amount, exactly
    // like the other digital receipt parsers.
    const unitPrice = round(lineTotal / quantity, 4);
    lines.push({
      description,
      rawDescription: description,
      quantity,
      unit: mapUnit(row.unit),
      unitPrice,
      lineTotal,
      taxRate: lineVatRate(row, taxBreakdown),
      discount: 0,
      barcode: null, // IMPACT's Code column is a merchant SKU.
    });
    textLines.push(
      [
        row.code ?? "",
        description,
        String(quantity),
        row.unit ?? "",
        unitPrice.toFixed(4), // Effective price from the draft, at the same precision.
        row.vatCategory ?? "",
        lineTotal.toFixed(2),
      ]
        .filter(Boolean)
        .join("  "),
    );
  }

  textLines.unshift(
    vendorName ?? "IMPACT",
    "ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ ΠΩΛΗΣΗΣ",
    ...(identifier ? [`Αρ. Παραστατικού ${identifier}`] : []),
    ...(purchasedAt ? [`ΗΜ/ΝΙΑ ${purchasedAt}`] : []),
    "",
  );
  if (total != null) textLines.push("", `ΣΥΝΟΛΟ ${total.toFixed(2)}`);
  if (subtotal != null) textLines.push(`ΚΑΘΑΡΗ ΑΞΙΑ ${subtotal.toFixed(2)}`);
  if (taxAmount != null) textLines.push(`ΦΠΑ ${taxAmount.toFixed(2)}`);
  for (const entry of taxBreakdown) {
    textLines.push(`ΦΠΑ ${entry.rate}% ${entry.net.toFixed(2)} ${entry.tax.toFixed(2)}`);
  }

  const draft: ReceiptDraft = {
    vendorName,
    purchasedAt,
    currency,
    total,
    subtotal,
    tax: taxAmount ?? (taxBreakdown.length ? round(taxBreakdown.reduce((sum, entry) => sum + entry.tax, 0), 2) : null),
    taxBreakdown,
    savings: null,
    notes: identifier ? `Αρ. Παραστατικού ${identifier}` : null,
    lines,
  };
  return { status: "ok", draft, text: textLines.join("\n"), excludedCharges: 0 };
}
