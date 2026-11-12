import { Router } from "express";
import { z } from "zod";
import { all, get, newId, now, parseJson, run, tx } from "../db.js";
import { memberRole, requireAuth, roleAtLeast } from "../auth.js";
import { ApiError, handler, parseBody, requireHouse } from "../http.js";
import { recipeMatch, serializeRecipe, stockQuantity } from "../serialize.js";
import { aiCleanRecipe, aiCompleteRecipe, aiReadRecipes, fileToDataUrl, resolveAi } from "../ai.js";
import { normaliseNutrition, recipeNutrition, type NutritionSourceItem } from "../services/nutrition.js";
import { heuristicRecipes, normaliseRecipeDraft, type ParsedRecipe } from "../services/recipe-local.js";
import { RecipeImportError, importRecipeFromUrl, normaliseRecipeUrl } from "../services/recipe-import.js";
import { OutboundBlockedError, assertOutboundUrl } from "../lib/outbound.js";
import { recipePortion } from "../../shared/recipe-grams.js";
import { removeUnreferencedUploads } from "../services/upload-cleanup.js";
import { uploader, uploadPath } from "../upload.js";
import type { OffProduct, Role, Recipe } from "../../shared/types.js";
import { readableWordRatio } from "../../shared/notebook-scan.js";

export const recipeRoutes = Router();
export const singleRecipeRoutes = Router();

recipeRoutes.use(requireAuth);
singleRecipeRoutes.use(requireAuth);

const stepSchema = z.union([
  z.string().max(4000),
  z.object({ text: z.string().max(4000), timerSeconds: z.number().min(0).max(86400).nullish() }),
]);

const ingredientSchema = z.object({
  name: z.string().trim().min(1).max(120),
  quantity: z.number().min(0).max(1e6).nullish(),
  unit: z.string().trim().max(20).nullish(),
  itemId: z.string().max(60).nullish(),
  optional: z.boolean().optional(),
  note: z.string().max(200).nullish(),
});

export const recipeInput = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).nullish(),
  servings: z.number().int().min(0).max(1000).nullish(),
  prepMinutes: z.number().int().min(0).max(10000).nullish(),
  cookMinutes: z.number().int().min(0).max(10000).nullish(),
  steps: z.array(stepSchema).max(150).optional(),
  tags: z.union([z.array(z.string().max(30)), z.string()]).optional(),
  image: z.string().max(2000).nullish(),
  sourceImage: z.string().max(2000).nullish(),
  ocrText: z.string().max(30000).nullish(),
  sourceUrl: z.string().trim().max(2000).regex(/^https?:\/\//i).nullish(),
  source: z.enum(["manual", "scan", "ai", "import"]).optional(),
  aiNotes: z.string().max(4000).nullish(),
  aiCost: z.number().min(0).max(1e9).nullish(),
  favorite: z.boolean().optional(),
  ingredients: z.array(ingredientSchema).max(150).optional(),
});

async function stockMaps(houseId: string) {
  const rows = await all<any>(
    `SELECT i.id, i.name, COALESCE((SELECT SUM(l.quantity) FROM stock_lots l WHERE l.item_id = i.id), 0) AS quantity
     FROM items i WHERE i.house_id = ? AND i.archived = 0`,
    [houseId],
  );
  const byName = new Map<string, number>();
  const byId = new Map<string, number>();
  for (const row of rows) {
    byId.set(row.id, Number(row.quantity));
    byName.set(String(row.name).toLowerCase().trim(), Number(row.quantity));
  }
  return { byName, byId };
}

async function nutritionItems(houseId: string): Promise<NutritionSourceItem[]> {
  return (await all<any>(
    `SELECT i.id, i.name, i.unit, i.nutrition, cp.summary AS off_summary
     FROM items i LEFT JOIN catalog_products cp ON cp.code = i.off_code AND cp.project = i.off_project
     WHERE i.house_id = ? AND i.archived = 0`,
    [houseId],
  )).map((row) => ({
    id: row.id,
    name: row.name,
    unit: row.unit,
    nutrition:
      normaliseNutrition(parseJson(row.nutrition, null)) ??
      normaliseNutrition(parseJson<OffProduct | null>(row.off_summary, null)?.nutrition),
  }));
}

