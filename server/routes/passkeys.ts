import { Router } from "express";
import { z } from "zod";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { get } from "../db.js";
import { createSession, requireAuth, sessionCookie } from "../auth.js";
import { ApiError, handler, parseBody } from "../http.js";
import { RP_ID, RP_ORIGIN } from "../config.js";
import {
  consumeChallenge,
  deleteAllPasskeys,
  deletePasskey,
  listPasskeys,
  passkeyByCredentialId,
  savePasskey,
  storeChallenge,
  updatePasskeyCounter,
} from "../services/passkeys.js";
import { userPayload } from "./auth.js";

export const passkeyRoutes = Router();

function relyingParty(req: any) {
  const origin = RP_ORIGIN || `${req.protocol}://${req.get("host")}`;
  let rpID = RP_ID;
  if (!rpID) {
    try {
      rpID = new URL(origin).hostname;
    } catch {
      rpID = "localhost";
    }
  }
  return { origin, rpID };
}

passkeyRoutes.get(
  "/passkeys",
  requireAuth,
  handler(async (req, res) => {
    const { origin, rpID } = relyingParty(req);
    res.json({
      supported: true,
      rpID,
      origin,
      passkeys: (await listPasskeys(req.user!.id)).map((passkey) => ({
        id: passkey.id,
        name: passkey.name,
        createdAt: passkey.createdAt,
        lastUsedAt: passkey.lastUsedAt,
        transports: passkey.transports,
      })),
    });
  }),
);

passkeyRoutes.post(
  "/passkeys/options",
  requireAuth,
  handler(async (req, res) => {
    const { rpID } = relyingParty(req);
    const user = (await get<any>("SELECT * FROM users WHERE id = ?", [req.user!.id]))!;
    const existing = await listPasskeys(user.id);
    const options = await generateRegistrationOptions({
      rpName: "SVault",
      rpID,
      userID: new TextEncoder().encode(user.id),
      userName: user.username || user.email,
      userDisplayName: user.name,
      attestationType: "none",
      excludeCredentials: existing.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports,
      })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    const challengeId = await storeChallenge({
      userId: user.id,
      type: "registration",
      challenge: options.challenge,
      data: { rpID },
    });
    res.json({ challengeId, options });
  }),
);

passkeyRoutes.post(
  "/passkeys/verify",
  requireAuth,
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        challengeId: z.string().min(1).max(120),
        response: z.record(z.string(), z.any()),
        name: z.string().trim().max(60).optional(),
      }),
      req.body,
    );
    const stored = await consumeChallenge(body.challengeId, "registration");
    if (!stored || stored.userId !== req.user!.id) throw new ApiError(400, "Registration challenge expired");
    const { origin, rpID } = relyingParty(req);
    const verification = await verifyRegistrationResponse({
      response: body.response as any,
      expectedChallenge: stored.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new ApiError(400, "Passkey registration could not be verified");
    }
    const credential = verification.registrationInfo.credential;
    const passkey = await savePasskey({
      userId: req.user!.id,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      transports: credential.transports ?? [],
      name: body.name,
    });
    res.status(201).json({
      passkey: {
        id: passkey.id,
        name: passkey.name,
        createdAt: passkey.createdAt,
        lastUsedAt: passkey.lastUsedAt,
      },
    });
  }),
);

passkeyRoutes.delete(
  "/passkeys/:passkeyId",
  requireAuth,
  handler(async (req, res) => {
    await deletePasskey(req.user!.id, String(req.params.passkeyId));
    res.json({ ok: true });
  }),
);

passkeyRoutes.delete(
  "/passkeys/user/:userId",
  requireAuth,
  handler(async (req, res) => {
    const targetId = String(req.params.userId);
    if (targetId !== req.user!.id && !req.user!.isAdmin) {
      throw new ApiError(403, "Requires instance admin access");
    }
    await deleteAllPasskeys(targetId);
    res.json({ ok: true });
  }),
);

passkeyRoutes.post(
  "/passkeys/login/options",
  handler(async (req, res) => {
    const body = parseBody(z.object({ identifier: z.string().trim().max(220).optional() }), req.body ?? {});
    const { rpID } = relyingParty(req);
    const identifier = (body.identifier ?? "").trim();
    // An unknown identifier receives the same options shape as an account
    // without passkeys; accounts with credentials still reveal their presence.
    const user = identifier
      ? await get<any>("SELECT * FROM users WHERE lower(email) = lower(?) OR lower(username) = lower(?)", [
          identifier,
          identifier,
        ])
      : null;
    const allowed = user ? await listPasskeys(user.id) : [];
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: allowed.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports,
      })),
      userVerification: "preferred",
    });
    const challengeId = await storeChallenge({
      userId: user?.id ?? null,
      type: "authentication",
      challenge: options.challenge,
      data: { rpID, identifierProvided: Boolean(identifier) },
    });
    res.json({
      challengeId,
      options,
      discoverable: !identifier,
      hasPasskeys: Boolean(user && allowed.length),
    });
  }),
);

passkeyRoutes.post(
  "/passkeys/login/verify",
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        challengeId: z.string().min(1).max(120),
        response: z.record(z.string(), z.any()),
      }),
      req.body,
    );
    const stored = await consumeChallenge(body.challengeId, "authentication");
    if (!stored) throw new ApiError(400, "Passkey challenge expired");
    if (stored.data.identifierProvided && !stored.userId) throw new ApiError(401, "Passkey does not match this account");
    const credentialId = String((body.response as any)?.id ?? "");
    const passkey = credentialId ? await passkeyByCredentialId(credentialId) : null;
    if (!passkey) throw new ApiError(401, "Unknown passkey");
    if (stored.userId && stored.userId !== passkey.userId) throw new ApiError(401, "Passkey does not match this account");
    const { origin, rpID } = relyingParty(req);
    const verification = await verifyAuthenticationResponse({
      response: body.response as any,
      expectedChallenge: stored.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: passkey.credentialId,
        publicKey: Buffer.from(passkey.publicKey, "base64url"),
        counter: passkey.counter,
        transports: passkey.transports,
      },
      requireUserVerification: false,
    });
    if (!verification.verified) throw new ApiError(401, "Passkey could not be verified");
    if (verification.authenticationInfo.newCounter <= passkey.counter && passkey.counter > 0) {
      throw new ApiError(401, "Passkey counter did not advance; possible replay");
    }
    await updatePasskeyCounter(passkey.id, verification.authenticationInfo.newCounter);
    const token = await createSession(passkey.userId, req.headers["user-agent"]);
    res.setHeader("Set-Cookie", sessionCookie(token));
    res.json(await userPayload(passkey.userId));
  }),
);
