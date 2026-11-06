import { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { all, get, newId, now, parseJson, run, tx } from "../db.js";
import { houseMembers, memberRole, requireAuth, roleAtLeast, verifyPassword } from "../auth.js";
import { ApiError, handler, parseBody, requireHouse } from "../http.js";
import { serializeHouse } from "../serialize.js";
import { createHouse } from "../services/houses.js";
import { houseUploadUrls, removeUnreferencedUploads } from "../services/upload-cleanup.js";
import { inviteExpired, inviteExpiresAt, newInviteExpiry } from "../services/invites.js";
import { notifyOwnershipTransferred } from "../services/notifications.js";
import {
  channelsFromSettings,
  deliveryLog,
  mergeChannels,
  sendChannelMessage,
  type ChannelMessage,
} from "../services/channels.js";
import { chat, resolveAi } from "../ai.js";
import type { NotificationChannel, Role } from "../../shared/types.js";

export const houseRoutes = Router();
houseRoutes.use(requireAuth);

const roleSchema = z.enum(["owner", "admin", "member", "viewer"]);

async function houseRow(houseId: string) {
  return await get<any>("SELECT * FROM houses WHERE id = ?", [houseId]);
}

async function houseDetail(houseId: string, role: Role) {
  const row = (await houseRow(houseId))!;
  const counts = {
    items: Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE house_id = ? AND archived = 0", [houseId]))?.n ?? 0),
    locations: Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM locations WHERE house_id = ?", [houseId]))?.n ?? 0),
    recipes: Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM recipes WHERE house_id = ?", [houseId]))?.n ?? 0),
    photos: Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM photos WHERE house_id = ?", [houseId]))?.n ?? 0),
    members: Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM house_members WHERE house_id = ?", [houseId]))?.n ?? 0),
  };
  return { ...serializeHouse(row, role), members: await houseMembers(houseId), counts };
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
    if (Array.isArray(incoming.notifications.channels)) {
      next.notifications.channels = mergeChannels(
        channelsFromSettings(current),
        incoming.notifications.channels as NotificationChannel[],
      );
    } else if (current.notifications?.channels) {
      next.notifications.channels = current.notifications.channels;
    }
  }
  return next;
}

houseRoutes.get(
  "/",
  handler(async (req, res) => {
    const houses = await all<any>(
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
  handler(async (req, res) => {
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
    const id = await createHouse({
      userId: req.user!.id,
      name: body.name,
      kind: body.kind ?? body.template ?? "home",
      address: body.address ?? null,
      currency: body.currency?.toUpperCase(),
    });
    res.status(201).json(await houseDetail(id, "owner"));
  }),
);

houseRoutes.get(
  "/:houseId",
  handler(async (req, res) => {
    const { houseId, role } = await requireHouse(req);
    res.json(await houseDetail(houseId, role));
  }),
);

houseRoutes.patch(
  "/:houseId",
  handler(async (req, res) => {
    const { houseId, role } = await requireHouse(req, "admin");
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
    const current = (await houseRow(houseId))!;
    const settings = body.settings
      ? mergeSettings(parseJson<Record<string, any>>(current.settings, {}), body.settings)
      : parseJson<Record<string, any>>(current.settings, {});
    await run(
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
    res.json(await houseDetail(houseId, role));
  }),
);

houseRoutes.delete(
  "/:houseId",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "owner");
    const uploads = await houseUploadUrls(houseId);
    await run("DELETE FROM houses WHERE id = ?", [houseId]);
    await run("DELETE FROM catalog_mappings WHERE house_id = ?", [houseId]);
    await removeUnreferencedUploads(uploads);
    res.json({ ok: true });
  }),
);

houseRoutes.post(
  "/:houseId/ai/test",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "admin");
    const row = (await houseRow(houseId))!;
    const cfg = resolveAi(parseJson<Record<string, any>>(row.settings, {}));
    if (!cfg.enabled) throw new ApiError(400, "No AI provider configured");
    const reply = await chat(
      cfg,
      {
        system: "You are a connectivity probe for a home inventory app. Reply with the single word OK.",
        user: "ping",
        temperature: 0,
      },
      { operation: "ai.test", houseId, userId: req.user!.id },
    );
    res.json({
      ok: true,
      model: cfg.model,
      visionModel: cfg.visionModel,
      reply: reply.text.trim().slice(0, 120),
      cost: reply.usage.cost,
    });
  }),
);

