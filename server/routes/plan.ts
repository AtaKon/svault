import { Router } from "express";
import { z } from "zod";
import { all, get, newId, now, parseJson, run } from "../db.js";
import { requireAuth } from "../auth.js";
import { ApiError, handler, parseBody, requireHouse } from "../http.js";
import { addShoppingLine, listShopping, normalizeName } from "../services/shopping.js";
import { serializePlanEntries } from "../lib/plan-serialize.js";
import { convert, round } from "../units.js";
import { MEAL_SLOTS, type FoodIdea, type IdeaResponse, type MealPlanEntry, type MealSlot } from "../../shared/types.js";

export const planRoutes = Router();
planRoutes.use(requireAuth);

const DAY_MS = 864e5;

function dayString(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function mondayOf(value?: string | null): string {
  const base = value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : new Date();
  if (Number.isNaN(base.getTime())) return mondayOf(null);
  const weekday = (base.getUTCDay() + 6) % 7;
  return dayString(new Date(base.getTime() - weekday * DAY_MS));
}

function addDays(day: string, days: number) {
  return dayString(new Date(new Date(`${day}T00:00:00Z`).getTime() + days * DAY_MS));
}

async function recipeFor(houseId: string, recipeId: string) {
  return await get<any>("SELECT * FROM recipes WHERE id = ? AND house_id = ?", [recipeId, houseId]);
}

async function ideaFor(houseId: string, ideaId: string) {
  return await get<any>("SELECT * FROM food_ideas WHERE id = ? AND house_id = ?", [ideaId, houseId]);
}

function ideaTitle(row: any, index: number | null) {
  const result = parseJson<IdeaResponse>(row?.result, { provider: "local", summary: "", ideas: [] });
  return result.ideas[index ?? 0]?.title ?? result.ideas[0]?.title ?? "Food idea";
}

async function serializeEntry(row: any): Promise<MealPlanEntry> {
  let recipe: MealPlanEntry["recipe"] = null;
  let idea: MealPlanEntry["idea"] = null;
  if (row.recipe_id) {
    const recipeRow = await get<any>("SELECT id, title, servings, image FROM recipes WHERE id = ?", [row.recipe_id]);
    if (recipeRow) {
      recipe = {
        id: recipeRow.id,
        title: recipeRow.title,
        servings: recipeRow.servings == null ? null : Number(recipeRow.servings),
        image: recipeRow.image ?? null,
      };
    }
  }
  if (row.idea_id) {
    const ideaRow = await get<any>("SELECT id, result FROM food_ideas WHERE id = ?", [row.idea_id]);
    const index = row.idea_index == null ? 0 : Number(row.idea_index);
    const result = parseJson<IdeaResponse>(ideaRow?.result, { provider: "local", summary: "", ideas: [] });
    const pick = result.ideas[index];
    idea = {
      id: row.idea_id,
      title: pick?.title ?? row.title ?? "Food idea",
      servings: pick?.servings == null ? null : Number(pick.servings),
    };
  }
  const title = recipe?.title ?? idea?.title ?? row.title ?? "Planned meal";
  return {
    id: row.id,
    houseId: row.house_id,
    day: row.day,
    slot: (MEAL_SLOTS.includes(row.slot) ? row.slot : "dinner") as MealSlot,
    recipeId: row.recipe_id ?? null,
    ideaId: row.idea_id ?? null,
    ideaIndex: row.idea_index == null ? null : Number(row.idea_index),
    title,
    servings: row.servings == null ? null : Number(row.servings),
    sort: Number(row.sort ?? 0),
    recipe,
    idea,
    createdAt: row.created_at,
  };
}

planRoutes.get(
  "/:houseId/plan",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    const weekStart = mondayOf(req.query.week ? String(req.query.week) : null);
    const weekEnd = addDays(weekStart, 6);
    // await every entry: serializeEntry is async, and a failure should surface
    // as a request error instead of silently serializing as {}.
    const entries = await serializePlanEntries(
      await all<any>(
        "SELECT * FROM meal_plan_entries WHERE house_id = ? AND day >= ? AND day <= ? ORDER BY day, slot, sort, created_at",
        [houseId, weekStart, weekEnd],
      ),
      serializeEntry,
    );
    res.json({ weekStart, weekEnd, entries });
  }),
);

