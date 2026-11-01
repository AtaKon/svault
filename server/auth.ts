import type { NextFunction, Request, Response } from "express";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { all, get, now, run, newId } from "./db.js";
import { SESSION_DAYS } from "./config.js";
import type { Role } from "../shared/types.js";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  createdAt: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionToken?: string;
    }
  }
}

const ROLE_RANK: Record<Role, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `s1$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "s1" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length !== 64) return false;
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), 64);
  return timingSafeEqual(expected, actual);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createSession(userId: string, userAgent?: string): string {
  const token = randomBytes(24).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  run(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [newId("ses"), userId, hashToken(token), expires, userAgent ?? null, now()],
  );
  return token;
}

export function destroySession(token: string) {
  run("DELETE FROM sessions WHERE token_hash = ?", [hashToken(token)]);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function readSessionUser(req: Request): AuthUser | null {
  const token = parseCookies(req.headers.cookie)["sv_session"];
  if (!token) return null;
  const row = get<any>(
    `SELECT u.id, u.email, u.name, u.is_admin, u.created_at, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`,
    [hashToken(token)],
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    run("DELETE FROM sessions WHERE token_hash = ?", [hashToken(token)]);
    return null;
  }
  req.sessionToken = token;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isAdmin: !!row.is_admin,
    createdAt: row.created_at,
  };
}

export function sessionCookie(token: string): string {
  const maxAge = SESSION_DAYS * 86400;
  return `sv_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${
    process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false" ? "; Secure" : ""
  }`;
}

export function clearedCookie(): string {
  return "sv_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

export function attachUser(req: Request, _res: Response, next: NextFunction) {
  req.user = readSessionUser(req) ?? undefined;
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  next();
}

export function memberRole(userId: string, houseId: string): Role | null {
  const row = get<{ role: string }>("SELECT role FROM house_members WHERE house_id = ? AND user_id = ?", [
    houseId,
    userId,
  ]);
  return (row?.role as Role) ?? null;
}

export function roleAtLeast(role: Role | null, required: Role): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export function houseMembers(houseId: string) {
  return all(
    `SELECT u.id, u.email, u.name, m.role, m.created_at FROM house_members m
     JOIN users u ON u.id = m.user_id WHERE m.house_id = ? ORDER BY m.created_at`,
    [houseId],
  );
}

/** Houses the user can see, with their role. */
export function userHouses(userId: string) {
  return all<any>(
    `SELECT h.*, m.role FROM houses h JOIN house_members m ON m.house_id = h.id
     WHERE m.user_id = ? ORDER BY h.created_at`,
    [userId],
  );
}
