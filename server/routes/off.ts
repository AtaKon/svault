import { Router } from "express";
import { z } from "zod";
import { memberRole, requireAuth, roleAtLeast } from "../auth.js";
import { ApiError, handler, intParam, parseBody, requireInstanceAdmin } from "../http.js";
import { fetchOffProduct, getCachedOffPayload } from "../services/openfoodfacts.js";
import {
  accountSummary,
  contributionIdentity,
  linkOffAccount,
  offDryRun,
  offWritesEnabled,
  unlinkOffAccount,
  verifyOffAccount,
} from "../services/off/auth.js";
import {
  acceptOffConsent,
  cancelContribution,
  createContribution,
  getContribution,
  listContributions,
  offConsent,
  offContributionStats,
  OFF_CONSENT_VERSION,
  retryContribution,
} from "../services/off/contributions.js";
import { contributionCandidates } from "../services/off/eligibility.js";
import { isOffProjectId, offProjectList } from "../services/off/projects.js";
import type { OffProjectId, Role } from "../../shared/types.js";

/**
 * Multi-project Open Food Facts reads and contributions.
 *
 * `/api/catalog/*` stays for existing clients. These routes are the forward
 * surface: project registry, universal lookup, account links, eligibility and
 * the durable contribution queue.
 */

export const offRoutes = Router();
offRoutes.use(requireAuth);

function projectParam(value: unknown): OffProjectId | "all" {
  const text = String(value ?? "").trim();
  if (text === "all") return "all";
  return isOffProjectId(text) ? text : "all";
}

function projectId(value: unknown): OffProjectId {
  if (!isOffProjectId(value)) throw new ApiError(400, "Unknown Open Food Facts project");
  return value;
}

async function houseAccess(req: any, houseId: string, min: Role = "member") {
  const role = await memberRole(req.user!.id, houseId);
  if (!role) throw new ApiError(404, "House not found");
  if (!roleAtLeast(role, min)) throw new ApiError(403, `Requires ${min} access`);
  return role;
}

offRoutes.get(
  "/projects",
  handler(async (_req, res) => {
    res.json({ projects: offProjectList() });
  }),
);

offRoutes.get(
  "/lookup/:code",
  handler(async (req, res) => {
    const code = String(req.params.code ?? "").trim();
    if (!code) throw new ApiError(400, "Missing barcode");
    const project = projectParam(req.query.project);
    const product = await fetchOffProduct(code, { project });
    if (!product) throw new ApiError(404, "Product not found on OpenFoodFacts");
    res.json({ product, project: product.project });
  }),
);

offRoutes.get(
  "/product/:project/:code",
  handler(async (req, res) => {
    const project = projectParam(req.params.project);
    if (project === "all") throw new ApiError(400, "Choose a project for a full product read");
    const code = String(req.params.code ?? "").trim();
    if (!code) throw new ApiError(400, "Missing barcode");
    const product = await fetchOffProduct(code, { project });
    if (!product) throw new ApiError(404, "Product not found on OpenFoodFacts");
    const full = String(req.query.full ?? "") === "1";
    res.json(full ? { ...product, payload: await getCachedOffPayload(product.code, product.project) } : product);
  }),
);

/* --------------------------------------------------------------- accounts */

offRoutes.get(
  "/accounts",
  handler(async (req, res) => {
    const summary = await accountSummary(req.user!.id);
    const consent = await offConsent(req.user!.id);
    res.json({
      ...summary,
      consentAt: consent?.acceptedAt ?? null,
      consentVersion: consent?.version ?? null,
      consentRequired: !consent,
    });
  }),
);

offRoutes.post(
  "/accounts/:project/link",
  handler(async (req, res) => {
    const project = projectId(req.params.project);
    const body = parseBody(
      z.object({
        username: z.string().trim().min(1).max(80),
        password: z.string().min(1).max(200),
        consent: z.boolean().optional(),
      }),
      req.body,
    );
    if (body.consent) await acceptOffConsent(req.user!.id);
    const account = await linkOffAccount({
      userId: req.user!.id,
      project,
      username: body.username,
      password: body.password,
    });
    res.json({ account });
  }),
);

