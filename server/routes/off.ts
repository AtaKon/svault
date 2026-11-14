import { Router } from "express";
import { z } from "zod";
import { memberRole, requireAuth, roleAtLeast, userHouses } from "../auth.js";
import { get } from "../db.js";
import { ApiError, handler, intParam, parseBody, requireInstanceAdmin } from "../http.js";
import { fetchOffProduct, getCachedOffPayload } from "../services/openfoodfacts.js";
import {
  accountSummary,
  contributionIdentity,
  instanceServiceBearer,
  isOffServiceId,
  linkOffAccount,
  linkServiceToken,
  offDryRun,
  offWritesEnabled,
  serviceBearer,
  unlinkOffAccount,
  unlinkServiceToken,
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
  recentContributionKeys,
  retryContribution,
} from "../services/off/contributions.js";
import { contributionCandidates } from "../services/off/eligibility.js";
import { searchPriceLocations } from "../services/off/prices.js";
import { addFolksonomyProperty } from "../services/off/folksonomy.js";
import { answerRobotoff, robotoffProjectSupported, robotoffQuestions } from "../services/off/robotoff.js";
import { REPORT_REASONS } from "../services/off/reports.js";
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
  if (!text) return "all";
  if (text === "all") return "all";
  if (isOffProjectId(text)) return text;
  throw new ApiError(400, "Unknown Open Food Facts project");
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

/**
 * Folksonomy and Robotoff writes are household data leaving the server even
 * though their payload has no house id, so the caller must still be a member+
 * of at least one household. A person who left every house cannot contribute.
 */
async function requireContributingMember(req: any) {
  const houses = await userHouses(req.user!.id);
  if (!houses.some((house) => roleAtLeast(house.role as Role, "member"))) {
    throw new ApiError(403, "Requires member access");
  }
}