houseRoutes.post(
  "/:houseId/notifications/test",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "admin");
    const row = (await houseRow(houseId))!;
    const body = parseBody(
      z.object({
        channelId: z.string().max(60).optional(),
        channel: z.record(z.string(), z.any()).optional(),
      }),
      req.body ?? {},
    );
    const current = channelsFromSettings(parseJson<Record<string, any>>(row.settings, {}));
    let channel: NotificationChannel | undefined;
    if (body.channel) {
      channel = mergeChannels(current, [body.channel as unknown as NotificationChannel])[0];
    } else if (body.channelId) {
      channel = current.find((entry) => entry.id === body.channelId);
    } else {
      channel = current[0];
    }
    if (!channel) throw new ApiError(400, "Configure a reminder channel first");
    const message: ChannelMessage = {
      event: "test",
      houseId,
      houseName: row.name,
      title: `SVault test · ${row.name}`,
      body: `This is a test reminder from ${row.name}. Low-stock, expiry and weekly summaries will arrive here.`,
      data: { test: true },
    };
    const result = await sendChannelMessage(channel, message);
    res.status(result.ok ? 200 : 502).json({
      ok: result.ok,
      status: result.status,
      error: result.error,
      channel: { id: channel.id, name: channel.name, type: channel.type },
    });
  }),
);

houseRoutes.get(
  "/:houseId/reminder-deliveries",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "admin");
    res.json({ deliveries: await deliveryLog(houseId) });
  }),
);

houseRoutes.get(
  "/:houseId/members",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    res.json(await houseMembers(houseId));
  }),
);

houseRoutes.post(
  "/:houseId/members",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "admin");
    const body = parseBody(
      z.object({ email: z.string().trim().toLowerCase().max(220), role: roleSchema.default("member") }),
      req.body,
    );
    if (body.role === "owner") throw new ApiError(400, "A house can only have one owner");
    const existing = await get<any>("SELECT * FROM users WHERE lower(email) = lower(?)", [body.email]);
    if (existing && await memberRole(existing.id, houseId)) {
      throw new ApiError(409, "That person is already a member");
    }
    // Existing accounts are not added silently: everyone gets an email-bound
    // invite and joins by accepting it, so nobody is put into a house without consent.
    const code = randomBytes(12).toString("base64url");
    const id = newId("inv");
    const expiresAt = newInviteExpiry();
    await run(
      "INSERT INTO house_invites (id, house_id, email, role, code, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, houseId, body.email, body.role, code, req.user!.id, now(), expiresAt],
    );
    res.status(201).json({
      invite: {
        id,
        code,
        email: body.email,
        role: body.role,
        url: `/join/${code}`,
        expiresAt,
        existingAccount: Boolean(existing),
      },
    });
  }),
);

