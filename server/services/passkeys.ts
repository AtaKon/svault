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

export async function listPasskeys(userId: string): Promise<StoredPasskey[]> {
  return (await all<any>("SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at", [userId])).map(serialize);
}

export async function listPasskeysForLogin(userId: string) {
  return await listPasskeys(userId);
}

export async function passkeyByCredentialId(credentialId: string): Promise<StoredPasskey | null> {
  const row = await get<any>("SELECT * FROM passkeys WHERE credential_id = ?", [credentialId]);
  return row ? await serialize(row) : null;
}

export async function savePasskey(opts: {
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: AuthenticatorTransportFuture[];
  name?: string;
}): Promise<StoredPasskey> {
  const id = newId("pky");
  await run(
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
  return await serialize(await get<any>("SELECT * FROM passkeys WHERE id = ?", [id]));
}

export async function updatePasskeyCounter(id: string, counter: number) {
  await run("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?", [counter, now(), id]);
}

export async function deletePasskey(userId: string, id: string) {
  await run("DELETE FROM passkeys WHERE id = ? AND user_id = ?", [id, userId]);
}

export async function deleteAllPasskeys(userId: string) {
  await run("DELETE FROM passkeys WHERE user_id = ?", [userId]);
}

export async function passkeyCount(userId: string): Promise<number> {
  return Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?", [userId]))?.n ?? 0);
}

export async function storeChallenge(opts: {
  id?: string;
  userId?: string | null;
  type: "registration" | "authentication" | "oidc";
  challenge: string;
  data?: Record<string, unknown>;
  ttlMs?: number;
}): Promise<string> {
  const id = opts.id ?? newId("wch");
  await run("DELETE FROM webauthn_challenges WHERE expires_at < ?", [now()]);
  await run(
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

export async function consumeChallenge(
  id: string,
  type: "registration" | "authentication" | "oidc",
): Promise<{ userId: string | null; challenge: string; data: Record<string, any> } | null> {
  const row = await get<any>("SELECT * FROM webauthn_challenges WHERE id = ? AND type = ?", [id, type]);
  if (!row) return null;
  await run("DELETE FROM webauthn_challenges WHERE id = ?", [id]);
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  let data: Record<string, any> = {};
  try {
    data = JSON.parse(row.data || "{}");
  } catch {
    data = {};
  }
  return { userId: row.user_id ?? null, challenge: row.challenge, data };
}
