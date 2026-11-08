import { all, get, now, run } from "../../db.js";
import { APP_VERSION } from "../../config.js";
import type { OffProjectId } from "../../../shared/types.js";
import { ApiError } from "../../http.js";
import { OFF_PROJECTS } from "./projects.js";
import { appUuidFor, decryptSecret, encryptSecret } from "./secrets.js";

/**
 * Open Food Facts account links.
 *
 * A linked user gets their own attribution. The instance account is a
 * fallback: its credentials live only in the environment, and every user gets
 * a stable pseudonymous `app_uuid` so moderators can still isolate abuse.
 */

const CONTACT = String(process.env.SV_OFF_CONTACT ?? "").trim();
const USER_AGENT = `SVault/${APP_VERSION} (self-hosted household inventory; https://github.com/AtaKon/svault${
  CONTACT ? `; ${CONTACT}` : ""
})`;

export interface OffAccountRow {
  user_id: string;
  project: string;
  username: string;
  secret_kind: string;
  secret_ciphertext: string;
  secret_iv: string;
  secret_tag: string;
  secret_expires_at: string | null;
  app_uuid: string;
  linked_at: string;
  verified_at: string | null;
  last_error: string | null;
}

export interface OffAccountPublic {
  project: OffProjectId;
  username: string;
  kind: "user" | "instance";
  linkedAt: string | null;
  verifiedAt: string | null;
  expiresAt: string | null;
  status: "connected" | "expired" | "error";
  error: string | null;
}

export interface OffContributionIdentity {
  mode: "session" | "credentials";
  username: string;
  appUuid: string;
  /** Cookie header value, for `mode: "session"`. */
  cookie?: string;
  /** Present only for the environment instance account. Never persisted. */
  password?: string;
}

export function offWritesEnabled(): boolean {
  return String(process.env.SV_OFF_WRITE_ENABLED ?? "").trim().toLowerCase() === "true";
}

export function offDryRun(): boolean {
  return String(process.env.SV_OFF_DRY_RUN ?? "").trim().toLowerCase() === "true";
}

export function instanceAccount(): { username: string; password: string } | null {
  const username = String(process.env.OFF_CONTRIB_USER ?? "").trim();
  const password = String(process.env.OFF_CONTRIB_PASSWORD ?? "");
  return username && password ? { username, password } : null;
}

function cookieFrom(headers: Headers): string | null {
  const values =
    typeof (headers as any).getSetCookie === "function"
      ? (headers as any).getSetCookie()
      : [headers.get("set-cookie")].filter(Boolean);
  for (const value of values as string[]) {
    const match = /(?:^|[,\s])session=([^;,\s]+)/.exec(value);
    if (match) return `session=${match[1]}`;
  }
  return null;
}

export function publicAccount(row: OffAccountRow | null | undefined): OffAccountPublic | null {
  if (!row) return null;
  const expired = row.secret_expires_at ? new Date(row.secret_expires_at).getTime() < Date.now() : false;
  return {
    project: row.project as OffProjectId,
    username: row.username,
    kind: "user",
    linkedAt: row.linked_at,
    verifiedAt: row.verified_at,
    expiresAt: row.secret_expires_at,
    status: row.last_error ? "error" : expired ? "expired" : "connected",
    error: row.last_error,
  };
}

export async function getOffAccountRow(userId: string, project: OffProjectId): Promise<OffAccountRow | null> {
  return (await get<OffAccountRow>("SELECT * FROM user_off_accounts WHERE user_id = ? AND project = ?", [userId, project])) ?? null;
}

export async function listOffAccounts(userId: string): Promise<OffAccountPublic[]> {
  const rows = await all<OffAccountRow>("SELECT * FROM user_off_accounts WHERE user_id = ? ORDER BY linked_at", [userId]);
  return rows.map((row) => publicAccount(row)).filter(Boolean) as OffAccountPublic[];
}

/**
 * Exchange an OFF username/password for a session cookie. The password is used
 * for this request only and is never stored or logged.
 */
