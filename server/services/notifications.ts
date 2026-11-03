import { all, get, now, newId, run } from "../db.js";

const DAY = 864e5;

export function createNotification(opts: {
  houseId: string;
  /** When set, only this user sees the notification. */
  userId?: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  dedupeKey: string;
}) {
  const existing = get<any>(
    "SELECT id, resolved_at FROM notifications WHERE house_id = ? AND dedupe_key = ? AND COALESCE(user_id, '') = COALESCE(?, '')",
    [opts.houseId, opts.dedupeKey, opts.userId ?? null],
  );
  if (existing) {
    if (!existing.resolved_at) return; // still active, keep read state
    run(
      "UPDATE notifications SET title = ?, body = ?, data = ?, read_by = '[]', resolved_at = NULL, created_at = ? WHERE id = ?",
      [opts.title, opts.body, JSON.stringify(opts.data ?? {}), now(), existing.id],
    );
    return;
  }
  run(
    `INSERT INTO notifications (id, house_id, user_id, type, title, body, data, dedupe_key, read_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
    [
      newId("ntf"),
      opts.houseId,
      opts.userId ?? null,
      opts.type,
      opts.title,
      opts.body,
      JSON.stringify(opts.data ?? {}),
      opts.dedupeKey,
      now(),
    ],
  );
}

/** Tell a user they were added to a house. The key tracks one membership, so
 * leaving and being re-added later produces a fresh notification. */
export function notifyHouseAdded(userId: string, houseId: string, role: string, invitedBy?: string | null) {
  const house = get<any>("SELECT name FROM houses WHERE id = ?", [houseId]);
  if (!house) return;
  const membership = get<{ created_at: string }>(
    "SELECT created_at FROM house_members WHERE house_id = ? AND user_id = ?",
    [houseId, userId],
  );
  const inviter = invitedBy ? get<{ name: string }>("SELECT name FROM users WHERE id = ?", [invitedBy]) : undefined;
  createNotification({
    houseId,
    userId,
    type: "house",
    title: `You were added to ${house.name}`,
    body: inviter
      ? `${inviter.name} added you as a ${role}. Tap to open the house.`
      : `You are now a ${role} in ${house.name}. Tap to open the house.`,
    data: { houseId, houseName: house.name, role },
    dedupeKey: `joined:${userId}:${membership?.created_at ?? houseId}`,
  });
}

function resolve(houseId: string, dedupeKey: string) {
  run(
    "UPDATE notifications SET resolved_at = ? WHERE house_id = ? AND dedupe_key = ? AND user_id IS NULL AND resolved_at IS NULL",
    [now(), houseId, dedupeKey],
  );
}

export interface LowStockRow {
  id: string;
  name: string;
  house_id: string;
  unit: string;
  reorder_point: number;
  quantity: number;
  target_stock: number | null;
}

export function lowStockItems(houseId: string): LowStockRow[] {
  return all<LowStockRow>(
    `SELECT i.id, i.name, i.house_id, i.unit, i.reorder_point, i.target_stock,
       COALESCE((SELECT SUM(l.quantity) FROM stock_lots l WHERE l.item_id = i.id), 0) AS quantity
     FROM items i
     WHERE i.house_id = ? AND i.archived = 0 AND i.reorder_point > 0`,
    [houseId],
  ).filter((r) => Number(r.quantity) <= Number(r.reorder_point));
}

/** Re-evaluate the low-stock reminder for one item after stock changes. */
export function syncItemLowStock(itemId: string) {
  const item = get<any>(
    `SELECT i.id, i.house_id, i.name, i.unit, i.reorder_point, h.settings,
       COALESCE((SELECT SUM(l.quantity) FROM stock_lots l WHERE l.item_id = i.id), 0) AS quantity
     FROM items i JOIN houses h ON h.id = i.house_id WHERE i.id = ?`,
    [itemId],
  );
  if (!item) return;
  const key = `low:${item.id}`;
  let settings: any = {};
  try {
    settings = JSON.parse(item.settings ?? "{}");
  } catch {
    settings = {};
  }
  if (settings?.notifications?.lowStock === false) {
    resolve(item.house_id, key);
    return;
  }
  const qty = Number(item.quantity);
  if (item.reorder_point > 0 && qty <= Number(item.reorder_point)) {
    createNotification({
      houseId: item.house_id,
      type: "low_stock",
      title: `${item.name} is running low`,
      body: qty <= 0
        ? `You are out of ${item.name}. Tap to review the item.`
        : `Only ${Math.round(qty * 1000) / 1000} ${item.unit} left (threshold ${item.reorder_point} ${item.unit}).`,
      data: { itemId: item.id, quantity: qty, unit: item.unit },
      dedupeKey: key,
    });
  } else {
    resolve(item.house_id, key);
  }
}

export function syncHouseExpiry(houseId: string, expiryDays = 7) {
  const horizon = new Date(Date.now() + expiryDays * DAY).toISOString().slice(0, 10);
  const lots = all<any>(
    `SELECT l.*, i.name AS item_name, i.house_id FROM stock_lots l
     JOIN items i ON i.id = l.item_id
     WHERE l.house_id = ? AND l.quantity > 0 AND l.expires_at IS NOT NULL AND l.expires_at <= ?
       AND i.archived = 0`,
    [houseId, horizon],
  );
  const seen = new Set<string>();
  for (const lot of lots) {
    seen.add(`exp:${lot.id}`);
    const expired = lot.expires_at < new Date().toISOString().slice(0, 10);
    createNotification({
      houseId,
      type: "expiring",
      title: expired ? `${lot.item_name} has expired` : `${lot.item_name} expires soon`,
      body: `${Math.round(lot.quantity * 1000) / 1000} ${lot.unit} with expiry ${lot.expires_at}${
        lot.location_id ? "" : ""
      }.`,
      data: { itemId: lot.item_id, lotId: lot.id, expiresAt: lot.expires_at, expired },
      dedupeKey: `exp:${lot.id}`,
    });
  }
  const active = all<any>(
    "SELECT id, dedupe_key FROM notifications WHERE house_id = ? AND type = 'expiring' AND user_id IS NULL AND resolved_at IS NULL",
    [houseId],
  );
  for (const n of active) {
    if (!seen.has(n.dedupe_key)) resolve(houseId, n.dedupe_key);
  }
}

/** Called on boot and on a timer: keep reminders in sync for every house. */
export function scanAllHouses() {
  const houses = all<{ id: string; settings: string }>("SELECT id, settings FROM houses");
  for (const house of houses) {
    let expiryDays = 7;
    try {
      const settings = JSON.parse(house.settings);
      expiryDays = Number(settings?.notifications?.expiryDays ?? 7);
    } catch {
      /* ignore */
    }
    const items = all<{ id: string }>("SELECT id FROM items WHERE house_id = ? AND archived = 0", [house.id]);
    for (const item of items) syncItemLowStock(item.id);
    syncHouseExpiry(house.id, expiryDays);
  }
}
