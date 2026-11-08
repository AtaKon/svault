/** Split a money amount into cent-exact shares in participant order. */
export function splitAmountEvenly(amount: number, count: number): number[] {
  if (!Number.isFinite(amount) || amount < 0 || !Number.isInteger(count) || count <= 0) return [];
  // Callers from bill routes already pass two-decimal values, but this helper
  // is shared publicly; compensate for values such as 1.005's binary rounding.
  const cents = Math.round((amount + Number.EPSILON) * 100);
  const baseCents = Math.floor(cents / count);
  const remainder = cents - baseCents * count;
  return Array.from({ length: count }, (_unused, index) => (baseCents + (index < remainder ? 1 : 0)) / 100);
}
