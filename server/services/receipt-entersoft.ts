import type { ReceiptDraft, TaxBreakdownEntry } from "../../shared/types.js";
import { detectDate, parseAmount, parseQuantity } from "./receipt-local.js";

/**
 * Parser for the HTML invoice document Entersoft's public viewer serves
 * (`/api/GetInvoice?contentType=PEPPOL…`, rendered inside the receipt page's
 * `iframe#iframeContent`).
 *
 * The document is machine-generated bootstrap markup: an item table whose cells
 * carry Greek `data-title` attributes, a totals block and a VAT breakdown.
 * Quantities use Greek decimal commas (including fractional weights such as
 * 2,159 kg), the printed unit price is VAT-exclusive and rounded, and the line
 * amounts are VAT-inclusive. Amounts print as "51,39EUR" with the currency
 * joined to the digits, and the totals labels carry Greek accents, so label
 * matching folds accents on both sides and the standalone "Έκπτωση" is told
 * apart from the "…προ έκπτωσης" label by a letter lookahead.
 *
 * Sign conventions follow the existing receipt templates: `lineTotal` is the
 * VAT-inclusive amount actually charged, `discount` records the gross discount
 * taken off that line, and `unitPrice` is recomputed as
 * `lineTotal / quantity` (four decimals) exactly like `applyDiscount` in
 * receipt-sklavenitis.ts, so stock and purchase history see the same value a
 * paper receipt of the same shop would produce.
 *
 * Only explicit fee rows are excluded from the lines (the PERTEL environmental
 * levy, or a matching fee description) and reported as `excludedCharges`, which
 * the scan route uses to explain the remaining difference from the printed
 * total — the same convention as Lidl's bag charges. Other Entersoft vendors
 * may assign alphanumeric SKUs to real products, so a non-numeric code alone
 * never makes a row a fee.
 */

export interface EntersoftInvoiceParse {
  draft: ReceiptDraft;
  /** Plain-text rendition of the invoice, for provenance and vendor detection. */
  text: string;
  /** Sum of fee-only rows excluded from the lines but still in the total. */
  excludedCharges: number;
}

interface EntersoftRow {
  code: string | null;
  description: string | null;
  unit: string | null;
  quantity: string | null;
  unitPrice: string | null;
  preDiscount: string | null;
  discount: string | null;
  taxRate: string | null;
  lineTotal: string | null;
}

/** Column data-title labels, folded to accent-free uppercase without spaces. */
const COLUMN_KEYS: Record<string, keyof EntersoftRow> = {
  ΚΩΔΙΚΟΣ: "code",
  ΠΕΡΙΓΡΑΦΗ: "description",
  ΜΜ: "unit",
  ΠΟΣΟΤΗΤΑ: "quantity",
  ΤΙΜΗΜΟΝΑΔΟΣ: "unitPrice",
  ΑΞΙΑΠΡΟΕΚΠΤΩΣΗΣ: "preDiscount",
  ΕΚΠΤΩΣΗ: "discount",
  "ΦΠΑ%": "taxRate",
  ΣΥΝΟΛΙΚΗΑΞΙΑ: "lineTotal",
};

/** Unit-of-measure cells mapped to SVault base units; pieces stay unit-less. */
const UNIT_MAP: Record<string, string> = {
  ΚΙΛΟ: "kg",
  ΓΡΑΜΜΑΡΙΟ: "g",
  ΛΙΤΡΟ: "l",
  ΧΙΛΙΟΣΤΟΛΙΤΡΟ: "ml",
};

/** Explicit fee rows: the PERTEL environmental levy or a fee description. */
const FEE_CODE = /^PERTEL$/i;
const FEE_DESCRIPTION = /περιβαλλοντικ|περιβαν\.?\s*τελος|τέλος\s*&?\s*πλασ|τ\.σ\.?π\.?χρ/i;

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'");
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Accent-free uppercase, so Greek labels match regardless of accents or case. */
function foldGreek(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase();
}

