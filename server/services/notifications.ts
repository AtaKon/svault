import { all, get, now, newId, parseJson, run } from "../db.js";
import { maybeSendWeeklySummaries, queueDeliveries, type DeliveryEvent } from "./channels.js";

const DAY = 864e5;

export async function createNotification(opts: {
  houseId: string;
  /** When set, only this user sees the notification. */
  userId?: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  dedupeKey: string;
}): Promise<{ created: boolean; id: string | null }> {
  const existing = await get<any>(
    "SELECT id, resolved_at FROM notifications WHERE house_id = ? AND dedupe_key = ? AND COALESCE(user_id, '') = COALESCE(?, '')",
    [opts.houseId, opts.dedupeKey, opts.userId ?? null],
  );
  if (existing) {
    if (!existing.resolved_at) return { created: false, id: existing.id }; // still active, keep read state
    await run(
      "UPDATE notifications SET title = ?, body = ?, data = ?, read_by = '[]', resolved_at = NULL, created_at = ? WHERE id = ?",
      [opts.title, opts.body, JSON.stringify(opts.data ?? {}), now(), existing.id],
    );
    // A resolved reminder that comes back is in-app only; delivery channels
    // already saw this dedupe key and must not be spammed with it again.
    return { created: false, id: existing.id };
  }
  const id = newId("ntf");
  await run(
    `INSERT INTO notifications (id, house_id, user_id, type, title, body, data, dedupe_key, read_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
    [
      id,
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
  const event: DeliveryEvent | null =
    opts.type === "low_stock" ? "low_stock" : opts.type === "expiring" ? "expiring" : opts.type === "budget_alert" ? "budget_alert" : null;
  if (event && !opts.userId) {
    await queueDeliveries(
      {
        event,
        houseId: opts.houseId,
        title: opts.title,
        body: opts.body,
        data: opts.data,
      },
      opts.dedupeKey,
    );
  }
  return { created: true, id };
}

/** Tell a user they were added to a house. The key tracks one membership, so
 * leaving and being re-added later produces a fresh notification. */
export async function notifyHouseAdded(userId: string, houseId: string, role: string, invitedBy?: string | null) {
  const house = await get<any>("SELECT name FROM houses WHERE id = ?", [houseId]);
  if (!house) return;
  const membership = await get<{ created_at: string }>(
    "SELECT created_at FROM house_members WHERE house_id = ? AND user_id = ?",
    [houseId, userId],
  );
  const inviter = invitedBy ? await get<{ name: string }>("SELECT name FROM users WHERE id = ?", [invitedBy]) : undefined;
  await createNotification({
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

/** Inform the new owner after an atomic ownership transfer. */
export async function notifyOwnershipTransferred(userId: string, houseId: string, previousOwnerId: string) {
  const house = await get<any>("SELECT name FROM houses WHERE id = ?", [houseId]);
  if (!house) return;
  const previous = await get<{ name: string }>("SELECT name FROM users WHERE id = ?", [previousOwnerId]);
  await createNotification({
    houseId,
    userId,
    type: "house",
    title: `You now own ${house.name}`,
    body: previous
      ? `${previous.name} transferred ownership to you. You can manage members and settings.`
      : "Ownership of this house was transferred to you.",
    data: { houseId, houseName: house.name, role: "owner", previousOwnerId },
    dedupeKey: `owner:${userId}:${houseId}:${now()}`,
  });
}

async function resolve(houseId: string, dedupeKey: string) {
  await run(
    "UPDATE notifications SET resolved_at = ? WHERE house_id = ? AND dedupe_key = ? AND user_id IS NULL AND resolved_at IS NULL",
    [now(), houseId, dedupeKey],
  );
}

/** Delete the reminders that belong to an item, so deleting an item does not
 * leave a low-stock or expiry notification pointing at something that is gone. */
export async function clearItemNotifications(itemId: string): Promise<number> {
  const rows = await all<{ id: string; data: string; dedupe_key: string }>(
    "SELECT id, data, dedupe_key FROM notifications WHERE resolved_at IS NULL",
  );
  let removed = 0;
  for (const row of rows) {
    const data = parseJson<Record<string, unknown>>(row.data, {});
    if (data.itemId === itemId || row.dedupe_key === `low:${itemId}`) {
      await run("DELETE FROM notifications WHERE id = ?", [row.id]);
      removed += 1;
    }
  }
  return removed;
}

/** Remove reminders whose item no longer exists. This catches reminders left
 * behind by older versions and restores, and keeps the bell free of dead links. */
export async function cleanupOrphanNotifications(houseId: string): Promise<number> {
  const rows = await all<{ id: string; data: string }>(
    "SELECT id, data FROM notifications WHERE house_id = ? AND resolved_at IS NULL",
    [houseId],
  );
  let removed = 0;
  for (const row of rows) {
    const data = parseJson<Record<string, unknown>>(row.data, {});
    const itemId = typeof data.itemId === "string" ? data.itemId : null;
    if (!itemId) continue;
    if (await get("SELECT id FROM items WHERE id = ?", [itemId])) continue;
    await run("DELETE FROM notifications WHERE id = ?", [row.id]);
    removed += 1;
  }
  return removed;
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

export async function lowStockItems(houseId: string): Promise<LowStockRow[]> {
  return (await all<LowStockRow>(
    `SELECT i.id, i.name, i.house_id, i.unit, i.reorder_point, i.target_stock,
       COALESCE((SELECT SUM(l.quantity) FROM stock_lots l WHERE l.item_id = i.id), 0) AS quantity
     FROM items i
     WHERE i.house_id = ? AND i.archived = 0 AND i.reorder_point > 0`,
    [houseId],
  )).filter((r) => Number(r.quantity) <= Number(r.reorder_point));
}

/** Re-evaluate the low-stock reminder for one item after stock changes. */
export async function syncItemLowStock(itemId: string) {
  const item = await get<any>(
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
    await resolve(item.house_id, key);
    return;
  }
  const qty = Number(item.quantity);
  if (item.reorder_point > 0 && qty <= Number(item.reorder_point)) {
    await createNotification({
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
    await resolve(item.house_id, key);
  }
}

export async function syncHouseExpiry(houseId: string, expiryDays = 7) {
  const horizon = new Date(Date.now() + expiryDays * DAY).toISOString().slice(0, 10);
  const lots = await all<any>(
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
    await createNotification({
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
  const active = await all<any>(
    "SELECT id, dedupe_key FROM notifications WHERE house_id = ? AND type = 'expiring' AND user_id IS NULL AND resolved_at IS NULL",
    [houseId],
  );
  for (const n of active) {
    if (!seen.has(n.dedupe_key)) await resolve(houseId, n.dedupe_key);
  }
}

/** Called on boot and on a timer: keep reminders in sync for every house. */
export async function scanAllHouses() {
  const houses = await all<{ id: string; settings: string }>("SELECT id, settings FROM houses");
  for (const house of houses) {
    await cleanupOrphanNotifications(house.id);
    let expiryDays = 7;
    try {
      const settings = JSON.parse(house.settings);
      expiryDays = Number(settings?.notifications?.expiryDays ?? 7);
    } catch {
      /* ignore */
    }
    const items = await all<{ id: string }>("SELECT id FROM items WHERE house_id = ? AND archived = 0", [house.id]);
    for (const item of items) await syncItemLowStock(item.id);
    await syncHouseExpiry(house.id, expiryDays);
    const { scanBudgetAlerts } = await import("./insights.js");
    await scanBudgetAlerts(house.id);
  }
  await maybeSendWeeklySummaries();
}
