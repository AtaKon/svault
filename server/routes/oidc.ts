import { Router } from "express";
import {
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  discovery,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  type Configuration,
} from "openid-client";
import { randomBytes } from "node:crypto";
import { get, newId, now, run } from "../db.js";
import { createSession, hashPassword, sessionCookie } from "../auth.js";
import { ApiError, handler } from "../http.js";
import { OIDC } from "../config.js";
import { consumeChallenge, storeChallenge } from "../services/passkeys.js";
import { createHouse } from "../services/houses.js";
import { registrationStatus } from "../services/registration.js";
import { usernameFromEmail, usernameWithSuffix } from "../username.js";

export const oidcRoutes = Router();

let cachedConfig: { key: string; config: Configuration } | null = null;

async function oidcConfig(): Promise<Configuration> {
  const key = `${OIDC.issuer}|${OIDC.clientId}|${OIDC.clientSecret ? "secret" : "public"}`;
  if (cachedConfig?.key === key) return cachedConfig.config;
  const config = await discovery(
    new URL(OIDC.issuer),
    OIDC.clientId,
    OIDC.clientSecret || undefined,
    undefined,
    OIDC.issuer.startsWith("http://") ? { execute: [allowInsecureRequests] } : undefined,
  );
  cachedConfig = { key, config };
  return config;
}

function enabled() {
  return Boolean(OIDC.issuer && OIDC.clientId);
}

function callbackUrl(req: any) {
  return OIDC.redirectUri || `${req.protocol}://${req.get("host")}/api/auth/oidc/callback`;
}

function redirectError(res: any, message: string) {
  res.redirect(`/login?oidc_error=${encodeURIComponent(message)}`);
}

async function uniqueUsername(email: string, excludeUserId?: string) {
  const base = usernameFromEmail(email);
  let candidate = base;
  let suffix = 1;
  while (await get("SELECT id FROM users WHERE lower(username) = lower(?) AND id <> ?", [candidate, excludeUserId ?? ""])) {
    suffix += 1;
    candidate = usernameWithSuffix(base, suffix);
  }
  return candidate;
}

async function findOrCreateIdentity(claims: Record<string, any>) {
  const email = String(claims.email ?? "").trim().toLowerCase();
  if (!email) throw new ApiError(400, "The identity provider did not return an email address");
  if (claims.email_verified !== true && claims.email_verified !== "true") {
    throw new ApiError(403, "The identity provider has not verified this email address");
  }
  if (!OIDC.allowedDomains.length || OIDC.allowedDomains.includes(email.split("@")[1])) {
    // allowed
  } else {
    throw new ApiError(403, `Email domain is not allowed for single sign-on`);
  }
  const subject = String(claims.sub ?? "");
  if (!subject) throw new ApiError(400, "The identity provider did not return a subject");

  const identity = await get<any>("SELECT * FROM user_identities WHERE provider = 'oidc' AND subject = ?", [subject]);
  if (identity) {
    const linked = await get<any>("SELECT * FROM users WHERE id = ?", [identity.user_id]);
    if (!linked) throw new ApiError(409, "This identity is linked to a missing account");
    return linked;
  }

  let user = await get<any>("SELECT * FROM users WHERE lower(email) = lower(?)", [email]);
  if (!user) {
    if (!OIDC.autoProvision) throw new ApiError(403, "No SVault account matches this identity");
    // Auto-provisioning creates an account, so it follows SV_REGISTRATION.
    const registration = await registrationStatus();
    if (registration.mode !== "open") {
      throw new ApiError(403, "No SVault account matches this identity. Ask the administrator for an invite.");
    }
    const userId = newId("usr");
    const first = registration.firstUser;
    await run("INSERT INTO users (id, email, username, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      userId,
      email,
      await uniqueUsername(email),
      String(claims.name ?? claims.preferred_username ?? email.split("@")[0]).slice(0, 80),
      hashPassword(randomBytes(24).toString("base64url")),
      first ? 1 : 0,
      now(),
    ]);
    if (OIDC.defaultHouseId && await get("SELECT id FROM houses WHERE id = ?", [OIDC.defaultHouseId])) {
      await run("INSERT INTO house_members (house_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)", [
        OIDC.defaultHouseId,
        userId,
        now(),
      ]);
    } else {
      await createHouse({ userId, name: `${String(claims.name ?? email.split("@")[0]).split(" ")[0]}'s Home` });
    }
    user = await get<any>("SELECT * FROM users WHERE id = ?", [userId]);
  }

  await run("INSERT INTO user_identities (id, user_id, provider, subject, email, created_at) VALUES (?, ?, 'oidc', ?, ?, ?) ON CONFLICT DO NOTHING", [
    newId("idn"),
    user.id,
    subject,
    email,
    now(),
  ]);
  return user;
}

oidcRoutes.get(
  "/oidc/status",
  handler((_req, res) => {
    res.json({ enabled: enabled(), label: OIDC.label });
  }),
);

oidcRoutes.get(
  "/oidc/start",
  handler(async (req, res) => {
    if (!enabled()) throw new ApiError(404, "Single sign-on is not configured");
    const config = await oidcConfig();
    const verifier = randomPKCECodeVerifier();
    const challenge = await calculatePKCECodeChallenge(verifier);
    const state = randomState();
    const nonce = randomNonce();
    await storeChallenge({
      id: state,
      type: "oidc",
      challenge: state,
      data: { verifier, nonce, redirectUri: callbackUrl(req) },
      ttlMs: 10 * 60_000,
    });
    const url = buildAuthorizationUrl(config, {
      redirect_uri: callbackUrl(req),
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    res.redirect(url.href);
  }),
);

oidcRoutes.get(
  "/oidc/callback",
  handler(async (req, res) => {
    if (!enabled()) throw new ApiError(404, "Single sign-on is not configured");
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!state) {
      redirectError(res, "The provider did not return a state value");
      return;
    }
    const stored = await consumeChallenge(state, "oidc");
    if (!stored) {
      redirectError(res, "The sign-in state expired. Try again.");
      return;
    }
    try {
      const config = await oidcConfig();
      const currentUrl = new URL(`${callbackUrl(req)}?${new URLSearchParams(req.query as any).toString()}`);
      const tokens = await authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: stored.data.verifier,
        expectedState: state,
        expectedNonce: stored.data.nonce,
      });
      const claims = tokens.claims() as Record<string, any> | undefined;
      if (!claims) throw new ApiError(400, "The provider did not return an ID token");
      const user = await findOrCreateIdentity(claims);
      const token = await createSession(user.id, req.headers["user-agent"]);
      res.setHeader("Set-Cookie", sessionCookie(token));
      res.redirect("/?sso=1");
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Single sign-on failed";
      redirectError(res, message);
    }
  }),
);