/** Scope a house-less OFF write to an item/house named by the request, when present. */
async function requireNamedHouse(req: any, houseId?: string, itemId?: string) {
  if (houseId) {
    await houseAccess(req, houseId, "member");
    if (itemId && !(await get("SELECT id FROM items WHERE id = ? AND house_id = ?", [itemId, houseId]))) {
      throw new ApiError(404, "Item not found");
    }
    return;
  }
  if (itemId) {
    const item = await get<{ house_id: string }>("SELECT house_id FROM items WHERE id = ?", [itemId]);
    if (!item) throw new ApiError(404, "Item not found");
    await houseAccess(req, item.house_id, "member");
  }
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
    if (!body.consent && !(await offConsent(req.user!.id))) {
      throw new ApiError(403, "Accept the Open Food Facts license before connecting an account");
    }
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

offRoutes.post(
  "/services/:service/link",
  handler(async (req, res) => {
    const service = String(req.params.service ?? "");
    if (!isOffServiceId(service)) throw new ApiError(400, "Unknown Open Food Facts service");
    const body = parseBody(
      z.object({
        username: z.string().trim().min(1).max(80),
        password: z.string().min(1).max(200),
        consent: z.boolean().optional(),
      }),
      req.body,
    );
    if (body.consent) await acceptOffConsent(req.user!.id);
    if (!body.consent && !(await offConsent(req.user!.id))) {
      throw new ApiError(403, "Accept the Open Food Facts license before connecting a service");
    }
    const linked = await linkServiceToken({
      userId: req.user!.id,
      service,
      username: body.username,
      password: body.password,
    });
    res.json({ service: linked.service, username: linked.username });
  }),
);

offRoutes.delete(
  "/services/:service",
  handler(async (req, res) => {
    const service = String(req.params.service ?? "");
    if (!isOffServiceId(service)) throw new ApiError(400, "Unknown Open Food Facts service");
    await unlinkServiceToken(req.user!.id, service);
    res.json({ ok: true });
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
    const recent = await recentContributionKeys(req.user!.id);
    const blockedBase = [
      ...(!offWritesEnabled() && !offDryRun() ? ["writes_disabled"] : []),
      ...(!consent ? ["consent"] : []),
    ];
    const identityCache = new Map<string, boolean>();
    let priceIdentity: boolean | null = null;
    const withState = [];
    for (const candidate of candidates) {
      if (candidate.kind !== "price" && recent.has(`${candidate.project}:${candidate.code}`)) continue;
      let hasIdentity: boolean;
      if (candidate.kind === "price") {
        if (priceIdentity === null) {
          priceIdentity = Boolean(
            (await serviceBearer(req.user!.id, "prices")) ?? (await instanceServiceBearer("prices")),
          );
        }
        hasIdentity = priceIdentity;
      } else {
        // Reports use the OFF session even when the product lives elsewhere.
        const project = candidate.kind === "wrong_project" || candidate.kind === "report" ? "off" : candidate.project;
        const cached = identityCache.get(project);
        if (cached === undefined) {
          identityCache.set(project, Boolean(await contributionIdentity(req.user!.id, project)));
        }
        hasIdentity = identityCache.get(project)!;
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
        itemId: z.string().trim().min(1).max(60).optional(),
        receiptLineId: z.string().trim().min(1).max(60).optional(),
        locationId: z.number().int().positive().optional(),
        kind: z.enum(["new_product", "missing_fields", "photo", "price", "report", "wrong_project", "folksonomy"]),
        fields: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
      }),
      req.body,
    );
    if (body.kind === "price" && !body.receiptLineId) throw new ApiError(400, "Missing receiptLineId");
    if (body.kind !== "price" && !body.itemId) throw new ApiError(400, "Missing itemId");
    await houseAccess(req, body.houseId, "member");
    const contribution = await createContribution({
      userId: req.user!.id,
      houseId: body.houseId,
      itemId: body.itemId,
      receiptLineId: body.receiptLineId,
      locationId: body.locationId,
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

offRoutes.get(
  "/report-reasons",
  handler(async (_req, res) => {
    res.json({ reasons: REPORT_REASONS });
  }),
);

offRoutes.get(
  "/prices/locations",
  handler(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    res.json({ locations: await searchPriceLocations(q) });
  }),
);

offRoutes.get(
  "/robotoff/questions",
  handler(async (req, res) => {
    const project = projectParam(req.query.project);
    if (project === "all") throw new ApiError(400, "Choose a project for Robotoff");
    if (!robotoffProjectSupported(project)) {
      res.json({ questions: [], supported: false });
      return;
    }
    const count = intParam(req.query.count, 1, 10);
    const lang = String(req.query.lang ?? "en").slice(0, 5);
    res.json({ questions: await robotoffQuestions(project, count, lang), supported: true });
  }),
);

offRoutes.post(
  "/robotoff/answers",
  handler(async (req, res) => {
    if (!offWritesEnabled()) throw new ApiError(403, "Contributions are disabled on this server");
    const body = parseBody(
      z.object({
        insightId: z.string().trim().min(1).max(80),
        annotation: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
      }),
      req.body,
    );
    if (offDryRun()) {
      res.json({ ok: true, dryRun: true });
      return;
    }
    res.json({ ok: await answerRobotoff(body.insightId, body.annotation) });
  }),
);

offRoutes.post(
  "/folksonomy",
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        project: z.enum(["off", "obf", "opff", "opf"]),
        code: z.string().trim().min(1).max(80),
        key: z.string().trim().min(1).max(120),
        value: z.string().trim().min(1).max(1000),
        houseId: z.string().trim().min(1).max(60).optional(),
        itemId: z.string().trim().min(1).max(60).optional(),
      }),
      req.body,
    );
    if (!(await offConsent(req.user!.id))) {
      throw new ApiError(403, "Accept the Open Food Facts license before contributing");
    }
    await requireContributingMember(req);
    await requireNamedHouse(req, body.houseId, body.itemId);
    if (!offWritesEnabled() && !offDryRun()) {
      throw new ApiError(403, "Contributions are disabled on this server");
    }
    if (offDryRun()) {
      res.json({ key: body.key, value: body.value, dryRun: true });
      return;
    }
    try {
      res.json(await addFolksonomyProperty({ userId: req.user!.id, ...body }));
    } catch (error) {
      throw new ApiError(502, error instanceof Error ? error.message : "Folksonomy write failed");
    }
  }),
);