offRoutes.post(
  "/accounts/:project/verify",
  handler(async (req, res) => {
    const project = projectId(req.params.project);
    res.json({ account: await verifyOffAccount(req.user!.id, project) });
  }),
);

offRoutes.delete(
  "/accounts/:project",
  handler(async (req, res) => {
    const project = projectId(req.params.project);
    await unlinkOffAccount(req.user!.id, project);
    res.json({ ok: true });
  }),
);

offRoutes.get(
  "/consent",
  handler(async (req, res) => {
    res.json({ consent: await offConsent(req.user!.id), version: OFF_CONSENT_VERSION });
  }),
);

offRoutes.post(
  "/consent",
  handler(async (req, res) => {
    const body = parseBody(z.object({ accept: z.literal(true) }), req.body);
    res.json({ consent: await acceptOffConsent(req.user!.id), accepted: body.accept });
  }),
);

/* ---------------------------------------------------------- contributions */

offRoutes.get(
  "/contributions/candidates",
  handler(async (req, res) => {
    const houseId = String(req.query.houseId ?? "").trim();
    if (!houseId) throw new ApiError(400, "Missing houseId");
    await houseAccess(req, houseId, "member");
    const limit = intParam(req.query.limit, 20, 50);
    const candidates = await contributionCandidates(houseId, limit);
    const consent = await offConsent(req.user!.id);
    const blockedBase = [
      ...(!offWritesEnabled() && !offDryRun() ? ["writes_disabled"] : []),
      ...(!consent ? ["consent"] : []),
    ];
    const identityCache = new Map<OffProjectId, boolean>();
    const withState = [];
    for (const candidate of candidates) {
      let hasIdentity = identityCache.get(candidate.project);
      if (hasIdentity === undefined) {
        hasIdentity = Boolean(await contributionIdentity(req.user!.id, candidate.project));
        identityCache.set(candidate.project, hasIdentity);
      }
      const blocked = [...blockedBase, ...(!hasIdentity ? ["account"] : [])];
      withState.push({ ...candidate, blocked, ready: blocked.length === 0 });
    }
    res.json({ candidates: withState, writesEnabled: offWritesEnabled(), dryRun: offDryRun(), consentRequired: !consent });
  }),
);

offRoutes.get(
  "/contributions",
  handler(async (req, res) => {
    res.json({
      contributions: await listContributions(req.user!.id, {
        status: typeof req.query.status === "string" ? req.query.status : undefined,
        limit: intParam(req.query.limit, 50, 200),
      }),
    });
  }),
);

offRoutes.post(
  "/contributions",
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        houseId: z.string().trim().min(1).max(60),
        itemId: z.string().trim().min(1).max(60),
        kind: z.enum(["new_product", "missing_fields", "photo"]),
        fields: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
      }),
      req.body,
    );
    await houseAccess(req, body.houseId, "member");
    const contribution = await createContribution({
      userId: req.user!.id,
      houseId: body.houseId,
      itemId: body.itemId,
      kind: body.kind,
      fields: body.fields,
    });
    res.status(202).json({ contribution });
  }),
);

offRoutes.get(
  "/contributions/:id",
  handler(async (req, res) => {
    const contribution = await getContribution(String(req.params.id), req.user!.id);
    if (!contribution) throw new ApiError(404, "Contribution not found");
    res.json({ contribution });
  }),
);

offRoutes.post(
  "/contributions/:id/retry",
  handler(async (req, res) => {
    const contribution = await retryContribution(String(req.params.id), req.user!.id);
    if (!contribution) throw new ApiError(404, "Contribution not found");
    res.json({ contribution });
  }),
);

offRoutes.delete(
  "/contributions/:id",
  handler(async (req, res) => {
    const contribution = await cancelContribution(String(req.params.id), req.user!.id);
    if (!contribution) throw new ApiError(404, "Contribution not found");
    res.json({ contribution });
  }),
);

offRoutes.get(
  "/stats",
  handler(async (req, res) => {
    requireInstanceAdmin(req);
    res.json(await offContributionStats());
  }),
);