const entryBody = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  slot: z.enum(["breakfast", "lunch", "dinner", "snack"]),
  recipeId: z.string().max(60).nullish(),
  ideaId: z.string().max(60).nullish(),
  ideaIndex: z.number().int().min(0).max(50).nullish(),
  title: z.string().trim().max(160).nullish(),
  servings: z.number().min(0).max(1000).nullish(),
  sort: z.number().int().min(0).max(999).optional(),
});

planRoutes.post(
  "/:houseId/plan",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(entryBody, req.body);
    let recipe: any = null;
    let idea: any = null;
    if (body.recipeId) {
      recipe = await recipeFor(houseId, body.recipeId);
      if (!recipe) throw new ApiError(400, "Recipe does not exist in this house");
    }
    if (body.ideaId) {
      idea = await ideaFor(houseId, body.ideaId);
      if (!idea) throw new ApiError(400, "Food idea does not exist in this house");
    }
    if (!recipe && !idea && !body.title) throw new ApiError(400, "Pick a recipe, a food idea or a title");
    const id = newId("pln");
    const servings = body.servings ?? (recipe?.servings != null ? Number(recipe.servings) : null);
    const title = body.title ?? (recipe ? recipe.title : ideaTitle(idea, body.ideaIndex ?? 0));
    await run(
      `INSERT INTO meal_plan_entries
        (id, house_id, day, slot, recipe_id, idea_id, idea_index, title, servings, sort, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        houseId,
        body.day,
        body.slot,
        recipe?.id ?? null,
        idea?.id ?? null,
        idea ? (body.ideaIndex ?? 0) : null,
        title,
        servings,
        body.sort ?? 0,
        req.user!.id,
        now(),
      ],
    );
    res.status(201).json(await serializeEntry(await get<any>("SELECT * FROM meal_plan_entries WHERE id = ?", [id])));
  }),
);

async function entryAccess(req: any, minRole: "viewer" | "member" = "viewer") {
  const entry = await get<any>("SELECT * FROM meal_plan_entries WHERE id = ?", [req.params.entryId]);
  if (!entry) throw new ApiError(404, "Planned meal not found");
  const { houseId } = await requireHouse(req, minRole);
  if (entry.house_id !== houseId) throw new ApiError(404, "Planned meal not found");
  return entry;
}

planRoutes.patch(
  "/:houseId/plan/:entryId",
  handler(async (req, res) => {
    const entry = await entryAccess(req, "member");
    const body = parseBody(
      entryBody.partial().extend({
        recipeId: z.string().max(60).nullish(),
        ideaId: z.string().max(60).nullish(),
      }),
      req.body,
    );
    let recipeId = entry.recipe_id;
    let ideaId = entry.idea_id;
    let ideaIndex = entry.idea_index;
    let title = entry.title;
    if (body.recipeId !== undefined) {
      if (body.recipeId) {
        const recipe = await recipeFor(entry.house_id, body.recipeId);
        if (!recipe) throw new ApiError(400, "Recipe does not exist in this house");
        recipeId = recipe.id;
        ideaId = null;
        ideaIndex = null;
        title = recipe.title;
      } else {
        recipeId = null;
      }
    }
    if (body.ideaId !== undefined) {
      if (body.ideaId) {
        const idea = await ideaFor(entry.house_id, body.ideaId);
        if (!idea) throw new ApiError(400, "Food idea does not exist in this house");
        ideaId = idea.id;
        recipeId = null;
        ideaIndex = body.ideaIndex ?? 0;
        title = ideaTitle(idea, ideaIndex);
      } else {
        ideaId = null;
      }
    }
    if (body.title !== undefined && body.title) title = body.title;
    await run(
      `UPDATE meal_plan_entries SET day = ?, slot = ?, recipe_id = ?, idea_id = ?, idea_index = ?, title = ?,
         servings = ?, sort = ? WHERE id = ?`,
      [
        body.day ?? entry.day,
        body.slot ?? entry.slot,
        recipeId,
        ideaId,
        ideaIndex,
        title,
        body.servings === undefined ? entry.servings : body.servings,
        body.sort ?? entry.sort,
        entry.id,
      ],
    );
    res.json(await serializeEntry(await get<any>("SELECT * FROM meal_plan_entries WHERE id = ?", [entry.id])));
  }),
);

planRoutes.post(
  "/:houseId/plan/:entryId/duplicate",
  handler(async (req, res) => {
    const entry = await entryAccess(req, "member");
    const body = parseBody(
      z.object({
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        slot: z.enum(["breakfast", "lunch", "dinner", "snack"]).optional(),
      }),
      req.body ?? {},
    );
    const id = newId("pln");
    await run(
      `INSERT INTO meal_plan_entries
        (id, house_id, day, slot, recipe_id, idea_id, idea_index, title, servings, sort, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        entry.house_id,
        body.day ?? addDays(entry.day, 1),
        body.slot ?? entry.slot,
        entry.recipe_id,
        entry.idea_id,
        entry.idea_index,
        entry.title,
        entry.servings,
        Number(entry.sort ?? 0) + 1,
        req.user!.id,
        now(),
      ],
    );
    res.status(201).json(await serializeEntry(await get<any>("SELECT * FROM meal_plan_entries WHERE id = ?", [id])));
  }),
);