function decorateRecipe(
  recipe: Recipe,
  maps: { byName: Map<string, number>; byId: Map<string, number> },
  items: NutritionSourceItem[],
): Recipe {
  const stock = new Map<string, number>();
  for (const [name, quantity] of maps.byName) stock.set(name, quantity);
  for (const ingredient of recipe.ingredients) {
    if (ingredient.itemId && maps.byId.has(ingredient.itemId)) {
      stock.set(ingredient.name.toLowerCase().trim(), maps.byId.get(ingredient.itemId) ?? 0);
    }
  }
  const ingredients = recipe.ingredients.map((ingredient) => ({
    ...ingredient,
    available: stockQuantity(stock, ingredient.name) > 0,
  }));
  return {
    ...recipe,
    ingredients,
    portion: recipePortion(ingredients, recipe.servings),
    match: recipeMatch(
      ingredients.map((ingredient) => ({
        name: ingredient.name,
        quantity: ingredient.quantity,
        unit: ingredient.unit,
        optional: ingredient.optional,
      })),
      stock,
    ),
    nutrition: recipeNutrition(ingredients, items, recipe.servings),
  };
}

async function ingredientsFor(recipeId: string) {
  return await all<any>("SELECT * FROM recipe_ingredients WHERE recipe_id = ? ORDER BY sort, id", [recipeId]);
}

async function recipeRow(recipeId: string) {
  return await get<any>("SELECT * FROM recipes WHERE id = ?", [recipeId]);
}

async function recipeAccess(req: any, minRole: Role = "viewer") {
  const recipe = await recipeRow(req.params.recipeId);
  if (!recipe) throw new ApiError(404, "Recipe not found");
  const role = await memberRole(req.user!.id, recipe.house_id);
  if (!role) throw new ApiError(404, "Recipe not found");
  if (!roleAtLeast(role, minRole)) throw new ApiError(403, `Requires ${minRole} access`);
  return { recipe, houseId: recipe.house_id as string, role };
}

function normaliseIngredientList(ings: z.infer<typeof ingredientSchema>[] | ParsedRecipe["ingredients"]): z.infer<typeof ingredientSchema>[] {
  return ings
    .filter((i) => i.name && i.name.trim())
    .map((i) => ({
      name: i.name.trim(),
      quantity: i.quantity ?? null,
      unit: i.unit ? i.unit.trim().toLowerCase() : null,
      itemId: (i as any).itemId ?? null,
      optional: Boolean(i.optional),
      note: i.note ?? null,
    }));
}

/**
 * Normalise and vet a stored source link. Invalid or disallowed targets are a
 * client error rather than a silent drop, so the user knows the link was not kept.
 */
async function validateSourceUrl(raw: string | null): Promise<string | null> {
  if (!raw) return null;
  let normalised: string;
  try {
    normalised = normaliseRecipeUrl(raw);
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : "That does not look like a valid link");
  }
  try {
    await assertOutboundUrl(normalised, "The recipe link");
  } catch (error) {
    if (error instanceof OutboundBlockedError) throw new ApiError(400, error.message);
    throw error;
  }
  return normalised;
}

