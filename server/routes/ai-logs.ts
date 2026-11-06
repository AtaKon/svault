import { Router } from "express";
import { requireAuth, roleAtLeast } from "../auth.js";
import { ApiError, handler, intParam, requireHouse } from "../http.js";
import {
  clearAiCallLogs,
  getAiCallLog,
  listAiCallLogs,
  type AiLogQuery,
} from "../services/ai-logs.js";

export const aiLogRoutes = Router();
aiLogRoutes.use(requireAuth);

function requireDeveloper(req: any) {
  if (!req.user?.developerMode) {
    throw new ApiError(403, "Enable developer mode in your profile to view AI call logs");
  }
}

function statusParam(value: unknown): "ok" | "error" | null {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "ok" || text === "error" ? text : null;
}

aiLogRoutes.get(
  "/:houseId/ai/logs",
  handler(async (req, res) => {
    const { houseId, role } = await requireHouse(req);
    requireDeveloper(req);

    const wantsAll = String(req.query.scope ?? "mine").toLowerCase() === "all";
    if (wantsAll && !roleAtLeast(role, "admin")) {
      throw new ApiError(403, "Only house admins can see every member's AI calls");
    }

    const query: AiLogQuery = {
      houseId,
      userId: wantsAll ? null : req.user!.id,
      operation: String(req.query.operation ?? "").trim().slice(0, 80) || null,
      status: statusParam(req.query.status),
      limit: intParam(req.query.limit, 50, 200),
      offset: Math.min(1_000_000, Math.max(0, Math.floor(Number(req.query.offset ?? 0) || 0))),
    };
    const page = await listAiCallLogs(query);
    res.json({ scope: wantsAll ? "all" : "mine", ...page });
  }),
);

aiLogRoutes.get(
  "/:houseId/ai/logs/:logId",
  handler(async (req, res) => {
    const { houseId, role } = await requireHouse(req);
    requireDeveloper(req);
    const ownOnly = roleAtLeast(role, "admin") ? null : req.user!.id;
    const log = await getAiCallLog(houseId, String(req.params.logId), ownOnly);
    if (!log) throw new ApiError(404, "AI call not found");
    res.json(log);
  }),
);

aiLogRoutes.delete(
  "/:houseId/ai/logs",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "admin");
    requireDeveloper(req);
    const deleted = await clearAiCallLogs(houseId);
    res.json({ ok: true, deleted });
  }),
);