export async function linkOffAccount(opts: {
  userId: string;
  project: OffProjectId;
  username: string;
  password: string;
}): Promise<OffAccountPublic> {
  const project = OFF_PROJECTS[opts.project];
  if (!project.capabilities.write) throw new ApiError(400, `${project.label} does not accept contributions`);
  const username = opts.username.trim();
  if (!username) throw new ApiError(400, "Enter your Open Food Facts username, not your email");
  if (!opts.password) throw new ApiError(400, "Enter your Open Food Facts password");

  let res: Response;
  try {
    res = await fetch(`${project.base}/cgi/session.pl`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": USER_AGENT,
      },
      body: new URLSearchParams({ user_id: username, password: opts.password }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApiError(503, "Could not reach Open Food Facts. Try again later.");
  }
  if (res.status === 401 || res.status === 403) {
    throw new ApiError(401, "Open Food Facts rejected that username or password");
  }
  const cookie = cookieFrom(res.headers);
  if (!cookie) throw new ApiError(401, "Open Food Facts did not return a session. Check the username and password.");
  const secret = encryptSecret(cookie);
  const existing = await getOffAccountRow(opts.userId, opts.project);
  const timestamp = now();
  await run(
    `INSERT INTO user_off_accounts
       (user_id, project, username, secret_kind, secret_ciphertext, secret_iv, secret_tag,
        secret_expires_at, app_uuid, linked_at, verified_at, last_error)
     VALUES (?, ?, ?, 'cookie', ?, ?, ?, NULL, ?, ?, ?, NULL)
     ON CONFLICT(user_id, project) DO UPDATE SET
       username = excluded.username,
       secret_kind = excluded.secret_kind,
       secret_ciphertext = excluded.secret_ciphertext,
       secret_iv = excluded.secret_iv,
       secret_tag = excluded.secret_tag,
       secret_expires_at = excluded.secret_expires_at,
       linked_at = excluded.linked_at,
       verified_at = excluded.verified_at,
       last_error = NULL`,
    [
      opts.userId,
      opts.project,
      username,
      secret.ciphertext,
      secret.iv,
      secret.tag,
      existing?.app_uuid || appUuidFor(opts.userId),
      timestamp,
      timestamp,
    ],
  );
  return publicAccount(await getOffAccountRow(opts.userId, opts.project))!;
}

export async function unlinkOffAccount(userId: string, project: OffProjectId) {
  await run("DELETE FROM user_off_accounts WHERE user_id = ? AND project = ?", [userId, project]);
  await run(
    "UPDATE off_contributions SET status = 'cancelled', next_attempt_at = NULL, updated_at = ? WHERE user_id = ? AND project = ? AND status IN ('queued', 'retry')",
    [now(), userId, project],
  );
}

/** Check whether the stored session still works. */
export async function verifyOffAccount(userId: string, projectId: OffProjectId): Promise<OffAccountPublic | null> {
  const row = await getOffAccountRow(userId, projectId);
  if (!row) return null;
  // Product reads are public, so they cannot prove a session. The login
  // exchange is the verification; the next write will surface an expired
  // session and prompt the user to reconnect. Keep this endpoint informational.
  return publicAccount(row);
}

/**
 * Resolve how a contribution should authenticate. Returns null when neither a
 * personal account nor the instance account is available.
 */
export async function contributionIdentity(
  userId: string,
  projectId: OffProjectId,
): Promise<OffContributionIdentity | null> {
  const row = await getOffAccountRow(userId, projectId);
  if (row) {
    let cookie: string;
    try {
      cookie = decryptSecret({
        ciphertext: row.secret_ciphertext,
        iv: row.secret_iv,
        tag: row.secret_tag,
      });
    } catch {
      return null;
    }
    return { mode: "session", username: row.username, appUuid: row.app_uuid, cookie };
  }
  if (projectId === "off") {
    const instance = instanceAccount();
    if (instance) {
      return {
        mode: "credentials",
        username: instance.username,
        password: instance.password,
        appUuid: appUuidFor(userId),
      };
    }
  }
  return null;
}

export async function accountSummary(userId: string) {
  const accounts = await listOffAccounts(userId);
  const instance = projectAccounts();
  return {
    accounts,
    instanceAccount: instance,
    writesEnabled: offWritesEnabled(),
    dryRun: offDryRun(),
  };
}

function projectAccounts(): { available: boolean; username: string | null } {
  const instance = instanceAccount();
  return {
    available: Boolean(instance),
    username: instance?.username ?? null,
  };
}