export async function saveRecipe(houseId: string, userId: string, body: z.infer<typeof recipeInput>, existingId?: string): Promise<string> {
  // A stored source link is rendered for every member, so only keep links the
  // server itself would be willing to open (same policy as the importer).
  const sourceUrl = await validateSourceUrl(body.sourceUrl ?? null);
  const steps = (body.steps ?? []).map((s) =>
    typeof s === "string" ? { text: s, timerSeconds: null } : { text: s.text, timerSeconds: s.timerSeconds ?? null },
  );
  const tags = Array.isArray(body.tags)
    ? body.tags
    : (body.tags ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
  // Editing a recipe must not erase what its AI scan already cost. Callers that
  // do not send aiCost keep the stored value.
  const currentAiCost = existingId
    ? ((await get<{ ai_cost: number | null }>("SELECT ai_cost FROM recipes WHERE id = ?", [existingId]))?.ai_cost ?? null)
    : null;
  const aiCost = body.aiCost === undefined ? currentAiCost : (body.aiCost ?? null);
  return await tx(async () => {
    const id = existingId ?? newId("rcp");
    if (existingId) {
      await run(
        `UPDATE recipes SET title = ?, description = ?, servings = ?, prep_minutes = ?, cook_minutes = ?, steps = ?,
           tags = ?, image = ?, source_image = ?, ocr_text = ?, source_url = ?, source = ?, ai_notes = ?, ai_cost = ?, favorite = ?, updated_at = ?
         WHERE id = ?`,
        [
          body.title,
          body.description ?? null,
          body.servings ?? null,
          body.prepMinutes ?? null,
          body.cookMinutes ?? null,
          JSON.stringify(steps),
          JSON.stringify(tags),
          body.image ?? null,
          body.sourceImage ?? null,
          body.ocrText ?? null,
          sourceUrl,
          body.source ?? "manual",
          body.aiNotes ?? null,
          aiCost,
          body.favorite ? 1 : 0,
          now(),
          id,
        ],
      );
      await run("DELETE FROM recipe_ingredients WHERE recipe_id = ?", [id]);
    } else {
      await run(
        `INSERT INTO recipes (id, house_id, title, description, servings, prep_minutes, cook_minutes, steps, tags,
           image, source_image, ocr_text, source_url, source, ai_notes, ai_cost, favorite, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          houseId,
          body.title,
          body.description ?? null,
          body.servings ?? null,
          body.prepMinutes ?? null,
          body.cookMinutes ?? null,
          JSON.stringify(steps),
          JSON.stringify(tags),
          body.image ?? null,
          body.sourceImage ?? null,
          body.ocrText ?? null,
          sourceUrl,
          body.source ?? "manual",
          body.aiNotes ?? null,
          aiCost,
          body.favorite ? 1 : 0,
          userId,
          now(),
          now(),
        ],
      );
    }
    for (const [index, ing] of normaliseIngredientList(body.ingredients ?? []).entries()) {
      await run(
        `INSERT INTO recipe_ingredients (id, recipe_id, name, quantity, unit, item_id, optional, note, sort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId("rin"),
          id,
          ing.name,
          ing.quantity ?? null,
          ing.unit ?? null,
          ing.itemId ?? null,
          ing.optional ? 1 : 0,
          ing.note ?? null,
          index,
        ],
      );
    }
    return id;
  });
}

function draftToInput(draft: ParsedRecipe, meta: { source?: "manual" | "scan" | "ai" | "import"; sourceImage?: string | null; ocrText?: string | null; sourceUrl?: string | null; image?: string | null; aiCost?: number | null }): z.infer<typeof recipeInput> {
  return {
    title: draft.title,
    description: draft.description,
    servings: draft.servings,
    prepMinutes: draft.prepMinutes,
    cookMinutes: draft.cookMinutes,
    steps: draft.steps,
    tags: draft.tags,
    image: meta.image ?? null,
    sourceImage: meta.sourceImage ?? null,
    ocrText: meta.ocrText ?? null,
    sourceUrl: meta.sourceUrl ?? null,
    source: meta.source ?? "scan",
    aiNotes: draft.notes,
    aiCost: meta.aiCost ?? null,
    ingredients: draft.ingredients,
  };
}

async function localImageToDataUrl(image: string): Promise<string | null> {
  if (!image.startsWith("/uploads/recipes/")) return Promise.resolve(null);
  const filename = image.split("/").pop()!;
  return await fileToDataUrl(uploadPath("recipes", filename), "image/jpeg");
}

/* ------------------------------------------------------------- house routes */

recipeRoutes.get(
  "/:houseId/recipes",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    const q = String(req.query.q ?? "").trim();
    const tag = req.query.tag ? String(req.query.tag) : null;
    const favorite = req.query.favorite === "1";
    const where = ["r.house_id = ?"];
    const params: unknown[] = [houseId];
    if (q) {
      where.push("(lower(r.title) LIKE lower(?) OR lower(r.description) LIKE lower(?) OR EXISTS (SELECT 1 FROM recipe_ingredients ri WHERE ri.recipe_id = r.id AND lower(ri.name) LIKE lower(?)))");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (tag) {
      where.push("lower(r.tags) LIKE lower(?)");
      params.push(`%${tag}%`);
    }
    if (favorite) where.push("r.favorite = 1");
    const rows = await all<any>(`SELECT * FROM recipes r WHERE ${where.join(" AND ")} ORDER BY r.favorite DESC, r.updated_at DESC`, params);
    const maps = await stockMaps(houseId);
    const items = await nutritionItems(houseId);
    const recipes = await Promise.all(rows.map(async (row) => {
      const ingredients = await ingredientsFor(row.id);
      const serialized = serializeRecipe(row, ingredients);
      return decorateRecipe(serialized, maps, items);
    }));
    res.json(recipes);
  }),
);

recipeRoutes.post(
  "/:houseId/recipes",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(recipeInput, req.body);
    const id = await saveRecipe(houseId, req.user!.id, body);
    const row = (await recipeRow(id))!;
    const serialized = serializeRecipe(row, await ingredientsFor(id));
    res.status(201).json(decorateRecipe(serialized, await stockMaps(houseId), await nutritionItems(houseId)));
  }),
);