planRoutes.delete(
  "/:houseId/plan/:entryId",
  handler(async (req, res) => {
    const entry = await entryAccess(req, "member");
    await run("DELETE FROM meal_plan_entries WHERE id = ?", [entry.id]);
    res.json({ ok: true });
  }),
);

interface RequiredIngredient {
  name: string;
  quantity: number | null;
  unit: string | null;
  itemId: string | null;
  categoryId: string | null;
}

async function itemForIngredient(houseId: string, ingredient: { name: string; itemId: string | null }) {
  if (ingredient.itemId) {
    const linked = await get<any>("SELECT * FROM items WHERE id = ? AND house_id = ?", [ingredient.itemId, houseId]);
    if (linked) return linked;
  }
  return await get<any>("SELECT * FROM items WHERE house_id = ? AND archived = 0 AND LOWER(name) = LOWER(?)", [
    houseId,
    ingredient.name,
  ]);
}

async function stockInUnit(item: any, unit: string | null) {
  const quantity = Number(
    (await get<{ q: number }>("SELECT COALESCE(SUM(quantity), 0) AS q FROM stock_lots WHERE item_id = ?", [item.id]))?.q ?? 0,
  );
  if (!unit) return quantity;
  return convert(quantity, item.unit, unit) ?? 0;
}

/** Build the week's missing shopping lines, then store them through the same
 * merge/idempotency path as every other shopping-list source. */
