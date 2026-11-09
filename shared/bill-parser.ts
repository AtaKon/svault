import type { BillBreakdownLine, BillParseResult } from "./types.js";
import type { BillType } from "./bill-types.js";

/**
 * Conservative local parser for utility-bill text (a PDF text layer or OCR).
 *
 * Bills vary a lot between suppliers, so this only trusts lines that carry a
 * printed amount and leaves anything unclear for the user to correct. It never
 * invents a total: when the printed total is missing the result is marked as
 * inferred from the breakdown.
 */

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Strip accents and case so Greek labels match regardless of OCR quality. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

const TOTAL_WORDS =
  /(συνολο(?:\s+(?:πληρωτεου|πληρωμης|με\s+φπα))?|πληρωτεο(?:\s+ποσο)?|ποσο\s+πληρωμης|τελικο\s+ποσο|προς\s+πληρωμη|total(?:\s+(?:amount|due|payable|incl(?:uding)?\s+(?:vat|tax)))?|amount\s+due|grand\s+total|balance\s+due|pay(?:ment)?\s+due)/;
const SUBTOTAL_WORDS = /(υποσυνολο|καθαρη\s+αξια|συνολο\s+χρεωσεων|χρεωσεις\s+συνολο|sub\s*-?\s*total|net\s+(?:amount|total)|total\s+charges)/;
const TOTAL_WITH_TAX = /(με\s+φπα|συμπεριλαμβανομενου|incl(?:uding)?\s+(?:vat|tax)|(?:vat|tax)\s+incl|with\s+vat)/;
const CONSUMPTION_ONLY = /(καταναλωσ|consumption|usage)/;
const NOT_A_TOTAL = /(page|σελιδα|invoice\s+no|receipt\s+no|αριθμ\p{L}*\s+παραστατικου|αρ\.?\s+παραστατικου|items|τεμαχια|ποσοτητα|quantity)/u;
const TAX_WORDS =
  /(φπα|φ\.π\.α|vat|iva|sales\s+tax|χαρτοσημο|δημοτικ\p{L}*\s+(?:τελ|φορ)|(?:^|[^α-ω])(?:ερτ|εφα)(?:[^α-ω]|$)|ε\.φ\.α|(?:^|[^α-ω])φορος(?:[^α-ω]|$)|(?:^|[^α-ω])εισφορα(?:[^α-ω]|$)|(?:^|[^α-ω])tax(?:[^α-ω]|$))/u;
const TAX_EXCLUDE = /(αφμ|a\.?\s*φ\.?\s*μ|vat\s+(?:no|number|id)|tax\s+(?:id|no|number|office|invoice)|invoice|τιμολογιο|αποδειξη|receipt)/;
const SUMMARY_WORDS =
  /(συνολο|υποσυνολο|πληρωτεο|πληρωμη|εξοφληση|καθαρη\s+αξια|total|sub\s*-?\s*total|amount\s+due|grand\s+total|payment|balance\s+due|change|ρεστα|μετρητα|καρτα|cash|card|iban|αφμ|vat\s+no|account\s+no|invoice|τιμολογιο|receipt|αποδειξη|ημερομηνια|σελιδα|page|barcode|γραμμωτ|τηλεφων|phone|email|www\.|https?:|παροχ|μετρητ|αριθμ|supply|meter|account|customer|reference|contract|συμβολαι)/;
const METER_READING = /(μετρηση|ενδειξη|reading|μετρητης|meter)/;
const DISCOUNT_WORDS = /(εκπτωσ|discount|μειωσ|προσφορα|πιστωσ|credit|refund|επιστροφη)/;
const CREDIT_WORDS = /(πιστωτικ|credit\s+note|επιστροφη|refund)/;
const DATE_LABEL = /(ληξη|εξοφληση|πληρωτεο\s+εως|πληρωμη\s+εως|προθεσμια|due\s+date|pay\s+by|payment\s+due|due\s+by)/;
const ISSUE_DATE_LABEL = /(εκδοσ|issue|ημερομηνια)/;

