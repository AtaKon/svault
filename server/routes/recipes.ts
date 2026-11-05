import { Router } from "express";
import { z } from "zod";
import { AI_ENV } from "../config.js";
import { all, get, newId, now, parseJson, run, tx } from "../db.js";
import { memberRole, requireAuth, roleAtLeast } from "../auth.js";
import { ApiError, handler, parseBody, requireHouse } from "../http.js";
import { recipeMatch, serializeRecipe, stockQuantity } from "../serialize.js";
import { aiCleanRecipe, aiCompleteRecipe, fileToDataUrl, resolveAi } from "../ai.js";
import { normaliseNutrition, recipeNutrition, type NutritionSourceItem } from "../services/nutrition.js";
import { heuristicRecipe, normaliseRecipeDraft, type ParsedRecipe } from "../services/recipe-local.js";
import { uploader, uploadPath } from "../upload.js";
import type { OffProduct, Role, Recipe } from "../../shared/types.js";

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
  image: z.string().max(300).nullish(),
  sourceImage: z.string().max(300).nullish(),
  ocrText: z.string().max(30000).nullish(),
  source: z.enum(["manual", "scan", "ai"]).optional(),
  aiNotes: z.string().max(4000).nullish(),
  aiCost: z.number().min(0).max(1e9).nullish(),
  favorite: z.boolean().optional(),
  ingredients: z.array(ingredientSchema).max(150).optional(),
});

