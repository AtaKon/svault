import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { DATA_DIR } from "../../config.js";

/**
 * Per-user secrets for Open Food Facts.
 *
 * Only a session cookie or bearer token is stored; passwords are exchanged for
 * a session and discarded. AES-256-GCM is used with a key from
 * `SV_OFF_SECRET_KEY` or a generated `DATA_DIR/off-secret.key`.
 */

const KEY_FILE = path.join(DATA_DIR, "off-secret.key");
let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const configured = String(process.env.SV_OFF_SECRET_KEY ?? "").trim();
  if (configured) {
    const key = Buffer.from(configured, "base64");
    if (key.length !== 32) throw new Error("SV_OFF_SECRET_KEY must be 32 bytes encoded as base64");
    cachedKey = key;
    return key;
  }
  if (fs.existsSync(KEY_FILE)) {
    const key = Buffer.from(fs.readFileSync(KEY_FILE, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error("DATA_DIR/off-secret.key is invalid; delete it to generate a new key");
    try {
      fs.chmodSync(KEY_FILE, 0o600);
    } catch {
      /* best effort on filesystems without POSIX modes */
    }
    cachedKey = key;
    return key;
  }
  const key = randomBytes(32);
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, `${key.toString("base64")}\n`, { mode: 0o600 });
  cachedKey = key;
  return key;
}

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
}

export function encryptSecret(value: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptSecret(secret: EncryptedSecret): string {
  const decipher = createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(secret.iv, "base64"));
  decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Stable pseudonymous id sent to Open Food Facts as `app_uuid`. It lets
 * moderators ban one abusive user without banning the instance, without
 * linking the id back to an email or name.
 */
export function appUuidFor(userId: string): string {
  return createHmac("sha256", loadKey()).update(`svault-off-app:${userId}`).digest("hex").slice(0, 32);
}

/** Test helper. Never call this in a request path. */
export function resetSecretKeyCache() {
  cachedKey = null;
}

/** Validate or create the key at boot so a bad key fails fast. */
export function validateSecretKey(): void {
  loadKey();
}