const NUMBER_TOKEN = String.raw`\d[\d.,]*\d|\d`;
const CONSUMPTION = new RegExp(
  `(${NUMBER_TOKEN})\\s*(kwh|kw\\s*h|mwh|m3|m³|κμ|λιτρα|lt|l|kg|ημερ(?:α|ες)?|days?|μην(?:ας|ες)?|months?|τεμαχια|τμχ|m2|m²|ωρ(?:α|ες)|hours?)`,
  "u",
);
const EXPLICIT_UNIT_PRICE = new RegExp(
  `(${NUMBER_TOKEN})\\s*(?:€|eur)?\\s*(?:\\/|ανα|per)\\s*(kwh|kw\\s*h|mwh|m3|m³|κμ|λιτρα|lt|l|kg|ημερ(?:α|ες)?|days?|μην(?:ας|ες)?|months?|τεμαχια|τμχ|m2|m²|ωρ(?:α|ες)|hours?)`,
  "u",
);

const UNIT_LABELS: Record<string, string> = {
  kwh: "kWh",
  mwh: "MWh",
  m3: "m³",
  "m³": "m³",
  κμ: "m³",
  λιτρα: "L",
  lt: "L",
  l: "L",
  kg: "kg",
  ημερα: "days",
  ημερες: "days",
  ημερ: "days",
  day: "days",
  days: "days",
  μηνας: "months",
  μηνες: "months",
  μην: "months",
  month: "months",
  months: "months",
  τεμαχια: "pcs",
  τμχ: "pcs",
  m2: "m²",
  "m²": "m²",
  ωρα: "hours",
  ωρες: "hours",
  hour: "hours",
  hours: "hours",
};

const SUPPLIERS: Array<[RegExp, string]> = [
  [/δ\.?ε\.?η|\bdei\b|δεδδηε/, "ΔΕΗ"],
  [/ευδαπ|eydap/, "ΕΥΔΑΠ"],
  [/ευαθ|eyath/, "ΕΥΑΘ"],
  [/κοσμοτε|cosmote/, "Cosmote"],
  [/βονταφον|vodafone/, "Vodafone"],
  [/\bnova\b/, "Nova"],
  [/\bwind\b/, "Wind"],
  [/\bote\b|(?:^|[^α-ω])οτε(?:[^α-ω]|$)/u, "OTE"],
  [/ηρων|heron/, "Ηρών"],
  [/elpedison|ελπεντισον/, "Elpedison"],
  [/protergia|προτεργια/, "Protergia"],
  [/δεπα|φυσικο\s+αεριο|φυσικου\s+αεριου/, "Φυσικό αέριο"],
  [/δημος|δημου|municipal/, "Δήμος"],
];

/** Supplier or document-type signals that beat generic keyword counting. */
const STRONG_TYPE_SIGNALS: Array<[BillType, RegExp]> = [
  ["building_fees", /(κοινοχρηστ|διαχειριση\s+πολυκατοικιας)/u],
  ["rent", /(ενοικιο|μισθωμα|μισθωτηριο)/u],
  ["insurance", /(ασφαλιστηριο|ασφαλεια\s+κατοικιας|home\s+insurance)/u],
  ["electricity", /(\bδεη\b|\bδ\.ε\.η\b|\bdei\b|ηρων|heron|elpedison|protergia)/u],
  ["water", /(ευδαπ|eydap|ευαθ|eyath|υδρευση|υδρευσης)/u],
  ["internet_telecom", /(κοσμοτε|cosmote|vodafone|βονταφον|\bnova\b|\bwind\b|\bote\b|(?:^|[^α-ω])οτε(?:[^α-ω]|$)|τηλεπικοινωνι)/u],
  ["natural_gas", /(δεπα|επα\s+αττικη|φυσικο\s+αεριο|φυσικου\s+αεριου)/u],
];

const TYPE_KEYWORDS_SOURCE: Array<[BillType, RegExp]> = [
  ["electricity", /(ηλεκτρικ\p{L}*\s+(?:ρευμα|ενεργεια)|ρευμα|\bδεη\b|\bdei\b|kwh|electricity|electric\s+power)/u],
  ["water", /(νερο|υδρευση|υδρευσης|ευδαπ|ευαθ|\bwater\b|\bm3\b|m³)/u],
  ["natural_gas", /(φυσικο\s+αεριο|φυσικου\s+αεριου|δεπα|natural\s+gas|\bgas\b)/u],
  ["heating_oil", /(πετρελαιο|θερμανσης|heating\s+oil|diesel)/u],
  ["internet_telecom", /(τηλεπικοινωνι|τηλεφωνι|ιντερνετ|internet|broadband|cosmote|vodafone|\bnova\b|\bote\b|(?:^|[^α-ω])οτε(?:[^α-ω]|$))/u],
  ["rent", /(ενοικιο|μισθωμα|\brent\b|lease)/u],
  ["building_fees", /(κοινοχρηστ|διαχειριση\s+πολυκατοικιας|building\s+fee|common\s+charge)/u],
  ["municipal_fees", /(δημοτικ\p{L}*\s+(?:τελ|φορ)|municipal|δημος|δημου)/u],
  ["insurance", /(ασφαλει|ασφαλιστ|insurance|policy\s+no)/u],
];
/** Global variants are built once instead of on every parser call. */
const TYPE_KEYWORDS = TYPE_KEYWORDS_SOURCE.map(([type, pattern]) => [type, new RegExp(pattern.source, "gu")] as const);

