import { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { all, get, newId, now, run } from "../db.js";
import { API_TOKEN_PREFIX, hashToken, requireAuth } from "../auth.js";
import { ApiError, handler, parseBody } from "../http.js";

export const apiTokenRoutes = Router();
apiTokenRoutes.use(requireAuth);

function serializeToken(row: any) {
  return {
    id: row.id,
    name: row.name,
    lastUsedAt: row.last_used_at ?? null,
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at,
  };
}

apiTokenRoutes.get(
  "/",
  handler(async (req, res) => {
    const rows = await all<any>(
      "SELECT id, name, last_used_at, expires_at, created_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC",
      [req.user!.id],
    );
    res.json({ tokens: rows.map(serializeToken) });
  }),
);

apiTokenRoutes.post(
  "/",
  handler(async (req, res) => {
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(80) }), req.body ?? {});
    const count = Number(
      (await get<{ n: number }>("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?", [req.user!.id]))?.n ?? 0,
    );
    if (count >= 20) throw new ApiError(400, "You already have 20 API tokens. Revoke one before creating another.");
    const token = `${API_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
    const id = newId("tok");
    await run(
      "INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      [id, req.user!.id, body.name, hashToken(token), now()],
    );
    const row = await get<any>("SELECT * FROM api_tokens WHERE id = ?", [id]);
    res.status(201).json({ ...serializeToken(row), token });
  }),
);

apiTokenRoutes.delete(
  "/:id",
  handler(async (req, res) => {
    const deleted = await run("DELETE FROM api_tokens WHERE id = ? AND user_id = ?", [req.params.id, req.user!.id]);
    if (!deleted.changes) throw new ApiError(404, "Token not found");
    res.json({ ok: true });
  }),
);
