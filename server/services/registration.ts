import { get } from "../db.js";

export type RegistrationMode = "open" | "invite" | "closed";

export const REGISTRATION_MODE_KEY = "registration_mode";

/**
 * Who may create an account.
 *
 * - `open`: anyone who can reach the server.
 * - `invite`: only with a valid, unexpired house invite.
 * - `closed`: nobody; accounts come from invites accepted by existing users,
 *   OIDC links to existing accounts, or the seed script.
 *
 * An instance admin can override the mode at runtime (stored in
 * `instance_settings`). Without an override, SV_REGISTRATION picks the mode and
 * registration is `invite` once the first account exists. The very first
 * account (the instance admin) can always be created so a fresh install is
 * usable.
 */
export function isRegistrationMode(value: unknown): value is RegistrationMode {
  return value === "open" || value === "invite" || value === "closed";
}

export function configuredRegistrationMode(): RegistrationMode | null {
  const value = (process.env.SV_REGISTRATION ?? "").trim().toLowerCase();
  return isRegistrationMode(value) ? value : null;
}

export async function registrationModeOverride(): Promise<RegistrationMode | null> {
  const row = await get<{ value: string }>("SELECT value FROM instance_settings WHERE key = ?", [REGISTRATION_MODE_KEY]);
  return isRegistrationMode(row?.value) ? row.value : null;
}

export async function registrationStatus(): Promise<{
  mode: RegistrationMode;
  firstUser: boolean;
  /** Where the mode came from, so the admin page can explain it. */
  source: "first-user" | "admin" | "environment" | "default";
}> {
  const firstUser = !await get("SELECT id FROM users LIMIT 1");
  if (firstUser) return { mode: "open", firstUser, source: "first-user" };
  const override = await registrationModeOverride();
  if (override) return { mode: override, firstUser, source: "admin" };
  const configured = configuredRegistrationMode();
  if (configured) return { mode: configured, firstUser, source: "environment" };
  return { mode: "invite", firstUser, source: "default" };
}