interface NumberToken {
  value: number;
  raw: string;
  percent: boolean;
}

function compactThousands(line: string): string {
  // "1 234,56" is one number, while "0,1234 152,30" is two. Only grouped
  // integer digits with exactly three digits per group are joined.
  return line.replace(
    /(?<![\d.,])(\d{1,3}(?:[ \u00a0]\d{3})+(?:[.,]\d+)?)/g,
    (match) => match.replace(/[ \u00a0]/g, ""),
  );
}

/**
 * Parse both 1.234,56 and 1,234.56, including 4-decimal unit prices.
 *
 * A single separator followed by exactly three digits is ambiguous: `1,234`
 * may be 1234 (money) or 1.234 (a per-unit price). Callers that know a value is
 * a unit price pass `{ thousands: false }`; totals keep the money default.
 */
export function parseBillNumber(raw: string, options: { thousands?: boolean } = {}): number | null {
  let text = raw.trim().replace(/[^\d.,+-]/g, "");
  if (!/\d/.test(text)) return null;
  let sign = 1;
  if (text.startsWith("-")) {
    sign = -1;
    text = text.slice(1);
  } else {
    text = text.replace(/^\+/, "");
  }

  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? "." : ",";
    const thousands = decimal === "." ? "," : ".";
    // Reject malformed grouping such as 1,2,3.45 instead of guessing.
    const shape = decimal === "."
      ? /^\d{1,3}(?:,\d{3})*\.\d+$/
      : /^\d{1,3}(?:\.\d{3})*,\d+$/;
    if (!shape.test(text)) return null;
    text = text.split(thousands).join("");
    if (decimal === ",") text = text.replace(",", ".");
  } else if (lastComma >= 0 || lastDot >= 0) {
    const separator = lastComma >= 0 ? "," : ".";
    const separatorCount = text.split(separator).length - 1;
    if (separatorCount > 1) {
      // Several separators are only valid as grouped thousands.
      if (!/^\d{1,3}(?:[.,]\d{3})+$/.test(text) || options.thousands === false) return null;
      text = text.replace(/[.,]/g, "");
    } else {
      const decimals = text.length - text.lastIndexOf(separator) - 1;
      const integer = text.slice(0, text.lastIndexOf(separator));
      const leadingZero = /^0+$/.test(integer);
      if (decimals === 3 && integer.length > 0 && integer.length <= 3 && !leadingZero && options.thousands !== false) {
        text = text.replace(separator, "");
      } else {
        text = text.replace(separator, ".");
      }
    }
  }

  const value = Number(text);
  return Number.isFinite(value) ? sign * value : null;
}

function numbersIn(line: string): NumberToken[] {
  // Money rows (totals, taxes) carry two decimals, so a three-digit run is
  // treated as grouped thousands by default; chargeLine re-parses unit-price
  // candidates with { thousands: false }.
  // Dates, billing periods and meter serials are not money; remove them first.
  // A dotted pair such as 100.00 is money, so dotted runs are stripped only
  // when they form a real date. This also keeps 1.234.567,00 intact.
  const source = compactThousands(line)
    // Strip any date-shaped run, valid or not; this also removes impossible
    // dates such as 31/02/2024 instead of turning them into money tokens.
    .replace(/\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/g, " ")
    .replace(/\b\d{1,2}\/(?:19|20)\d{2}\b/g, " ");
  const tokens: NumberToken[] = [];
  const pattern = /[-+]?\d[\d.,]*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const value = parseBillNumber(match[0]);
    if (value == null) continue;
    const percent = /^\s*%/.test(source.slice(pattern.lastIndex));
    tokens.push({ value, raw: match[0], percent });
  }
  return tokens;
}

