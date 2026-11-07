import { get, run, now } from "../db.js";
import { ApiError } from "../http.js";

export const AI_BUDGET_KEY = "ai_monthly_budget";

/** Instance-wide AI spend limit for a calendar month, in USD. 0 disables it. */
export async function aiMonthlyBudget(): Promise<number> {
  const row = await get<{ value: string }>("SELECT value FROM instance_settings WHERE key = ?", [AI_BUDGET_KEY]);
  const value = Number(row?.value ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export async function aiSpendThisMonth(): Promise<number> {
  const month = new Date().toISOString().slice(0, 7);
  const row = await get<{ cost: number }>(
    "SELECT COALESCE(SUM(cost), 0) AS cost FROM ai_call_logs WHERE substr(created_at, 1, 7) = ?",
    [month],
  );
  const value = Number(row?.cost ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export async function saveAiMonthlyBudget(value: number): Promise<number> {
  const budget = Math.max(0, Math.min(Number(value) || 0, 1e6));
  if (budget === 0) {
    await run("DELETE FROM instance_settings WHERE key = ?", [AI_BUDGET_KEY]);
  } else {
    await run(
      `INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [AI_BUDGET_KEY, String(budget), now()],
    );
  }
  return budget;
}

/**
 * Called before every AI endpoint. The limit is instance-wide because the
 * provider key and its bill usually belong to the instance, not a house.
 */
export async function assertAiBudget(): Promise<void> {
  const budget = await aiMonthlyBudget();
  if (budget <= 0) return;
  const spent = await aiSpendThisMonth();
  if (spent >= budget) {
    throw new ApiError(
      429,
      `The AI budget for this month is used up ($${spent.toFixed(2)} of $${budget.toFixed(2)}). An instance administrator can raise it in the admin console.`,
    );
  }
}
