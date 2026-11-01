import { Router } from "express";
import { z } from "zod";
import { all, get, newId, now, parseJson, run } from "../db.js";
import { memberRole, requireAuth } from "../auth.js";
import { ApiError, handler, parseBody, requireHouse } from "../http.js";
import { aiSuggestIdeas, resolveAi } from "../ai.js";
import { localIdeas, normaliseIdeas } from "../services/recipe-local.js";
import { recipeInput, saveRecipe } from "./recipes.js";
import type { IdeaResponse } from "../../shared/types.js";

export const ideaRoutes = Router();
export const singleIdeaRoutes = Router();

ideaRoutes.use(requireAuth);
singleIdeaRoutes.use(requireAuth);

function inventory(houseId: string) {
  return all<any>(
    `SELECT i.id, i.name, i.unit, i.category_id, c.name AS category_name,
       COALESCE((SELECT SUM(l.quantity) FROM stock_lots l WHERE l.item_id = i.id), 0) AS quantity
     FROM items i LEFT JOIN categories c ON c.id = i.category_id
     WHERE i.house_id = ? AND i.archived = 0
     ORDER BY quantity DESC, i.name COLLATE NOCASE`,
    [houseId],
  )
    .filter((r) => Number(r.quantity) > 0)
    .map((r) => ({
      id: r.id as string,
      name: r.name as string,
      quantity: Number(r.quantity),
      unit: r.unit as string,
      categoryName: (r.category_name as string) ?? null,
    }));
}

function ideaRecipes(houseId: string) {
  const rows = all<any>("SELECT id, title, steps FROM recipes WHERE house_id = ? ORDER BY favorite DESC, updated_at DESC LIMIT 60", [
    houseId,
  ]);
  return rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    steps: parseJson<{ text: string }[]>(r.steps, []),
    ingredients: all<any>("SELECT name, quantity, unit, optional FROM recipe_ingredients WHERE recipe_id = ? ORDER BY sort", [
      r.id,
    ]).map((i) => ({
      name: i.name as string,
      quantity: i.quantity == null ? null : Number(i.quantity),
      unit: (i.unit as string) ?? null,
      optional: Boolean(i.optional),
    })),
  }));
}

ideaRoutes.get(
  "/:houseId/ideas",
  handler((req, res) => {
    const { houseId } = requireHouse(req);
    const rows = all<any>("SELECT * FROM food_ideas WHERE house_id = ? ORDER BY created_at DESC LIMIT 12", [houseId]);
    res.json(
      rows.map((r) => ({
        id: r.id,
        prompt: r.prompt,
        createdAt: r.created_at,
        ...parseJson<IdeaResponse>(r.result, { provider: "local", summary: "", ideas: [] }),
      })),
    );
  }),
);

ideaRoutes.post(
  "/:houseId/ideas",
  handler(async (req, res) => {
    const { houseId } = requireHouse(req, "member");
    const body = parseBody(
      z.object({
        prompt: z.string().trim().max(500).optional(),
        maxTimeMinutes: z.number().int().min(1).max(600).optional(),
        dietary: z.array(z.string().max(30)).max(10).optional(),
      }),
      req.body ?? {},
    );
    const prompt = [body.prompt ?? "", body.maxTimeMinutes ? `under ${body.maxTimeMinutes} minutes` : "", ...(body.dietary ?? [])]
      .filter(Boolean)
      .join(", ");

    const items = inventory(houseId);
    const recipes = ideaRecipes(houseId);
    const house = get<any>("SELECT * FROM houses WHERE id = ?", [houseId])!;
    const cfg = resolveAi(parseJson(house.settings, {}));

    let result: IdeaResponse;
    let warning: string | null = null;
    if (cfg.enabled) {
      try {
        const raw = await aiSuggestIdeas(
          cfg,
          items,
          recipes.map((r) => ({ id: r.id, title: r.title, ingredients: r.ingredients.map((i) => i.name) })),
          prompt,
        );
        result = normaliseIdeas(raw);
        if (!result.ideas.length) result = localIdeas(items, recipes, prompt);
      } catch (err) {
        warning = `AI ideas failed, showing local suggestions. ${err instanceof Error ? err.message : ""}`.trim();
        result = localIdeas(items, recipes, prompt);
      }
    } else {
      result = localIdeas(items, recipes, prompt);
      warning = "No AI provider configured — these suggestions come from your inventory and saved recipes.";
    }

    const id = newId("ida");
    run("INSERT INTO food_ideas (id, house_id, user_id, prompt, result, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
      id,
      houseId,
      req.user!.id,
      prompt || null,
      JSON.stringify(result),
      now(),
    ]);
    res.json({ id, prompt, createdAt: now(), ...result, warning });
  }),
);

singleIdeaRoutes.post(
  "/:ideaId/save",
  handler((req, res) => {
    const idea = get<any>("SELECT * FROM food_ideas WHERE id = ?", [req.params.ideaId]);
    if (!idea) throw new ApiError(404, "Idea not found");
    const role = memberRole(req.user!.id, idea.house_id);
    if (!role || role === "viewer") throw new ApiError(403, "Requires member access");
    const body = parseBody(z.object({ index: z.number().int().min(0).default(0) }), req.body ?? {});
    const result = parseJson<IdeaResponse>(idea.result, { provider: "local", summary: "", ideas: [] });
    const pick = result.ideas[body.index];
    if (!pick) throw new ApiError(404, "That idea is no longer available");
    const payload = recipeInput.parse({
      title: pick.title,
      description: [pick.rationale, result.summary].filter(Boolean).join(" ").slice(0, 2000),
      servings: pick.servings,
      prepMinutes: pick.timeMinutes,
      cookMinutes: null,
      steps: pick.steps.map((text) => ({ text })),
      tags: ["ai", "idea"],
      source: "ai",
      aiNotes: pick.missing.length ? `Missing when suggested: ${pick.missing.map((m) => m.name).join(", ")}` : null,
      ingredients: [...pick.uses, ...pick.missing].map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unit: i.unit,
        optional: pick.missing.some((m) => m.name === i.name),
      })),
    });
    const id = saveRecipe(idea.house_id, req.user!.id, payload);
    res.status(201).json({ recipeId: id });
  }),
);
