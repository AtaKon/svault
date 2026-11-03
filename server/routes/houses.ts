import { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { all, get, newId, now, parseJson, run } from "../db.js";
import { houseMembers, memberRole, requireAuth, roleAtLeast } from "../auth.js";
import { ApiError, handler, parseBody, requireHouse } from "../http.js";
import { serializeHouse } from "../serialize.js";
import { createHouse } from "../services/houses.js";
import { notifyHouseAdded } from "../services/notifications.js";
import { chat, resolveAi } from "../ai.js";
import type { Role } from "../../shared/types.js";

export const houseRoutes = Router();
houseRoutes.use(requireAuth);

const roleSchema = z.enum(["owner", "admin", "member", "viewer"]);

function houseRow(houseId: string) {
  return get<any>("SELECT * FROM houses WHERE id = ?", [houseId]);
}

function houseDetail(houseId: string, role: Role) {
  const row = houseRow(houseId)!;
  const counts = {
    items: Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE house_id = ? AND archived = 0", [houseId])?.n ?? 0),
    locations: Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM locations WHERE house_id = ?", [houseId])?.n ?? 0),
    recipes: Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM recipes WHERE house_id = ?", [houseId])?.n ?? 0),
    photos: Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM photos WHERE house_id = ?", [houseId])?.n ?? 0),
    members: Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM house_members WHERE house_id = ?", [houseId])?.n ?? 0),
  };
  return { ...serializeHouse(row, role), members: houseMembers(houseId), counts };
}

function mergeSettings(current: Record<string, any>, incoming: Record<string, any>) {
  const next: Record<string, any> = { ...current, ...incoming };
  if (incoming.ai && typeof incoming.ai === "object") {
    const mergedAi: Record<string, any> = { ...(current.ai ?? {}), ...incoming.ai };
    if (incoming.ai.apiKey === undefined || incoming.ai.apiKey === "***") {
      if (current.ai?.apiKey) mergedAi.apiKey = current.ai.apiKey;
      else delete mergedAi.apiKey;
    }
    if (incoming.ai.apiKey === "" || incoming.ai.apiKey === null) delete mergedAi.apiKey;
    next.ai = mergedAi;
  }
  if (incoming.notifications && typeof incoming.notifications === "object") {
    next.notifications = { ...(current.notifications ?? {}), ...incoming.notifications };
  }
  return next;
}

houseRoutes.get(
  "/",
  handler((req, res) => {
    const houses = all<any>(
      `SELECT h.*, m.role, (SELECT COUNT(*) FROM house_members m2 WHERE m2.house_id = h.id) AS member_count
       FROM houses h JOIN house_members m ON m.house_id = h.id WHERE m.user_id = ?
       ORDER BY h.created_at`,
      [req.user!.id],
    );
    res.json(houses.map((h) => serializeHouse(h, h.role)));
  }),
);

houseRoutes.post(
  "/",
  handler((req, res) => {
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(80),
        kind: z.string().trim().max(30).optional(),
        address: z.string().trim().max(200).nullish(),
        currency: z.string().trim().length(3).optional(),
        template: z.enum(["home", "cabin", "fridge", "closet", "garage"]).optional(),
      }),
      req.body,
    );
    const id = createHouse({
      userId: req.user!.id,
      name: body.name,
      kind: body.kind ?? body.template ?? "home",
      address: body.address ?? null,
      currency: body.currency?.toUpperCase(),
    });
    res.status(201).json(houseDetail(id, "owner"));
  }),
);

houseRoutes.get(
  "/:houseId",
  handler((req, res) => {
    const { houseId, role } = requireHouse(req);
    res.json(houseDetail(houseId, role));
  }),
);

houseRoutes.patch(
  "/:houseId",
  handler((req, res) => {
    const { houseId, role } = requireHouse(req, "admin");
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(80).optional(),
        kind: z.string().trim().max(30).optional(),
        address: z.string().trim().max(200).nullish(),
        currency: z.string().trim().length(3).optional(),
        settings: z.record(z.string(), z.any()).optional(),
      }),
      req.body,
    );
    const current = houseRow(houseId)!;
    const settings = body.settings
      ? mergeSettings(parseJson<Record<string, any>>(current.settings, {}), body.settings)
      : parseJson<Record<string, any>>(current.settings, {});
    run(
      `UPDATE houses SET name = COALESCE(?, name), kind = COALESCE(?, kind), address = ?, currency = COALESCE(?, currency),
         settings = ? WHERE id = ?`,
      [
        body.name ?? null,
        body.kind ?? null,
        body.address === undefined ? current.address : body.address,
        body.currency?.toUpperCase() ?? null,
        JSON.stringify(settings),
        houseId,
      ],
    );
    res.json(houseDetail(houseId, role));
  }),
);

houseRoutes.delete(
  "/:houseId",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "owner");
    run("DELETE FROM houses WHERE id = ?", [houseId]);
    res.json({ ok: true });
  }),
);

