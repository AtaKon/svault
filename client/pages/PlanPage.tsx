import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/api";
import { useHouse } from "@/state";
import { useI18n } from "@/i18n";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Select, Sheet, Skeleton } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { qty } from "@/format";
import { MEAL_SLOTS, type FoodIdea, type MealPlanEntry, type MealPlanWeek, type MealSlot, type Recipe } from "@shared/types";

const SLOT_LABELS: Record<MealSlot, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snacks",
};

const DAY_MS = 864e5;

function mondayOf(value?: string | null) {
  const date = value ? new Date(`${value}T00:00:00`) : new Date();
  const weekday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - weekday);
  date.setHours(0, 0, 0, 0);
  return date;
}

function dayKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

interface SavedIdeas {
  id: string;
  createdAt: string;
  ideas: FoodIdea[];
}

export function PlanPage() {
  const { house, can } = useHouse();
  const { t, locale } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const [weekStart, setWeekStart] = useState(() => dayKey(mondayOf()));
  const [week, setWeek] = useState<MealPlanWeek | null>(null);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [ideas, setIdeas] = useState<SavedIdeas[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState<{ day: string; slot: MealSlot } | null>(null);
  const [moveTarget, setMoveTarget] = useState<MealPlanEntry | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [plan, recipeList, ideaList] = await Promise.all([
        api<MealPlanWeek>(`/api/houses/${house.id}/plan?week=${weekStart}`),
        api<Recipe[]>(`/api/houses/${house.id}/recipes`),
        api<SavedIdeas[]>(`/api/houses/${house.id}/ideas`),
      ]);
      setWeek(plan);
      setRecipes(recipeList);
      setIdeas(ideaList);
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not load the meal plan"));
    } finally {
      setLoading(false);
    }
  }, [house.id, weekStart, toast, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const days = useMemo(() => {
    const start = mondayOf(weekStart);
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(start.getTime() + index * DAY_MS);
      return { key: dayKey(date), date };
    });
  }, [weekStart]);

  const byCell = useMemo(() => {
    const map = new Map<string, MealPlanEntry[]>();
    for (const entry of week?.entries ?? []) {
      const key = `${entry.day}:${entry.slot}`;
      (map.get(key) ?? map.set(key, []).get(key)!).push(entry);
    }
    return map;
  }, [week]);

  const shiftWeek = (daysToShift: number) => {
    const date = new Date(`${weekStart}T00:00:00`);
    date.setDate(date.getDate() + daysToShift);
    setWeekStart(dayKey(date));
  };

  const remove = async (entry: MealPlanEntry) => {
    try {
      await api(`/api/houses/${house.id}/plan/${entry.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not remove the meal"));
    }
  };

  const duplicate = async (entry: MealPlanEntry) => {
    try {
      await api(`/api/houses/${house.id}/plan/${entry.id}/duplicate`, { method: "POST", body: {} });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not duplicate the meal"));
    }
  };

  const addToShoppingList = async () => {
    setBusy(true);
    try {
      const result = await api<{ added: number; merged: number; skipped: number }>(
        `/api/houses/${house.id}/plan/shopping-list`,
        { method: "POST", body: { week: weekStart } },
      );
      const count = result.added + result.merged;
      if (count) {
        toast.success(t(count === 1 ? "Added {count} line to the shopping list" : "Added {count} lines to the shopping list", { count }));
        navigate("/shopping");
      } else {
        toast.push(t("Everything planned is already in stock or on the list"));
      }
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not build the shopping list"));
    } finally {
      setBusy(false);
    }
  };

  const today = dayKey(new Date());

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={house.name}
        title={t("Meal plan")}
        subtitle={t("Plan the week, scale servings and turn the missing ingredients into one shopping list.")}
        actions={
          <>
            <Button variant="secondary" icon="list" onClick={() => void addToShoppingList()} loading={busy} disabled={!can("member")}>
              {t("Shopping list")}
            </Button>
            <Button icon="plus" onClick={() => setAdding({ day: today, slot: "dinner" })} disabled={!can("member")}>
              {t("Plan a meal")}
            </Button>
          </>
        }
      />

      <Card className="flex flex-wrap items-center gap-2 p-3">
        <Button size="sm" variant="secondary" icon="arrowLeft" onClick={() => shiftWeek(-7)} aria-label={t("Previous week")}>
          {t("Previous")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setWeekStart(dayKey(mondayOf()))}>
          {t("This week")}
        </Button>
        <Button size="sm" variant="secondary" iconRight="chevronRight" onClick={() => shiftWeek(7)} aria-label={t("Next week")}>
          {t("Next")}
        </Button>
        <div className="ml-auto text-sm">
          <span className="font-medium">
            {new Date(`${weekStart}T00:00:00`).toLocaleDateString(locale, { day: "numeric", month: "long" })}
          </span>
          <span className="text-muted">
            {" "}
            – {new Date(new Date(`${weekStart}T00:00:00`).getTime() + 6 * DAY_MS).toLocaleDateString(locale, {
              day: "numeric",
              month: "long",
            })}
          </span>
        </div>
      </Card>

      {loading ? (
        <div className="grid gap-3 lg:grid-cols-7">
          {Array.from({ length: 7 }, (_, index) => (
            <Skeleton key={index} className="h-64" />
          ))}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-7">
          {days.map((day) => {
            const isToday = day.key === today;
            const weekday = day.date.toLocaleDateString(locale, { weekday: "short" });
            const label = day.date.toLocaleDateString(locale, { day: "numeric", month: "short" });
            return (
              <Card key={day.key} className={isToday ? "border-brand/50 p-2.5" : "p-2.5"}>
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{weekday}</div>
                    <div className="font-display text-lg leading-tight">{label}</div>
                  </div>
                  {isToday && <Badge tone="brand">{t("today")}</Badge>}
                </div>
                <div className="space-y-2">
                  {MEAL_SLOTS.map((slot) => {
                    const entries = byCell.get(`${day.key}:${slot}`) ?? [];
                    return (
                      <div key={slot}>
                        <div className="mb-1 flex items-center justify-between gap-1">
                          <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">{t(SLOT_LABELS[slot])}</span>
                          <button
                            onClick={() => setAdding({ day: day.key, slot })}
                            className="-my-2 -mr-2 flex h-9 w-9 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-ink md:my-0 md:mr-0 md:h-5 md:w-5"
                            aria-label={t("Add {meal} on {date}", { meal: t(SLOT_LABELS[slot]).toLowerCase(), date: label })}
                            disabled={!can("member")}
                          >
                            <Icon name="plus" size={12} />
                          </button>
                        </div>
                        {entries.length === 0 ? (
                          <div className="rounded-lg border border-dashed border-line/70 px-2 py-1.5 text-[10px] text-muted/60">—</div>
                        ) : (
                          <div className="space-y-1">
                            {entries.map((entry) => (
                              <div key={entry.id} className="rounded-lg border border-line bg-bg px-2 py-1.5">
                                <div className="text-[12px] font-medium leading-snug">{entry.title}</div>
                                <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted">
                                  {entry.servings != null && <span>{t("{count} servings", { count: qty(entry.servings) })}</span>}
                                  <div className="ml-auto flex items-center">
                                    <button
                                      onClick={() => setMoveTarget(entry)}
                                      className="rounded p-0.5 text-muted hover:text-brand"
                                      aria-label={t("Move {item}", { item: entry.title })}
                                      disabled={!can("member")}
                                    >
                                      <Icon name="calendar" size={11} />
                                    </button>
                                    <button
                                      onClick={() => void duplicate(entry)}
                                      className="rounded p-0.5 text-muted hover:text-brand"
                                      aria-label={t("Duplicate {item}", { item: entry.title })}
                                      disabled={!can("member")}
                                    >
                                      <Icon name="grid" size={11} />
                                    </button>
                                    <button
                                      onClick={() => void remove(entry)}
                                      className="rounded p-0.5 text-muted hover:text-danger"
                                      aria-label={t("Remove {item}", { item: entry.title })}
                                      disabled={!can("member")}
                                    >
                                      <Icon name="close" size={11} />
                                    </button>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {!loading && (week?.entries.length ?? 0) === 0 && (
        <EmptyState
          icon="calendar"
          title={t("This week is empty")}
          body={t("Pick a saved recipe or food idea for any slot. Servings scale the ingredients without changing the recipe.")}
          action={<Button onClick={() => setAdding({ day: today, slot: "dinner" })}>{t("Plan the first meal")}</Button>}
        />
      )}

      <AddPlanSheet
        target={adding}
        houseId={house.id}
        recipes={recipes}
        ideas={ideas}
        onClose={() => setAdding(null)}
        onSaved={async () => {
          setAdding(null);
          await load();
        }}
      />

      <MovePlanSheet
        entry={moveTarget}
        houseId={house.id}
        onClose={() => setMoveTarget(null)}
        onSaved={async () => {
          setMoveTarget(null);
          await load();
        }}
      />
    </div>
  );
}

function AddPlanSheet({
  target,
  houseId,
  recipes,
  ideas,
  onClose,
  onSaved,
}: {
  target: { day: string; slot: MealSlot } | null;
  houseId: string;
  recipes: Recipe[];
  ideas: SavedIdeas[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [kind, setKind] = useState<"recipe" | "idea" | "custom">("recipe");
  const [recipeId, setRecipeId] = useState("");
  const [ideaKey, setIdeaKey] = useState("");
  const [title, setTitle] = useState("");
  const [servings, setServings] = useState("");
  const [day, setDay] = useState("");
  const [slot, setSlot] = useState<MealSlot>("dinner");
  const [busy, setBusy] = useState(false);

  const flatIdeas = useMemo(
    () =>
      ideas.flatMap((entry) =>
        entry.ideas.map((idea, index) => ({
          key: `${entry.id}:${index}`,
          ideaId: entry.id,
          index,
          title: idea.title,
          servings: idea.servings,
        })),
      ),
    [ideas],
  );

  useEffect(() => {
    if (!target) return;
    setKind(recipes.length ? "recipe" : flatIdeas.length ? "idea" : "custom");
    setRecipeId(recipes[0]?.id ?? "");
    setIdeaKey(flatIdeas[0]?.key ?? "");
    setTitle("");
    setServings("");
    setDay(target.day);
    setSlot(target.slot);
  }, [target, recipes, flatIdeas]);

  useEffect(() => {
    if (kind === "recipe") {
      const recipe = recipes.find((entry) => entry.id === recipeId);
      setServings(recipe?.servings != null ? String(recipe.servings) : "");
    } else if (kind === "idea") {
      const idea = flatIdeas.find((entry) => entry.key === ideaKey);
      setServings(idea?.servings != null ? String(idea.servings) : "");
    }
  }, [kind, recipeId, ideaKey, recipes, flatIdeas]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!target) return;
    setBusy(true);
    try {
      const chosen = flatIdeas.find((entry) => entry.key === ideaKey);
      await api(`/api/houses/${houseId}/plan`, {
        method: "POST",
        body: {
          day,
          slot,
          recipeId: kind === "recipe" ? recipeId || null : null,
          ideaId: kind === "idea" ? chosen?.ideaId ?? null : null,
          ideaIndex: kind === "idea" ? chosen?.index ?? 0 : null,
          title: kind === "custom" ? title.trim() || null : null,
          servings: servings.trim() === "" ? null : Number(servings),
        },
      });
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not plan the meal"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={Boolean(target)}
      onClose={onClose}
      title={t("Plan a meal")}
      description={t("The plan is shared with everyone in this house.")}
      footer={
        <Button block onClick={submit} loading={busy} disabled={kind === "custom" ? !title.trim() : kind === "recipe" ? !recipeId : !ideaKey}>
          {t("Add to plan")}
        </Button>
      }
    >
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("Day")}>
            <input
              type="date"
              value={day}
              onChange={(event) => setDay(event.target.value)}
              className="h-11 w-full rounded-xl border border-line bg-surface px-3 text-[15px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/15"
            />
          </Field>
          <Field label={t("Meal")}>
            <Select value={slot} onChange={(event) => setSlot(event.target.value as MealSlot)}>
              {MEAL_SLOTS.map((entry) => (
                <option key={entry} value={entry}>
                  {t(SLOT_LABELS[entry])}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {[
            { value: "recipe", label: t("Recipe") },
            { value: "idea", label: t("Food idea") },
            { value: "custom", label: t("Custom") },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setKind(option.value as typeof kind)}
              className={
                kind === option.value
                  ? "rounded-full bg-ink px-3 py-1 text-[12px] font-medium text-bg"
                  : "rounded-full border border-line px-3 py-1 text-[12px] text-muted hover:bg-raised"
              }
            >
              {option.label}
            </button>
          ))}
        </div>

        {kind === "recipe" && (
          <Field label={t("Recipe")}>
            <Select value={recipeId} onChange={(event) => setRecipeId(event.target.value)}>
              {recipes.map((recipe) => (
                <option key={recipe.id} value={recipe.id}>
                  {recipe.title}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {kind === "idea" && (
          <Field label={t("Food idea")}>
            <Select value={ideaKey} onChange={(event) => setIdeaKey(event.target.value)}>
              {flatIdeas.map((idea) => (
                <option key={idea.key} value={idea.key}>
                  {idea.title}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {kind === "custom" && (
          <Field label={t("Title")} required>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t("Leftovers, takeaway…")}
              maxLength={160}
              className="h-11 w-full rounded-xl border border-line bg-surface px-3 text-[15px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/15"
            />
          </Field>
        )}
        <Field label={t("Servings")} hint={t("scales the ingredients")}>
          <input
            value={servings}
            onChange={(event) => setServings(event.target.value)}
            inputMode="decimal"
            className="h-11 w-full rounded-xl border border-line bg-surface px-3 text-[15px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/15"
          />
        </Field>
      </form>
    </Sheet>
  );
}

function MovePlanSheet({
  entry,
  houseId,
  onClose,
  onSaved,
}: {
  entry: MealPlanEntry | null;
  houseId: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [day, setDay] = useState("");
  const [slot, setSlot] = useState<MealSlot>("dinner");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!entry) return;
    setDay(entry.day);
    setSlot(entry.slot);
  }, [entry]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!entry) return;
    setBusy(true);
    try {
      await api(`/api/houses/${houseId}/plan/${entry.id}`, { method: "PATCH", body: { day, slot } });
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not move the meal"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={Boolean(entry)}
      onClose={onClose}
      title={t("Move {item}", { item: entry?.title ?? t("meal") })}
      description={t("Choose another day or meal slot. No drag and drop needed.")}
      footer={
        <Button block onClick={submit} loading={busy} disabled={!day}>
          {t("Move meal")}
        </Button>
      }
    >
      <form onSubmit={submit} className="space-y-3">
        <input
          type="date"
          value={day}
          onChange={(event) => setDay(event.target.value)}
          className="h-11 w-full rounded-xl border border-line bg-surface px-3 text-[15px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/15"
          aria-label={t("Destination day")}
        />
        <Select value={slot} onChange={(event) => setSlot(event.target.value as MealSlot)} aria-label={t("Destination meal")}>
          {MEAL_SLOTS.map((entry) => (
            <option key={entry} value={entry}>
              {t(SLOT_LABELS[entry])}
            </option>
          ))}
        </Select>
      </form>
    </Sheet>
  );
}
