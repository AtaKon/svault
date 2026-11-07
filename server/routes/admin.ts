import { Router } from "express";
import { z } from "zod";
import { all, databaseKind, get, now, run } from "../db.js";
import { requireAuth } from "../auth.js";
import { ApiError, handler, parseBody, requireInstanceAdmin } from "../http.js";
import { configuredRegistrationMode, registrationModeOverride, registrationStatus, REGISTRATION_MODE_KEY, isRegistrationMode } from "../services/registration.js";
import { orphanCandidates, sweepOrphanUploads } from "../services/upload-cleanup.js";
import { aiMonthlyBudget, aiSpendThisMonth, saveAiMonthlyBudget } from "../services/ai-budget.js";

export const adminRoutes = Router();
adminRoutes.use(requireAuth);
adminRoutes.use((req, _res, next) => {
  requireInstanceAdmin(req);
  next();
});

adminRoutes.get(
  "/overview",
  handler(async (_req, res) => {
    const days = 30;
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const users = Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM users"))?.n ?? 0);
    const houses = Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM houses"))?.n ?? 0);
    const sessions = Number(
      (await get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?", [now()]))?.n ?? 0,
    );
    const pendingInvites = Number(
      (await get<{ n: number }>("SELECT COUNT(*) AS n FROM house_invites WHERE accepted_at IS NULL"))?.n ?? 0,
    );
    const ai = await get<any>(
      `SELECT COUNT(*) AS calls,
         COALESCE(SUM(cost), 0) AS cost,
         COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors
       FROM ai_call_logs WHERE created_at >= ?`,
      [since],
    );
    const orphans = await orphanCandidates();
    const registration = await registrationStatus();
    const aiBudget = await aiMonthlyBudget();
    const aiMonthSpend = await aiSpendThisMonth();
    res.json({
      users,
      houses,
      sessions,
      pendingInvites,
      uploads: {
        count: orphans.length,
        bytes: orphans.reduce((sum, file) => sum + file.size, 0),
      },
      ai: {
        calls: Number(ai?.calls ?? 0),
        cost: Math.round(Number(ai?.cost ?? 0) * 10000) / 10000,
        errors: Number(ai?.errors ?? 0),
        days,
        budget: aiBudget,
        monthSpend: Math.round(aiMonthSpend * 10000) / 10000,
      },
      registration: { mode: registration.mode, source: registration.source },
      database: databaseKind(),
    });
  }),
);

adminRoutes.get(
  "/users",
  handler(async (req, res) => {
    const q = String(req.query.q ?? "").trim().toLowerCase();
    const rows = await all<any>(
      `SELECT u.id, u.email, u.username, u.name, u.is_admin, u.developer_mode, u.created_at,
         (SELECT COUNT(*) FROM house_members m WHERE m.user_id = u.id) AS houses,
         (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions,
         (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_session_at
       FROM users u
       ${q ? "WHERE lower(u.email) LIKE ? OR lower(u.name) LIKE ? OR lower(COALESCE(u.username, '')) LIKE ?" : ""}
       ORDER BY u.created_at`,
      q ? [now(), `%${q}%`, `%${q}%`, `%${q}%`] : [now()],
    );
    res.json({
      users: rows.map((row) => ({
        id: row.id,
        email: row.email,
        username: row.username ?? null,
        name: row.name,
        isAdmin: !!row.is_admin,
        developerMode: !!row.developer_mode,
        houses: Number(row.houses ?? 0),
        sessions: Number(row.sessions ?? 0),
        lastSessionAt: row.last_session_at ?? null,
        createdAt: row.created_at,
      })),
    });
  }),
);

adminRoutes.patch(
  "/users/:id",
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        isAdmin: z.boolean().optional(),
        developerMode: z.boolean().optional(),
      }),
      req.body ?? {},
    );
    const target = await get<any>("SELECT id, is_admin FROM users WHERE id = ?", [req.params.id]);
    if (!target) throw new ApiError(404, "User not found");
    if (body.isAdmin === false) {
      if (target.id === req.user!.id) throw new ApiError(400, "You cannot remove your own administrator access");
      const admins = Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1"))?.n ?? 0);
      if (admins <= 1) throw new ApiError(400, "At least one instance administrator is required");
    }
    if (body.isAdmin !== undefined) {
      await run("UPDATE users SET is_admin = ? WHERE id = ?", [body.isAdmin ? 1 : 0, target.id]);
    }
    if (body.developerMode !== undefined) {
      await run("UPDATE users SET developer_mode = ? WHERE id = ?", [body.developerMode ? 1 : 0, target.id]);
    }
    res.json({ ok: true });
  }),
);