planRoutes.post(
  "/:houseId/plan/shopping-list",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(z.object({ week: z.string().optional() }), req.body ?? {});
    const weekStart = mondayOf(body.week ?? null);
    const weekEnd = addDays(weekStart, 6);
    const entries = await all<any>(
      "SELECT * FROM meal_plan_entries WHERE house_id = ? AND day >= ? AND day <= ?",
      [houseId, weekStart, weekEnd],
    );
    if (!entries.length) throw new ApiError(400, "Nothing is planned for this week yet");

    const required: RequiredIngredient[] = [];
    for (const entry of entries) {
      if (entry.recipe_id) {
        const recipe = await get<any>("SELECT * FROM recipes WHERE id = ?", [entry.recipe_id]);
        if (!recipe) continue;
        const factor =
          entry.servings != null && recipe.servings != null && Number(recipe.servings) > 0
            ? Number(entry.servings) / Number(recipe.servings)
            : 1;
        for (const ingredient of await all<any>(
          "SELECT ri.*, i.category_id AS item_category FROM recipe_ingredients ri LEFT JOIN items i ON i.id = ri.item_id WHERE ri.recipe_id = ? ORDER BY ri.sort",
          [recipe.id],
        )) {
          if (ingredient.optional) continue;
          required.push({
            name: ingredient.name,
            quantity: ingredient.quantity == null ? null : round(Number(ingredient.quantity) * factor),
            unit: ingredient.unit ?? null,
            itemId: ingredient.item_id ?? null,
            categoryId: ingredient.item_category ?? null,
          });
        }
      } else if (entry.idea_id) {
        const ideaRow = await get<any>("SELECT * FROM food_ideas WHERE id = ?", [entry.idea_id]);
        const result = parseJson<IdeaResponse>(ideaRow?.result, { provider: "local", summary: "", ideas: [] });
        const pick: FoodIdea | undefined = result.ideas[entry.idea_index == null ? 0 : Number(entry.idea_index)];
        if (!pick) continue;
        const factor =
          entry.servings != null && pick.servings != null && Number(pick.servings) > 0
            ? Number(entry.servings) / Number(pick.servings)
            : 1;
        for (const ingredient of [...pick.uses, ...pick.missing]) {
          required.push({
            name: ingredient.name,
            quantity: ingredient.quantity == null ? null : round(ingredient.quantity * factor),
            unit: ingredient.unit ?? null,
            itemId: null,
            categoryId: null,
          });
        }
      }
    }

    // Merge identical ingredients across meals before subtracting stock, so
    // three dinners needing 200 g of rice subtract the pantry only once.
    interface Aggregate extends RequiredIngredient {
      stockItemId: string | null;
    }
    const aggregates: Aggregate[] = [];
    for (const ingredient of required) {
      const match = aggregates.find(
        (entry) =>
          normalizeName(entry.name) === normalizeName(ingredient.name) &&
          (entry.unit === ingredient.unit ||
            (entry.unit && ingredient.unit && convert(1, entry.unit, ingredient.unit) != null)),
      );
      if (match) {
        if (ingredient.quantity != null) {
          const converted =
            ingredient.unit && match.unit && ingredient.unit !== match.unit
              ? convert(ingredient.quantity, ingredient.unit, match.unit)
              : ingredient.quantity;
          if (converted != null) match.quantity = round((match.quantity ?? 0) + converted);
        }
        match.itemId ??= ingredient.itemId;
        match.categoryId ??= ingredient.categoryId;
      } else {
        const item = await itemForIngredient(houseId, ingredient);
        aggregates.push({ ...ingredient, stockItemId: item?.id ?? null });
      }
    }

    let added = 0;
    let merged = 0;
    let skipped = 0;
    for (const ingredient of aggregates) {
      const item = ingredient.stockItemId
        ? await get<any>("SELECT * FROM items WHERE id = ?", [ingredient.stockItemId])
        : await itemForIngredient(houseId, ingredient);
      const inStock = item ? await stockInUnit(item, ingredient.unit) : 0;
      let quantity = ingredient.quantity;
      if (quantity == null) {
        if (inStock > 0) continue;
      } else {
        quantity = round(Math.max(0, quantity - inStock));
        if (quantity <= 0) continue;
      }
      const result = await addShoppingLine({
        houseId,
        userId: req.user!.id,
        name: ingredient.name,
        quantity,
        unit: ingredient.unit,
        itemId: item?.id ?? null,
        categoryId: ingredient.categoryId ?? item?.category_id ?? null,
        source: "meal_plan",
        sourceKey: `plan:${weekStart}:${normalizeName(ingredient.name)}:${ingredient.unit ?? ""}`,
      });
      if (result.status === "added") added++;
      else if (result.status === "merged") merged++;
      else skipped++;
    }

    res.json({ added, merged, skipped, weekStart, weekEnd, items: await listShopping(houseId) });
  }),
);
