// CSV parsing for inventory imports. Deliberately dependency-free and strict
// about the details spreadsheets actually produce: BOMs, CRLF, quoted fields
// containing separators or newlines, semicolon exports and decimal commas.

export type CsvDelimiter = "," | ";";

export interface ParsedCsv {
  delimiter: CsvDelimiter;
  headers: string[];
  rows: Record<string, string>[];
}

function countUnquoted(line: string, char: string) {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const current = line[index];
    if (current === '"') {
      if (quoted && line[index + 1] === '"') {
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && current === char) {
      count++;
    }
  }
  return count;
}

export function detectDelimiter(text: string): CsvDelimiter {
  const firstLine = text.replace(/^\uFEFF/, "").split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  return countUnquoted(firstLine, ";") > countUnquoted(firstLine, ",") ? ";" : ",";
}

function parseRows(text: string, delimiter: CsvDelimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  row.push(field);
  rows.push(row);
  return rows;
}

export function parseCsv(input: string): ParsedCsv {
  const text = input.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(text);
  const raw = parseRows(text, delimiter);
  const nonEmpty = raw.filter((row) => row.some((cell) => cell.trim() !== ""));
  if (!nonEmpty.length) return { delimiter, headers: [], rows: [] };
  const headers = nonEmpty[0].map((header, index) => header.trim() || `column_${index + 1}`);
  const rows = nonEmpty.slice(1).map((cells) => {
    const entry: Record<string, string> = {};
    headers.forEach((header, index) => {
      entry[header] = (cells[index] ?? "").trim();
    });
    return entry;
  });
  return { delimiter, headers, rows };
}

/** Parse a spreadsheet number, including "1.234,56", "1,5" and "€ 2,40". */
export function parseCsvNumber(value: string | null | undefined): number | null {
  if (value == null) return null;
  let text = String(value)
    .replace(/[\s\u00a0\u202f]/g, "")
    .replace(/[€$£¥]/g, "")
    .trim();
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text);
  text = text.replace(/^\((.*)\)$/, "$1").replace(/[^0-9.,+-]/g, "");
  if (!text) return null;

  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      // 1.234,56 -> dots are thousands separators
      text = text.replace(/\./g, "").replace(/,/g, ".");
    } else {
      // 1,234.56 -> commas are thousands separators
      text = text.replace(/,/g, "");
    }
  } else if (lastComma >= 0) {
    const decimals = text.length - lastComma - 1;
    if (decimals > 0 && decimals <= 2 && text.indexOf(",") === lastComma) {
      text = text.replace(",", ".");
    } else {
      text = text.replace(/,/g, "");
    }
  }

  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  return negative ? -Math.abs(number) : number;
}

function normaliseHeader(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const FIELD_ALIASES: Record<string, string[]> = {
  name: ["name", "product", "product name", "item", "item name", "description", "title", "ονομα", "προιον"],
  brand: ["brand", "manufacturer", "maker", "μαρκα"],
  category: ["category", "type", "group", "κατηγορια"],
  place: ["place", "location", "room", "shelf", "where", "θεση", "τοποθεσια"],
  unit: ["unit", "uom", "measure", "μοναδα"],
  quantity: ["quantity", "qty", "amount", "stock", "count", "on hand", "ποσοτητα"],
  reorderPoint: ["reorder point", "reorder", "reorder level", "threshold", "min", "minimum", "point"],
  targetStock: ["target stock", "target", "max", "maximum", "desired", "par"],
  price: ["price", "unit price", "cost", "value", "τιμη"],
  barcodes: ["barcodes", "barcode", "ean", "upc", "code", "codes", "sku"],
  attributes: ["attributes", "attrs", "metadata", "properties", "extra"],
};

export function guessColumnMap(headers: string[]) {
  const map: Record<string, string> = {};
  const normalised = headers.map((header) => ({ header, key: normaliseHeader(header) }));
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const found = normalised.find((entry) => aliases.includes(entry.key));
    if (found) map[field] = found.header;
  }
  return map;
}