adminRoutes.get(
  "/sessions",
  handler(async (_req, res) => {
    const rows = await all<any>(
      `SELECT s.id, s.user_id, s.user_agent, s.created_at, s.expires_at, u.name, u.email
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.expires_at > ? ORDER BY s.created_at DESC LIMIT 200`,
      [now()],
    );
    res.json({
      sessions: rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        userName: row.name,
        userEmail: row.email,
        userAgent: row.user_agent ?? null,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      })),
    });
  }),
);

adminRoutes.delete(
  "/sessions/:id",
  handler(async (req, res) => {
    await run("DELETE FROM sessions WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  }),
);

adminRoutes.get(
  "/registration",
  handler(async (_req, res) => {
    const status = await registrationStatus();
    res.json({
      mode: status.mode,
      source: status.source,
      firstUser: status.firstUser,
      override: await registrationModeOverride(),
      environment: configuredRegistrationMode(),
    });
  }),
);

adminRoutes.patch(
  "/registration",
  handler(async (req, res) => {
    const body = parseBody(z.object({ mode: z.enum(["open", "invite", "closed", "environment"]) }), req.body ?? {});
    if (body.mode === "environment") {
      await run("DELETE FROM instance_settings WHERE key = ?", [REGISTRATION_MODE_KEY]);
    } else {
      if (!isRegistrationMode(body.mode)) throw new ApiError(400, "Unknown registration mode");
      await run(
        `INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [REGISTRATION_MODE_KEY, body.mode, now()],
      );
    }
    const status = await registrationStatus();
    res.json({ mode: status.mode, source: status.source });
  }),
);

adminRoutes.get(
  "/files",
  handler(async (_req, res) => {
    const files = await orphanCandidates();
    res.json({
      count: files.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      files: files
        .sort((a, b) => b.size - a.size)
        .slice(0, 100)
        .map((file) => ({ key: file.key, size: file.size, modifiedAt: file.modifiedAt })),
    });
  }),
);

adminRoutes.post(
  "/files/sweep",
  handler(async (_req, res) => {
    res.json({ removed: await sweepOrphanUploads() });
  }),
);

adminRoutes.get(
  "/ai",
  handler(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 1), 365);
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const byHouse = await all<any>(
      `SELECT COALESCE(h.name, 'Removed house') AS name, COUNT(*) AS calls, COALESCE(SUM(l.cost), 0) AS cost
       FROM ai_call_logs l LEFT JOIN houses h ON h.id = l.house_id
       WHERE l.created_at >= ? GROUP BY l.house_id, h.name ORDER BY cost DESC LIMIT 20`,
      [since],
    );
    const byOperation = await all<any>(
      `SELECT operation, COUNT(*) AS calls, COALESCE(SUM(cost), 0) AS cost
       FROM ai_call_logs WHERE created_at >= ? GROUP BY operation ORDER BY cost DESC LIMIT 20`,
      [since],
    );
    res.json({
      days,
      budget: await aiMonthlyBudget(),
      monthSpend: Math.round((await aiSpendThisMonth()) * 10000) / 10000,
      byHouse: byHouse.map((row) => ({ name: row.name, calls: Number(row.calls), cost: Number(row.cost) })),
      byOperation: byOperation.map((row) => ({ operation: row.operation, calls: Number(row.calls), cost: Number(row.cost) })),
    });
  }),
);

adminRoutes.patch(
  "/ai/budget",
  handler(async (req, res) => {
    const body = parseBody(z.object({ monthlyBudget: z.number().min(0).max(1e6) }), req.body ?? {});
    const budget = await saveAiMonthlyBudget(body.monthlyBudget);
    res.json({ budget, monthSpend: Math.round((await aiSpendThisMonth()) * 10000) / 10000 });
  }),
);
