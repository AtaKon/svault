import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "@/api";
import { Badge, Button, Card, EmptyState, LoadingBlock, Sheet, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { minutesLabel, plural, qty } from "@/format";
import {
  estimateIngredientGrams,
  gramsLabel,
  recipePortion,
  scaledQuantity,
} from "@shared/recipe-grams";
import { scaledCalories } from "@shared/recipe-calories";
import type { Location, Recipe } from "@shared/types";
import { useHouse } from "@/state";
import { useI18n } from "@/i18n";

/** Scale an ingredient line and keep a readable quantity. */
function scaled(quantity: number | null, base: number | null, portions: number): number | null {
  const value = scaledQuantity(quantity, base, portions);
  return value == null ? null : Math.round(value * 1000) / 1000;
}

export function RecipeCookPage() {
  const { t } = useI18n();
  const { house, can } = useHouse();
  const { recipeId = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [locations, setLocations] = useState<Location[]>([]);
  const [reviewLines, setReviewLines] = useState<{ ingredientId: string; itemId: string; name: string; quantity: string; unit: string; enabled: boolean }[]>([]);
  const [saveLeftovers, setSaveLeftovers] = useState(false);
  const [leftoverPortions, setLeftoverPortions] = useState("1");
  const [locationId, setLocationId] = useState("");
  const [useBy, setUseBy] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 3); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
  const [cookKey, setCookKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ lines: { name: string; shortfall: number; unit: string }[] } | null>(null);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [portions, setPortions] = useState(1);
  const [inGrams, setInGrams] = useState(true);
  const [doneIngredients, setDoneIngredients] = useState<Set<number>>(new Set());
  const [doneSteps, setDoneSteps] = useState<Set<number>>(new Set());

  useEffect(() => {
    api<Recipe>(`/api/recipes/${recipeId}`)
      .then((data) => {
        setRecipe(data);
        setPortions(Math.max(1, data.servings ?? 1));
      })
      .catch((err) => {
        const message = err instanceof Error ? t(err.message) : t("Could not load the recipe");
        setError(message);
        toast.error(message);
      });
    // t/toast come from context and are stable for the life of the page; adding
    // them to the deps would reload the recipe (and reset the portions) when the
    // language changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipeId]);

  useEffect(() => {
    api<Location[]>(`/api/houses/${house.id}/locations`).then(setLocations).catch(() => toast.error(t("Could not load locations")));
  }, [house.id]);

  // Keep the screen on while cooking, when the browser supports it. The browser
  // drops the lock when the tab is hidden, so it is requested again on return.
  useEffect(() => {
    const wakeLock = (navigator as Navigator & { wakeLock?: { request: (type: string) => Promise<{ release?: () => Promise<void> }> } }).wakeLock;
    if (!wakeLock?.request) return;
    let sentinel: { release?: () => Promise<void> } | null = null;
    let cancelled = false;
    const request = () => {
      wakeLock
        .request("screen")
        .then((lock) => {
          if (cancelled) void lock.release?.().catch(() => undefined);
          else sentinel = lock;
        })
        .catch(() => undefined);
    };
    const onVisibility = () => {
      if (!cancelled && document.visibilityState === "visible") request();
    };
    request();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release?.().catch(() => undefined);
    };
  }, []);

  // Without a serving count there is nothing to scale against; the portions
  // control then only divides the same recipe into more servings.
  const baseServings = recipe?.servings != null && recipe.servings > 0 ? recipe.servings : null;
  const base = baseServings ?? 1;

  const visibleIngredients = useMemo(() => {
    if (!recipe) return [];
    return recipe.ingredients.map((ingredient, index) => {
      // Convert from the unrounded quantity: rounding first can zero out very
      // small amounts before the gram estimate runs.
      const raw = scaledQuantity(ingredient.quantity, baseServings, portions);
      const quantity = scaled(ingredient.quantity, baseServings, portions);
      const grams = estimateIngredientGrams({ name: ingredient.name, quantity: raw, unit: ingredient.unit }).grams;
      return { ingredient, index, quantity, grams };
    });
  }, [recipe, baseServings, portions]);

  const scaledPortion = useMemo(() => {
    if (!recipe) return null;
    return recipePortion(
      recipe.ingredients.map((ingredient) => ({
        name: ingredient.name,
        quantity: scaled(ingredient.quantity, baseServings, portions),
        unit: ingredient.unit,
      })),
      portions,
    );
  }, [recipe, baseServings, portions]);

  if (error) {
    return (
      <EmptyState
        icon="utensils"
        title={t("Recipe not found")}
        body={error}
        action={<Button onClick={() => navigate("/recipes")}>{t("Back to recipes")}</Button>}
      />
    );
  }
  if (!recipe) return <LoadingBlock label={t("Loading cook mode")} />;

  const toggle = (set: Set<number>, setter: (next: Set<number>) => void, index: number) => {
    const next = new Set(set);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setter(next);
  };

  const openReview = () => {
    setReviewLines(visibleIngredients.filter(({ ingredient }) => ingredient.itemId && ingredient.id).map(({ ingredient, quantity }) => ({
      ingredientId: ingredient.id!, itemId: ingredient.itemId!, name: ingredient.name,
      quantity: quantity == null ? "" : String(quantity), unit: ingredient.unit ?? "", enabled: true,
    })));
    setCookKey(crypto.randomUUID());
    setResult(null);
    setReviewOpen(true);
  };
  const confirmCook = async () => {
    const selected = reviewLines.filter((line) => line.enabled);
    if (selected.some((line) => !line.unit.trim() || !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0) ||
        (saveLeftovers && (!Number.isFinite(Number(leftoverPortions)) || Number(leftoverPortions) <= 0 || !useBy))) {
      toast.error(t("Enter a positive quantity and unit for each selected ingredient."));
      return;
    }
    setSaving(true);
    try {
      const response = await api<{ lines: { name: string; shortfall: number; unit: string }[] }>(`/api/recipes/${recipe.id}/cook`, { body: {
        portions, idempotencyKey: cookKey,
        lines: selected.map(({ ingredientId, itemId, quantity, unit }) => ({ ingredientId, itemId, quantity: Number(quantity), unit })),
        ...(saveLeftovers ? { leftovers: { portions: Number(leftoverPortions), locationId: locationId || null, useBy } } : {}),
      } });
      setResult(response);
    } catch (err) { toast.error(err instanceof Error ? t(err.message) : t("Could not finish cooking")); }
    finally { setSaving(false); }
  };

  // Keep the two figures consistent: whatever the whole scaled recipe holds,
  // one portion is that divided by the number of portions being cooked.
  const { totalKcal, perPortionKcal: kcalPerPortion } = scaledCalories(
    {
      totalKcal: recipe.nutrition?.total.energyKcal ?? null,
      perServingKcal: recipe.nutrition?.perServing?.energyKcal ?? null,
    },
    baseServings,
    portions,
  );

  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-24">
      <div className="sticky top-0 z-20 -mx-3 flex flex-wrap items-center gap-2 border-b border-line bg-bg/95 px-3 py-2 backdrop-blur sm:-mx-4 sm:px-4">
        <button
          onClick={() => navigate(`/recipes/${recipe.id}`)}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line bg-surface text-muted hover:text-ink"
          aria-label={t("Back to recipe")}
        >
          <Icon name="arrowLeft" size={18} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-brand">{t("Cook mode")}</div>
          <div className="truncate font-display text-lg leading-tight">{recipe.title}</div>
        </div>
        <Badge tone={inGrams ? "brand" : "outline"}>{inGrams ? t("grams") : t("recipe units")}</Badge>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{t("Portions")}</div>
            <div className="mt-1 flex items-center gap-2">
              <button
                onClick={() => setPortions((current) => Math.max(1, current - 1))}
                disabled={portions <= 1}
                aria-label={t("Remove a portion")}
                className="flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-surface text-lg font-semibold text-ink transition-colors hover:bg-raised disabled:opacity-40"
              >
                <Icon name="minus" size={18} />
              </button>
              <input
                type="number"
                min={1}
                max={100}
                value={portions}
                onChange={(event) => setPortions(Math.max(1, Math.min(100, Math.round(Number(event.target.value) || 1))))}
                className="h-11 w-16 rounded-xl border border-line bg-surface text-center font-display text-xl"
                aria-label={t("Portions")}
              />
              <button
                onClick={() => setPortions((current) => Math.min(100, current + 1))}
                aria-label={t("Add a portion")}
                className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand text-brand-ink transition-opacity hover:opacity-90"
              >
                <Icon name="plus" size={18} />
              </button>
              <span className="text-[11px] text-muted">{t("of the recipe")}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="soft" onClick={() => setPortions((current) => Math.min(100, Math.max(1, current * 2)))}>
              ×2
            </Button>
            <Button
              size="sm"
              variant="soft"
              disabled={portions <= 1}
              onClick={() => setPortions((current) => Math.min(100, Math.max(1, Math.round(current / 2))))}
            >
              ÷2
            </Button>
            <Button size="sm" variant="ghost" icon="refresh" onClick={() => setPortions(base)}>
              {t("Reset")}
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => setInGrams((value) => !value)}
            className={cn(
              "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              inGrams ? "border-brand/40 bg-brand-soft text-brand" : "border-line bg-surface text-muted hover:text-ink",
            )}
            aria-pressed={inGrams}
          >
            <span className={cn("flex h-4 w-4 items-center justify-center rounded-full border", inGrams ? "border-brand bg-brand text-brand-ink" : "border-line")}>
              {inGrams && <Icon name="check" size={9} />}
            </span>
            {t("Convert everything to grams")}
          </button>
          <span className="text-[11px] text-muted">{t("Weights are estimates; exact labels always win.")}</span>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-xl bg-raised px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-muted">{t("Portion weight")}</div>
            <div className="font-display text-lg">{gramsLabel(scaledPortion?.perServingGrams ?? null)}</div>
          </div>
          <div className="rounded-xl bg-raised px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-muted">{t("Total weight")}</div>
            <div className="font-display text-lg">{gramsLabel(scaledPortion?.totalGrams ?? null)}</div>
          </div>
          <div className="rounded-xl bg-raised px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-muted">{t("kcal per portion")}</div>
            <div className="font-display text-lg">{kcalPerPortion != null ? Math.round(kcalPerPortion) : "—"}</div>
          </div>
          <div className="rounded-xl bg-raised px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-muted">{t("kcal total")}</div>
            <div className="font-display text-lg">{totalKcal != null ? Math.round(totalKcal) : "—"}</div>
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-display text-lg">{t("Ingredients")}</h2>
          <span className="text-[11px] text-muted">{plural(recipe.ingredients.length, "ingredient")}</span>
        </div>
        {visibleIngredients.length === 0 ? (
          <p className="text-sm text-muted">{t("No ingredients to show.")}</p>
        ) : (
          <ul className="divide-y divide-line">
            {visibleIngredients.map(({ ingredient, index, quantity, grams }) => {
              const done = doneIngredients.has(index);
              return (
                <li key={ingredient.id ?? `${ingredient.name}-${index}`}>
                  <button
                    onClick={() => toggle(doneIngredients, setDoneIngredients, index)}
                    className={cn("flex w-full items-center gap-3 py-3 text-left", done && "opacity-55")}
                  >
                    <span
                      className={cn(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px]",
                        done ? "border-brand bg-brand text-brand-ink" : "border-line bg-raised text-transparent",
                      )}
                    >
                      <Icon name="check" size={13} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn("block break-words text-[15px]", done && "line-through")}>{ingredient.name}</span>
                      {ingredient.note && <span className="block text-[11px] text-muted">{ingredient.note}</span>}
                    </span>
                    <span className="shrink-0 text-right">
                      {inGrams ? (
                        <>
                          <span className="block text-[15px] font-medium">{gramsLabel(grams)}</span>
                          <span className="block text-[11px] text-muted">
                            {quantity != null ? qty(quantity) : ""} {ingredient.unit ?? ""}
                          </span>
                        </>
                      ) : (
                        <span className="block text-[15px] font-medium">
                          {quantity != null ? qty(quantity) : ""} {ingredient.unit ?? ""}
                        </span>
                      )}
                      {ingredient.optional && <span className="block text-[10px] uppercase tracking-wide text-muted">{t("optional")}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {scaledPortion && scaledPortion.covered < scaledPortion.ingredients && (
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            {t("Weight estimated for {covered} of {total} ingredients. Lines without a convertible unit stay in their original measure.", {
              covered: scaledPortion.covered,
              total: scaledPortion.ingredients,
            })}
          </p>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-display text-lg">{t("Method")}</h2>
          <span className="text-[11px] text-muted">{plural(recipe.steps.length, "step")}</span>
        </div>
        {recipe.steps.length === 0 ? (
          <p className="text-sm text-muted">{t("This recipe has no steps yet.")}</p>
        ) : (
          <ol className="space-y-2.5">
            {recipe.steps.map((step, index) => {
              const done = doneSteps.has(index);
              return (
                <li key={index}>
                  <button
                    onClick={() => toggle(doneSteps, setDoneSteps, index)}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors",
                      done ? "border-brand/30 bg-brand-soft/60" : "border-line bg-surface hover:bg-raised",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold",
                        done ? "bg-brand text-brand-ink" : "bg-raised text-muted",
                      )}
                    >
                      {done ? <Icon name="check" size={13} /> : index + 1}
                    </span>
                    <span className={cn("min-w-0 flex-1 break-words text-[15px] leading-relaxed", done && "text-muted line-through")}>
                      {step.text}
                      {step.timerSeconds ? (
                        <span className="mt-1 flex items-center gap-1 text-[12px] font-medium text-brand">
                          <Icon name="clock" size={11} /> {minutesLabel(Math.round(step.timerSeconds / 60))}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      <div className="sticky bottom-20 z-20 rounded-xl border border-line bg-bg/95 px-3 py-3 backdrop-blur sm:static">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div className="text-[11px] leading-tight text-muted">
            <div>
              {t("{count} portions", { count: portions })} · {gramsLabel(scaledPortion?.totalGrams ?? null)}
            </div>
            {recipe.servings && portions !== base && <div>{t("Scaled from {count} portions", { count: base })}</div>}
          </div>
          <Button variant="secondary" icon="check" onClick={openReview} disabled={!can("member")}>
            {t("Finish cooking")}
          </Button>
        </div>
      </div>
      <Sheet open={reviewOpen} onClose={() => { if (!saving) { if (result) navigate(`/recipes/${recipe.id}`); else setReviewOpen(false); } }} title={result ? t("Cooking saved") : t("Review cooking")} footer={result ? <Button className="w-full" onClick={() => navigate(`/recipes/${recipe.id}`)}>{t("Back to recipe")}</Button> : <Button className="w-full" disabled={saving} onClick={confirmCook}>{saving ? t("Saving…") : t("Confirm cooking")}</Button>}>
        {result ? <div className="space-y-2"><p>{t("Cooking has been saved.")}</p>{result.lines.some((line) => line.shortfall > 0) ? <><p className="font-semibold">{t("Stock shortfall")}</p>{result.lines.filter((line) => line.shortfall > 0).map((line, index) => <p key={index}>{line.name}: {qty(line.shortfall)} {line.unit}</p>)}</> : <p>{t("No stock shortfalls.")}</p>}</div> : <div className="space-y-4">
          <p className="text-sm text-muted">{t("Review the amounts used for {count} portions.", { count: portions })}</p>
          {reviewLines.map((line, index) => <div key={line.ingredientId} className="rounded-xl border border-line p-3"><label className="flex items-center gap-2"><input type="checkbox" checked={line.enabled} onChange={(e) => setReviewLines((lines) => lines.map((entry, i) => i === index ? { ...entry, enabled: e.target.checked } : entry))} /><span className="min-w-0 break-words font-medium">{line.name}</span></label><div className="mt-2 flex gap-2"><input aria-label={t("Quantity")} type="number" min="0" step="any" disabled={!line.enabled} value={line.quantity} onChange={(e) => setReviewLines((lines) => lines.map((entry, i) => i === index ? { ...entry, quantity: e.target.value } : entry))} className="w-1/2 min-w-0 rounded-xl border border-line bg-bg p-2" /><input aria-label={t("Unit")} disabled={!line.enabled} value={line.unit} onChange={(e) => setReviewLines((lines) => lines.map((entry, i) => i === index ? { ...entry, unit: e.target.value } : entry))} className="w-1/2 min-w-0 rounded-xl border border-line bg-bg p-2" /></div></div>)}
          {recipe.ingredients.filter((ingredient) => !ingredient.itemId).map((ingredient, index) => <p key={index} className="text-sm text-muted">{ingredient.name} · {t("Not tracked")}</p>)}
          <div className="space-y-3 rounded-xl border border-line p-3"><label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={saveLeftovers} onChange={(e) => setSaveLeftovers(e.target.checked)} />{t("Save leftovers")}</label>{saveLeftovers && <><label className="block text-sm">{t("Portions")}<input type="number" min="0.001" step="any" value={leftoverPortions} onChange={(e) => setLeftoverPortions(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-bg p-2" /></label><label className="block text-sm">{t("Location")}<select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-bg p-2"><option value="">{t("No location")}</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label><label className="block text-sm">{t("Use by")}<input type="date" value={useBy} onChange={(e) => setUseBy(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-bg p-2" /></label></>}</div>
        </div>}
      </Sheet>
    </div>
  );
}