houseRoutes.post(
  "/:houseId/ai/test",
  handler(async (req, res) => {
    const { houseId } = requireHouse(req, "admin");
    const row = houseRow(houseId)!;
    const cfg = resolveAi(parseJson<Record<string, any>>(row.settings, {}));
    if (!cfg.enabled) throw new ApiError(400, "No AI provider configured");
    const reply = await chat(cfg, {
      system: "You are a connectivity probe for a home inventory app. Reply with the single word OK.",
      user: "ping",
      temperature: 0,
    });
    res.json({ ok: true, model: cfg.model, visionModel: cfg.visionModel, reply: reply.trim().slice(0, 120) });
  }),
);

houseRoutes.get(
  "/:houseId/members",
  handler((req, res) => {
    const { houseId } = requireHouse(req);
    res.json(houseMembers(houseId));
  }),
);

houseRoutes.post(
  "/:houseId/members",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "admin");
    const body = parseBody(
      z.object({ email: z.string().trim().toLowerCase().max(220), role: roleSchema.default("member") }),
      req.body,
    );
    if (body.role === "owner") throw new ApiError(400, "A house can only have one owner");
    const existing = get<any>("SELECT * FROM users WHERE email = ?", [body.email]);
    if (existing && memberRole(existing.id, houseId)) {
      throw new ApiError(409, "That person is already a member");
    }
    if (existing) {
      run("INSERT INTO house_members (house_id, user_id, role, created_at) VALUES (?, ?, ?, ?)", [
        houseId,
        existing.id,
        body.role,
        now(),
      ]);
      notifyHouseAdded(existing.id, houseId, body.role, req.user!.id);
      res.status(201).json({
        member: { id: existing.id, email: existing.email, name: existing.name, role: body.role },
      });
      return;
    }
    const code = randomBytes(9).toString("base64url");
    const id = newId("inv");
    run(
      "INSERT INTO house_invites (id, house_id, email, role, code, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, houseId, body.email, body.role, code, req.user!.id, now()],
    );
    res.status(201).json({
      invite: { id, code, email: body.email, role: body.role, url: `/join/${code}` },
    });
  }),
);

houseRoutes.patch(
  "/:houseId/members/:userId",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "owner");
    const body = parseBody(z.object({ role: roleSchema }), req.body);
    const targetId = String(req.params.userId);
    const targetRole = memberRole(targetId, houseId);
    if (!targetRole) throw new ApiError(404, "That person is not a member");
    if (body.role === "owner" && targetId !== req.user!.id) {
      throw new ApiError(400, "Ownership can only be taken over by yourself");
    }
    if (targetRole === "owner" && body.role !== "owner") {
      throw new ApiError(400, "Transfer ownership before changing the owner's role");
    }
    run("UPDATE house_members SET role = ? WHERE house_id = ? AND user_id = ?", [body.role, houseId, targetId]);
    res.json({ ok: true, members: houseMembers(houseId) });
  }),
);

houseRoutes.delete(
  "/:houseId/members/:userId",
  handler((req, res) => {
    const { houseId, role } = requireHouse(req, "admin");
    const targetId = String(req.params.userId);
    const targetRole = memberRole(targetId, houseId);
    if (!targetRole) throw new ApiError(404, "That person is not a member");
    if (targetRole === "owner") throw new ApiError(400, "The owner cannot be removed");
    if (role === "admin" && targetRole === "admin") throw new ApiError(403, "Only the owner can remove an admin");
    run("DELETE FROM house_members WHERE house_id = ? AND user_id = ?", [houseId, targetId]);
    res.json({ ok: true });
  }),
);

houseRoutes.get(
  "/:houseId/invites",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "admin");
    const invites = all<any>(
      `SELECT i.*, u.name AS inviter FROM house_invites i LEFT JOIN users u ON u.id = i.created_by
       WHERE i.house_id = ? ORDER BY i.created_at DESC`,
      [houseId],
    );
    res.json(
      invites.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        code: i.code,
        url: `/join/${i.code}`,
        inviter: i.inviter ?? null,
        createdAt: i.created_at,
        acceptedAt: i.accepted_at ?? null,
      })),
    );
  }),
);

houseRoutes.delete(
  "/:houseId/invites/:inviteId",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "admin");
    run("DELETE FROM house_invites WHERE id = ? AND house_id = ?", [req.params.inviteId, houseId]);
    res.json({ ok: true });
  }),
);

houseRoutes.post(
  "/:houseId/leave",
  handler((req, res) => {
    const { houseId } = requireHouse(req);
    const role = memberRole(req.user!.id, houseId);
    if (role === "owner") {
      const owners = all<any>("SELECT user_id FROM house_members WHERE house_id = ? AND role = 'owner'", [houseId]);
      if (owners.length <= 1) throw new ApiError(400, "Transfer this house to someone else before leaving");
    }
    run("DELETE FROM house_members WHERE house_id = ? AND user_id = ?", [houseId, req.user!.id]);
    res.json({ ok: true });
  }),
);

export { houseDetail, roleAtLeast };
