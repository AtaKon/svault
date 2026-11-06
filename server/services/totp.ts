import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { get, now, run } from "../db.js";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(value: string): Buffer {
  const clean = value.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let current = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) continue;
    current = (current << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((current >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, timestamp = Date.now(), step = 30, digits = 6): string {
  const counter = Math.floor(timestamp / 1000 / step);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(value % 10 ** digits).padStart(digits, "0");
}

export function verifyTotp(secret: string, code: string, window = 1): boolean {
  const wanted = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(wanted)) return false;
  for (let offset = -window; offset <= window; offset++) {
    const candidate = totpCode(secret, Date.now() + offset * 30_000);
    if (timingSafeEqual(Buffer.from(candidate), Buffer.from(wanted))) return true;
  }
  return false;
}

export function otpauthUrl(secret: string, account: string, issuer = "SVault"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function hashBackupCode(code: string): string {
  return createHash("sha256").update(code.replace(/[^a-z0-9]/gi, "").toUpperCase()).digest("hex");
}

export function generateBackupCodes(count = 8): { plain: string[]; hashed: string[] } {
  const plain: string[] = [];
  for (let index = 0; index < count; index++) {
    const raw = randomBytes(5).toString("hex").toUpperCase();
    plain.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return { plain, hashed: plain.map(hashBackupCode) };
}

export async function getTotp(userId: string) {
  return await get<any>("SELECT * FROM user_totp WHERE user_id = ?", [userId]);
}

export async function totpStatus(userId: string) {
  const row = await getTotp(userId);
  return {
    enabled: Boolean(row?.enabled),
    configured: Boolean(row),
    backupCodesRemaining: row ? (JSON.parse(row.backup_codes || "[]") as string[]).length : 0,
  };
}

export async function saveTotpSetup(userId: string, secret: string) {
  await run(
    `INSERT INTO user_totp (user_id, secret, enabled, backup_codes, created_at, confirmed_at)
     VALUES (?, ?, 0, '[]', ?, NULL)
     ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, enabled = 0, confirmed_at = NULL`,
    [userId, secret, now()],
  );
}

export async function enableTotp(userId: string) {
  const codes = generateBackupCodes();
  await run("UPDATE user_totp SET enabled = 1, backup_codes = ?, confirmed_at = ? WHERE user_id = ?", [
    JSON.stringify(codes.hashed),
    now(),
    userId,
  ]);
  return codes.plain;
}

export async function disableTotp(userId: string) {
  await run("DELETE FROM user_totp WHERE user_id = ?", [userId]);
}

/** Accept a TOTP code or consume one of the hashed backup codes. */
export async function verifyTotpOrBackup(userId: string, code: string): Promise<boolean> {
  const row = await getTotp(userId);
  if (!row || !row.enabled) return false;
  if (verifyTotp(row.secret, code)) return true;
  const hashed = JSON.parse(row.backup_codes || "[]") as string[];
  const wanted = hashBackupCode(code);
  const index = hashed.findIndex((entry) => timingSafeEqual(Buffer.from(entry), Buffer.from(wanted)));
  if (index < 0) return false;
  hashed.splice(index, 1);
  await run("UPDATE user_totp SET backup_codes = ? WHERE user_id = ?", [JSON.stringify(hashed), userId]);
  return true;
}

export async function requireTotp(userId: string): Promise<boolean> {
  return Boolean((await getTotp(userId))?.enabled);
}

export async function createLoginChallenge(userId: string, type = "totp"): Promise<string> {
  const id = randomBytes(18).toString("base64url");
  const expires = new Date(Date.now() + 5 * 60_000).toISOString();
  await run("DELETE FROM login_challenges WHERE expires_at < ?", [now()]);
  await run("INSERT INTO login_challenges (id, user_id, type, expires_at, created_at) VALUES (?, ?, ?, ?, ?)", [
    id,
    userId,
    type,
    expires,
    now(),
  ]);
  return id;
}

export async function consumeLoginChallenge(id: string, type = "totp"): Promise<string | null> {
  const row = await get<any>("SELECT * FROM login_challenges WHERE id = ? AND type = ?", [id, type]);
  if (!row) return null;
  await run("DELETE FROM login_challenges WHERE id = ?", [id]);
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.user_id as string;
}

/** Look at a challenge without invalidating it, so a mistyped code can be retried. */
export async function peekLoginChallenge(id: string, type = "totp"): Promise<string | null> {
  const row = await get<any>("SELECT * FROM login_challenges WHERE id = ? AND type = ?", [id, type]);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await run("DELETE FROM login_challenges WHERE id = ?", [id]);
    return null;
  }
  return row.user_id as string;
}
