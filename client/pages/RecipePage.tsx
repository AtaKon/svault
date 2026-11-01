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
import { useToast } from "@/components/toast";
import { minutesLabel, plural, qty, relativeTime } from "@/format";
import type { Recipe } from "@shared/types";

export function RecipePage() {
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
      setError(err instanceof Error ? err.message : "Could not load the recipe");
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
      toast.success("Recipe refreshed with AI");
    } catch (err) {
      const message = err instanceof Error ? err.message : "AI assistance failed";
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
      toast.success("Recipe deleted");
      navigate("/recipes", { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete the recipe");
      setDeleting(false);
    }
  };

  if (error) {
    return (
      <EmptyState icon="book" title="Recipe not found" body={error} action={<Button onClick={() => navigate("/recipes")}>Back to recipes</Button>} />
    );
  }
  if (!recipe) return <LoadingBlock label="Loading recipe" />;

  const missingNames = new Set((recipe.match?.missing ?? []).map((item) => item.name.toLowerCase()));
  const totalMinutes = (recipe.prepMinutes ?? 0) + (recipe.cookMinutes ?? 0);

  return (
    <div className="space-y-4">
      <PageHeader
        back={() => navigate(-1)}
        eyebrow={recipe.source === "scan" ? "Scanned recipe" : recipe.source === "ai" ? "AI idea" : "Recipe"}
        title={recipe.title}
        subtitle={recipe.description || undefined}
        actions={
          <>
            <button
              onClick={() => void toggleFavorite()}
              aria-label="Toggle favourite"
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
                aria-label="Edit recipe"
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
            {recipe.match.available} of {recipe.match.total} ingredients in stock
          </Badge>
        )}
        {recipe.tags.map((tag) => (
          <Badge key={tag} tone="neutral">
            {tag}
          </Badge>
        ))}
        <span className="text-[11px] text-muted">updated {relativeTime(recipe.updatedAt)}</span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr]">
        <div className="space-y-4">
          {(recipe.image || recipe.sourceImage) && (
            <Card className="overflow-hidden">
              <img
                src={recipe.image ?? recipe.sourceImage ?? ""}
                alt={recipe.title}
                className="max-h-72 w-full object-cover"
              />
              {recipe.sourceImage && (
                <div className="flex items-center justify-between px-3 py-2 text-[11px] text-muted">
                  <span className="inline-flex items-center gap-1">
                    <Icon name="camera" size={12} /> Original scan
                  </span>
                  <a href={recipe.sourceImage} target="_blank" rel="noreferrer" className="font-medium text-brand hover:underline">
                    Open full size
                  </a>
                </div>
              )}
            </Card>
          )}

          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-display text-lg">Ingredients</h2>
              <span className="text-[11px] text-muted">{recipe.ingredients.length}</span>
            </div>
            {recipe.ingredients.length === 0 ? (
              <p className="text-sm text-muted">No ingredients recorded yet.</p>
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
                        {ingredient.optional && <span className="text-[11px] text-muted"> (optional)</span>}
                        {ingredient.note && <span className="block text-[11px] text-muted">{ingredient.note}</span>}
                      </span>
                      {ingredient.itemId && (
                        <button
                          onClick={() => navigate(`/items/${ingredient.itemId}`)}
                          className="text-muted transition-colors hover:text-brand"
                          aria-label="Open item"
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
                <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-warn">Missing</div>
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
                <p className="mt-1.5 text-[11px] text-warn/80">Tap one to add it to your inventory.</p>
              </div>
            )}
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-lg">AI polish</h2>
              <Button size="sm" variant="soft" icon="sparkles" loading={aiBusy} onClick={() => void improve()} disabled={!can("member")}>
                Improve
              </Button>
            </div>
            {aiBusy ? (
              <div className="mt-3 flex items-center gap-2 rounded-xl bg-brand-soft px-3 py-2.5 text-xs text-brand">
                <Spinner size={14} /> Reading the notes, filling gaps and tidying the steps…
              </div>
            ) : (
              <p className="mt-2 text-xs leading-relaxed text-muted">
                Let AI fill missing quantities, add temperatures and timings, and rewrite steps so they are easy to follow.
                It keeps your ingredients and explains what it changed.
              </p>
            )}
            {recipe.aiNotes && (
              <div className="mt-3 rounded-xl border border-line bg-raised p-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">AI notes</div>
                <p className="mt-1 whitespace-pre-line text-xs leading-relaxed">{recipe.aiNotes}</p>
              </div>
            )}
            {aiHint && <p className="mt-2 text-[11px] text-danger">{aiHint}</p>}
            {!recipe.aiNotes && !aiBusy && (
              <p className="mt-2 text-[11px] text-muted">
                No AI provider? Add an OpenAI-compatible key in Settings → AI. Without one, scans still parse locally.
              </p>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-lg">Method</h2>
              <span className="text-[11px] text-muted">{recipe.steps.length} steps</span>
            </div>
            {recipe.steps.length === 0 ? (
              <p className="text-sm text-muted">No steps yet — add them in the editor or let AI rebuild the method.</p>
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
            <p className="mt-3 text-[11px] text-muted">Tap a step to tick it off while you cook.</p>
          </Card>

          <Card className="p-4">
            <h2 className="mb-2 font-display text-lg">More</h2>
            <div className="space-y-1.5">
              <button
                onClick={() => navigate(`/ideas`)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-raised"
              >
                <Icon name="sparkles" size={16} className="text-muted" />
                <span className="flex-1">Ask for ideas using this kitchen</span>
                <Icon name="chevronRight" size={14} className="text-muted" />
              </button>
              <button
                onClick={() => navigate("/photos")}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-raised"
              >
                <Icon name="image" size={16} className="text-muted" />
                <span className="flex-1">Photo library</span>
                <Icon name="chevronRight" size={14} className="text-muted" />
              </button>
              {can("member") && (
                <button
                  onClick={() => setDeleteOpen(true)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm text-danger transition-colors hover:bg-danger-soft"
                >
                  <Icon name="trash" size={16} />
                  <span className="flex-1">Delete recipe</span>
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
        title={`Delete ${recipe.title}?`}
        body="The recipe and its ingredient list will be removed from this house."
        confirmLabel="Delete recipe"
        loading={deleting}
      />
      <p className="text-center text-[10px] text-muted">Recipe from {house.name}</p>
    </div>
  );
}