recipeRoutes.post(
  "/:houseId/recipes/upload",
  uploader("recipes").single("image"),
  handler(async (req, res) => {
    await requireHouse(req, "member");
    if (!req.file) throw new ApiError(400, "No image uploaded");
    res.status(201).json({ path: `/uploads/recipes/${req.file.filename}` });
  }),
);

/** One scan accepts at most this many photos; the schema and loader share it. */
const MAX_RECIPE_SCAN_IMAGES = 6;

async function loadRecipeImages(
  paths: string[],
): Promise<{ images: string[]; skipped: number; usedPaths: string[] }> {
  const images: string[] = [];
  // Keep the paths that actually produced a data URL so the saved link names a
  // photo the model really saw, not one that was skipped for being too large.
  const usedPaths: string[] = [];
  let skipped = 0;
  for (const image of paths.slice(0, MAX_RECIPE_SCAN_IMAGES)) {
    const dataUrl = await localImageToDataUrl(image);
    if (dataUrl) {
      images.push(dataUrl);
      usedPaths.push(image);
    } else {
      skipped++;
    }
  }
  return { images, skipped, usedPaths };
}

/** The provider status the AI layer embedded in a chain failure message, if any. */
function providerStatusOf(message: string): number | null {
  const match = /AI provider error \((\d{3})\)/.exec(message);
  return match ? Number(match[1]) : null;
}

/**
 * Words a provider uses when it cannot read image input at all. A plain
 * "image …" mention is not enough: "image too large" or "invalid image URL"
 * describes the photo, and removing the photo fixes it, so retrying text-only
 * would throw away a vision read the user paid for. Only an explicit statement
 * that the model does not support image input earns the photo-less retry.
 */
const IMAGE_INPUT_UNSUPPORTED =
  /(?:does\s+not|doesn['’]t|doesnt|did\s+not|cannot|can['’]t)\s+(?:support|accept|handle|process|read|see)\s+(?:image|images|image[\s_-]*input|image_url|vision|multimodal|visual)|(?:image|images|image[\s_-]*input|image_url|vision|multimodal|visual)[^.]{0,80}\b(?:is|are)?\s*(?:not\s+supported|not\s+available|not\s+enabled|unsupported)\b|(?:image|images|image_url|vision|multimodal)[^.]{0,80}\bonly\s+supported\s+by\s+certain\s+models\b/i;

/**
 * A provider that cannot accept image parts says so in a client-error body.
 * Match only explicit model-support wording and only a 4xx: an unrelated
 * "unsupported parameter: reasoning", a content-type error, a rate limit, an
 * auth failure or a 5xx must not trigger a second, photo-less call that
 * re-bills the request.
 */
function isImageInputError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!IMAGE_INPUT_UNSUPPORTED.test(message)) return false;
  if (
    /rate.?limit|too many requests|quota|unauthor|forbidden|api.?key|reasoning|unsupported\s+(?:parameter|value|option|model|field)/i.test(
      message,
    )
  ) {
    return false;
  }
  const status = providerStatusOf(message);
  if (status == null) return false;
  return status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429;
}

/** Notes an AI helper attached to an error, e.g. why a retry happened. */
function notesFrom(error: unknown): string[] {
  const notes = (error as { details?: { notes?: unknown } } | null)?.details?.notes;
  return Array.isArray(notes) ? notes.filter((note): note is string => typeof note === "string") : [];
}

/** Models the failed chain actually tried, reported with the error. */
function attemptedModelsFrom(error: unknown): string[] {
  const models = (error as { details?: { models?: unknown } } | null)?.details?.models;
  return Array.isArray(models) ? models.filter((model): model is string => typeof model === "string") : [];
}

/** The model whose error ended the chain, reported with the error. */
function failedModelFrom(error: unknown): string | null {
  const model = (error as { details?: { model?: unknown } } | null)?.details?.model;
  return typeof model === "string" && model ? model : null;
}

/** Add the models a failed call tried, keeping the ones an earlier call used. */
function addAttemptedModels(current: string[], error: unknown): string[] {
  const models = attemptedModelsFrom(error);
  return models.length ? [...new Set([...current, ...models])] : current;
}