function labelKey(value: string): string {
  return foldGreek(value).replace(/[\s.]+/g, "");
}

/** Merchant: the first bold header that is not a known section label. */
function findVendor(html: string): string | null {
  const headers = [...html.matchAll(/<div[^>]*class="[^"]*BoldBlueHeader[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)]
    .map((match) => stripTags(match[1]))
    .filter(Boolean);
  const sectionLabel = /^(ΑΠΟΔΕΙΞΗ|ΣΤΟΙΧΕΙΑ|ΑΝΑΛΥΣΗ|ΤΡΟΠΟΣ|ΠΑΡΑΤΗΡΗΣΕΙΣ)/i;
  const merchant = headers.find((header) => header.length >= 3 && !sectionLabel.test(header));
  return merchant ?? null;
}

/**
 * The invoice's own issue date wins over the dispatch timestamp; both are
 * matched on accent-folded text and parsed from their printed forms.
 */
function findDate(foldedText: string): string | null {
  const issue = foldedText.match(/ΗΜ\/ΝΙΑΣ?\s+ΕΚΔΟΣΗΣ[^0-9]*(\d{1,2}-\d{1,2}-\d{2,4})/);
  if (issue) return detectDate(issue[1]);
  const dispatch = foldedText.match(/ΕΝΑΡΞΗΣ\s*ΑΠΟΣΤΟΛΗΣ[^0-9]*(\d{4}-\d{2}-\d{2})/);
  if (dispatch) return detectDate(dispatch[1]);
  return null;
}

function findReceiptNumber(html: string): string | null {
  // Keep the series and number inside the issuer's printed field.
  const match = html.match(/Αρ\.?[ \t]+Παραστατικ(?:ού|ου)[ \t]*:?[ \t]*(\d{1,20}(?:[ \t]+\d{1,20})?)[ \t]*(?=<\/|\r?\n)/iu);
  return match ? match[1].replace(/[ \t]+/g, " ") : null;
}

/**
 * Amount printed right after a standalone summary label on accent-folded
 * text, e.g. "ΕΚΠΤΩΣΗ 1,09EUR". The letter lookarounds keep "ΕΚΠΤΩΣΗ" from
 * matching the tail of "ΑΞΙΑ ΠΡΟ ΕΚΠΤΩΣΗΣ" and keep "ΦΠΑ" off the "ΦΠΑ%"
 * breakdown header.
 */
function labelledAmount(foldedText: string, label: string): number | null {
  const match = foldedText.match(new RegExp(`(?<![\\p{L}])${label}(?![\\p{L}])[\\s:]*(\\d+(?:[.,]\\d{3})*[.,]\\d{2})(?!\\d)`, "u"));
  return match ? parseAmount(match[1]) : null;
}

function parseVatBreakdown(html: string): TaxBreakdownEntry[] {
  const section = html.match(/ΑΝΑΛΥΣΗ\s+ΦΠΑ([\s\S]*?)(?:ΣΤΟΙΧΕΙΑ\s+ΠΛΗΡΩΜΗΣ|ΠΑΡΑΤΗΡΗΣΕΙΣ|$)/i);
  if (!section) return [];
  const entries: TaxBreakdownEntry[] = [];
  // Only the issuer's three-column layout identifies a rate, net amount and tax.
  const rows = section[1].matchAll(/<div\b[^>]*>\s*((?:<div\b[^>]*>[^<]*<\/div>\s*){3})<\/div>/gi);
  const money = /^-?\d[\d.,]*[.,]\d{2}\s*(?:EUR|€)?$/i;
  for (const row of rows) {
    const [rateCell, netCell, taxCell] = [...row[1].matchAll(/<div\b[^>]*>([^<]*)<\/div>/gi)]
      .map((cell) => stripTags(cell[1]));
    if (!/^\d{1,3}(?:[.,]\d+)?\s*%$/.test(rateCell) || !money.test(netCell) || !money.test(taxCell)) continue;
    const rate = parseQuantity(rateCell);
    const net = parseAmount(netCell);
    const tax = parseAmount(taxCell);
    if (rate == null || rate > 100 || net == null || tax == null) continue;
    entries.push({ rate, net, tax, gross: round(net + tax, 2) });
  }
  return entries;
}

