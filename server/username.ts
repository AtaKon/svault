export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidUsername(value: string): boolean {
  return value.length >= USERNAME_MIN && value.length <= USERNAME_MAX && USERNAME_RE.test(value);
}

/** Turn an email local part into a readable, valid username seed. */
export function usernameFromEmail(email: string): string {
  const local = String(email).split("@")[0] ?? "";
  let base = local
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "")
    .replace(/^[._-]+|[._-]+$/g, "");
  if (!/^[a-z0-9]/.test(base)) base = `user-${base}`;
  if (base.length < USERNAME_MIN) base = `${base || "user"}-user`;
  return base.slice(0, USERNAME_MAX).replace(/[._-]+$/g, "") || "user";
}

/** Keep generated usernames within the limit while adding a numeric suffix. */
export function usernameWithSuffix(base: string, suffix: number): string {
  if (suffix <= 1) return base.slice(0, USERNAME_MAX);
  const tail = String(suffix);
  return `${base.slice(0, USERNAME_MAX - tail.length)}${tail}`;
}