function roundMicro(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

recipeRoutes.post(
  "/:houseId/recipes/scan",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(
      z.object({
        text: z.string().max(30000).optional(),
        image: z.string().max(300).optional(),
        images: z.array(z.string().max(300)).max(MAX_RECIPE_SCAN_IMAGES).optional(),
        title: z.string().max(120).optional(),
        save: z.boolean().optional(),
        /** Ask for an AI read even when local parsing already produced text. */
        preferAi: z.boolean().optional(),
      }),
      req.body,
    );
    const rawText = (body.text ?? "").trim();
    const visionPaths = body.images?.length ? body.images : body.image ? [body.image] : [];
    if (!rawText && !visionPaths.length) throw new ApiError(400, "Provide recipe text or a scan image");

    const house = (await get<any>("SELECT * FROM houses WHERE id = ?", [houseId]))!;
    const settings = parseJson<Record<string, any>>(house.settings, {});
    const cfg = resolveAi(settings);
    // Do not gate the photo on a separately configured vision model. `resolveAi`
    // already falls back to the main model, and most models people configure
    // accept images; a text-only model is detected by retrying without them.
    const canUseAi = cfg.enabled && Boolean(rawText || visionPaths.length);
    const vision = visionPaths.length ? await loadRecipeImages(visionPaths) : { images: [], skipped: 0, usedPaths: [] };
    const fallbackTitle = body.title || "Scanned recipe";
    const warnings: string[] = [];

    let drafts = heuristicRecipes(rawText, fallbackTitle);
    let provider: "ai" | "local" = "local";
    let aiCost: number | null = null;
    let aiModel: string | null = null;
    let aiModels: string[] = [];
    let aiTruncated = false;
    if (cfg.recipeVisionWarning) warnings.push(cfg.recipeVisionWarning);

    const readWithAi = async (
      images: string[],
      reason: string,
      models?: typeof cfg.recipeVisionCandidates,
    ) => {
      const result = await aiReadRecipes(cfg, rawText, images, {
        operation: "recipe.scan",
        houseId,
        userId: req.user!.id,
        metadata: {
          hasImage: images.length > 0,
          imageCount: images.length,
          skippedImages: vision.skipped,
          ocrChars: rawText.length,
          reason,
          localRecipeCount: drafts.length,
          recipeReasoning: cfg.recipeReasoning,
          visionChain: cfg.recipeVisionCandidates.map((candidate) => candidate.model),
        },
      }, models?.length ? { models } : {});
      aiCost = result.usage.cost == null ? aiCost : roundMicro((aiCost ?? 0) + result.usage.cost);
      aiModel = result.model ?? null;
      // A text-only retry is a second call, not a replacement: keep the models
      // the failed photo chain already tried so the response lists every one.
      aiModels = [...new Set([...aiModels, ...(result.models ?? [])])];
      aiTruncated = Boolean(result.truncated);
      if (result.notes?.length) warnings.push(...result.notes);
      return result.data.recipes
        .map((entry, index) => normaliseRecipeDraft(entry, index === 0 ? fallbackTitle : "Recipe"))
        .filter((recipe) => recipe.ingredients.length > 0 || recipe.steps.length > 0);
    };

    /** Keep the cost of a failed chain visible instead of reporting none. */
    const spentOnFailure = (error: unknown) => {
      const usage = (error as { details?: { usage?: { cost?: number | null } }; usage?: { cost?: number | null } } | null);
      const cost = usage?.details?.usage?.cost ?? usage?.usage?.cost ?? null;
      if (cost != null) aiCost = roundMicro((aiCost ?? 0) + cost);
    };

    if (canUseAi) {
      try {
        const aiDrafts = await readWithAi(vision.images, body.preferAi ? "requested" : "image-first");
        if (aiDrafts.length) {
          drafts = aiDrafts;
          provider = "ai";
          if (vision.skipped) {
            warnings.push(
              vision.skipped === visionPaths.length
                ? "The photo could not be sent to the vision model (missing or larger than 8 MB); only the recognised text was used."
                : `${vision.skipped} of ${visionPaths.length} photos could not be sent to the vision model; the rest were used.`,
            );
          }
        } else {
          warnings.push("AI read the page but found no recipe, so the locally parsed version was kept.");
        }
      } catch (err) {
        spentOnFailure(err);
        aiModels = addAttemptedModels(aiModels, err);
        if (vision.images.length && isImageInputError(err)) {
          try {
            // Retry the model that actually rejected the photo. Re-running the
            // first model would re-bill every earlier failure (a 5xx, a rate
            // limit) and could hit the same image rejection again.
            const failedModel = failedModelFrom(err) ?? attemptedModelsFrom(err).at(-1) ?? null;
            const retryCandidate = failedModel
              ? cfg.recipeVisionCandidates.find((candidate) => candidate.model === failedModel)
              : undefined;
            const retryModels = retryCandidate ? [retryCandidate] : cfg.recipeVisionCandidates.slice(0, 1);
            const aiDrafts = await readWithAi([], "text-only-retry", retryModels);
            if (aiDrafts.length) {
              drafts = aiDrafts;
              provider = "ai";
            }
            warnings.push(
              "The configured AI model did not accept the photo, so only the recognised text was cleaned up. " +
                "Handwriting is only read reliably by a vision model — pick one under Settings → AI.",
            );
          } catch (retryError) {
            spentOnFailure(retryError);
            // The retry is a second call, not a replacement: the response must
            // still list the photo chain's models alongside the retried one.
            aiModels = addAttemptedModels(aiModels, retryError);
            warnings.push(
              `AI cleanup failed, kept the locally parsed version. ${retryError instanceof Error ? retryError.message : ""}`.trim(),
            );
            warnings.push(...notesFrom(retryError));
          }
        } else {
          warnings.push(`AI cleanup failed, kept the locally parsed version. ${err instanceof Error ? err.message : ""}`.trim());
          warnings.push(...notesFrom(err));
        }
      }
    } else {
      warnings.push(
        "No AI provider configured — parsed locally. On-device OCR does not read handwriting, so check the text against the photo.",
      );
    }

    if (!rawText && provider === "local") {
      warnings.push(
        "No text was recognised in the scan. Add a vision-capable model in Settings → AI to let AI read the photo, or type the text before digitising.",
      );
    }

    // This is only a rough character-shape heuristic, not a dictionary or a
    // reliable measure of recognition. Warn without discarding the user's text.
    const unreadableReading =
      provider === "local" && Boolean(rawText) && readableWordRatio(rawText) < 0.35;
    if (unreadableReading) {
      warnings.push(
        "The on-device OCR reading may be unreliable. Check it against the photo, use a vision model, or type the text.",
      );
    }

    const warning = warnings.length ? warnings.join(" ") : null;
    // A draft with neither ingredients nor steps is not a recipe. Without this
    // filter an empty OCR reading (or a title-only AI fragment) would still be
    // "saved" as a blank recipe.
    const usableDrafts = drafts.filter(
      (draft) => draft.ingredients.length > 0 || draft.steps.some((step) => step.text.trim()),
    );
    // `aiCost` at the top level is the whole scan. A page can hold several
    // recipes, so each draft carries its share: storing the full scan cost on
    // every saved recipe would count the same spend once per recipe.
    const draftAiCost = aiCost == null ? null : roundMicro(aiCost / Math.max(1, usableDrafts.length));
    const draftInputs = usableDrafts.map((draft) =>
      draftToInput(draft, {
        source: "scan",
        // Link to the photo that was actually sent to the model. A request can
        // carry both `image` and `images`; the loader then uses `images` only,
        // so `body.image` may name a photo the model never saw. Fall back to
        // the first supplied path when every photo was skipped (the file still
        // exists on disk, so the link is still useful).
        sourceImage: vision.usedPaths[0] ?? visionPaths[0] ?? null,
        ocrText: rawText,
        aiCost: draftAiCost,
      }),
    );

    if (body.save) {
      // The AI call was billed even when it produced nothing usable. Put the
      // spend on the error payload so it is not invisible to API clients.
      if (!draftInputs.length) {
        throw new ApiError(400, "No recipe could be read from this page", { aiCost, aiModels });
      }
      // Never persist a best-effort partial read unattended: the caller can
      // show the draft, let the user check it, and save it deliberately.
      if (aiTruncated) {
        throw new ApiError(
          409,
          "The AI answer was cut off at the output token limit, so nothing was saved. Review the draft and save it when it looks complete.",
        );
      }
      const id = await saveRecipe(houseId, req.user!.id, draftInputs[0]);
      const row = (await recipeRow(id))!;
      const serialized = serializeRecipe(row, await ingredientsFor(id));
      // One call saves one recipe. Say so instead of reporting a count the
      // response does not match, which used to look like the extra recipes
      // had been saved too.
      const partialSave =
        draftInputs.length > 1
          ? `${draftInputs.length} recipes were found; only the first was saved. Scan again to save the others.`
          : null;
      res.status(201).json({
        provider,
        warning: [warning, partialSave].filter(Boolean).join(" ") || null,
        aiCost,
        aiModel,
        aiModels,
        truncated: aiTruncated,
        saved: true,
        savedCount: 1,
        aiAvailable: canUseAi,
        count: draftInputs.length,
        recipe: decorateRecipe(serialized, await stockMaps(houseId), await nutritionItems(houseId)),
      });
      return;
    }

    res.json({
      provider,
      warning,
      aiCost,
      aiModel,
      aiModels,
      truncated: aiTruncated,
      saved: false,
      aiAvailable: canUseAi,
      count: draftInputs.length,
      drafts: draftInputs,
      // Older clients read `draft`; the first section is the safest default.
      draft: draftInputs[0] ?? null,
    });
  }),
);

