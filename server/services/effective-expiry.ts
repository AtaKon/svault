import {
  DEFAULT_FREEZER_SHELF_LIFE_DAYS,
  DEFAULT_THAW_SHELF_LIFE_DAYS,
} from "../../shared/types.js";

/**
 * Add whole days to a `YYYY-MM-DD` date using UTC calendar arithmetic, so the
 * result does not depend on the server timezone or on daylight saving.
 */
export function addDays(date: string, days: number): string | null {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return null;
  parsed.setUTCDate(parsed.getUTCDate() + Number(days));
  return parsed.toISOString().slice(0, 10);
}

function earliest(...dates: (string | null | undefined)[]): string | null {
  let result: string | null = null;
  for (const date of dates) {
    if (!date) continue;
    if (!result || date < result) result = date;
  }
  return result;
}

/**
 * Calendar-date expiry, independent of server timezone.
 *
 * A batch that is in the freezer or was thawed uses its cold-storage window
 * instead of the printed date: freezing replaces a short fridge use-by with the
 * freezer shelf life, and thawing switches to the short thaw window. An opened
 * batch keeps its separate, usually shorter, window and always wins when it is
 * earlier. Items that are neither frozen nor thawed keep the original rule:
 * the earlier of the printed date and the opening date plus shelf life.
 */
export function effectiveExpiry(
  lot: {
    expires_at?: string | null;
    opened_at?: string | null;
    frozen_on?: string | null;
    thawed_on?: string | null;
  },
  item: {
    opened_shelf_life_days?: number | null;
    freezer_shelf_life_days?: number | null;
    thaw_shelf_life_days?: number | null;
  },
): string | null {
  const printed = lot.expires_at || null;
  let openedExpiry: string | null = null;
  if (lot.opened_at && item.opened_shelf_life_days != null) {
    openedExpiry = addDays(lot.opened_at, Number(item.opened_shelf_life_days));
  }

  let coldExpiry: string | null = null;
  if (lot.thawed_on) {
    coldExpiry = addDays(
      lot.thawed_on,
      item.thaw_shelf_life_days ?? DEFAULT_THAW_SHELF_LIFE_DAYS,
    );
  } else if (lot.frozen_on) {
    coldExpiry = addDays(
      lot.frozen_on,
      item.freezer_shelf_life_days ?? DEFAULT_FREEZER_SHELF_LIFE_DAYS,
    );
  }

  if (lot.frozen_on || lot.thawed_on) return earliest(coldExpiry, openedExpiry);
  return earliest(printed, openedExpiry);
}
