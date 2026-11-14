/** Calendar-date expiry, independent of server timezone. */
export function effectiveExpiry(lot: { expires_at?: string | null; opened_at?: string | null }, item: { opened_shelf_life_days?: number | null }): string | null {
  const printed = lot.expires_at || null;
  let openedExpiry: string | null = null;
  if (lot.opened_at && item.opened_shelf_life_days != null) {
    const date = new Date(`${lot.opened_at}T00:00:00Z`);
    if (Number.isFinite(date.getTime())) {
      date.setUTCDate(date.getUTCDate() + Number(item.opened_shelf_life_days));
      openedExpiry = date.toISOString().slice(0, 10);
    }
  }
  return printed && openedExpiry ? (printed < openedExpiry ? printed : openedExpiry) : printed ?? openedExpiry;
}