recipeRoutes.post(
  "/:houseId/recipes/import",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(
      z.object({
        url: z.string().trim().min(4).max(2000),
        save: z.boolean().optional(),
      }),
      req.body,
    );

    let imported;
    try {
      imported = await importRecipeFromUrl(body.url);
    } catch (err) {
      if (err instanceof RecipeImportError) throw new ApiError(400, err.message);
      throw err;
    }

    const house = (await get<any>("SELECT * FROM houses WHERE id = ?", [houseId]))!;
    const cfg = resolveAi(parseJson(house.settings, {}));
    let draft = imported.draft;
    let provider: "structured" | "html" | "ai" = imported.provider;
    let warning = imported.warning;
    let aiCost: number | null = null;

    // A page without JSON-LD is only a rough text read. If an AI provider is
    // configured, let it structure the page copy the same way scan clean-up does.
    if (imported.provider === "html" && cfg.enabled && imported.textForAi.trim()) {
      try {
        const aiDraft = await aiCleanRecipe(cfg, imported.textForAi.slice(0, 12000), [], {
          operation: "recipe.import",
          houseId,
          userId: req.user!.id,
          metadata: { sourceUrl: imported.sourceUrl, provider: imported.provider },
        });
        const normalised = normaliseRecipeDraft(aiDraft.data, draft.title || "Imported recipe");
        draft = {
          ...draft,
          ...normalised,
          description: normalised.description ?? draft.description,
          servings: normalised.servings ?? draft.servings,
          prepMinutes: normalised.prepMinutes ?? draft.prepMinutes,
          cookMinutes: normalised.cookMinutes ?? draft.cookMinutes,
          tags: normalised.tags.length ? normalised.tags : draft.tags,
          notes: normalised.notes ?? draft.notes,
          ingredients: normalised.ingredients.length ? normalised.ingredients : draft.ingredients,
          steps: normalised.steps.length ? normalised.steps : draft.steps,
        };
        aiCost = aiDraft.usage.cost;
        provider = "ai";
        // A cut-off answer still parsed: keep it, but tell the user it may be
        // incomplete instead of presenting it as a finished import.
        warning = [
          aiDraft.truncated
            ? "The AI answer was cut off at the output token limit, so the imported recipe may be incomplete."
            : null,
          ...(aiDraft.notes ?? []),
        ]
          .filter(Boolean)
          .join(" ") || null;
      } catch (err) {
        warning = `${warning ?? ""} AI clean-up also failed: ${err instanceof Error ? err.message : "unknown error"}`.trim();
      }
    }

    const input = draftToInput(draft, {
      source: "import",
      sourceUrl: imported.sourceUrl,
      image: imported.image,
      aiCost,
    });

    if (body.save) {
      const id = await saveRecipe(houseId, req.user!.id, input);
      const row = (await recipeRow(id))!;
      const serialized = serializeRecipe(row, await ingredientsFor(id));
      res.status(201).json({
        provider,
        warning,
        aiCost,
        saved: true,
        sourceUrl: imported.sourceUrl,
        image: imported.image,
        recipe: decorateRecipe(serialized, await stockMaps(houseId), await nutritionItems(houseId)),
      });
      return;
    }

    res.json({
      provider,
      warning,
      aiCost,
      saved: false,
      sourceUrl: imported.sourceUrl,
      image: imported.image,
      pageTitle: imported.pageTitle,
      draft: input,
    });
  }),
);