/** Prefer a decimal amount over an integer consumption figure on total rows. */
function moneyValue(tokens: NumberToken[]): number | null {
  if (!tokens.length || tokens.length >= 3) return null;
  const decimal = [...tokens].reverse().find((token) => /[.,]\d{1,2}$/.test(token.raw));
  return (decimal ?? tokens[tokens.length - 1]).value;
}

function describeLine(line: string): string {
  return line
    .replace(/[€£$¥%]/g, " ")
    .replace(/\b\d[\d.,]*\s*(?:kwh|kw\s*h|mwh|m3|m³|κμ|λιτρα|lt|kg|days?|months?|ημερ\p{L}*|μην\p{L}*|τεμαχια|τμχ|hours?|ωρ\p{L}*)\b/giu, " ")
    .replace(/[-+]?\d[\d.,]*/g, " ")
    .replace(/[x×*+/=]/giu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s:;.,\-–—|]+|[\s:;.,\-–—|]+$/g, "")
    .trim()
    .slice(0, 160);
}

function unitLabel(unit: string): string {
  return UNIT_LABELS[unit.toLowerCase().replace(/\s+/g, "")] ?? unit;
}

/** Fold text while keeping a map back to original character offsets. */
function foldWithIndex(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const normalized = text[index].normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    if (!normalized) {
      map.push(index);
      continue;
    }
    for (const part of normalized) {
      folded += part;
      map.push(index);
    }
  }
  return { folded, map };
}

function parseDateText(text: string): string | null {
  const iso = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const short = text.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/);
  if (!short) return null;
  const first = Number(short[1]);
  const second = Number(short[2]);
  let year = Number(short[3]);
  if (year < 100) year += 2000;
  // European bills print dd/mm; flip only when the values force it.
  if (first > 12) return isoDate(year, second, first);
  if (second > 12) return isoDate(year, first, second);
  return isoDate(year, second, first);
}

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function detectDueDate(lines: string[]): string | null {
  for (let index = 0; index < lines.length; index++) {
    const folded = fold(lines[index]);
    if (ISSUE_DATE_LABEL.test(folded) && !DATE_LABEL.test(folded)) continue;
    if (!DATE_LABEL.test(folded)) continue;
    if (ISSUE_DATE_LABEL.test(folded)) {
      // Both labels share a line: read only the text after the due label so
      // the issue date cannot win just because it is printed first.
      const { folded: mapped, map } = foldWithIndex(lines[index]);
      const dueMatch = mapped.match(DATE_LABEL);
      if (dueMatch?.index != null) {
        const afterLabel = map[dueMatch.index + dueMatch[0].length] ?? lines[index].length;
        const dueDate = parseDateText(lines[index].slice(afterLabel));
        if (dueDate) return dueDate;
      }
    } else {
      const sameLine = parseDateText(lines[index]);
      if (sameLine) return sameLine;
    }
    const next = lines[index + 1];
    if (next) {
      const nextFolded = fold(next);
      if (!ISSUE_DATE_LABEL.test(nextFolded)) {
        const nextDate = parseDateText(next);
        if (nextDate) return nextDate;
      }
    }
  }
  return null;
}

function detectCurrency(text: string): string | null {
  if (/\d\s?€|€\s?\d|\beur\b/i.test(text)) return "EUR";
  // Require a currency-like amount so a stray symbol in a URL or slogan does
  // not decide the bill currency.
  if (/£\s?\d|\bgbp\b/i.test(text)) return "GBP";
  if (/\$\s?\d|\busd\b/i.test(text)) return "USD";
  return null;
}

function detectName(lines: string[]): string | null {
  const joined = lines.slice(0, 6).join("\n");
  for (const [pattern, name] of SUPPLIERS) {
    if (pattern.test(fold(joined))) return name;
  }
  for (const line of lines.slice(0, 10)) {
    const candidate = line.trim().replace(/\s{2,}/g, " ");
    if (candidate.length < 3 || candidate.length > 60) continue;
    if (!/\p{L}{3}/u.test(candidate)) continue;
    if (/\d/.test(candidate)) continue;
    const folded = fold(candidate);
    if (/(λογαριασμ|τιμολογ|αποδειξ|ειδοποιησ|invoice|statement|bill|receipt|page|σελιδα|αφμ|vat|ημερομηνια|date|customer|πελατ|τελ|χρεωσ|καταναλωσ|παγιο|φορ|φπα|tax|charge|usage|consumption|amount|ποσο)/.test(folded)) continue;
    return candidate;
  }
  return null;
}

