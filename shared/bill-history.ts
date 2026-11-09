import type { UtilityBill } from "./types.js";
import { parseBillNumber } from "./bill-parser.js";

export type BillMetrics = { consumptionKwh: number | null; consumptionM3: number | null; municipalCharges: number | null; stateCharges: number | null };
const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Extract only identifiable quantities and tax categories. Manual values win. */
export function extractBillMetrics(bill: Pick<UtilityBill, "billType" | "ocrText">): BillMetrics {
  const lines = (bill.ocrText ?? "").split(/\r?\n/);
  let kwh: number | null = null;
  let m3: number | null = null;
  let city: number | null = null;
  let state: number | null = null;
  const zenith = /zenith|zeniθ|ζενιθ/i.test(fold(bill.ocrText ?? ""));
  if (zenith && bill.billType === "electricity") {
    for (const row of lines) {
      const f = fold(row);
      const usage = f.match(/υψος\s*καταναλωσης\s+(\d[\d.,]*)\s*kwh/);
      if (usage) kwh = parseBillNumber(usage[1]);
      const value = row.match(/(\d[\d.,]*[.,]\d{2})\s*€?\s*$/);
      if (value && /^δημος\s/.test(f)) city = parseBillNumber(value[1]);
      if (value && /^φοροι\s*[-–]\s*τελη/.test(f)) state = parseBillNumber(value[1]);
    }
  } else if (zenith && bill.billType === "natural_gas") {
    for (const row of lines) {
      // Zenith's meter table ends with corrected Nm³ and kWh, after the two
      // readings, difference and correction factor. Do not use previous-year usage.
      const usage = row.match(/^\s*\d{2}\/\d{2}\/\d{4}\s+\d{2}\/\d{2}\/\d{4}\s+[\d.,]+\s+[\d.,]+\s+[\d.,]+\s+[\d.,]+\s+([\d.,]+)\s+([\d.,]+)\s*$/);
      if (usage) { m3 = parseBillNumber(usage[1]); kwh = parseBillNumber(usage[2]); }
      const value = row.match(/(\d[\d.,]*[.,]\d{2})\s*€?\s*$/);
      if (value && /^αξια\s+φ\.\s*π\.\s*α\./.test(fold(row))) state = parseBillNumber(value[1]);
    }
  }
  return {
    consumptionKwh: kwh,
    consumptionM3: m3,
    municipalCharges: city,
    stateCharges: state,
  };
}

export function billMetrics(bill: Pick<UtilityBill, keyof BillMetrics>): BillMetrics {
  return { consumptionKwh: bill.consumptionKwh, consumptionM3: bill.consumptionM3, municipalCharges: bill.municipalCharges, stateCharges: bill.stateCharges };
}

/** Compare only consecutive bills with matching type, name and currency. */
export function billHistory(bills: UtilityBill[]) {
  // Compare and display using the same date. When no due date is available,
  // creation date is an approximation; creation time and ID break ties.
  const date = (bill: UtilityBill) => bill.dueDate ?? bill.createdAt.slice(0, 10);
  const sorted = bills.filter(b => b.billType === "electricity" || b.billType === "natural_gas")
    .slice().sort((a, b) => date(a).localeCompare(date(b)) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const previous = new Map<string, BillMetrics>();
  return sorted.map(bill => {
    const metrics = billMetrics(bill);
    const key = `${bill.billType}|${bill.name.trim().toLocaleLowerCase()}|${bill.currency}`;
    const prior = previous.get(key);
    previous.set(key, metrics);
    return { bill, metrics, prior, perKwh: metrics.consumptionKwh && metrics.consumptionKwh > 0 ? bill.amount / metrics.consumptionKwh : null,
      perM3: bill.billType === "natural_gas" && metrics.consumptionM3 && metrics.consumptionM3 > 0 ? bill.amount / metrics.consumptionM3 : null };
  }).reverse();
}
