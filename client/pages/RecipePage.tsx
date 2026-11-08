import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "@/api";
import { useHouse } from "@/state";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  LoadingBlock,
  PageHeader,
  Spinner,
  cn,
} from "@/components/ui";
import { Icon } from "@/components/icons";
import { NutritionRows } from "@/components/Nutrition";
import { ZoomableImage } from "@/components/ZoomableImage";
import { useToast } from "@/components/toast";
import { aiCostLabel, minutesLabel, plural, qty, relativeTime } from "@/format";
import type { Recipe } from "@shared/types";
import { useI18n } from "@/i18n";

export function RecipePage() {
  const { t } = useI18n();
  const { recipeId = "" } = useParams();
  const { house, can } = useHouse();
  const navigate = useNavigate();
  const toast = useToast();
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [aiHint, setAiHint] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<Recipe>(`/api/recipes/${recipeId}`);
      setRecipe(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? t(err.message) : t("Could not load the recipe"));
    }
  }, [recipeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleFavorite = async () => {
    if (!recipe) return;
    const next = !recipe.favorite;
    setRecipe({ ...recipe, favorite: next });
    try {
      await api(`/api/recipes/${recipe.id}/favorite`, { method: "POST", body: { favorite: next } });
    } catch {
      setRecipe({ ...recipe, favorite: !next });
    }
  };

  const improve = async () => {
    if (!recipe) return;
    setAiBusy(true);
    setAiHint(null);
    try {
      const updated = await api<Recipe>(`/api/recipes/${recipe.id}/ai`, { method: "POST", body: { action: "complete" } });
      setRecipe(updated);
      toast.success(t("Recipe refreshed with AI"));
    } catch (err) {
      const message = err instanceof Error ? t(err.message) : t("AI assistance failed");
      setAiHint(message);
      toast.error(message);
    } finally {
      setAiBusy(false);
    }
  };

  const remove = async () => {
    if (!recipe) return;
    setDeleting(true);
    try {
      await api(`/api/recipes/${recipe.id}`, { method: "DELETE" });
      toast.success(t("Recipe deleted"));
      navigate("/recipes", { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not delete the recipe"));
      setDeleting(false);
    }
  };

  const addToShoppingList = async (includeOptional: boolean, missingOnly: boolean) => {
    if (!recipe) return;
    try {
      const result = await api<{ added: number; merged: number; skipped: number }>(
        `/api/houses/${house.id}/shopping/from-recipe`,
        { method: "POST", body: { recipeId: recipe.id, includeOptional, missingOnly } },
      );
      const count = result.added + result.merged;
      if (count) {
        toast.success(t("Added {count} ingredients to the shopping list", { count }));
        navigate("/shopping");
      } else {
        toast.push(t("Everything is already in stock or on the list"));
      }
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not build the shopping list"));
    }
  };

  if (error) {
    return (
      <EmptyState icon="book" title={t("Recipe not found")} body={error} action={<Button onClick={() => navigate("/recipes")}>{t("Back to recipes")}</Button>} />
    );
  }
  if (!recipe) return <LoadingBlock label={t("Loading recipe")} />;

  const missingNames = new Set((recipe.match?.missing ?? []).map((item) => item.name.toLowerCase()));
  const totalMinutes = (recipe.prepMinutes ?? 0) + (recipe.cookMinutes ?? 0);

  return (
    <div className="space-y-4">
      <PageHeader
        back={() => navigate(-1)}
        eyebrow={recipe.source === "scan" ? t("Scanned recipe") : recipe.source === "ai" ? t("AI idea") : t("Recipe")}
        title={recipe.title}
        subtitle={recipe.description || undefined}
        actions={
          <>
            <button
              onClick={() => void toggleFavorite()}
              aria-label={t("Toggle favourite")}
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-xl border transition-colors",
                recipe.favorite ? "border-brand/40 bg-brand-soft text-brand" : "border-line bg-surface text-muted hover:text-ink",
              )}
            >
              <Icon name="heart" size={18} fill={recipe.favorite ? "currentColor" : "none"} />
            </button>
            {can("member") && (
              <button
                onClick={() => navigate(`/recipes/${recipe.id}/edit`)}
                aria-label={t("Edit recipe")}
                className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-surface text-muted transition-colors hover:text-ink"
              >
                <Icon name="pencil" size={17} />
              </button>
            )}
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-1.5">
        {recipe.servings ? <Badge tone="outline">{plural(recipe.servings, "serving")}</Badge> : null}
        {totalMinutes > 0 && <Badge tone="outline"><Icon name="clock" size={11} /> {minutesLabel(totalMinutes)}</Badge>}
        {recipe.match && (
          <Badge tone={recipe.match.coverage >= 0.75 ? "brand" : recipe.match.coverage >= 0.4 ? "warn" : "neutral"}>
            {recipe.match.available} {' '}{t(" of ")}{' '}{recipe.match.total} {' '}{t(" ingredients in stock ")}</Badge>
        )}
        {recipe.nutrition?.perServing?.energyKcal != null && (
          <Badge tone="outline">~{Math.round(recipe.nutrition.perServing.energyKcal)} {' '}{t(" kcal / portion")}</Badge>
        )}
        {recipe.tags.map((tag) => (
          <Badge key={tag} tone="neutral">
            {tag}
          </Badge>
        ))}
        <span className="text-[11px] text-muted">{t("updated ")}{' '}{relativeTime(recipe.updatedAt)}</span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr]">
        <div className="space-y-4">
          {(recipe.image || recipe.sourceImage) && (
            <Card className="overflow-hidden">
              <ZoomableImage
                src={recipe.image ?? recipe.sourceImage ?? ""}
                alt={recipe.title}
                className="max-h-72 w-full object-cover"
              />
              {recipe.sourceImage && (
                <div className="flex items-center justify-between px-3 py-2 text-[11px] text-muted">
                  <span className="inline-flex items-center gap-1">
                    <Icon name="camera" size={12} /> {' '}{t(" Original scan ")}</span>
                  <a href={recipe.sourceImage} target="_blank" rel="noreferrer" className="font-medium text-brand hover:underline">
                    {t("Open full size ")}</a>
                </div>
              )}
            </Card>
          )}

          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-display text-lg">{t("Ingredients")}</h2>
              <span className="text-[11px] text-muted">{recipe.ingredients.length}</span>
            </div>
            {recipe.ingredients.length === 0 ? (
              <p className="text-sm text-muted">{t("No ingredients recorded yet.")}</p>
            ) : (
              <ul className="divide-y divide-line">
                {recipe.ingredients.map((ingredient, index) => {
                  const stocked = ingredient.available ?? !missingNames.has(ingredient.name.toLowerCase());
                  return (
                    <li key={ingredient.id ?? `${ingredient.name}-${index}`} className="flex items-center gap-3 py-2">
                      <span
                        className={cn(
                          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px]",
                          stocked ? "bg-brand-soft text-brand" : "bg-raised text-muted",
                        )}
                      >
                        {stocked ? <Icon name="check" size={12} /> : <Icon name="minus" size={11} />}
                      </span>
                      <span className="min-w-0 flex-1 text-sm">
                        {ingredient.quantity != null && <span className="font-medium">{qty(ingredient.quantity)} </span>}
                        {ingredient.unit && <span className="text-muted">{ingredient.unit} </span>}
                        {ingredient.name}
                        {ingredient.optional && <span className="text-[11px] text-muted"> {' '}{t(" (optional)")}</span>}
                        {ingredient.note && <span className="block text-[11px] text-muted">{ingredient.note}</span>}
                      </span>
                      {ingredient.itemId && (
                        <button
                          onClick={() => navigate(`/items/${ingredient.itemId}`)}
                          className="text-muted transition-colors hover:text-brand"
                          aria-label={t("Open item")}
                        >
                          <Icon name="arrowUpRight" size={14} />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {recipe.match && recipe.match.missing.length > 0 && (
              <div className="mt-3 rounded-xl bg-warn-soft p-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-warn">{t("Missing")}</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {recipe.match.missing.map((item) => (
                    <button
                      key={item.name}
                      onClick={() => navigate(`/items/new?name=${encodeURIComponent(item.name)}`)}
                      className="inline-flex items-center gap-1 rounded-full border border-warn/30 bg-surface px-2 py-0.5 text-[11px] text-warn hover:border-warn"
                    >
                      <Icon name="plus" size={10} /> {item.name}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] text-warn/80">{t("Tap one to add it to your inventory.")}</p>
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="soft" icon="list" onClick={() => void addToShoppingList(false, true)} disabled={!can("member")}>
                {t("Add missing to list ")}</Button>
              <Button size="sm" variant="secondary" icon="plus" onClick={() => void addToShoppingList(true, false)} disabled={!can("member")}>
                {t("Add all (optional too) ")}</Button>
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-lg">{t("AI polish")}</h2>
              <div className="flex items-center gap-1.5">
                {recipe.aiCost != null && <Badge tone="outline">{aiCostLabel(recipe.aiCost)}</Badge>}
                <Button size="sm" variant="soft" icon="sparkles" loading={aiBusy} onClick={() => void improve()} disabled={!can("member")}>
                  {t("Improve ")}</Button>
              </div>
            </div>
            {aiBusy ? (
              <div role="status" className="mt-3 flex items-center gap-2 rounded-xl bg-brand-soft px-3 py-2.5 text-xs text-brand">
                <Spinner size={14} /> {t("Reading the notes, filling gaps and tidying the steps…")}</div>
            ) : (
              <p className="mt-2 text-xs leading-relaxed text-muted">
                {t("Let AI fill missing quantities, add temperatures and timings, and rewrite steps so they are easy to follow. It keeps your ingredients and explains what it changed. ")}</p>
            )}
            {recipe.aiNotes && (
              <div className="mt-3 rounded-xl border border-line bg-raised p-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{t("AI notes")}</div>
                <p className="mt-1 whitespace-pre-line text-xs leading-relaxed">{recipe.aiNotes}</p>
              </div>
            )}
            {aiHint && <p className="mt-2 text-[11px] text-danger">{aiHint}</p>}
            {!recipe.aiNotes && !aiBusy && (
              <p className="mt-2 text-[11px] text-muted">
                {t("No AI provider? Add an OpenAI-compatible key in Settings → AI. Without one, scans still parse locally. ")}</p>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="font-display text-lg">{t("Nutrition")}</h2>
              {recipe.nutrition && <Badge tone="outline">{t("estimated")}</Badge>}
            </div>
            {recipe.nutrition ? (
              <>
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                      {recipe.nutrition.perServing ? t("Per portion") : t("Whole recipe")}
                    </div>
                    <div className="mt-0.5 font-display text-4xl leading-none">
                      {Math.round(
                        (recipe.nutrition.perServing ?? recipe.nutrition.total).energyKcal ?? 0,
                      )}
                      <span className="ml-1 text-sm text-muted">{t("kcal")}</span>
                    </div>
                  </div>
                  {recipe.nutrition.perServing && (
                    <div className="text-right text-[11px] text-muted">
                      {Math.round(recipe.nutrition.total.energyKcal ?? 0)} {' '}{t(" kcal total ")}{recipe.nutrition.servings ? t(" · {count} portions", { count: recipe.nutrition.servings }) : ""}
                    </div>
                  )}
                </div>
                <div className="mt-3">
                  <NutritionRows values={recipe.nutrition.perServing ?? recipe.nutrition.total} />
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-muted">
                  {t("Estimated from ")}{' '}{recipe.nutrition.matched} {' '}{t(" of ")}{' '}{recipe.nutrition.ingredients} {' '}{t(" ingredients ")}{recipe.nutrition.coverage < 1
                    ? t(" — add nutrition to the remaining items for a closer number.")
                    : "."}
                </p>
              </>
            ) : (
              <p className="text-xs leading-relaxed text-muted">
                {t("No estimate yet. Ingredients that match inventory items with nutrition data are summed automatically. Link an OpenFoodFacts product or enter the label values on an item to start. ")}</p>
            )}
          </Card>

          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-lg">{t("Method")}</h2>
              <span className="text-[11px] text-muted">{recipe.steps.length} {' '}{t(" steps")}</span>
            </div>
            {recipe.steps.length === 0 ? (
              <p className="text-sm text-muted">{t("No steps yet — add them in the editor or let AI rebuild the method.")}</p>
            ) : (
              <ol className="space-y-2.5">
                {recipe.steps.map((step, index) => (
                  <li key={index}>
                    <button
                      onClick={() =>
                        setDone((current) => {
                          const next = new Set(current);
                          if (next.has(index)) next.delete(index);
                          else next.add(index);
                          return next;
                        })
                      }
                      className={cn(
                        "flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors",
                        done.has(index) ? "border-brand/30 bg-brand-soft/60" : "border-line bg-surface hover:bg-raised",
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                          done.has(index) ? "bg-brand text-brand-ink" : "bg-raised text-muted",
                        )}
                      >
                        {done.has(index) ? <Icon name="check" size={12} /> : index + 1}
                      </span>
                      <span className={cn("flex-1 text-sm leading-relaxed", done.has(index) && "text-muted line-through")}>
                        {step.text}
                        {step.timerSeconds ? (
                          <span className="mt-1 flex items-center gap-1 text-[11px] font-medium text-brand">
                            <Icon name="clock" size={11} /> {minutesLabel(Math.round(step.timerSeconds / 60))}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-3 text-[11px] text-muted">{t("Tap a step to tick it off while you cook.")}</p>
          </Card>

          <Card className="p-4">
            <h2 className="mb-2 font-display text-lg">{t("More")}</h2>
            <div className="space-y-1.5">
              <button
                onClick={() => navigate(`/ideas`)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-raised"
              >
                <Icon name="sparkles" size={16} className="text-muted" />
                <span className="flex-1">{t("Ask for ideas using this kitchen")}</span>
                <Icon name="chevronRight" size={14} className="text-muted" />
              </button>
              <button
                onClick={() => navigate("/photos")}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-raised"
              >
                <Icon name="image" size={16} className="text-muted" />
                <span className="flex-1">{t("Photo library")}</span>
                <Icon name="chevronRight" size={14} className="text-muted" />
              </button>
              {can("member") && (
                <button
                  onClick={() => setDeleteOpen(true)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm text-danger transition-colors hover:bg-danger-soft"
                >
                  <Icon name="trash" size={16} />
                  <span className="flex-1">{t("Delete recipe")}</span>
                </button>
              )}
            </div>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => void remove()}
        title={t("Delete {name}?", { name: recipe.title })}
        body={t("The recipe and its ingredient list will be removed from this house.")}
        confirmLabel={t("Delete recipe")}
        loading={deleting}
      />
      <p className="text-center text-[10px] text-muted">{t("Recipe from ")}{' '}{house.name}</p>
    </div>
  );
}
