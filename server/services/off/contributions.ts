import { createHash } from "node:crypto";
import { all, get, newId, now, parseJson, run } from "../../db.js";
import { ApiError } from "../../http.js";
import type {
  OffCandidateKind,
  OffContribution,
  OffContributionKind,
  OffContributionStatus,
  OffProjectId,
} from "../../../shared/types.js";
import { contributionIdentity, instanceServiceBearer, offDryRun, offWritesEnabled, serviceBearer } from "./auth.js";
import { buildContribution, sendContribution, type PreparedContribution } from "./writer.js";
import { OffWriteError } from "./errors.js";

/**
 * Durable contribution queue.
 *
 * One row per action; one worker loop in the server process. A write is only
 * removed from the queue after OFF confirms it. Transient failures retry with
 * backoff; validation and auth failures stop and keep the draft for the user.
 */

export const OFF_CONSENT_VERSION = "2026-11-off-v1";
const MAX_ATTEMPTS = 6;
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000, 900_000];

export interface ContributionRow {
  id: string;
  idempotency_key: string;
  user_id: string;
  house_id: string | null;
  item_id: string | null;
  project: string;
  code: string;
  kind: string;
  payload: string;
  field_keys: string;
  image_field: string | null;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  remote_status: string | null;
  remote_message: string | null;
  remote_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function offConsent(userId: string): Promise<{ acceptedAt: string; version: string } | null> {
  const row = await get<{ accepted_at: string; version: string }>(
    "SELECT accepted_at, version FROM off_consents WHERE user_id = ?",
    [userId],
  );
  return row ? { acceptedAt: row.accepted_at, version: row.version } : null;
}

export async function acceptOffConsent(userId: string) {
  const timestamp = now();
  await run(
    `INSERT INTO off_consents (user_id, accepted_at, version) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET accepted_at = excluded.accepted_at, version = excluded.version`,
    [userId, timestamp, OFF_CONSENT_VERSION],
  );
  return { acceptedAt: timestamp, version: OFF_CONSENT_VERSION };
}

function event(contributionId: string, status: string, detail: string | null = null) {
  return run(
    "INSERT INTO off_contribution_events (id, contribution_id, status, detail, created_at) VALUES (?, ?, ?, ?, ?)",
    [newId("offev"), contributionId, status, detail, now()],
  );
}

function idempotencyKey(
  userId: string,
  houseId: string,
  project: OffProjectId,
  code: string,
  kind: OffContributionKind,
  fields: string[],
  payload: PreparedContribution,
): string {
  return createHash("sha256")
    .update(
      [
        userId,
        houseId,
        project,
        code,
        kind,
        [...fields].sort().join(","),
        JSON.stringify(payload.form),
        payload.imageField ?? "",
      ].join("|"),
    )
    .digest("hex");
}

export function serializeContribution(row: ContributionRow, itemName: string | null = null): OffContribution {
  const status = row.status as OffContributionStatus;
  return {
    id: row.id,
    project: row.project as OffProjectId,
    code: row.code,
    kind: row.kind as OffContributionKind,
    status,
    itemId: row.item_id,
    itemName,
    fields: parseJson<string[]>(row.field_keys, []),
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: row.next_attempt_at,
    lastAttemptAt: row.last_attempt_at,
    remoteStatus: row.remote_status,
    remoteMessage: row.remote_message,
    remoteId: row.remote_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canRetry: status === "failed" || status === "retry",
    canCancel: status === "queued" || status === "retry",
  };
}

export async function listContributions(
  userId: string,
  filters: { status?: string; limit?: number } = {},
): Promise<OffContribution[]> {
  const limit = Math.min(Math.max(Number(filters.limit ?? 50), 1), 200);
  const status = String(filters.status ?? "").trim();
  const rows = status
    ? await all<ContributionRow & { item_name: string | null }>(
        `SELECT c.*, i.name AS item_name FROM off_contributions c
         LEFT JOIN items i ON i.id = c.item_id AND i.house_id = c.house_id
         WHERE c.user_id = ? AND c.status = ? ORDER BY c.created_at DESC LIMIT ?`,
        [userId, status, limit],
      )
    : await all<ContributionRow & { item_name: string | null }>(
        `SELECT c.*, i.name AS item_name FROM off_contributions c
         LEFT JOIN items i ON i.id = c.item_id AND i.house_id = c.house_id
         WHERE c.user_id = ? ORDER BY c.created_at DESC LIMIT ?`,
        [userId, limit],
      );
  return rows.map((row) => serializeContribution(row, row.item_name));
}

export async function getContribution(id: string, userId: string): Promise<OffContribution | null> {
  const row = await get<ContributionRow & { item_name: string | null }>(
    `SELECT c.*, i.name AS item_name FROM off_contributions c
     LEFT JOIN items i ON i.id = c.item_id AND i.house_id = c.house_id
     WHERE c.id = ? AND c.user_id = ?`,
    [id, userId],
  );
  return row ? serializeContribution(row, row.item_name) : null;
}

/** Products this user already queued/sent recently, so the queue does not nag. */
export async function recentContributionKeys(userId: string): Promise<Set<string>> {
  const rows = await all<{ project: string; code: string }>(
    `SELECT project, code FROM off_contributions
     WHERE user_id = ? AND kind <> 'price' AND created_at > ? AND status IN ('queued', 'sending', 'retry', 'sent')`,
    [userId, new Date(Date.now() - 864e5).toISOString()],
  );
  return new Set(rows.map((row) => `${row.project}:${row.code}`));
}

export async function createContribution(opts: {
  userId: string;
  houseId: string;
  itemId?: string;
  receiptLineId?: string;
  locationId?: number;
  kind: OffCandidateKind;
  fields?: string[];
}): Promise<OffContribution> {
  if (!offWritesEnabled() && !offDryRun()) {
    throw new ApiError(403, "Contributions are disabled on this server");
  }
  const dailyLimit = Math.max(1, Number(process.env.SV_OFF_DAILY_LIMIT ?? 50) || 50);
  const today = await get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM off_contributions WHERE user_id = ? AND created_at > ?",
    [opts.userId, new Date(Date.now() - 864e5).toISOString()],
  );
  if (Number(today?.n ?? 0) >= dailyLimit) {
    throw new ApiError(429, `Daily contribution limit reached (${dailyLimit}). Try again tomorrow.`);
  }
  if (!(await offConsent(opts.userId))) {
    throw new ApiError(403, "Accept the Open Food Facts license before contributing");
  }
  // Price contributions are built from a receipt line, so the optional item is
  // otherwise never checked; every kind must name an item of this house.
  if (opts.itemId && !(await get("SELECT id FROM items WHERE id = ? AND house_id = ?", [opts.itemId, opts.houseId]))) {
    throw new ApiError(404, "Item not found");
  }
  const prepared = await buildContribution(opts);
  if (prepared.kind === "price") {
    const token = (await serviceBearer(opts.userId, "prices")) ?? (await instanceServiceBearer("prices"));
    if (!token) throw new ApiError(403, "Connect Open Prices to share a price");
  } else {
    const identityProject = prepared.kind === "report" ? "off" : prepared.project;
    const identity = await contributionIdentity(opts.userId, identityProject);
    if (!identity) {
      throw new ApiError(403, "Connect an Open Food Facts account to contribute");
    }
  }
  const key = idempotencyKey(
    opts.userId,
    opts.houseId,
    prepared.project,
    prepared.code,
    prepared.kind,
    prepared.fields,
    prepared,
  );
  const existing = await get<ContributionRow>("SELECT * FROM off_contributions WHERE idempotency_key = ?", [key]);
  if (existing) {
    const item = existing.item_id
      ? await get<{ name: string }>("SELECT name FROM items WHERE id = ? AND house_id = ?", [existing.item_id, existing.house_id])
      : null;
    return serializeContribution(existing, item?.name ?? null);
  }