houseRoutes.post(
  "/:houseId/members/:userId/transfer-ownership",
  handler(async (req, res) => {
    const { houseId, role } = await requireHouse(req, "owner");
    if (role !== "owner") throw new ApiError(403, "Only the owner can transfer ownership");
    const targetId = String(req.params.userId);
    if (targetId === req.user!.id) throw new ApiError(400, "You already own this house");
    const targetRole = await memberRole(targetId, houseId);
    if (!targetRole) throw new ApiError(404, "That person is not a member");
    const body = parseBody(
      z.object({
        houseName: z.string().trim().max(80).optional(),
        password: z.string().max(200).optional(),
      }),
      req.body ?? {},
    );
    const house = (await houseRow(houseId))!;
    const named = (body.houseName ?? "").trim().toLowerCase() === String(house.name).trim().toLowerCase();
    const passwordHash = body.password
      ? (await get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", [req.user!.id]))?.password_hash
      : null;
    const confirmed = Boolean(body.houseName?.trim() ? named : body.password && passwordHash && verifyPassword(body.password, passwordHash));
    if (!confirmed) throw new ApiError(400, "Type the house name or your password to confirm");

    await tx(async () => {
      await run("UPDATE house_members SET role = 'admin' WHERE house_id = ? AND user_id = ?", [houseId, req.user!.id]);
      await run("UPDATE house_members SET role = 'owner' WHERE house_id = ? AND user_id = ?", [houseId, targetId]);
      const owners = await all<any>("SELECT user_id FROM house_members WHERE house_id = ? AND role = 'owner'", [houseId]);
      if (owners.length !== 1 || owners[0].user_id !== targetId) {
        throw new ApiError(409, "Ownership transfer failed; no changes were saved");
      }
    });
    await notifyOwnershipTransferred(targetId, houseId, req.user!.id);
    res.json({ ok: true, ownerId: targetId, members: await houseMembers(houseId) });
  }),
);

houseRoutes.patch(
  "/:houseId/members/:userId",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "owner");
    const body = parseBody(z.object({ role: roleSchema }), req.body);
    const targetId = String(req.params.userId);
    const targetRole = await memberRole(targetId, houseId);
    if (!targetRole) throw new ApiError(404, "That person is not a member");
    if (body.role === "owner" && targetId !== req.user!.id) {
      throw new ApiError(400, "Ownership can only be taken over by yourself");
    }
    if (targetRole === "owner" && body.role !== "owner") {
      throw new ApiError(400, "Transfer ownership before changing the owner's role");
    }
    await run("UPDATE house_members SET role = ? WHERE house_id = ? AND user_id = ?", [body.role, houseId, targetId]);
    res.json({ ok: true, members: await houseMembers(houseId) });
  }),
);

houseRoutes.delete(
  "/:houseId/members/:userId",
  handler(async (req, res) => {
    const { houseId, role } = await requireHouse(req, "admin");
    const targetId = String(req.params.userId);
    const targetRole = await memberRole(targetId, houseId);
    if (!targetRole) throw new ApiError(404, "That person is not a member");
    if (targetRole === "owner") throw new ApiError(400, "The owner cannot be removed");
    if (role === "admin" && targetRole === "admin") throw new ApiError(403, "Only the owner can remove an admin");
    await run("DELETE FROM house_members WHERE house_id = ? AND user_id = ?", [houseId, targetId]);
    res.json({ ok: true });
  }),
);

houseRoutes.get(
  "/:houseId/invites",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "admin");
    const invites = await all<any>(
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
        expiresAt: inviteExpiresAt(i),
        expired: !i.accepted_at && inviteExpired(i),
        acceptedAt: i.accepted_at ?? null,
      })),
    );
  }),
);

houseRoutes.delete(
  "/:houseId/invites/:inviteId",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "admin");
    await run("DELETE FROM house_invites WHERE id = ? AND house_id = ?", [req.params.inviteId, houseId]);
    res.json({ ok: true });
  }),
);

houseRoutes.post(
  "/:houseId/leave",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    const role = await memberRole(req.user!.id, houseId);
    if (role === "owner") {
      const owners = await all<any>("SELECT user_id FROM house_members WHERE house_id = ? AND role = 'owner'", [houseId]);
      if (owners.length <= 1) throw new ApiError(400, "Transfer this house to someone else before leaving");
    }
    await run("DELETE FROM house_members WHERE house_id = ? AND user_id = ?", [houseId, req.user!.id]);
    res.json({ ok: true });
  }),
);

export { houseDetail, roleAtLeast };
