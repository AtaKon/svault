import { Router } from "express";
import { z } from "zod";
import { get, newId, now, run, tx } from "../db.js";
import {
  createSession,
  hashPassword,
  hashToken,
  requireAuth,
  sessionCookie,
  clearedCookie,
  verifyPassword,
  userHouses,
  memberRole,
} from "../auth.js";
import { parseBody, handler, ApiError } from "../http.js";
import { serializeHouse } from "../serialize.js";
import { createHouse } from "../services/houses.js";
import type { Role } from "../../shared/types.js";

export const authRoutes = Router();

const emailSchema = z
  .string()
  .max(220)
  .refine((v) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(v.trim()), "Enter a valid email address")
  .transform((v) => v.trim().toLowerCase());

const passwordSchema = z.string().min(8, "Use at least 8 characters").max(200);

function publicUser(row: any) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isAdmin: !!row.is_admin,
    createdAt: row.created_at,
  };
}

function userPayload(userId: string) {
  const user = get<any>("SELECT * FROM users WHERE id = ?", [userId])!;
  const houses = userHouses(userId).map((h) => serializeHouse(h, h.role));
  return { user: publicUser(user), houses };
}

authRoutes.post(
  "/register",
  handler((req, res) => {
    const body = parseBody(
      z.object({
        email: emailSchema,
        name: z.string().trim().min(1).max(80),
        password: passwordSchema,
        inviteCode: z.string().trim().max(80).optional(),
        houseName: z.string().trim().max(80).optional(),
      }),
      req.body,
    );

    if (get("SELECT id FROM users WHERE email = ?", [body.email])) {
      throw new ApiError(409, "An account with that email already exists");
    }

    const userId = newId("usr");
    const isFirst = !get("SELECT id FROM users LIMIT 1");
    const invite = body.inviteCode
      ? get<any>("SELECT * FROM house_invites WHERE code = ? AND accepted_at IS NULL", [body.inviteCode])
      : undefined;
    if (body.inviteCode && !invite) throw new ApiError(400, "That invite link is no longer valid");
    if (invite?.email && invite.email.toLowerCase() !== body.email) {
      throw new ApiError(403, "This invite was sent to a different email address");
    }

    tx(() => {
      run("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
        userId,
        body.email,
        body.name,
        hashPassword(body.password),
        isFirst ? 1 : 0,
        now(),
      ]);
      if (invite) {
        run("INSERT OR IGNORE INTO house_members (house_id, user_id, role, created_at) VALUES (?, ?, ?, ?)", [
          invite.house_id,
          userId,
          invite.role,
          now(),
        ]);
        run("UPDATE house_invites SET accepted_at = ?, accepted_by = ? WHERE id = ?", [now(), userId, invite.id]);
      } else {
        const fallback = body.houseName?.trim() || `${body.name.split(" ")[0]}'s Home`;
        createHouse({ userId, name: fallback });
      }
    });

    const token = createSession(userId, req.headers["user-agent"]);
    res.setHeader("Set-Cookie", sessionCookie(token));
    res.status(201).json(userPayload(userId));
  }),
);

authRoutes.post(
  "/login",
  handler((req, res) => {
    const body = parseBody(
      z.object({ email: emailSchema, password: z.string().min(1).max(200) }),
      req.body,
    );
    const user = get<any>("SELECT * FROM users WHERE email = ?", [body.email]);
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      throw new ApiError(401, "Wrong email or password");
    }
    const token = createSession(user.id, req.headers["user-agent"]);
    res.setHeader("Set-Cookie", sessionCookie(token));
    res.json(userPayload(user.id));
  }),
);

authRoutes.post(
  "/logout",
  handler((req, res) => {
    if (req.sessionToken) run("DELETE FROM sessions WHERE token_hash = ?", [hashToken(req.sessionToken)]);
    res.setHeader("Set-Cookie", clearedCookie());
    res.json({ ok: true });
  }),
);

authRoutes.get(
  "/me",
  requireAuth,
  handler((req, res) => {
    res.json(userPayload(req.user!.id));
  }),
);

authRoutes.patch(
  "/me",
  requireAuth,
  handler((req, res) => {
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(80).optional(),
        email: emailSchema.optional(),
      }),
      req.body,
    );
    if (body.email && get("SELECT id FROM users WHERE email = ? AND id <> ?", [body.email, req.user!.id])) {
      throw new ApiError(409, "Another account already uses that email");
    }
    run("UPDATE users SET name = COALESCE(?, name), email = COALESCE(?, email) WHERE id = ?", [
      body.name ?? null,
      body.email ?? null,
      req.user!.id,
    ]);
    res.json(userPayload(req.user!.id));
  }),
);

authRoutes.post(
  "/me/password",
  requireAuth,
  handler((req, res) => {
    const body = parseBody(
      z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema }),
      req.body,
    );
    const user = get<any>("SELECT * FROM users WHERE id = ?", [req.user!.id])!;
    if (!verifyPassword(body.currentPassword, user.password_hash)) {
      throw new ApiError(400, "Current password is not correct");
    }
    run("UPDATE users SET password_hash = ? WHERE id = ?", [hashPassword(body.newPassword), user.id]);
    run("DELETE FROM sessions WHERE user_id = ?", [user.id]);
    const token = createSession(user.id, req.headers["user-agent"]);
    res.setHeader("Set-Cookie", sessionCookie(token));
    res.json({ ok: true });
  }),
);

authRoutes.get(
  "/invites/:code",
  handler((req, res) => {
    const invite = get<any>(
      `SELECT i.*, h.name AS house_name, h.kind AS house_kind, u.name AS inviter_name
       FROM house_invites i JOIN houses h ON h.id = i.house_id
       LEFT JOIN users u ON u.id = i.created_by
       WHERE i.code = ?`,
      [req.params.code],
    );
    if (!invite || invite.accepted_at) throw new ApiError(404, "That invite link is no longer valid");
    res.json({
      code: invite.code,
      houseName: invite.house_name,
      houseKind: invite.house_kind,
      role: invite.role,
      email: invite.email,
      inviterName: invite.inviter_name ?? null,
      memberCount: Number(
        get<{ n: number }>("SELECT COUNT(*) AS n FROM house_members WHERE house_id = ?", [invite.house_id])?.n ?? 0,
      ),
    });
  }),
);

authRoutes.post(
  "/invites/:code/accept",
  requireAuth,
  handler((req, res) => {
    const invite = get<any>("SELECT * FROM house_invites WHERE code = ? AND accepted_at IS NULL", [req.params.code]);
    if (!invite) throw new ApiError(404, "That invite link is no longer valid");
    if (invite.email && invite.email.toLowerCase() !== req.user!.email.toLowerCase()) {
      throw new ApiError(403, "This invite was sent to a different email address");
    }
    if (!memberRole(req.user!.id, invite.house_id)) {
      run("INSERT INTO house_members (house_id, user_id, role, created_at) VALUES (?, ?, ?, ?)", [
        invite.house_id,
        req.user!.id,
        invite.role as Role,
        now(),
      ]);
    }
    run("UPDATE house_invites SET accepted_at = ?, accepted_by = ? WHERE id = ?", [now(), req.user!.id, invite.id]);
    res.json(userPayload(req.user!.id));
  }),
);

/** Small helper used by the seed script and tests. */
export function createUserAccount(email: string, name: string, password: string, isAdmin = false): string {
  const id = newId("usr");
  run("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    id,
    email.toLowerCase(),
    name,
    hashPassword(password),
    isAdmin ? 1 : 0,
    now(),
  ]);
  return id;
}

export { publicUser };
