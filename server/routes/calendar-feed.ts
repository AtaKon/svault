import { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { all, get, newId, now, run } from "../db.js";
import { hashToken, requireAuth } from "../auth.js";
import { ApiError, handler, parseBody } from "../http.js";

export const calendarFeedRoutes = Router();
calendarFeedRoutes.use(requireAuth, (req, res, next) => {
  if (req.apiTokenId || !req.sessionToken) { res.status(403).json({ error: "Session required" }); return; }
  next();
});
const settings = z.object({ houseIds: z.array(z.string()).max(1000).nullable().optional(), includePlan: z.boolean().optional(), includeBills: z.boolean().optional(), rotate: z.boolean().optional() }).strict();
function serialize(row: any) {
  return { id: row.id, houseIds: row.house_ids == null ? null : JSON.parse(row.house_ids), includePlan: !!row.include_plan, includeBills: !!row.include_bills, createdAt: row.created_at, lastUsedAt: row.last_used_at };
}
async function validateHouses(userId: string, ids: string[] | null | undefined) {
  if (!ids) return;
  const members = await all<{ house_id: string }>("SELECT house_id FROM house_members WHERE user_id = ?", [userId]);
  const allowed = new Set(members.map((m) => m.house_id));
  if (ids.some((id) => !allowed.has(id))) throw new ApiError(400, "Invalid house selection");
}
calendarFeedRoutes.get("/", handler(async (req, res) => {
  const row = await get<any>("SELECT * FROM calendar_feeds WHERE user_id = ?", [req.user!.id]);
  res.json({ feed: row ? serialize(row) : null });
}));
calendarFeedRoutes.post("/", handler(async (req, res) => {
  const body = parseBody(settings, req.body ?? {});
  await validateHouses(req.user!.id, body.houseIds);
  if (await get("SELECT id FROM calendar_feeds WHERE user_id = ?", [req.user!.id])) throw new ApiError(409, "Calendar feed already exists");
  const token = randomBytes(32).toString("base64url");
  const id = newId("cal");
  await run("INSERT INTO calendar_feeds (id, user_id, token_hash, house_ids, include_plan, include_bills, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, req.user!.id, hashToken(token), body.houseIds == null ? null : JSON.stringify(body.houseIds), Number(body.includePlan ?? true), Number(body.includeBills ?? true), now()]);
  res.status(201).json({ feed: serialize(await get<any>("SELECT * FROM calendar_feeds WHERE id = ?", [id])), token });
}));
calendarFeedRoutes.patch("/", handler(async (req, res) => {
  const body = parseBody(settings, req.body ?? {});
  const row = await get<any>("SELECT * FROM calendar_feeds WHERE user_id = ?", [req.user!.id]);
  if (!row) throw new ApiError(404, "Calendar feed not found");
  await validateHouses(req.user!.id, body.houseIds);
  const token = body.rotate ? randomBytes(32).toString("base64url") : undefined;
  await run("UPDATE calendar_feeds SET token_hash = ?, house_ids = ?, include_plan = ?, include_bills = ? WHERE id = ?", [token ? hashToken(token) : row.token_hash, body.houseIds === undefined ? row.house_ids : body.houseIds === null ? null : JSON.stringify(body.houseIds), Number(body.includePlan ?? !!row.include_plan), Number(body.includeBills ?? !!row.include_bills), row.id]);
  res.json({ feed: serialize(await get<any>("SELECT * FROM calendar_feeds WHERE id = ?", [row.id])), ...(token ? { token } : {}) });
}));
calendarFeedRoutes.delete("/", handler(async (req, res) => {
  const result = await run("DELETE FROM calendar_feeds WHERE user_id = ?", [req.user!.id]);
  if (!result.changes) throw new ApiError(404, "Calendar feed not found");
  res.json({ ok: true });
}));
