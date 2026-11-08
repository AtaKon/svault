/** Split a money amount into cent-exact shares in participant order. */
export function splitAmountEvenly(amount: number, count: number): number[] {
  if (!Number.isFinite(amount) || amount < 0 || !Number.isInteger(count) || count <= 0) return [];
  const scaled = amount * 100;
  const cents = Math.round(scaled);
  // Match the bill API's two-decimal invariant and avoid unsafe integer math.
  if (!Number.isSafeInteger(cents) || Math.abs(scaled - cents) > 1e-7) return [];
  const baseCents = Math.floor(cents / count);
  const remainder = cents - baseCents * count;
  return Array.from({ length: count }, (_unused, index) => (baseCents + (index < remainder ? 1 : 0)) / 100);
}
