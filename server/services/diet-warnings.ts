import { all, parseJson } from "../db.js";
import type { DietWarning, DietCompatibility, FoodIdea } from "../../shared/types.js";

/** Uses only locally cached product data. Missing data is never interpreted as safe. */
export async function recipeDietWarnings(houseId: string, recipeId: string): Promise<{ warnings: DietWarning[]; dietCompatibility: DietCompatibility[] }> {
  const profiles = await all<any>(`SELECT p.*, u.name FROM member_diet_profiles p JOIN house_members m
    ON m.house_id = p.house_id AND m.user_id = p.user_id JOIN users u ON u.id = p.user_id WHERE p.house_id = ?`, [houseId]);
  const ingredients = await all<any>(`SELECT ri.name, cp.summary, cp.payload FROM recipe_ingredients ri
    JOIN recipes r ON r.id = ri.recipe_id AND r.house_id = ?
    LEFT JOIN items i ON i.id = ri.item_id AND i.house_id = r.house_id
    LEFT JOIN catalog_products cp ON cp.code = i.off_code AND cp.project = i.off_project
    WHERE ri.recipe_id = ? ORDER BY ri.sort, ri.id`, [houseId, recipeId]);
  const warnings: DietWarning[] = [];
  for (const ingredient of ingredients) {
    const summary = parseJson<any>(ingredient.summary, {});
    const tags: string[] = Array.isArray(summary?.allergens) ? summary.allergens : [];
    for (const tag of new Set(tags.map(t => String(t).replace(/^en:/, "").replace(/ /g, "-").toLowerCase()))) {
      const members = profiles.filter(p => parseJson<string[]>(p.allergens, []).includes(tag)).map(p => String(p.name));
      if (members.length) warnings.push({ ingredient: ingredient.name, allergen: tag, members });
    }
  }
  const dietCompatibility: DietCompatibility[] = [];
  for (const p of profiles) for (const diet of parseJson<string[]>(p.diets, [])) {
    const statuses = ingredients.map(i => {
      const payload = parseJson<any>(i.payload, {});
      const tags: string[] = Array.isArray(payload?.ingredients_analysis_tags) ? payload.ingredients_analysis_tags : [];
      if (tags.includes(`en:non-${diet}`)) return "incompatible";
      if (tags.includes(`en:${diet}`)) return "compatible";
      return "unknown";
    });
    dietCompatibility.push({ member: p.name, diet, status: statuses.includes("incompatible") ? "incompatible" : statuses.length && statuses.every(s => s === "compatible") ? "compatible" : "unknown" });
  }
  return { warnings, dietCompatibility };
}

export async function unknownDietWarnings(houseId: string): Promise<{ warnings: DietWarning[]; dietCompatibility: DietCompatibility[] }> {
  const profiles = await all<any>(`SELECT p.diets, u.name FROM member_diet_profiles p JOIN house_members m
    ON m.house_id = p.house_id AND m.user_id = p.user_id JOIN users u ON u.id = p.user_id WHERE p.house_id = ?`, [houseId]);
  return { warnings: [] as DietWarning[], dietCompatibility: profiles.flatMap(p =>
    parseJson<string[]>(p.diets, []).map(diet => ({ member: String(p.name), diet, status: "unknown" as const }))) };
}

export async function ideaDietWarnings(houseId: string, idea: FoodIdea) {
  return idea.recipeId ? recipeDietWarnings(houseId, idea.recipeId) : unknownDietWarnings(houseId);
}
