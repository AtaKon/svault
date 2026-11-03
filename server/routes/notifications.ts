import { Router } from "express";
import { z } from "zod";
import { all, get, parseJson, run, now } from "../db.js";
import { requireAuth } from "../auth.js";
import { handler, parseBody, requireHouse } from "../http.js";
import { serializeNotification } from "../serialize.js";
import { scanAllHouses, syncHouseExpiry, syncItemLowStock } from "../services/notifications.js";

export const notificationRoutes = Router();
notificationRoutes.use(requireAuth);

notificationRoutes.get(
  "/:houseId/notifications",
  handler((req, res) => {
    const { houseId } = requireHouse(req);
    const unreadOnly = req.query.unread === "1";
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 200);
    let rows = all<any>(
      `SELECT * FROM notifications WHERE house_id = ? AND resolved_at IS NULL
         AND (user_id IS NULL OR user_id = ?) ORDER BY created_at DESC LIMIT ?`,
      [houseId, req.user!.id, limit],
    ).map((r) => serializeNotification(r, req.user!.id));
    if (unreadOnly) rows = rows.filter((r) => !r.read);
    res.json({ notifications: rows, unread: rows.filter((r) => !r.read).length });
  }),
);

notificationRoutes.post(
  "/:houseId/notifications/read",
  handler((req, res) => {
    const { houseId } = requireHouse(req);
    const body = parseBody(z.object({ ids: z.array(z.string()).max(200).optional() }), req.body ?? {});
    const rows = all<any>(
      "SELECT id, read_by FROM notifications WHERE house_id = ? AND (user_id IS NULL OR user_id = ?)",
      [houseId, req.user!.id],
    );
    for (const row of rows) {
      if (body.ids && !body.ids.includes(row.id)) continue;
      const readBy = parseJson<string[]>(row.read_by, []);
      if (!readBy.includes(req.user!.id)) {
        readBy.push(req.user!.id);
        run("UPDATE notifications SET read_by = ? WHERE id = ?", [JSON.stringify(readBy), row.id]);
      }
    }
    res.json({ ok: true });
  }),
);

notificationRoutes.post(
  "/:houseId/notifications/scan",
  handler((req, res) => {
    const { houseId } = requireHouse(req);
    const house = get<any>("SELECT settings FROM houses WHERE id = ?", [houseId]);
    const settings = parseJson<Record<string, any>>(house?.settings, {});
    const expiryDays = Number(settings?.notifications?.expiryDays ?? 7);
    for (const item of all<any>("SELECT id FROM items WHERE house_id = ? AND archived = 0", [houseId])) {
      syncItemLowStock(item.id);
    }
    syncHouseExpiry(houseId, expiryDays);
    const rows = all<any>(
      `SELECT * FROM notifications WHERE house_id = ? AND resolved_at IS NULL
         AND (user_id IS NULL OR user_id = ?) ORDER BY created_at DESC LIMIT 100`,
      [houseId, req.user!.id],
    ).map((r) => serializeNotification(r, req.user!.id));
    res.json({ notifications: rows, scannedAt: now() });
  }),
);

/** Notifications from every house the caller belongs to, for the global bell. */
export const globalNotificationRoutes = Router();
globalNotificationRoutes.use(requireAuth);

function visibleNotifications(userId: string) {
  return all<any>(
    `SELECT n.*, h.name AS house_name
     FROM notifications n
     JOIN houses h ON h.id = n.house_id
     JOIN house_members m ON m.house_id = n.house_id AND m.user_id = ?
     WHERE n.resolved_at IS NULL AND (n.user_id IS NULL OR n.user_id = ?)
     ORDER BY n.created_at DESC`,
    [userId, userId],
  );
}

globalNotificationRoutes.get(
  "/",
  handler((req, res) => {
    const unreadOnly = req.query.unread === "1";
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 200);
    let rows = visibleNotifications(req.user!.id).map((r) => serializeNotification(r, req.user!.id));
    const unread = rows.filter((r) => !r.read).length;
    if (unreadOnly) rows = rows.filter((r) => !r.read);
    res.json({ notifications: rows.slice(0, limit), unread });
  }),
);

globalNotificationRoutes.post(
  "/read",
  handler((req, res) => {
    const body = parseBody(z.object({ ids: z.array(z.string()).max(200).optional() }), req.body ?? {});
    const rows = visibleNotifications(req.user!.id);
    for (const row of rows) {
      if (body.ids && !body.ids.includes(row.id)) continue;
      const readBy = parseJson<string[]>(row.read_by, []);
      if (!readBy.includes(req.user!.id)) {
        readBy.push(req.user!.id);
        run("UPDATE notifications SET read_by = ? WHERE id = ?", [JSON.stringify(readBy), row.id]);
      }
    }
    res.json({ ok: true });
  }),
);

/** Used by the boot job. */
export { scanAllHouses };
