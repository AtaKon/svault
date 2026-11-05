import { all, get, newId, now, run } from "../db.js";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";

export interface StoredPasskey {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: AuthenticatorTransportFuture[];
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function serialize(row: any): StoredPasskey {
  let transports: AuthenticatorTransportFuture[] = [];
  try {
    transports = JSON.parse(row.transports || "[]");
  } catch {
    transports = [];
  }
  return {
    id: row.id,
    userId: row.user_id,
    credentialId: row.credential_id,
    publicKey: row.public_key,
    counter: Number(row.counter ?? 0),
    transports,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
  };
}

export function listPasskeys(userId: string): StoredPasskey[] {
  return all<any>("SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at", [userId]).map(serialize);
}

export function listPasskeysForLogin(userId: string) {
  return listPasskeys(userId);
}

export function passkeyByCredentialId(credentialId: string): StoredPasskey | null {
  const row = get<any>("SELECT * FROM passkeys WHERE credential_id = ?", [credentialId]);
  return row ? serialize(row) : null;
}

export function savePasskey(opts: {
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: AuthenticatorTransportFuture[];
  name?: string;
}): StoredPasskey {
  const id = newId("pky");
  run(
    `INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.userId,
      opts.credentialId,
      opts.publicKey,
      opts.counter,
      JSON.stringify(opts.transports ?? []),
      (opts.name ?? "Passkey").slice(0, 60),
      now(),
    ],
  );
  return serialize(get<any>("SELECT * FROM passkeys WHERE id = ?", [id]));
}

export function updatePasskeyCounter(id: string, counter: number) {
  run("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?", [counter, now(), id]);
}

export function deletePasskey(userId: string, id: string) {
  run("DELETE FROM passkeys WHERE id = ? AND user_id = ?", [id, userId]);
}

export function deleteAllPasskeys(userId: string) {
  run("DELETE FROM passkeys WHERE user_id = ?", [userId]);
}

export function passkeyCount(userId: string): number {
  return Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?", [userId])?.n ?? 0);
}

export function storeChallenge(opts: {
  id?: string;
  userId?: string | null;
  type: "registration" | "authentication" | "oidc";
  challenge: string;
  data?: Record<string, unknown>;
  ttlMs?: number;
}): string {
  const id = opts.id ?? newId("wch");
  run("DELETE FROM webauthn_challenges WHERE expires_at < ?", [now()]);
  run(
    "INSERT INTO webauthn_challenges (id, user_id, type, challenge, data, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      opts.userId ?? null,
      opts.type,
      opts.challenge,
      JSON.stringify(opts.data ?? {}),
      new Date(Date.now() + (opts.ttlMs ?? 5 * 60_000)).toISOString(),
      now(),
    ],
  );
  return id;
}

export function consumeChallenge(
  id: string,
  type: "registration" | "authentication" | "oidc",
): { userId: string | null; challenge: string; data: Record<string, any> } | null {
  const row = get<any>("SELECT * FROM webauthn_challenges WHERE id = ? AND type = ?", [id, type]);
  if (!row) return null;
  run("DELETE FROM webauthn_challenges WHERE id = ?", [id]);
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  let data: Record<string, any> = {};
  try {
    data = JSON.parse(row.data || "{}");
  } catch {
    data = {};
  }
  return { userId: row.user_id ?? null, challenge: row.challenge, data };
}
