import { AI_LOG_PREVIEW_CHARS, AI_LOG_RETENTION_DAYS } from "../config.js";
import { all, get, newId, now, parseJson, run } from "../db.js";
import type { AiCallLog, AiCallLogPage, AiCallLogSummary } from "../../shared/types.js";

export interface AiCallLogInput {
  houseId?: string | null;
  userId?: string | null;
  operation: string;
  provider?: string | null;
  model?: string | null;
  status: "ok" | "error";
  httpStatus?: number | null;
  attempts?: number;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number | null;
  imageCount?: number;
  requestBytes?: number;
  responseBytes?: number;
  requestPreview?: string | null;
  responsePreview?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`;
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Persist one logical AI call and mirror a compact version to the server log.
 *
 * Logging must never break the scan that triggered it, so both the database
 * write and the console line are best-effort.
 */
export async function recordAiCall(input: AiCallLogInput): Promise<void> {
  const entry = {
    id: newId("ail"),
    houseId: input.houseId ?? null,
    userId: input.userId ?? null,
    operation: input.operation,
    provider: input.provider ?? null,
    model: input.model ?? null,
    status: input.status,
    httpStatus: input.httpStatus ?? null,
    attempts: input.attempts ?? 1,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    promptTokens: Math.max(0, Math.round(input.promptTokens ?? 0)),
    completionTokens: Math.max(0, Math.round(input.completionTokens ?? 0)),
    totalTokens: Math.max(0, Math.round(input.totalTokens ?? 0)),
    cost: input.cost ?? null,
    imageCount: Math.max(0, Math.round(input.imageCount ?? 0)),
    requestBytes: Math.max(0, Math.round(input.requestBytes ?? 0)),
    responseBytes: Math.max(0, Math.round(input.responseBytes ?? 0)),
    requestPreview: truncate(input.requestPreview, AI_LOG_PREVIEW_CHARS),
    responsePreview: truncate(input.responsePreview, AI_LOG_PREVIEW_CHARS),
    error: truncate(input.error, 2000),
    metadata: input.metadata ?? {},
    createdAt: now(),
  };

  const consoleEntry = {
    type: "ai_call",
    id: entry.id,
    operation: entry.operation,
    status: entry.status,
    model: entry.model,
    provider: entry.provider,
    durationMs: entry.durationMs,
    attempts: entry.attempts,
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
    totalTokens: entry.totalTokens,
    cost: entry.cost,
    images: entry.imageCount,
    houseId: entry.houseId,
    userId: entry.userId,
    error: entry.error,
  };
  const line = `[ai] ${JSON.stringify(consoleEntry)}`;
  if (entry.status === "error") console.error(line);
  else console.log(line);

  try {
    await run(
      `INSERT INTO ai_call_logs
        (id, house_id, user_id, operation, provider, model, status, http_status, attempts, duration_ms,
         prompt_tokens, completion_tokens, total_tokens, cost, image_count, request_bytes, response_bytes,
         request_preview, response_preview, error, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.houseId,
        entry.userId,
        entry.operation,
        entry.provider,
        entry.model,
        entry.status,
        entry.httpStatus,
        entry.attempts,
        entry.durationMs,
        entry.promptTokens,
        entry.completionTokens,
        entry.totalTokens,
        entry.cost,
        entry.imageCount,
        entry.requestBytes,
        entry.responseBytes,
        entry.requestPreview,
        entry.responsePreview,
        entry.error,
        JSON.stringify(entry.metadata),
        entry.createdAt,
      ],
    );
  } catch (err) {
    console.error("[ai] could not persist call log:", err);
  }
}

