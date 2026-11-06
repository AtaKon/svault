import { Router } from "express";
import { z } from "zod";
import { get, run } from "../db.js";
import { createSession, requireAuth, sessionCookie, verifyPassword } from "../auth.js";
import { ApiError, handler, parseBody } from "../http.js";
import {
  consumeLoginChallenge,
  disableTotp,
  enableTotp,
  generateBackupCodes,
  generateTotpSecret,
  getTotp,
  otpauthUrl,
  peekLoginChallenge,
  recordChallengeFailure,
  saveTotpSetup,
  totpStatus,
  verifyTotp,
  verifyTotpOrBackup,
} from "../services/totp.js";
import { userPayload } from "./auth.js";

export const twoFactorRoutes = Router();

twoFactorRoutes.get(
  "/2fa",
  requireAuth,
  handler(async (req, res) => {
    res.json(await totpStatus(req.user!.id));
  }),
);

twoFactorRoutes.post(
  "/2fa/setup",
  requireAuth,
  handler(async (req, res) => {
    const body = parseBody(z.object({ password: z.string().min(1).max(200) }), req.body);
    const user = (await get<any>("SELECT * FROM users WHERE id = ?", [req.user!.id]))!;
    if (!verifyPassword(body.password, user.password_hash)) throw new ApiError(400, "Password is not correct");
    if ((await getTotp(user.id))?.enabled) throw new ApiError(400, "Two-factor authentication is already enabled");
    const secret = generateTotpSecret();
    await saveTotpSetup(user.id, secret);
    res.json({
      secret,
      otpauth: otpauthUrl(secret, user.email),
      issuer: "SVault",
      account: user.email,
      digits: 6,
      period: 30,
    });
  }),
);

twoFactorRoutes.post(
  "/2fa/enable",
  requireAuth,
  handler(async (req, res) => {
    const body = parseBody(z.object({ code: z.string().trim().min(6).max(10) }), req.body);
    const row = await getTotp(req.user!.id);
    if (!row) throw new ApiError(400, "Start two-factor setup first");
    if (row.enabled) throw new ApiError(400, "Two-factor authentication is already enabled");
    if (!verifyTotp(row.secret, body.code)) throw new ApiError(400, "That code is not valid");
    const backupCodes = await enableTotp(req.user!.id);
    res.json({ ok: true, backupCodes });
  }),
);

twoFactorRoutes.post(
  "/2fa/disable",
  requireAuth,
  handler(async (req, res) => {
    const body = parseBody(
      z.object({ password: z.string().min(1).max(200), code: z.string().trim().max(20).optional() }),
      req.body,
    );
    const user = (await get<any>("SELECT * FROM users WHERE id = ?", [req.user!.id]))!;
    if (!verifyPassword(body.password, user.password_hash)) throw new ApiError(400, "Password is not correct");
    if ((await getTotp(user.id))?.enabled && !body.code) throw new ApiError(400, "Enter a current code to disable 2FA");
    if ((await getTotp(user.id))?.enabled && body.code && !await verifyTotpOrBackup(user.id, body.code)) {
      throw new ApiError(400, "That code is not valid");
    }
    await disableTotp(user.id);
    res.json({ ok: true });
  }),
);

twoFactorRoutes.post(
  "/2fa/backup-codes",
  requireAuth,
  handler(async (req, res) => {
    const body = parseBody(
      z.object({ password: z.string().min(1).max(200), code: z.string().trim().min(6).max(20) }),
      req.body,
    );
    const user = (await get<any>("SELECT * FROM users WHERE id = ?", [req.user!.id]))!;
    if (!verifyPassword(body.password, user.password_hash)) throw new ApiError(400, "Password is not correct");
    if (!await verifyTotpOrBackup(user.id, body.code)) throw new ApiError(400, "That code is not valid");
    const codes = generateBackupCodes();
    await run("UPDATE user_totp SET backup_codes = ? WHERE user_id = ?", [JSON.stringify(codes.hashed), user.id]);
    res.json({ backupCodes: codes.plain });
  }),
);

twoFactorRoutes.post(
  "/2fa/verify",
  handler(async (req, res) => {
    const body = parseBody(
      z.object({ challenge: z.string().min(1).max(200), code: z.string().trim().min(1).max(30) }),
      req.body,
    );
    const userId = await peekLoginChallenge(body.challenge);
    if (!userId) throw new ApiError(401, "That sign-in challenge expired; enter your password again");
    if (!await verifyTotpOrBackup(userId, body.code)) {
      const left = await recordChallengeFailure(body.challenge);
      if (left <= 0) throw new ApiError(401, "Too many wrong codes. Enter your password again.");
      throw new ApiError(401, "That code is not valid");
    }
    if (!await consumeLoginChallenge(body.challenge)) {
      throw new ApiError(401, "That sign-in challenge expired; enter your password again");
    }
    const token = await createSession(userId, req.headers["user-agent"]);
    res.setHeader("Set-Cookie", sessionCookie(token));
    res.json(await userPayload(userId));
  }),
);