/* ------------------------------------------------------------ single recipe */

singleRecipeRoutes.get(
  "/:recipeId",
  handler(async (req, res) => {
    const { recipe, houseId } = await recipeAccess(req);
    const serialized = serializeRecipe(recipe, await ingredientsFor(recipe.id));
    res.json(decorateRecipe(serialized, await stockMaps(houseId), await nutritionItems(houseId)));
  }),
);

singleRecipeRoutes.patch(
  "/:recipeId",
  handler(async (req, res) => {
    const { recipe, houseId } = await recipeAccess(req, "member");
    const body = parseBody(recipeInput.partial(), req.body);
    const current = serializeRecipe(recipe, await ingredientsFor(recipe.id));
    const merged = recipeInput.parse({
      ...current,
      ...body,
      title: body.title ?? current.title,
      ingredients: body.ingredients ?? current.ingredients,
      steps: body.steps ?? current.steps,
    });
    await saveRecipe(houseId, req.user!.id, merged, recipe.id);
    const updated = (await recipeRow(recipe.id))!;
    const serialized = serializeRecipe(updated, await ingredientsFor(recipe.id));
    res.json(decorateRecipe(serialized, await stockMaps(houseId), await nutritionItems(houseId)));
  }),
);

singleRecipeRoutes.delete(
  "/:recipeId",
  handler(async (req, res) => {
    const { recipe } = await recipeAccess(req, "member");
    await run("DELETE FROM recipes WHERE id = ?", [recipe.id]);
    await removeUnreferencedUploads([recipe.image, recipe.source_image]);
    res.json({ ok: true });
  }),
);