export function serializeAiCallLog(row: any, detail = false): AiCallLog {
  return {
    id: row.id,
    houseId: row.house_id ?? null,
    userId: row.user_id ?? null,
    userName: row.user_name ?? null,
    operation: row.operation,
    provider: row.provider ?? null,
    model: row.model ?? null,
    status: row.status === "error" ? "error" : "ok",
    httpStatus: row.http_status == null ? null : number(row.http_status),
    attempts: Math.max(1, number(row.attempts)),
    durationMs: number(row.duration_ms),
    promptTokens: number(row.prompt_tokens),
    completionTokens: number(row.completion_tokens),
    totalTokens: number(row.total_tokens),
    cost: row.cost == null ? null : number(row.cost),
    imageCount: number(row.image_count),
    requestBytes: number(row.request_bytes),
    responseBytes: number(row.response_bytes),
    requestPreview: detail
      ? (row.request_preview ?? null)
      : truncate(row.request_preview, 240),
    responsePreview: detail
      ? (row.response_preview ?? null)
      : truncate(row.response_preview, 240),
    error: row.error ?? null,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.created_at,
  };
}

export interface AiLogQuery {
  houseId: string;
  userId?: string | null;
  operation?: string | null;
  status?: "ok" | "error" | null;
  limit: number;
  offset: number;
}

function whereClause(query: AiLogQuery) {
  const where = ["house_id = ?"];
  const params: unknown[] = [query.houseId];
  if (query.userId) {
    where.push("user_id = ?");
    params.push(query.userId);
  }
  if (query.operation) {
    where.push("operation = ?");
    params.push(query.operation);
  }
  if (query.status) {
    where.push("status = ?");
    params.push(query.status);
  }
  return { where: where.join(" AND "), params };
}

export async function listAiCallLogs(query: AiLogQuery): Promise<{ logs: AiCallLog[]; total: number; summary: AiCallLogSummary }> {
  const { where, params } = whereClause(query);
  const rows = await all<any>(
    `SELECT l.*, u.name AS user_name
     FROM ai_call_logs l LEFT JOIN users u ON u.id = l.user_id
     WHERE ${where}
     ORDER BY l.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, query.limit, query.offset],
  );
  const totalRow = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM ai_call_logs WHERE ${where}`, params);
  const summaryRow = await get<any>(
    `SELECT COUNT(*) AS calls,
       COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors,
       COALESCE(SUM(cost), 0) AS cost,
       COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
       COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
       COALESCE(SUM(total_tokens), 0) AS total_tokens
     FROM ai_call_logs WHERE ${where}`,
    params,
  );
  return {
    logs: rows.map((row) => serializeAiCallLog(row)),
    total: number(totalRow?.n),
    summary: {
      calls: number(summaryRow?.calls),
      errors: number(summaryRow?.errors),
      cost: number(summaryRow?.cost),
      promptTokens: number(summaryRow?.prompt_tokens),
      completionTokens: number(summaryRow?.completion_tokens),
      totalTokens: number(summaryRow?.total_tokens),
    },
  };
}

export async function getAiCallLog(houseId: string, logId: string, userId?: string | null): Promise<AiCallLog | null> {
  const params: unknown[] = [logId, houseId];
  let sql = `SELECT l.*, u.name AS user_name
    FROM ai_call_logs l LEFT JOIN users u ON u.id = l.user_id
    WHERE l.id = ? AND l.house_id = ?`;
  if (userId) {
    sql += " AND l.user_id = ?";
    params.push(userId);
  }
  const row = await get<any>(sql, params);
  return row ? serializeAiCallLog(row, true) : null;
}

export async function clearAiCallLogs(houseId: string): Promise<number> {
  const result = await run("DELETE FROM ai_call_logs WHERE house_id = ?", [houseId]);
  return Number(result?.changes ?? 0);
}

/** Delete entries older than the configured retention window. 0 keeps everything. */
export async function pruneAiCallLogs(): Promise<void> {
  if (!AI_LOG_RETENTION_DAYS) return;
  const cutoff = new Date(Date.now() - AI_LOG_RETENTION_DAYS * 864e5).toISOString();
  try {
    await run("DELETE FROM ai_call_logs WHERE created_at < ?", [cutoff]);
  } catch (err) {
    console.error("[ai] could not prune call logs:", err);
  }
}

export type { AiCallLogPage };