  const id = newId("offc");
  const timestamp = now();
  await run(
    `INSERT INTO off_contributions
       (id, idempotency_key, user_id, house_id, item_id, project, code, kind, payload,
        field_keys, image_field, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
    [
      id,
      key,
      opts.userId,
      opts.houseId,
      opts.itemId,
      prepared.project,
      prepared.code,
      prepared.kind,
      JSON.stringify({
        form: prepared.form,
        values: prepared.values,
        imageField: prepared.imageField,
        fields: prepared.fields,
        price: prepared.price ?? null,
        report: prepared.report ?? null,
      }),
      JSON.stringify(prepared.fields),
      prepared.imageField,
      timestamp,
      timestamp,
      timestamp,
    ],
  );
  await event(id, "queued", `${prepared.kind} for ${prepared.project}:${prepared.code}`);
  // Try immediately, but never block the response on the remote service.
  void processContribution(id).catch(() => undefined);
  return (await getContribution(id, opts.userId))!;
}

function payloadFromRow(row: ContributionRow): PreparedContribution {
  const stored = parseJson<any>(row.payload, {});
  return {
    project: row.project as OffProjectId,
    code: row.code,
    kind: row.kind as OffContributionKind,
    fields: parseJson<string[]>(row.field_keys, []),
    form: stored.form ?? {},
    imageField: stored.imageField ?? null,
    values: stored.values ?? {},
    price: stored.price ?? null,
    report: stored.report ?? null,
  };
}

function retryDate(attempts: number): string {
  const delay = RETRY_DELAYS_MS[Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MS.length - 1)];
  return new Date(Date.now() + delay).toISOString();
}

/** Process one queued/retry row. Safe to call from the worker or a test. */
export async function processContribution(id: string): Promise<void> {
  const claimed = await run(
    `UPDATE off_contributions
     SET status = 'sending', attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
     WHERE id = ? AND (status IN ('queued', 'retry') OR (status = 'sending' AND last_attempt_at IS NOT NULL AND last_attempt_at < ?))`,
    [now(), now(), id, new Date(Date.now() - 10 * 60_000).toISOString()],
  );
  if (!claimed.changes) return;
  const row = await get<ContributionRow>("SELECT * FROM off_contributions WHERE id = ?", [id]);
  if (!row) return;
  const attempts = Number(row.attempts ?? 1);
  try {
    let identity = null;
    if (row.kind !== "price") {
      const identityProject = row.kind === "report" ? "off" : (row.project as OffProjectId);
      identity = await contributionIdentity(row.user_id, identityProject);
      if (!identity) {
        throw new OffWriteError("Connect an Open Food Facts account to contribute");
      }
    }
    const effectiveIdentity = identity ?? {
      mode: "credentials" as const,
      username: "",
      password: "",
      appUuid: "",
    };
    const result = await sendContribution(payloadFromRow(row), effectiveIdentity, row.user_id);
    await run(
      `UPDATE off_contributions SET status = 'sent', remote_status = ?, remote_message = ?, remote_id = ?,
         next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
      [result.remoteStatus, result.remoteMessage, result.remoteId, now(), id],
    );
    await event(id, "sent", result.remoteMessage);
  } catch (error) {
    const writeError = error instanceof OffWriteError ? error : new OffWriteError("Contribution failed");
    if (writeError.retryable && attempts < MAX_ATTEMPTS) {
      const next = retryDate(attempts);
      await run(
        `UPDATE off_contributions SET status = 'retry', remote_status = ?, remote_message = ?,
           next_attempt_at = ?, updated_at = ? WHERE id = ?`,
        [writeError.remoteStatus, writeError.message, next, now(), id],
      );
      await event(id, "retry", writeError.message);
    } else {
      await run(
        `UPDATE off_contributions SET status = 'failed', remote_status = ?, remote_message = ?,
           next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
        [writeError.remoteStatus, writeError.message, now(), id],
      );
      await event(id, "failed", writeError.message);
    }
  }
}

export async function retryContribution(id: string, userId: string): Promise<OffContribution | null> {
  if (!offWritesEnabled() && !offDryRun()) {
    throw new ApiError(403, "Contributions are disabled on this server");
  }
  const row = await get<ContributionRow>("SELECT * FROM off_contributions WHERE id = ? AND user_id = ?", [id, userId]);
  if (!row) return null;
  if (!["failed", "retry"].includes(row.status)) return getContribution(id, userId);
  await run(
    "UPDATE off_contributions SET status = 'queued', attempts = 0, next_attempt_at = ?, updated_at = ? WHERE id = ?",
    [now(), now(), id],
  );
  void processContribution(id).catch(() => undefined);
  return getContribution(id, userId);
}

export async function cancelContribution(id: string, userId: string): Promise<OffContribution | null> {
  const row = await get<ContributionRow>("SELECT * FROM off_contributions WHERE id = ? AND user_id = ?", [id, userId]);
  if (!row) return null;
  if (!["queued", "retry"].includes(row.status)) return getContribution(id, userId);
  await run(
    "UPDATE off_contributions SET status = 'cancelled', next_attempt_at = NULL, updated_at = ? WHERE id = ?",
    [now(), id],
  );
  await event(id, "cancelled", null);
  return getContribution(id, userId);
}

/** Worker tick. Returns the number of rows it attempted. */
export async function processDueContributions(limit = 5): Promise<number> {
  if (!offWritesEnabled() && !offDryRun()) return 0;
  const rows = await all<{ id: string }>(
    `SELECT id FROM off_contributions
     WHERE (status IN ('queued', 'retry') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
        OR (status = 'sending' AND last_attempt_at IS NOT NULL AND last_attempt_at < ?)
     ORDER BY created_at LIMIT ?`,
    [now(), new Date(Date.now() - 10 * 60_000).toISOString(), Math.min(Math.max(limit, 1), 25)],
  );
  for (const row of rows) await processContribution(row.id);
  return rows.length;
}

export function startOffContributionWorker(): NodeJS.Timeout {
  const timer = setInterval(() => {
    void processDueContributions().catch((error) => {
      console.warn("Open Food Facts contribution worker:", error instanceof Error ? error.message : error);
    });
  }, 15_000);
  timer.unref?.();
  return timer;
}

export async function offContributionStats() {
  const rows = await all<{ status: string; n: number }>(
    "SELECT status, COUNT(*) AS n FROM off_contributions GROUP BY status",
  );
  return {
    byStatus: Object.fromEntries(rows.map((row) => [row.status, Number(row.n)])),
    writesEnabled: offWritesEnabled(),
    dryRun: offDryRun(),
  };
}
