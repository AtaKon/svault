// Lightweight unit handling: mass, volume and countable units.
// Count aliases (pack, box, ...) are treated as 1 piece because their real
// content is unknown; users can pick a more precise base unit per item.

const MASS: Record<string, number> = { mg: 0.001, g: 1, kg: 1000, oz: 28.349523, lb: 453.59237 };
const VOLUME: Record<string, number> = {
  ml: 1,
  cl: 10,
  dl: 100,
  l: 1000,
  tsp: 4.928922,
  tbsp: 14.786765,
  cup: 240,
  floz: 29.57353,
  pint: 473.176,
  qt: 946.353,
};
const COUNT: Record<string, number> = {
  pcs: 1,
  pc: 1,
  pack: 1,
  box: 1,
  bottle: 1,
  can: 1,
  jar: 1,
  bag: 1,
  roll: 1,
  pair: 1,
  set: 1,
  dozen: 12,
};

function table(unit: string): Record<string, number> | null {
  const u = unit.trim().toLowerCase();
  if (u in MASS) return MASS;
  if (u in VOLUME) return VOLUME;
  if (u in COUNT) return COUNT;
  return null;
}

export const UNITS = [
  ...Object.keys(MASS),
  ...Object.keys(VOLUME),
  ...Object.keys(COUNT),
].filter((u, i, arr) => arr.indexOf(u) === i);

/** How many `to` are in one `from`, or null when incompatible. */
export function convert(amount: number, from: string, to: string): number | null {
  const f = from.trim().toLowerCase();
  const t = to.trim().toLowerCase();
  if (f === t) return amount;
  const ft = table(f);
  const tt = table(t);
  if (!ft || !tt || ft !== tt) return null;
  return (amount * ft[f]) / tt[t];
}

export function compatible(a: string, b: string): boolean {
  return convert(1, a, b) !== null;
}

export function pricePerUnit(price: number, priceUnit: string, baseUnit: string): number | null {
  const factor = convert(1, priceUnit, baseUnit);
  if (!factor) return null;
  return price / factor;
}

export function round(value: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * f) / f;
}

export function smartPrice(price: number | null | undefined): string {
  if (price == null || !Number.isFinite(price)) return "—";
  if (price === 0) return "0.00";
  if (price < 0.01) return price.toFixed(4);
  if (price < 1) return price.toFixed(3);
  return price.toFixed(2);
}

export function formatQuantity(qty: number): string {
  if (!Number.isFinite(qty)) return "0";
  return Number.isInteger(qty) ? String(qty) : String(Math.round(qty * 1000) / 1000);
}

export const MASS_UNITS = Object.keys(MASS);
export const VOLUME_UNITS = Object.keys(VOLUME);
export const COUNT_UNITS = Object.keys(COUNT);
