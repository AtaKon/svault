// Valuation / insurance export.
//
// The pure part: given item rows that already carry their price observations,
// batches and places, derive per-item values, subtotals and the CSV text. The
// route (server/routes/reports.ts) owns the SQL; keeping the maths here means
// the totals and the CSV guard are covered by fast unit tests.

import { round } from "../units.js";
import type {
  ValuationBasis,
  ValuationCategoryTotal,
  ValuationDocumentRef,
  ValuationItem,
  ValuationPlaceTotal,
  ValuationReport,
  ValuationValueSource,
} from "../../shared/types.js";

/** Hard cap so one huge house cannot exhaust the request. Documented in api.md. */
export const MAX_VALUATION_ITEMS = 20_000;

export const VALUATION_BASIS_LABELS: Record<ValuationBasis, string> = {
  latest: "latest purchase price",
  average: "average purchase price",
  stockCost: "stock cost",
};

export const VALUATION_VALUE_SOURCE_LABELS: Record<ValuationValueSource, string> = {
  "latest-purchase": "latest purchase price",
  "average-purchase": "average purchase price",
  "stock-cost": "stock cost",
  none: "no value recorded",
};

export interface ValuationFilters {
  basis: ValuationBasis;
  categoryIds: string[];
  locationIds: string[];
  tags: string[];
  /** Minimum item total in the house currency; null means no minimum. */
  minValue: number | null;
  /** Only items whose warranty ends today or later. */
  warrantyOnly: boolean;
  includeArchived: boolean;
  includeDocuments: boolean;
}

export function emptyValuationFilters(basis: ValuationBasis = "latest"): ValuationFilters {
  return {
    basis,
    categoryIds: [],
    locationIds: [],
    tags: [],
    minValue: null,
    warrantyOnly: false,
    includeArchived: false,
    includeDocuments: false,
  };
}

/** One place (stock location) an item currently has stock in. */
export interface ValuationSourcePlace {
  locationId: string | null;
  locationName: string | null;
  quantity: number;
  /** Sum of lot quantity × lot unit price in this place. */
  value: number;
}

/** Aggregated item row loaded by the route, before any valuation maths. */
export interface ValuationSourceItem {
  id: string;
  name: string;
  brand: string | null;
  categoryId: string | null;
  categoryName: string | null;
  unit: string;
  /** Current stock in the item's base unit. */
  quantity: number;
  /** Latest incoming price, normalised to the base unit. */
  latestPrice: number | null;
  /** Average of incoming prices, normalised to the base unit. */
  averagePrice: number | null;
  /** Quantity held in lots that recorded a unit price. */
  pricedQuantity: number;
  /** Cost of those priced lots. */
  stockValue: number;
  purchasedAt: string | null;
  shop: string | null;
  warrantyUntil: string | null;
  warrantyNote: string | null;
  attributes: Record<string, unknown>;
  tags: string[];
  image: string | null;
  archived: boolean;
  documentCount: number;
  places: ValuationSourcePlace[];
  documents?: ValuationDocumentRef[];
}

export interface ValuationInput {
  house: { id: string; name: string; currency: string };
  reportDate: string;
  generatedAt?: string;
  filters: ValuationFilters;
  items: ValuationSourceItem[];
  truncated?: boolean;
}

interface DerivedValue {
  unitValue: number | null;
  totalValue: number | null;
  valueSource: ValuationValueSource;
}

const NO_VALUE: DerivedValue = { unitValue: null, totalValue: null, valueSource: "none" };

function finiteOrNull(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value;
}

/**
 * Derive one item's value.
 *
 * `latest` and `average` price the current stock quantity from purchase
 * observations; `stockCost` uses what the stock on hand actually cost. An item
 * with no price observation (or no priced lot for `stockCost`) has no value at
 * all rather than a zero: a missing record must not look like "worth nothing".
 */
export function valueForItem(
  item: Pick<ValuationSourceItem, "quantity" | "latestPrice" | "averagePrice" | "pricedQuantity" | "stockValue">,
  basis: ValuationBasis,
): DerivedValue {
  if (basis === "stockCost") {
    if (!(item.pricedQuantity > 0) || !Number.isFinite(item.stockValue)) return NO_VALUE;
    return {
      unitValue: round(item.stockValue / item.pricedQuantity, 4),
      totalValue: round(item.stockValue, 2),
      valueSource: "stock-cost",
    };
  }
  const unit = finiteOrNull(basis === "average" ? item.averagePrice : item.latestPrice);
  if (unit == null || unit <= 0) return NO_VALUE;
  return {
    unitValue: round(unit, 4),
    totalValue: round(unit * (item.quantity || 0), 2),
    valueSource: basis === "average" ? "average-purchase" : "latest-purchase",
  };
}

