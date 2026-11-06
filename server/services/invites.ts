/**
 * House invites expire. SV_INVITE_DAYS (default 14) sets the lifetime of new
 * invites; invites created before expiry existed get the same lifetime counted
 * from their creation date.
 */
function inviteDays(): number {
  const parsed = Number(process.env.SV_INVITE_DAYS ?? 14);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 14;
}

export function newInviteExpiry(from = Date.now()): string {
  return new Date(from + inviteDays() * 864e5).toISOString();
}

export function inviteExpiresAt(invite: { expires_at?: string | null; created_at?: string | null }): string | null {
  if (invite.expires_at) return invite.expires_at;
  const created = Date.parse(String(invite.created_at ?? ""));
  return Number.isFinite(created) ? newInviteExpiry(created) : null;
}

export function inviteExpired(invite: { expires_at?: string | null; created_at?: string | null }): boolean {
  const expires = Date.parse(String(inviteExpiresAt(invite) ?? ""));
  return !Number.isFinite(expires) || expires <= Date.now();
}