singleRecipeRoutes.post(
  "/:recipeId/favorite",
  handler(async (req, res) => {
    const { recipe } = await recipeAccess(req, "member");
    const body = parseBody(z.object({ favorite: z.boolean().optional() }), req.body ?? {});
    const next = body.favorite === undefined ? !recipe.favorite : body.favorite;
    await run("UPDATE recipes SET favorite = ?, updated_at = ? WHERE id = ?", [next ? 1 : 0, now(), recipe.id]);
    res.json({ favorite: next });
  }),
);

singleRecipeRoutes.post(
  "/:recipeId/ai",
  handler(async (req, res) => {
    const { recipe, houseId } = await recipeAccess(req, "member");
    const house = (await get<any>("SELECT * FROM houses WHERE id = ?", [houseId]))!;
    const cfg = resolveAi(parseJson(house.settings, {}));
    if (!cfg.enabled) {
      throw new ApiError(400, "Add an AI provider in Settings → AI to use recipe assistance");
    }
    const body = parseBody(z.object({ action: z.enum(["complete"]).default("complete") }), req.body ?? {});
    void body;
    const current = serializeRecipe(recipe, await ingredientsFor(recipe.id));
    const aiResult = await aiCompleteRecipe(cfg, {
      title: current.title,
      description: current.description,
      servings: current.servings,
      prepMinutes: current.prepMinutes,
      cookMinutes: current.cookMinutes,
      tags: current.tags,
      ingredients: current.ingredients.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unit: i.unit,
        optional: i.optional,
        note: i.note,
      })),
      steps: current.steps,
    }, {
      operation: "recipe.complete",
      houseId,
      userId: req.user!.id,
      targetId: recipe.id,
      metadata: { ingredientCount: current.ingredients.length, stepCount: current.steps.length },
    });
    const normalised = normaliseRecipeDraft(aiResult.data, current.title);
    // A recipe can be scanned and polished several times: keep the total AI spend.
    const spentBefore = current.aiCost ?? 0;
    const aiCost =
      aiResult.usage.cost == null
        ? current.aiCost ?? null
        : Math.round((spentBefore + aiResult.usage.cost) * 1e6) / 1e6;
    const payload = recipeInput.parse({
      title: normalised.title,
      description: normalised.description ?? current.description,
      servings: normalised.servings ?? current.servings,
      prepMinutes: normalised.prepMinutes ?? current.prepMinutes,
      cookMinutes: normalised.cookMinutes ?? current.cookMinutes,
      steps: normalised.steps.length ? normalised.steps : current.steps,
      tags: normalised.tags.length ? normalised.tags : current.tags,
      image: current.image,
      sourceImage: current.sourceImage,
      ocrText: current.ocrText,
      sourceUrl: current.sourceUrl,
      source: current.source,
      aiNotes: normalised.notes ?? current.aiNotes,
      aiCost,
      favorite: current.favorite,
      ingredients: normalised.ingredients.length ? normalised.ingredients : current.ingredients,
    });
    await saveRecipe(houseId, req.user!.id, payload, recipe.id);
    const updated = (await recipeRow(recipe.id))!;
    const serialized = serializeRecipe(updated, await ingredientsFor(recipe.id));
    res.json(decorateRecipe(serialized, await stockMaps(houseId), await nutritionItems(houseId)));
  }),
);
