import { Router } from "express";
import { randomBytes } from "node:crypto";
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
import { notifyHouseAdded } from "../services/notifications.js";
import { usernameFromEmail, usernameWithSuffix } from "../username.js";
import { createLoginChallenge, requireTotp } from "../services/totp.js";
import { RateLimitError, limiters } from "../rate-limit.js";
import { registrationStatus } from "../services/registration.js";
import { inviteExpired, inviteExpiresAt } from "../services/invites.js";
import type { Role } from "../../shared/types.js";

export const authRoutes = Router();

const emailSchema = z
  .string()
  .max(220)
  .refine((v) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(v.trim()), "Enter a valid email address")
  .transform((v) => v.trim().toLowerCase());

const passwordSchema = z.string().min(8, "Use at least 8 characters").max(200);

const usernameSchema = z
  .string()
  .trim()
  .min(3, "Use at least 3 characters")
  .max(32, "Use at most 32 characters")
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
    "Use letters, numbers, dots, dashes or underscores and start with a letter or number",
  )
  .transform((value) => value.toLowerCase());

async function usernameTaken(username: string, excludeUserId?: string): Promise<boolean> {
  return !!await get("SELECT id FROM users WHERE lower(username) = lower(?) AND id <> ?", [username, excludeUserId ?? ""]);
}

/** Pick a free username derived from an email local part. */
async function uniqueUsername(email: string, excludeUserId?: string): Promise<string> {
  const base = usernameFromEmail(email);
  let candidate = base;
  let suffix = 1;
  while (await usernameTaken(candidate, excludeUserId)) {
    suffix += 1;
    candidate = usernameWithSuffix(base, suffix);
  }
  return candidate;
}

/* Verified against when the account does not exist, so a missing account
   costs the same scrypt work as a wrong password. */
const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(16).toString("hex"));

function publicUser(row: any) {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    name: row.name,
    language: row.language ?? "en",
    isAdmin: !!row.is_admin,
    developerMode: !!row.developer_mode,
    hasPassword: Number(row.password_set ?? 1) !== 0,
    createdAt: row.created_at,
  };
}

export async function userPayload(userId: string) {
  const user = (await get<any>("SELECT * FROM users WHERE id = ?", [userId]))!;
  const houses = (await userHouses(userId)).map((h) => serializeHouse(h, h.role));
  return { user: publicUser(user), houses };
}

/** Public: lets the sign-up page explain whether an invite is needed. */
authRoutes.get(
  "/registration",
  handler(async (_req, res) => {
    const status = await registrationStatus();
    res.json({ mode: status.mode, inviteRequired: status.mode === "invite", firstUser: status.firstUser });
  }),
);

authRoutes.post(
  "/register",
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        email: emailSchema,
        username: usernameSchema.optional(),
        name: z.string().trim().min(1).max(80),
        password: passwordSchema,
        inviteCode: z.string().trim().max(80).optional(),
        houseName: z.string().trim().max(80).optional(),
      }),
      req.body,
    );

    if (await get("SELECT id FROM users WHERE lower(email) = lower(?)", [body.email])) {
      throw new ApiError(409, "An account with that email already exists");
    }
    if (body.username && await usernameTaken(body.username)) {
      throw new ApiError(409, "That username is already taken");
    }
    const username = body.username ?? await uniqueUsername(body.email);

    const userId = newId("usr");
    const registration = await registrationStatus();
    const isFirst = registration.firstUser;
    if (registration.mode === "closed") {
      throw new ApiError(403, "Registration is closed on this server. Ask the administrator for an account.");
    }
    if (registration.mode === "invite" && !body.inviteCode) {
      throw new ApiError(403, "Registration on this server needs an invite link from a house admin.");
    }
    const invite = body.inviteCode
      ? await get<any>("SELECT * FROM house_invites WHERE code = ? AND accepted_at IS NULL", [body.inviteCode])
      : undefined;
    if (body.inviteCode && (!invite || inviteExpired(invite))) throw new ApiError(400, "That invite link is no longer valid");
    if (invite?.email && invite.email.toLowerCase() !== body.email) {
      throw new ApiError(403, "This invite was sent to a different email address");
    }

    await tx(async () => {
      await run("INSERT INTO users (id, email, username, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        userId,
        body.email,
        username,
        body.name,
        hashPassword(body.password),
        isFirst ? 1 : 0,
        now(),
      ]);
      if (invite) {
        await run("INSERT INTO house_members (house_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", [
          invite.house_id,
          userId,
          invite.role,
          now(),
        ]);
        await run("UPDATE house_invites SET accepted_at = ?, accepted_by = ? WHERE id = ?", [now(), userId, invite.id]);
      } else {
        const fallback = body.houseName?.trim() || `${body.name.split(" ")[0]}'s Home`;
        await createHouse({ userId, name: fallback });
      }
    });

    if (invite) await notifyHouseAdded(userId, invite.house_id, invite.role as Role, invite.created_by);

    const token = await createSession(userId, req.headers["user-agent"]);
    res.setHeader("Set-Cookie", sessionCookie(token));
    res.status(201).json(await userPayload(userId));
  }),
);

