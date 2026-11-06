import { get } from "../db.js";

export type RegistrationMode = "open" | "invite" | "closed";

/**
 * Who may create an account.
 *
 * - `open`: anyone who can reach the server.
 * - `invite`: only with a valid, unexpired house invite.
 * - `closed`: nobody; accounts come from invites accepted by existing users,
 *   OIDC links to existing accounts, or the seed script.
 *
 * SV_REGISTRATION picks the mode. Without it, registration is `invite` once
 * the first account exists. The very first account (the instance admin) can
 * always be created so a fresh install is usable.
 */
export function configuredRegistrationMode(): RegistrationMode | null {
  const value = (process.env.SV_REGISTRATION ?? "").trim().toLowerCase();
  return value === "open" || value === "invite" || value === "closed" ? value : null;
}

export async function registrationStatus(): Promise<{ mode: RegistrationMode; firstUser: boolean }> {
  const firstUser = !await get("SELECT id FROM users LIMIT 1");
  if (firstUser) return { mode: "open", firstUser };
  return { mode: configuredRegistrationMode() ?? "invite", firstUser };
}
