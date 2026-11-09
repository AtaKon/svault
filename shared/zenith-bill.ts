import type { BillBreakdownLine, BillParseResult } from "./types.js";

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const line = (description: string, amount: number, kind: BillBreakdownLine["kind"] = "charge", quantity: number | null = null, unitPrice: number | null = null): BillBreakdownLine => ({
  description, kind, amount: Math.abs(amount), quantity, unit: quantity == null ? null : "kWh", unitPrice, taxRate: null,
});
const sum = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;
const date = (raw: string): string | null => {
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
};

/** The Zenith layouts put many labels in artwork, so accept this mapping only
 * when the printed summary categories reconcile with a repeated euro amount. */
export function parseZenithBill(text: string, parseBillNumber: (raw: string, options?: { thousands?: boolean }) => number | null): BillParseResult | null {
  const money = (s: string) => parseBillNumber(s);
  const f = fold(text).replace(/zeniθ/g, "zenith");
  if (!/zenith|ζενιθ/.test(f)) return null;
  const rows = text.split(/\n/).map(s => s.trim());
  const patterns = [
    /χρεωση\s+προμηθειας/, /ρυθμιζομενες\s+χρεωσεις/, /φοροι\s*[-–]\s*τελη/, /χρεωσεις\s+υπερ\s+τριτων/,
  ];
  const gasPatterns = [/προμηθεια\s+φυσικου\s+αεριου/, /διανομη\s+φυσικου\s+αεριου/, /μεταφορα\s+φυσικου\s+αεριου/, /αξια\s+φ\.\s*π\.\s*α\./];
  const pick = (pattern: RegExp) => {
    const row = rows.find(r => pattern.test(fold(r)) && /\d[.,]\d{2}\s*€?$/.test(r));
    const match = row?.match(/(\d[\d.,]*[.,]\d{2})\s*€?$/);
    return row && match ? { description: row.slice(0, match.index).trim(), amount: money(match[1]) } : null;
  };
  const electricity = patterns.map(pick);
  const gas = gasPatterns.map(pick);
  const isElectricity = electricity.every(v => v?.amount != null);
  const items = isElectricity ? electricity : gas;
  if (!items.every(v => v?.amount != null)) return null;
  const summary = items as Array<{ description: string; amount: number }>;
  const total = sum(summary.map(v => v.amount));
  const matchesTotal = rows.some(r => {
    const m = r.match(/(?:^|\s)(\d[\d.,]*[.,]\d{2})\s*€/);
    return m && money(m[1]) === total;
  });
  if (!matchesTotal) return null;
  // Both layouts print the due date adjacent to the repeated payable amount.
  let dueDate: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i].match(/\b\d{2}\/\d{2}\/\d{4}\b/);
    if (!m) continue;
    const nearby = rows.slice(Math.max(0, i - 1), i + 2).join(" ");
    if (new RegExp(`(?:^|\\s)${total.toFixed(2).replace('.', '[.,]')}\\s*€`).test(nearby)) { dueDate = date(m[0]); if (dueDate) break; }
  }
  let lines = summary.map((v, i) => line(v.description, v.amount, i === (isElectricity ? 2 : 3) ? "tax" : "charge"));
  if (isElectricity) {
    // The supply charge is broken down on page two, with headings on a line
    // above their dated values. Keep the summary if the details don't reconcile.
    const details: BillBreakdownLine[] = [];
    for (const pattern of [/παγιο\s+τελος/, /καταναλωση\s+ημερας/, /εκπτωση\s*συνεπειας/]) {
      const index = rows.findIndex((r, i) => pattern.test(fold(r)) && /\d{2}\/\d{2}\/\d{2,4}/.test(rows[i + 1] ?? "") && /=\s*-?\d/.test(rows[i + 1] ?? ""));
      const row = index >= 0 ? rows[index + 1] : "";
      const amount = row?.match(/=\s*(-?\d[\d.,]*[.,]\d{2})\s*€/);
      if (!amount) continue;
      const value = money(amount[1]);
      const q = row.slice(0, amount.index).match(/(\d[\d.,]*)\s*kwh\s*x\s*(\d[\d.,]*)\s*€\s*\/\s*kwh/i);
      if (value == null) continue;
      const label = rows[index].split(/\s{2,}/)[0].trim();
      details.push(line(label, value, value < 0 ? "discount" : "charge", q ? money(q[1]) : null, q ? parseBillNumber(q[2], { thousands: false }) : null));
    }
    const net = sum(details.map(v => v.kind === "discount" ? -v.amount! : v.amount!));
    if (details.length === 3 && Math.abs(net - summary[0].amount) < 0.02) lines = [...details, ...lines.slice(1)];
  } else {
    const details: BillBreakdownLine[] = [];
    // Ignore the unrelated right-hand notices: a detail row has two dates,
    // days and a printed final amount in the left-hand table.
    for (const row of rows) {
      const m = row.match(/^(.+?)\s+\d{2}\/\d{2}\/\d{2}\s+\d{2}\/\d{2}\/\d{2}\s+(\d+)\s+(?:(\d[\d.,]*)\s+(\d[\d.,]*)\s+)?(-?\d[\d.,]*[.,]\d{2})(?:\s|$)/);
      if (!m) continue;
      const amount = money(m[5]);
      if (amount == null) continue;
      const rawQuantity = m[3] ? money(m[3]) : null;
      const rawPrice = m[4] ? parseBillNumber(m[4], { thousands: false }) : null;
      // A capacity row uses a different unit and a day multiplier. Only mark
      // quantities as kWh when the multiplication actually reconciles.
      const reconciles = rawQuantity != null && rawPrice != null && Math.abs(rawQuantity * rawPrice - Math.abs(amount)) <= 0.05;
      const quantity = reconciles ? rawQuantity : null;
      // Stored unit prices currently have four decimal places. Do not round a
      // more precise printed rate into a misleading value.
      const price = reconciles && rawPrice != null && Math.abs(rawPrice * 10000 - Math.round(rawPrice * 10000)) < 1e-8 ? rawPrice : null;
      details.push(line(m[1], amount, amount < 0 ? "discount" : "charge", quantity, price));
    }
    const net = sum(details.map(v => v.kind === "discount" ? -v.amount! : v.amount!));
    if (details.length && Math.abs(net - sum(summary.slice(0, 3).map(v => v.amount))) < 0.03) lines = [...details, lines[3]];
  }
  return { name: "Zenith", billType: isElectricity ? "electricity" : "natural_gas", contractColor: isElectricity && /σταθερο\s+τιμολογιο/.test(f) ? "blue" : null,
    currency: "EUR", dueDate, total, totalInferred: false, subtotal: isElectricity ? null : sum(summary.slice(0, 3).map(v => v.amount)), taxTotal: summary[isElectricity ? 2 : 3].amount, lines };
}