authRoutes.post(
  "/login",
  handler(async (req, res) => {
    const body = parseBody(
      z
        .object({
          // `email` is kept for older clients; new clients send `identifier`.
          email: z.string().trim().max(220).optional(),
          username: z.string().trim().max(64).optional(),
          identifier: z.string().trim().max(220).optional(),
          password: z.string().min(1).max(200),
        })
        .refine((value) => Boolean(value.identifier || value.email || value.username), {
          message: "Enter your email or username",
        }),
      req.body,
    );
    const identifier = (body.identifier || body.email || body.username || "").trim();
    const accountKey = identifier.toLowerCase();
    const wait = limiters.loginAccount.blocked(accountKey);
    if (wait > 0) {
      throw new RateLimitError(wait, "Too many failed sign-ins for this account. Wait a few minutes and try again.");
    }
    const user = identifier
      ? await get<any>("SELECT * FROM users WHERE lower(email) = lower(?) OR lower(username) = lower(?)", [
          identifier,
          identifier,
        ])
      : undefined;
    const passwordOk = user
      ? verifyPassword(body.password, user.password_hash)
      : (verifyPassword(body.password, DUMMY_PASSWORD_HASH), false);
    if (!user || !passwordOk) {
      limiters.loginAccount.hit(accountKey);
      throw new ApiError(401, "Wrong email/username or password");
    }
    limiters.loginAccount.reset(accountKey);
    if (await requireTotp(user.id)) {
      const challenge = await createLoginChallenge(user.id, "totp");
      res.json({
        twoFactorRequired: true,
        challenge,
        methods: ["totp", "backup_code"],
        user: { name: user.name, email: user.email },
      });
      return;
    }
    const token = await createSession(user.id, req.headers["user-agent"]);
    res.setHeader("Set-Cookie", sessionCookie(token));
    res.json(await userPayload(user.id));
  }),
);

authRoutes.post(
  "/logout",
  handler(async (req, res) => {
    if (req.sessionToken) await run("DELETE FROM sessions WHERE token_hash = ?", [hashToken(req.sessionToken)]);
    res.setHeader("Set-Cookie", clearedCookie());
    res.json({ ok: true });
  }),
);

authRoutes.get(
  "/me",
  requireAuth,
  handler(async (req, res) => {
    res.json(await userPayload(req.user!.id));
  }),
);

authRoutes.patch(
  "/me",
  requireAuth,
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(80).optional(),
        email: emailSchema.optional(),
        username: usernameSchema.optional(),
        language: z.enum(["en", "el"]).optional(),
        developerMode: z.boolean().optional(),
        currentPassword: z.string().max(200).optional(),
      }),
      req.body,
    );
    // Email and username are sign-in identifiers (and the email receives
    // invites), so changing them needs the current password, not just a session.
    const current = (await get<any>("SELECT * FROM users WHERE id = ?", [req.user!.id]))!;
    const emailChanged = Boolean(body.email && body.email !== String(current.email).toLowerCase());
    const usernameChanged = Boolean(body.username && body.username !== String(current.username ?? "").toLowerCase());
    if (emailChanged || usernameChanged) {
      if (Number(current.password_set ?? 1) === 0) {
        if (emailChanged) {
          throw new ApiError(403, "Your email is managed by your single sign-on provider. Change it there.");
        }
      } else if (!body.currentPassword) {
        throw new ApiError(400, "Enter your current password to change your email or username");
      } else if (!verifyPassword(body.currentPassword, current.password_hash)) {
        throw new ApiError(400, "Current password is not correct");
      }
    }
    if (body.email && await get("SELECT id FROM users WHERE lower(email) = lower(?) AND id <> ?", [body.email, req.user!.id])) {
      throw new ApiError(409, "Another account already uses that email");
    }
    if (body.username && await usernameTaken(body.username, req.user!.id)) {
      throw new ApiError(409, "Another account already uses that username");
    }
    await run(
      `UPDATE users SET name = COALESCE(?, name), email = COALESCE(?, email),
         username = COALESCE(?, username), language = COALESCE(?, language),
         developer_mode = COALESCE(?, developer_mode)
       WHERE id = ?`,
      [
        body.name ?? null,
        body.email ?? null,
        body.username ?? null,
        body.language ?? null,
        body.developerMode === undefined ? null : body.developerMode ? 1 : 0,
        req.user!.id,
      ],
    );
    res.json(await userPayload(req.user!.id));
  }),
);