function detectBillType(text: string): BillType | null {
  const folded = fold(text);
  for (const [type, pattern] of STRONG_TYPE_SIGNALS) {
    if (pattern.test(folded)) return type;
  }
  let best: BillType | null = null;
  let bestScore = 0;
  for (const [type, pattern] of TYPE_KEYWORDS) {
    const matches = folded.match(pattern);
    const score = matches ? matches.length : 0;
    if (score > bestScore) {
      best = type;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function taxAmount(values: number[], rate: number | null): { amount: number | null; base: number | null } {
  if (!values.length) return { amount: null, base: null };
  if (values.length === 1) return { amount: values[0], base: null };

  if (values.length >= 3) {
    const [base, tax, gross] = values.slice(-3);
    if (rate != null &&
      Math.abs(base + tax - gross) <= 0.03 &&
      Math.abs(base * rate / 100 - tax) <= Math.max(0.03, tax * 0.02)) {
      return { amount: tax, base };
    }
    // Three values are normally net/tax/gross, but guessing the middle column
    // when the rate does not reconcile risks recording the gross as tax.
    return { amount: null, base: null };
  }
  if (values.length === 2 && rate == null) {
    // Two values without a printed rate are ambiguous; do not guess the gross.
    return { amount: null, base: null };
  }
  if (rate != null) {
    for (let index = values.length - 2; index >= 0; index--) {
      const base = values[index];
      const tax = values[index + 1];
      if (Math.abs(base * rate / 100 - tax) <= Math.max(0.03, Math.abs(tax) * 0.02)) {
        return { amount: tax, base };
      }
      // Some layouts print tax before the net amount.
      if (Math.abs(tax * rate / 100 - base) <= Math.max(0.03, Math.abs(base) * 0.02)) {
        return { amount: base, base: tax };
      }
    }
    // A printed rate that does not reconcile leaves the column order unclear.
    return { amount: null, base: null };
  }
  return { amount: values[values.length - 1], base: null };
}

function chargeLine(line: string): BillBreakdownLine | null {
  const folded = fold(line);
  const allTokens = numbersIn(line);
  const tokens = allTokens.filter((token) => !token.percent);
  if (!tokens.length) return null;

  const quantityMatch = folded.match(CONSUMPTION);
  const explicitUnitPrice = folded.match(EXPLICIT_UNIT_PRICE);
  // Consumption quantities group thousands on most bills ("1.234 kWh"), so
  // they use the money interpretation; unit prices opt out separately.
  const quantity = quantityMatch ? parseBillNumber(quantityMatch[1]) : null;
  const unit = quantityMatch ? unitLabel(quantityMatch[2]) : null;
  let unitPrice = explicitUnitPrice ? parseBillNumber(explicitUnitPrice[1], { thousands: false }) : null;

  // Unit prices may legitimately have three decimals ("1,234"), unlike the
  // printed money totals, so they are parsed with the decimal interpretation.
  const asUnitNumber = (token: NumberToken) => parseBillNumber(token.raw, { thousands: false });
  const near = (value: number, target: number) => Math.abs(value - target) <= Math.max(1e-6, Math.abs(target) * 1e-6);
  const candidates = [...tokens];
  if (quantity != null) {
    const quantityIndex = candidates.findIndex((token) => {
      const value = asUnitNumber(token);
      return value != null && near(value, quantity);
    });
    if (quantityIndex >= 0 && candidates.length > 1) candidates.splice(quantityIndex, 1);
  }
  if (unitPrice != null) {
    const priceIndex = candidates.findIndex((token) => {
      const value = asUnitNumber(token);
      return value != null && near(value, unitPrice!);
    });
    if (priceIndex >= 0) candidates.splice(priceIndex, 1);
  }
  if (!candidates.length && !(quantity != null && unitPrice != null)) return null;

  let amount: number | null = null;
  if (quantity != null && unitPrice == null) {
    if (candidates.length >= 2) {
      const previous = candidates[candidates.length - 2];
      const last = candidates[candidates.length - 1];
      const previousPrice = asUnitNumber(previous);
      const lastPrice = asUnitNumber(last);
      const tolerance = (value: number) => Math.max(0.05, Math.abs(value) * 0.01);
      if (previousPrice != null && Math.abs(quantity * previousPrice - last.value) <= tolerance(last.value)) {
        unitPrice = previousPrice;
        amount = last.value;
      } else if (lastPrice != null && Math.abs(quantity * lastPrice - previous.value) <= tolerance(previous.value)) {
        unitPrice = lastPrice;
        amount = previous.value;
      } else {
        // Neither order reconciles with the quantity; keep the amount but do
        // not present a made-up unit price.
        unitPrice = null;
        amount = last.value;
      }
    } else if (candidates.length === 1) {
      const value = candidates[0].value;
      if (value < 1 && quantity >= 10) {
        // A small number after a large quantity is usually the unit price;
        // derive the line amount instead of dropping the charge.
        unitPrice = value;
        amount = round2(quantity * value);
      } else {
        amount = value;
        unitPrice = quantity > 0 ? amount / quantity : null;
      }
    }
  } else if (quantity != null && unitPrice != null) {
    amount = candidates.length ? candidates[candidates.length - 1].value : quantity * unitPrice;
  } else if (candidates.length) {
    amount = candidates[candidates.length - 1].value;
  }
  if (amount == null && unitPrice != null && quantity != null) amount = quantity * unitPrice;
  if (amount == null || !Number.isFinite(amount)) return null;
  // A fixed charge that happens to mention consumption has no printed unit
  // price; do not derive one.
  if (explicitUnitPrice == null && /(παγιο|standing|fixed\s+charge|fee|τελος|χαρτοσημο)/.test(folded)) {
    unitPrice = null;
  }

  let description = describeLine(line);
  if (!description) {
    if (quantity != null) description = "Consumption";
    else return null;
  }
  if (!/\p{L}{2}/u.test(description) && quantity == null) return null;

  const kind = CREDIT_WORDS.test(folded) ? "credit" : DISCOUNT_WORDS.test(folded) ? "discount" : "charge";
  const rate = allTokens.find((token) => token.percent)?.value ?? null;
  const magnitude = Math.abs(amount);
  if (!(magnitude > 0) || magnitude > 1_000_000) return null;
  // Account and meter numbers are long integers without decimals or a currency.
  const hasFraction = tokens.some((token) => /[.,]\d{1,2}$/.test(token.raw));
  if (!hasFraction && magnitude >= 10_000 && !/[€£$¥]/.test(line)) return null;

  return {
    description,
    kind,
    quantity: quantity != null ? Math.round(quantity * 1000) / 1000 : null,
    unit,
    unitPrice: unitPrice != null ? Math.round(unitPrice * 10000) / 10000 : null,
    amount: round2(magnitude),
    taxRate: rate != null && rate > 0 && rate <= 100 ? round2(rate) : null,
  };
}

export function billLinesTotal(lines: BillBreakdownLine[]): number {
  return round2(lines.reduce((sum, line) => {
    if (line.amount == null) return sum;
    return line.kind === "discount" || line.kind === "credit"
      ? sum - Math.abs(line.amount)
      : sum + line.amount;
  }, 0));
}

export function parseBillText(rawText: string, options: { currency?: string | null } = {}): BillParseResult {
  const text = rawText.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
  const lines = text.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim());

  let printedTotal: number | null = null;
  let totalScore = 0;
  let printedSubtotal: number | null = null;
  const breakdown: BillBreakdownLine[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (!line) continue;
    const folded = fold(line);
    const numbers = numbersIn(line);
    const money = numbers.filter((token) => !token.percent);

    // Order matters: tax rows first, then subtotals, then grand totals.
    const isGrandWithTax = TOTAL_WITH_TAX.test(folded);

    // "Total VAT" and "total stamp duty" are tax rows; "total including VAT"
    // is the grand total that also happens to mention a tax.
    if (TAX_WORDS.test(folded) && !TAX_EXCLUDE.test(folded) && !isGrandWithTax) {
      const rate = numbers.find((token) => token.percent)?.value ?? null;
      const picked = taxAmount(money.map((token) => token.value), rate);
      if (picked.amount != null && picked.amount > 0 && picked.amount <= 1_000_000) {
        const description = describeLine(line) || "Tax";
        breakdown.push({
          description,
          kind: "tax",
          quantity: null,
          unit: null,
          unitPrice: null,
          amount: round2(picked.amount),
          taxRate: rate != null && rate > 0 && rate <= 100 ? round2(rate) : null,
        });
      }
      continue;
    }

    if (SUBTOTAL_WORDS.test(folded) && !isGrandWithTax) {
      const value = moneyValue(money);
      if (value != null && value > 0) printedSubtotal = round2(value);
      continue;
    }

    if (TOTAL_WORDS.test(folded) && !CONSUMPTION_ONLY.test(folded) && !NOT_A_TOTAL.test(folded)) {
      const value = moneyValue(money);
      if (value != null && value > 0) {
        const explicit = /(πληρωτεο|ποσο\s+πληρωμης|amount\s+due|balance\s+due|pay(?:ment)?\s+due)/.test(folded);
        const score = (explicit ? 10 : 5) +
          (folded.includes("συνολο") || folded.includes("total") ? 2 : 0) +
          lineIndex / Math.max(1, lines.length);
        if (score >= totalScore) {
          totalScore = score;
          printedTotal = round2(value);
        }
      }
      continue;
    }

    if (SUMMARY_WORDS.test(folded) || METER_READING.test(folded) || DATE_LABEL.test(folded)) continue;

    const charge = chargeLine(line);
    if (charge) breakdown.push(charge);
  }

  // Remove duplicate charges that OCR may repeat across page breaks.
  const seen = new Set<string>();
  const linesOut = breakdown.filter((line) => {
    const key = `${line.kind}|${fold(line.description)}|${line.amount ?? ""}|${line.quantity ?? ""}|${line.unit ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const charges = linesOut.filter((line) => line.kind === "charge");
  const discounts = linesOut.filter((line) => line.kind === "discount");
  const credits = linesOut.filter((line) => line.kind === "credit");
  const taxLines = linesOut.filter((line) => line.kind === "tax");
  const chargeSum = round2(charges.reduce((sum, line) => sum + (line.amount ?? 0), 0));
  const discountSum = round2([...discounts, ...credits].reduce((sum, line) => sum + (line.amount ?? 0), 0));

  let subtotal = printedSubtotal;
  if (subtotal == null && charges.length) subtotal = round2(chargeSum - discountSum);

  // A single-value tax row is ambiguous: it may print the tax, the net or the
  // gross. When the printed total and subtotal are available, use their
  // difference to correct a lone tax line instead of inflating taxTotal.
  // Discounts and credits change the tax base, so never correct those bills.
  if (printedTotal != null && printedSubtotal != null && subtotal != null && taxLines.length === 1 && taxLines[0].taxRate != null &&
    discounts.length === 0 && credits.length === 0) {
    const expected = round2(printedTotal - subtotal);
    const current = taxLines[0].amount ?? 0;
    const rate = taxLines[0].taxRate ?? 0;
    const expectedByRate = round2(subtotal * rate / 100);
    const grossWithTax = round2(subtotal * (1 + rate / 100));
    const looksLikeGross = Math.abs(current - grossWithTax) <= 0.05;
    // Fix only a printed gross or a total that reconciles with the tax rate; a
    // wilder gap is more likely a parse error elsewhere in the bill.
    if (expected > 0 && (looksLikeGross || Math.abs(expected - expectedByRate) <= 0.05)) {
      taxLines[0].amount = expected;
    }
  }

  let taxTotal = taxLines.length ? round2(taxLines.reduce((sum, line) => sum + (line.amount ?? 0), 0)) : null;
  if (taxTotal == null && printedTotal != null && subtotal != null && printedTotal > subtotal) {
    taxTotal = round2(printedTotal - subtotal);
  }
  if (subtotal == null && printedTotal != null && taxTotal != null && printedTotal >= taxTotal) {
    subtotal = round2(printedTotal - taxTotal);
  }

  let total = printedTotal;
  let totalInferred = false;
  if (total == null && subtotal != null) {
    total = round2(subtotal + (taxTotal ?? 0));
    totalInferred = true;
  }
  if (total == null && linesOut.length) {
    total = billLinesTotal(linesOut);
    totalInferred = true;
  }

  return {
    name: detectName(lines),
    billType: detectBillType(text),
    currency: detectCurrency(text) ?? (options.currency ? options.currency.toUpperCase() : null),
    dueDate: detectDueDate(lines),
    total,
    totalInferred,
    subtotal,
    taxTotal,
    lines: linesOut,
  };
}