function stockMaps(houseId: string) {
  const rows = all<any>(
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

function nutritionItems(houseId: string): NutritionSourceItem[] {
  return all<any>(
    `SELECT i.id, i.name, i.unit, i.nutrition, cp.summary AS off_summary
     FROM items i LEFT JOIN catalog_products cp ON cp.code = i.off_code
     WHERE i.house_id = ? AND i.archived = 0`,
    [houseId],
  ).map((row) => ({
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

function ingredientsFor(recipeId: string) {
  return all<any>("SELECT * FROM recipe_ingredients WHERE recipe_id = ? ORDER BY sort, rowid", [recipeId]);
}

function recipeRow(recipeId: string) {
  return get<any>("SELECT * FROM recipes WHERE id = ?", [recipeId]);
}

function recipeAccess(req: any, minRole: Role = "viewer") {
  const recipe = recipeRow(req.params.recipeId);
  if (!recipe) throw new ApiError(404, "Recipe not found");
  const role = memberRole(req.user!.id, recipe.house_id);
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

export function saveRecipe(houseId: string, userId: string, body: z.infer<typeof recipeInput>, existingId?: string): string {
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
    ? (get<{ ai_cost: number | null }>("SELECT ai_cost FROM recipes WHERE id = ?", [existingId])?.ai_cost ?? null)
    : null;
  const aiCost = body.aiCost === undefined ? currentAiCost : (body.aiCost ?? null);
  return tx(() => {
    const id = existingId ?? newId("rcp");
    if (existingId) {
      run(
        `UPDATE recipes SET title = ?, description = ?, servings = ?, prep_minutes = ?, cook_minutes = ?, steps = ?,
           tags = ?, image = ?, source_image = ?, ocr_text = ?, source = ?, ai_notes = ?, ai_cost = ?, favorite = ?, updated_at = ?
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
          body.source ?? "manual",
          body.aiNotes ?? null,
          aiCost,
          body.favorite ? 1 : 0,
          now(),
          id,
        ],
      );
      run("DELETE FROM recipe_ingredients WHERE recipe_id = ?", [id]);
    } else {
      run(
        `INSERT INTO recipes (id, house_id, title, description, servings, prep_minutes, cook_minutes, steps, tags,
           image, source_image, ocr_text, source, ai_notes, ai_cost, favorite, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    normaliseIngredientList(body.ingredients ?? []).forEach((ing, index) => {
      run(
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
    });
    return id;
  });
}

function draftToInput(draft: ParsedRecipe, meta: { source?: "manual" | "scan" | "ai"; sourceImage?: string | null; ocrText?: string | null; aiCost?: number | null }): z.infer<typeof recipeInput> {
  return {
    title: draft.title,
    description: draft.description,
    servings: draft.servings,
    prepMinutes: draft.prepMinutes,
    cookMinutes: draft.cookMinutes,
    steps: draft.steps,
    tags: draft.tags,
    image: null,
    sourceImage: meta.sourceImage ?? null,
    ocrText: meta.ocrText ?? null,
    source: meta.source ?? "scan",
    aiNotes: draft.notes,
    aiCost: meta.aiCost ?? null,
    ingredients: draft.ingredients,
  };
}

function localImageToDataUrl(image: string): Promise<string | null> {
  if (!image.startsWith("/uploads/recipes/")) return Promise.resolve(null);
  const filename = image.split("/").pop()!;
  return fileToDataUrl(uploadPath("recipes", filename), "image/jpeg");
}

/* ------------------------------------------------------------- house routes */

recipeRoutes.get(
  "/:houseId/recipes",
  handler((req, res) => {
    const { houseId } = requireHouse(req);
    const q = String(req.query.q ?? "").trim();
    const tag = req.query.tag ? String(req.query.tag) : null;
    const favorite = req.query.favorite === "1";
    const where = ["r.house_id = ?"];
    const params: unknown[] = [houseId];
    if (q) {
      where.push("(r.title LIKE ? OR r.description LIKE ? OR EXISTS (SELECT 1 FROM recipe_ingredients ri WHERE ri.recipe_id = r.id AND ri.name LIKE ?))");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (tag) {
      where.push("r.tags LIKE ?");
      params.push(`%${tag}%`);
    }
    if (favorite) where.push("r.favorite = 1");
    const rows = all<any>(`SELECT * FROM recipes r WHERE ${where.join(" AND ")} ORDER BY r.favorite DESC, r.updated_at DESC`, params);
    const maps = stockMaps(houseId);
    const items = nutritionItems(houseId);
    const recipes = rows.map((row) => {
      const ingredients = ingredientsFor(row.id);
      const serialized = serializeRecipe(row, ingredients);
      return decorateRecipe(serialized, maps, items);
    });
    res.json(recipes);
  }),
);

recipeRoutes.post(
  "/:houseId/recipes",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "member");
    const body = parseBody(recipeInput, req.body);
    const id = saveRecipe(houseId, req.user!.id, body);
    const row = recipeRow(id)!;
    const serialized = serializeRecipe(row, ingredientsFor(id));
    res.status(201).json(decorateRecipe(serialized, stockMaps(houseId), nutritionItems(houseId)));
  }),
);

recipeRoutes.post(
  "/:houseId/recipes/upload",
  uploader("recipes").single("image"),
  handler((req, res) => {
    requireHouse(req, "member");
    if (!req.file) throw new ApiError(400, "No image uploaded");
    res.status(201).json({ path: `/uploads/recipes/${req.file.filename}` });
  }),
);

recipeRoutes.post(
  "/:houseId/recipes/scan",
  handler(async (req, res) => {
    const { houseId } = requireHouse(req, "member");
    const body = parseBody(
      z.object({
        text: z.string().max(30000).optional(),
        image: z.string().max(300).optional(),
        title: z.string().max(120).optional(),
        save: z.boolean().optional(),
      }),
      req.body,
    );
    const rawText = (body.text ?? "").trim();
    if (!rawText && !body.image) throw new ApiError(400, "Provide recipe text or a scan image");

    const house = get<any>("SELECT * FROM houses WHERE id = ?", [houseId])!;
    const settings = parseJson<Record<string, any>>(house.settings, {});
    const cfg = resolveAi(settings);
    // Only send the photo when a vision model is explicitly configured. With a
    // text-only local model we rely on the OCR text instead.
    const hasVisionModel = Boolean(settings?.ai?.visionModel || AI_ENV.visionModel);
    let draft = heuristicRecipe(rawText, body.title || "Scanned recipe");
    let provider: "ai" | "local" = "local";
    let aiCost: number | null = null;
    let warning: string | null = null;

    if (cfg.enabled && (rawText || (body.image && hasVisionModel))) {
      try {
        const images =
          body.image && hasVisionModel
            ? [await localImageToDataUrl(body.image)].filter((value): value is string => !!value)
            : [];
        const aiDraft = await aiCleanRecipe(cfg, rawText, images);
        draft = normaliseRecipeDraft(aiDraft.data, body.title || draft.title || "Scanned recipe");
        aiCost = aiDraft.usage.cost;
        provider = "ai";
      } catch (err) {
        warning = `AI cleanup failed, kept the locally parsed version. ${err instanceof Error ? err.message : ""}`.trim();
      }
    } else if (cfg.enabled) {
      warning =
        "No text was recognised in the scan. Add a vision-capable model in Settings → AI to let AI read the photo, or correct the text before digitising.";
    } else {
      warning = "No AI provider configured — parsed locally. Add a key in Settings → AI to clean up scans automatically.";
    }

    if (body.save) {
      const id = saveRecipe(houseId, req.user!.id, draftToInput(draft, { source: "scan", sourceImage: body.image ?? null, ocrText: rawText, aiCost }));
      const row = recipeRow(id)!;
      const serialized = serializeRecipe(row, ingredientsFor(id));
      res.status(201).json({
        provider,
        warning,
        aiCost,
        saved: true,
        recipe: decorateRecipe(serialized, stockMaps(houseId), nutritionItems(houseId)),
      });
      return;
    }

    res.json({
      provider,
      warning,
      aiCost,
      saved: false,
      draft: draftToInput(draft, { source: "scan", sourceImage: body.image ?? null, ocrText: rawText, aiCost }),
    });
  }),
);

/* ------------------------------------------------------------ single recipe */

singleRecipeRoutes.get(
  "/:recipeId",
  handler((req, res) => {
    const { recipe, houseId } = recipeAccess(req);
    const serialized = serializeRecipe(recipe, ingredientsFor(recipe.id));
    res.json(decorateRecipe(serialized, stockMaps(houseId), nutritionItems(houseId)));
  }),
);

singleRecipeRoutes.patch(
  "/:recipeId",
  handler((req, res) => {
    const { recipe, houseId } = recipeAccess(req, "member");
    const body = parseBody(recipeInput.partial(), req.body);
    const current = serializeRecipe(recipe, ingredientsFor(recipe.id));
    const merged = recipeInput.parse({
      ...current,
      ...body,
      title: body.title ?? current.title,
      ingredients: body.ingredients ?? current.ingredients,
      steps: body.steps ?? current.steps,
    });
    saveRecipe(houseId, req.user!.id, merged, recipe.id);
    const updated = recipeRow(recipe.id)!;
    const serialized = serializeRecipe(updated, ingredientsFor(recipe.id));
    res.json(decorateRecipe(serialized, stockMaps(houseId), nutritionItems(houseId)));
  }),
);

singleRecipeRoutes.delete(
  "/:recipeId",
  handler((req, res) => {
    const { recipe } = recipeAccess(req, "member");
    run("DELETE FROM recipes WHERE id = ?", [recipe.id]);
    res.json({ ok: true });
  }),
);

singleRecipeRoutes.post(
  "/:recipeId/favorite",
  handler((req, res) => {
    const { recipe } = recipeAccess(req, "member");
    const body = parseBody(z.object({ favorite: z.boolean().optional() }), req.body ?? {});
    const next = body.favorite === undefined ? !recipe.favorite : body.favorite;
    run("UPDATE recipes SET favorite = ?, updated_at = ? WHERE id = ?", [next ? 1 : 0, now(), recipe.id]);
    res.json({ favorite: next });
  }),
);

singleRecipeRoutes.post(
  "/:recipeId/ai",
  handler(async (req, res) => {
    const { recipe, houseId } = recipeAccess(req, "member");
    const house = get<any>("SELECT * FROM houses WHERE id = ?", [houseId])!;
    const cfg = resolveAi(parseJson(house.settings, {}));
    if (!cfg.enabled) {
      throw new ApiError(400, "Add an AI provider in Settings → AI to use recipe assistance");
    }
    const body = parseBody(z.object({ action: z.enum(["complete"]).default("complete") }), req.body ?? {});
    void body;
    const current = serializeRecipe(recipe, ingredientsFor(recipe.id));
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
      source: current.source,
      aiNotes: normalised.notes ?? current.aiNotes,
      aiCost,
      favorite: current.favorite,
      ingredients: normalised.ingredients.length ? normalised.ingredients : current.ingredients,
    });
    saveRecipe(houseId, req.user!.id, payload, recipe.id);
    const updated = recipeRow(recipe.id)!;
    const serialized = serializeRecipe(updated, ingredientsFor(recipe.id));
    res.json(decorateRecipe(serialized, stockMaps(houseId), nutritionItems(houseId)));
  }),
);