/** Parse the item table rows; returns null when the page has no such table. */
function parseRows(html: string): EntersoftRow[] | null {
  const table = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!table) return null;
  const rows: EntersoftRow[] = [];
  for (const rowMatch of table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi)];
    if (!cells.length) continue;
    const row: EntersoftRow = {
      code: null,
      description: null,
      unit: null,
      quantity: null,
      unitPrice: null,
      preDiscount: null,
      discount: null,
      taxRate: null,
      lineTotal: null,
    };
    for (const cell of cells) {
      const value = stripTags(cell[2]);
      const title = cell[1].match(/\sdata-title\s*=\s*(["'])(.*?)\1/i);
      const field = title && COLUMN_KEYS[labelKey(title[2])];
      if (field && value) row[field] = value;
    }
    if (!Object.values(row).some(Boolean)) continue; // Unlabeled summary or spacer row.
    if (!row.lineTotal && row.preDiscount) {
      const before = parseAmount(row.preDiscount);
      const discount = row.discount ? parseAmount(row.discount) : 0;
      // A blank amount is a free item only when the other amounts establish zero.
      if (before != null && discount != null && before === Math.abs(discount)) row.lineTotal = "0,00";
    }
    // An incomplete labeled item would create a partial purchase draft.
    if (!row.description || !row.quantity || !row.lineTotal ||
        parseQuantity(row.quantity) == null || parseAmount(row.lineTotal) == null) return null;
    rows.push(row);
  }
  return rows.length ? rows : null;
}

/** Only explicit fees: PERTEL, or a description that says levy/fee. */
function isFeeRow(row: EntersoftRow): boolean {
  if (row.code && FEE_CODE.test(row.code.trim())) return true;
  return Boolean(row.description && FEE_DESCRIPTION.test(row.description));
}

function mapUnit(raw: string | null): string | null {
  if (!raw) return null;
  return UNIT_MAP[labelKey(raw)] ?? null;
}

/**
 * Parse an Entersoft invoice page. Returns null when the HTML does not look
 * like the expected document, so the caller can fall back honestly.
 */
export function parseEntersoftInvoiceHtml(
  html: string,
  fallbackCurrency: string | null = null,
): EntersoftInvoiceParse | null {
  const source = String(html ?? "");
  if (!source.trim()) return null;
  const rows = parseRows(source);
  if (!rows) return null;

  const fullText = stripTags(source);
  const foldedFullText = foldGreek(fullText);
  const afterTable = source.slice(source.lastIndexOf("</table>") + 1);
  const foldedTotals = foldGreek(stripTags(afterTable));

  const total = labelledAmount(foldedTotals, "ΤΕΛΙΚΗ\\s+ΑΞΙΑ");
  const subtotal = labelledAmount(foldedTotals, "ΚΑΘΑΡΗ\\s+ΑΞΙΑ");
  const tax = labelledAmount(foldedTotals, "Φ\\.?\\s*Π\\.?\\s*Α\\.?");
  const savings = labelledAmount(foldedTotals, "ΕΚΠΤΩΣΗ");
  const taxBreakdown = parseVatBreakdown(afterTable);
  // Amounts print the currency joined to the digits ("51,39EUR"), so the
  // currency test must not require a word boundary before EUR.
  const currency = /(?<![A-Za-z])EUR(?![A-Za-z])|\u20ac/.test(source) ? "EUR" : fallbackCurrency;
  const purchasedAt = findDate(foldedFullText);
  const vendorName = findVendor(source);
  const receiptNumber = findReceiptNumber(source);
  if (total == null && !rows.some((row) => row.lineTotal)) return null;

  const lines: ReceiptDraft["lines"] = [];
  const textLines: string[] = [];
  let excludedCharges = 0;
  let lineSavings = 0;

  for (const row of rows) {
    const description = (row.description ?? "").trim().slice(0, 160);
    if (!description) continue;
    const quantity = parseQuantity(row.quantity ?? "") ?? 1;
    const lineTotalRaw = parseAmount(row.lineTotal ?? "");
    const lineTotal = lineTotalRaw != null ? Math.max(0, lineTotalRaw) : null;
    const discount = Math.abs(parseAmount(row.discount ?? "") ?? 0);
    const taxRate = parseAmount(row.taxRate ?? "");

    if (isFeeRow(row)) {
      if (lineTotal != null) excludedCharges = round(excludedCharges + lineTotal, 2);
      textLines.push(
        `${row.code ?? ""}  ${description}  ${(row.quantity ?? "").trim()} ${(row.unit ?? "").trim()} ${lineTotal ?? ""}`.trim(),
      );
      continue;
    }

    // Same convention as the template parsers' applyDiscount: the effective
    // VAT-inclusive unit price after the discount, from the charged amount.
    const unitPrice = lineTotal != null && quantity > 0 ? round(lineTotal / quantity, 4) : null;
    if (discount > 0) lineSavings = round(lineSavings + discount, 2);

    lines.push({
      description,
      rawDescription: description,
      quantity,
      unit: mapUnit(row.unit),
      unitPrice,
      lineTotal,
      taxRate: taxRate != null && taxRate >= 0 && taxRate <= 100 ? taxRate : null,
      discount,
      barcode: null,
    });
    textLines.push(
      [
        row.code ?? "",
        description,
        (row.quantity ?? "").trim(),
        (row.unit ?? "").trim(),
        unitPrice != null ? unitPrice.toFixed(2) : "",
        (row.preDiscount ?? "").trim(),
        discount > 0 ? discount.toFixed(2) : "",
        row.taxRate ?? "",
        lineTotal != null ? lineTotal.toFixed(2) : "",
      ]
        .filter(Boolean)
        .join("  "),
    );
  }

  textLines.unshift(
    vendorName ?? "Entersoft",
    "ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ ΠΩΛΗΣΗΣ",
    ...(receiptNumber ? [`Αρ. Παραστατικού ${receiptNumber}`] : []),
    ...(purchasedAt ? [`ΗΜ/ΝΙΑ ${purchasedAt}`] : []),
    "",
  );
  if (total != null) textLines.push("", `ΣΥΝΟΛΟ ${total.toFixed(2)}`);
  if (subtotal != null) textLines.push(`ΚΑΘΑΡΗ ΑΞΙΑ ${subtotal.toFixed(2)}`);
  if (tax != null) textLines.push(`ΦΠΑ ${tax.toFixed(2)}`);
  if (savings != null && savings > 0) textLines.push(`ΣΥΝΟΛΟ ΕΚΠΤΩΣΕΩΝ ${savings.toFixed(2)}`);
  for (const entry of taxBreakdown) {
    textLines.push(`ΦΠΑ ${entry.rate}% ${entry.net.toFixed(2)} ${entry.tax.toFixed(2)}`);
  }

  const draft: ReceiptDraft = {
    vendorName,
    purchasedAt,
    currency,
    total,
    subtotal,
    tax: tax ?? (taxBreakdown.length ? round(taxBreakdown.reduce((sum, entry) => sum + entry.tax, 0), 2) : null),
    taxBreakdown,
    savings: savings != null && savings > 0 ? savings : lineSavings > 0 ? lineSavings : null,
    notes: receiptNumber ? `Αρ. Παραστατικού ${receiptNumber}` : null,
    lines,
  };
  return { draft, text: textLines.join("\n"), excludedCharges };
}