authRoutes.post(
  "/me/password",
  requireAuth,
  handler(async (req, res) => {
    const body = parseBody(
      z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema }),
      req.body,
    );
    const user = (await get<any>("SELECT * FROM users WHERE id = ?", [req.user!.id]))!;
    if (!verifyPassword(body.currentPassword, user.password_hash)) {
      throw new ApiError(400, "Current password is not correct");
    }
    await run("UPDATE users SET password_hash = ? WHERE id = ?", [hashPassword(body.newPassword), user.id]);
    await run("DELETE FROM sessions WHERE user_id = ?", [user.id]);
    const token = await createSession(user.id, req.headers["user-agent"]);
    res.setHeader("Set-Cookie", sessionCookie(token));
    res.json({ ok: true });
  }),
);

authRoutes.get(
  "/invites/:code",
  handler(async (req, res) => {
    const invite = await get<any>(
      `SELECT i.*, h.name AS house_name, h.kind AS house_kind, u.name AS inviter_name
       FROM house_invites i JOIN houses h ON h.id = i.house_id
       LEFT JOIN users u ON u.id = i.created_by
       WHERE i.code = ?`,
      [req.params.code],
    );
    if (!invite || invite.accepted_at || inviteExpired(invite)) throw new ApiError(404, "That invite link is no longer valid");
    res.json({
      code: invite.code,
      houseName: invite.house_name,
      houseKind: invite.house_kind,
      role: invite.role,
      email: invite.email,
      expiresAt: inviteExpiresAt(invite),
      inviterName: invite.inviter_name ?? null,
      memberCount: Number(
        (await get<{ n: number }>("SELECT COUNT(*) AS n FROM house_members WHERE house_id = ?", [invite.house_id]))?.n ?? 0,
      ),
    });
  }),
);

authRoutes.post(
  "/invites/:code/accept",
  requireAuth,
  handler(async (req, res) => {
    const invite = await get<any>("SELECT * FROM house_invites WHERE code = ? AND accepted_at IS NULL", [req.params.code]);
    if (!invite || inviteExpired(invite)) throw new ApiError(404, "That invite link is no longer valid");
    if (invite.email && invite.email.toLowerCase() !== req.user!.email.toLowerCase()) {
      throw new ApiError(403, "This invite was sent to a different email address");
    }
    if (!await memberRole(req.user!.id, invite.house_id)) {
      await run("INSERT INTO house_members (house_id, user_id, role, created_at) VALUES (?, ?, ?, ?)", [
        invite.house_id,
        req.user!.id,
        invite.role as Role,
        now(),
      ]);
      await notifyHouseAdded(req.user!.id, invite.house_id, invite.role as Role, invite.created_by);
    }
    await run("UPDATE house_invites SET accepted_at = ?, accepted_by = ? WHERE id = ?", [now(), req.user!.id, invite.id]);
    res.json(await userPayload(req.user!.id));
  }),
);

/** Small helper used by the seed script and tests. */
export async function createUserAccount(email: string, name: string, password: string, isAdmin = false): Promise<string> {
  const id = newId("usr");
  const normalizedEmail = email.toLowerCase();
  await run("INSERT INTO users (id, email, username, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    id,
    normalizedEmail,
    await uniqueUsername(normalizedEmail),
    name,
    hashPassword(password),
    isAdmin ? 1 : 0,
    now(),
  ]);
  return id;
}

export { publicUser };