function lowered(values: string[]): string[] {
  return values.map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function matchesFilters(item: ValuationSourceItem, filters: ValuationFilters, reportDate: string): boolean {
  if (!filters.includeArchived && item.archived) return false;
  if (filters.categoryIds.length && (!item.categoryId || !filters.categoryIds.includes(item.categoryId))) return false;
  if (
    filters.locationIds.length &&
    !item.places.some(
      (place) =>
        place.quantity !== 0 && place.locationId != null && filters.locationIds.includes(place.locationId),
    )
  ) {
    return false;
  }
  if (filters.warrantyOnly && !(item.warrantyUntil && item.warrantyUntil >= reportDate)) return false;
  const wanted = lowered(filters.tags);
  if (wanted.length) {
    const own = lowered(item.tags);
    if (!wanted.some((tag) => own.includes(tag))) return false;
  }
  return true;
}

function attributeText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function attributesText(attributes: Record<string, unknown>): string {
  return Object.entries(attributes)
    .filter(([, value]) => value != null && value !== "")
    .map(([key, value]) => `${key}=${attributeText(value)}`)
    .join("; ");
}

function compareNames(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a.localeCompare(b);
}

/** Build the report from loaded rows. Pure: no database access, no clock. */
export function buildValuationReport(input: ValuationInput): ValuationReport {
  const { filters, house, reportDate } = input;
  const basis = filters.basis;

  const items: ValuationItem[] = [];
  const categoryTotals = new Map<string, ValuationCategoryTotal>();
  const placeTotals = new Map<string, ValuationPlaceTotal>();
  let grandTotal = 0;
  let itemsWithoutValue = 0;

  const addCategory = (categoryId: string | null, categoryName: string | null, totalValue: number | null) => {
    const key = categoryId ?? "";
    const current =
      categoryTotals.get(key) ??
      { categoryId, categoryName, itemCount: 0, itemsWithoutValue: 0, total: 0 };
    current.itemCount += 1;
    if (totalValue == null) current.itemsWithoutValue += 1;
    else current.total = round(current.total + totalValue, 2);
    categoryTotals.set(key, current);
  };

  const addPlace = (locationId: string | null, locationName: string | null, value: number) => {
    const key = locationId ?? "";
    const current = placeTotals.get(key) ?? { locationId, locationName, itemCount: 0, total: 0 };
    current.itemCount += 1;
    current.total = round(current.total + (Number.isFinite(value) ? value : 0), 2);
    placeTotals.set(key, current);
  };

  for (const source of input.items) {
    if (!matchesFilters(source, filters, reportDate)) continue;
    const derived = valueForItem(source, basis);
    if (filters.minValue != null && (derived.totalValue == null || derived.totalValue < filters.minValue)) {
      continue;
    }

    const places = source.places
      .filter((place) => place.quantity !== 0 || place.value > 0)
      .map((place) => ({
        locationId: place.locationId,
        locationName: place.locationName,
        quantity: round(place.quantity, 3),
      }));

    items.push({
      id: source.id,
      name: source.name,
      brand: source.brand,
      categoryId: source.categoryId,
      categoryName: source.categoryName,
      unit: source.unit,
      quantity: round(source.quantity, 3),
      places,
      unitValue: derived.unitValue,
      totalValue: derived.totalValue,
      valueSource: derived.valueSource,
      purchasedAt: source.purchasedAt,
      shop: source.shop,
      warrantyUntil: source.warrantyUntil,
      warrantyNote: source.warrantyNote,
      attributes: source.attributes,
      image: source.image,
      tags: source.tags,
      documentCount: source.documentCount,
      ...(filters.includeDocuments ? { documents: source.documents ?? [] } : {}),
      archived: source.archived,
    });

    addCategory(source.categoryId, source.categoryName, derived.totalValue);
    if (derived.totalValue == null) {
      itemsWithoutValue += 1;
    } else {
      grandTotal = round(grandTotal + derived.totalValue, 2);
    }

    // Split the item total across the places that hold it, so place subtotals
    // add back up to the grand total. Any remainder (lots without a place)
    // lands in the "no place" bucket.
    let placed = 0;
    for (const place of source.places) {
      if (place.quantity === 0 && place.value <= 0) continue;
      const placeValue =
        basis === "stockCost"
          ? place.value
          : derived.unitValue == null
            ? 0
            : derived.unitValue * place.quantity;
      addPlace(place.locationId, place.locationName, placeValue);
      placed += placeValue;
    }
    if (derived.totalValue != null) {
      const remainder = round(derived.totalValue - placed, 2);
      if (remainder > 0.004) {
        addPlace(null, null, remainder);
      }
    }
  }

  return {
    houseId: house.id,
    houseName: house.name,
    currency: house.currency,
    reportDate,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    basis,
    itemCount: items.length,
    itemsWithoutValue,
    grandTotal: round(grandTotal, 2),
    truncated: Boolean(input.truncated),
    includeDocuments: filters.includeDocuments,
    items,
    categoryTotals: [...categoryTotals.values()].sort((a, b) =>
      compareNames(a.categoryName, b.categoryName),
    ),
    placeTotals: [...placeTotals.values()].sort((a, b) => compareNames(a.locationName, b.locationName)),
  };
}

/* ------------------------------------------------------------------- CSV */

const CSV_DELIMITER = ",";

/**
 * Escape one cell. Spreadsheet apps execute a leading =, +, - or @ as a
 * formula, so a name like "=HYPERLINK(...)" must not become code on open. The
 * guard prefixes those cells with a single quote. Numbers stay unquoted so
 * spreadsheets read them as numbers.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value == null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(CSV_DELIMITER);
}

function placesText(places: { locationName: string | null; quantity: number }[]): string {
  return places
    .map((place) => `${place.locationName ?? "No place"} (${place.quantity})`)
    .join("; ");
}

function documentsText(documents: ValuationDocumentRef[] | undefined): string {
  if (!documents?.length) return "";
  return documents.map((document) => `${document.name} (${document.kind})`).join("; ");
}

/**
 * The CSV is a small report: a metadata line, the item table, then category
 * and place subtotals. The route prepends the UTF-8 BOM; the delimiter is a
 * comma because that is what the existing inventory CSV export uses and the
 * importer auto-detects either.
 */
export function valuationCsv(report: ValuationReport): string {
  const rows: string[] = [];

  rows.push(
    csvRow([
      "House",
      "Currency",
      "Report date",
      "Value basis",
      "Items",
      "Items without value",
      "Grand total",
      "Truncated",
    ]),
  );
  rows.push(
    csvRow([
      report.houseName,
      report.currency,
      report.reportDate,
      VALUATION_BASIS_LABELS[report.basis],
      report.itemCount,
      report.itemsWithoutValue,
      report.grandTotal,
      report.truncated ? "yes" : "no",
    ]),
  );
  rows.push("");

  rows.push(
    csvRow([
      "Name",
      "Brand",
      "Category",
      "Places",
      "Quantity",
      "Unit",
      "Unit value",
      "Total value",
      "Value basis",
      "Purchased",
      "Shop",
      "Warranty until",
      "Warranty note",
      "Attributes",
      "Image",
      "Tags",
      "Archived",
      "Documents",
      "Document files",
    ]),
  );
  for (const item of report.items) {
    rows.push(
      csvRow([
        item.name,
        item.brand,
        item.categoryName,
        placesText(item.places),
        item.quantity,
        item.unit,
        item.unitValue,
        item.totalValue,
        VALUATION_VALUE_SOURCE_LABELS[item.valueSource],
        item.purchasedAt,
        item.shop,
        item.warrantyUntil,
        item.warrantyNote,
        attributesText(item.attributes),
        item.image,
        item.tags.join("; "),
        item.archived ? "yes" : "no",
        item.documentCount,
        report.includeDocuments ? documentsText(item.documents) : "",
      ]),
    );
  }
  rows.push("");

  rows.push(csvRow(["Category totals"]));
  rows.push(csvRow(["Category", "Items", "Items without value", "Total"]));
  for (const entry of report.categoryTotals) {
    rows.push(
      csvRow([entry.categoryName ?? "Uncategorised", entry.itemCount, entry.itemsWithoutValue, entry.total]),
    );
  }
  rows.push("");

  rows.push(csvRow(["Place totals"]));
  rows.push(csvRow(["Place", "Items", "Total"]));
  for (const entry of report.placeTotals) {
    rows.push(csvRow([entry.locationName ?? "No place", entry.itemCount, entry.total]));
  }

  return `${rows.join("\r\n")}\r\n`;
}
