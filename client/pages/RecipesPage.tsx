import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, qs } from "@/api";
import { useHouse } from "@/state";
import { useI18n } from "@/i18n";
import { Badge, Button, Card, EmptyState, Input, PageHeader, Select, Skeleton, Tabs, useDebounced } from "@/components/ui";
import { Icon } from "@/components/icons";
import { minutesLabel, money, qty } from "@/format";
import { gramsLabel } from "@shared/recipe-grams";
import type { Recipe, RecipeCostSummary } from "@shared/types";

export function RecipesPage() {
  const { house } = useHouse();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [costs, setCosts] = useState<Record<string, RecipeCostSummary>>({});
  const [search, setSearch] = useState(params.get("q") ?? "");
  const debounced = useDebounced(search, 250);
  const favorite = params.get("favorite") === "1";
  const tag = params.get("tag") ?? "";
  const sort = params.get("sort") ?? "";
  const pricedOnly = params.get("priced") === "1";

  const load = useCallback(async () => {
    try {
      // The cost list is a second, house-wide read; if it fails the kitchen list
      // still works, just without the per-portion figures.
      const [data, costData] = await Promise.all([
        api<Recipe[]>(`/api/houses/${house.id}/recipes${qs({ q: params.get("q") ?? "", favorite: favorite ? 1 : undefined, tag: tag || undefined })}`),
        api<{ recipes: RecipeCostSummary[] }>(`/api/houses/${house.id}/recipes/costs${qs({ basis: params.get("basis") ?? "" })}`).catch(() => null),
      ]);
      setRecipes(data);
      setCosts(Object.fromEntries((costData?.recipes ?? []).map((row) => [row.recipeId, row])));
    } catch {
      setRecipes([]);
    }
  }, [house.id, params, favorite, tag]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const next = new URLSearchParams(params);
    if (debounced) next.set("q", debounced);
    else next.delete("q");
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const tags = Array.from(new Set((recipes ?? []).flatMap((recipe) => recipe.tags))).slice(0, 10);

  const costOf = (recipeId: string) => costs[recipeId] ?? null;
  const costValue = (recipeId: string) => {
    const cost = costOf(recipeId);
    return cost?.perPortion ?? cost?.total ?? null;
  };
  // Sorting and filtering happen here because the list is already in memory for
  // the tags and the search box; the cost rows arrive with it.
  const visible = (recipes ?? [])
    .filter((recipe) => !pricedOnly || costOf(recipe.id)?.total != null)
    .sort((left, right) => {
      if (!sort) return 0;
      const a = costValue(left.id);
      const b = costValue(right.id);
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      return sort === "cost-desc" ? b - a : a - b;
    });

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div>
      <PageHeader
        eyebrow={t("{count} recipes", { count: qty(recipes?.length ?? 0) })}
        title={t("The kitchen")}
        subtitle={t("Family recipes, scanned notes, and what you can cook tonight.")}
        actions={
          <>
            <div className="hidden sm:block">
              <Button variant="secondary" icon="camera" onClick={() => navigate("/recipes/scan")}>
                {t("Scan recipe")}
              </Button>
            </div>
            <div className="hidden sm:block">
              <Button variant="secondary" icon="download" onClick={() => navigate("/recipes/import")}>
                {t("Import link")}
              </Button>
            </div>
            <Button icon="plus" onClick={() => navigate("/recipes/new")}>
              {t("New")}
            </Button>
          </>
        }
      />

      <div className="mb-4 space-y-2">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Icon name="search" size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("Search recipes or ingredients")} className="pl-9" inputMode="search" />
          </div>
          <Button variant="secondary" icon="sparkles" onClick={() => navigate("/ideas")} className="shrink-0">
            {t("Ideas")}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Tabs
            items={[
              { value: "", label: t("All") },
              { value: "favorite", label: t("Favourites") },
              ...tags.map((entry) => ({ value: `tag:${entry}`, label: entry })),
            ]}
            value={favorite ? "favorite" : tag ? `tag:${tag}` : ""}
            onChange={(value) => {
              if (value === "") {
                setParam("favorite", null);
                setParam("tag", null);
              } else if (value === "favorite") {
                setParam("favorite", "1");
                setParam("tag", null);
              } else {
                setParam("tag", value.replace("tag:", ""));
                setParam("favorite", null);
              }
            }}
            className="min-w-0 flex-1"
          />
        </div>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 sm:max-w-[15rem]">
            <Select
              value={sort}
              onChange={(event) => setParam("sort", event.target.value || null)}
              aria-label={t("Sort recipes")}
              className="h-9 text-[13px]"
            >
              <option value="">{t("Recently updated")}</option>
              <option value="cost-asc">{t("Cheapest portion first")}</option>
              <option value="cost-desc">{t("Most expensive portion first")}</option>
            </Select>
          </div>
          <button
            onClick={() => setParam("priced", pricedOnly ? null : "1")}
            aria-pressed={pricedOnly}
            className={
              pricedOnly
                ? "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-3 text-xs font-medium text-brand"
                : "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-xs font-medium text-muted hover:text-ink"
            }
          >
            <Icon name={pricedOnly ? "check" : "minus"} size={12} />
            {t("Priced only")}
          </button>
        </div>
      </div>

      {!recipes ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-[132px]" />
          ))}
        </div>
      ) : recipes.length === 0 ? (
        <EmptyState
          icon="utensils"
          title={t("No recipes here yet")}
          body={t("Scan a handwritten recipe from a notebook, or write one down. Any ingredients you already own are marked automatically.")}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button icon="camera" onClick={() => navigate("/recipes/scan")}>
                {t("Scan a recipe")}
              </Button>
              <Button variant="secondary" onClick={() => navigate("/recipes/new")}>
                {t("Write one")}
              </Button>
            </div>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {visible.length === 0 && (
            <Card className="p-4 text-sm text-muted sm:col-span-2">
              {t("No recipe matches the cost filter yet. Record a purchase price on the linked items, or clear the filter.")}
            </Card>
          )}
          {visible.map((recipe) => {
            const coverage = recipe.match?.coverage ?? 0;
            const cost = costOf(recipe.id);
            return (
              <Card key={recipe.id} className="group flex flex-col overflow-hidden transition-colors hover:border-brand/40">
                <Link to={`/recipes/${recipe.id}`} className="flex flex-1 flex-col p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-display text-lg leading-tight">{recipe.title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                        {recipe.servings ? <span>{t(recipe.servings === 1 ? "{count} serving" : "{count} servings", { count: recipe.servings })}</span> : null}
                        {recipe.prepMinutes || recipe.cookMinutes ? (
                          <span>· {minutesLabel((recipe.prepMinutes ?? 0) + (recipe.cookMinutes ?? 0))}</span>
                        ) : null}
                        <span>· {t(recipe.steps.length === 1 ? "{count} step" : "{count} steps", { count: recipe.steps.length })}</span>
                      </div>
                    </div>
                    {recipe.favorite && <Icon name="heart" size={16} fill="currentColor" className="shrink-0 text-brand" />}
                  </div>

                  {recipe.description && <p className="mt-2 line-clamp-2 text-xs text-muted">{recipe.description}</p>}

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {recipe.match && (
                      <Badge tone={coverage >= 0.75 ? "brand" : coverage >= 0.4 ? "warn" : "neutral"}>
                        {Math.round(coverage * 100)}% {t("in stock")}
                      </Badge>
                    )}
                    {(recipe.match?.missing.length ?? 0) > 0 && (
                      <Badge tone="outline">{t("{count} missing", { count: recipe.match!.missing.length })}</Badge>
                    )}
                    {recipe.nutrition?.perServing?.energyKcal != null && (
                      <Badge tone="outline">
                        ~{Math.round(recipe.nutrition.perServing.energyKcal)} {' '}{t(" kcal / ")}{' '}{t("portion")}
                      </Badge>
                    )}
                    {recipe.portion?.perServingGrams != null && (
                      <Badge tone="outline">{gramsLabel(recipe.portion.perServingGrams)} {' '}{t("/ portion")}</Badge>
                    )}
                    {cost && cost.total != null && (
                      <Badge tone={cost.partial ? "outline" : "brand"}>
                        {cost.partial ? "≥ " : ""}
                        {money(cost.perPortion ?? cost.total, house.currency)}
                        {cost.perPortion != null ? ` ${t("/ portion")}` : ""}
                      </Badge>
                    )}
                    {recipe.tags.slice(0, 2).map((entry) => (
                      <Badge key={entry} tone="neutral">
                        {entry}
                      </Badge>
                    ))}
                  </div>
                </Link>
              </Card>
            );
          })}
        </div>
      )}

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <button onClick={() => navigate("/recipes/scan")} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-3 text-left transition-colors hover:bg-raised sm:hidden">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-soft text-brand">
            <Icon name="camera" size={17} />
          </span>
          <span>
            <span className="block text-[13px] font-medium">{t("Scan grandma's recipe")}</span>
            <span className="block text-[11px] text-muted">{t("Photo or note → clean steps")}</span>
          </span>
        </button>
        <button onClick={() => navigate("/recipes/import")} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-3 text-left transition-colors hover:bg-raised sm:hidden">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-soft text-brand">
            <Icon name="download" size={17} />
          </span>
          <span>
            <span className="block text-[13px] font-medium">{t("Import a recipe link")}</span>
            <span className="block text-[11px] text-muted">{t("Ingredients and steps from a page")}</span>
          </span>
        </button>
        <button onClick={() => navigate("/ideas")} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-3 text-left transition-colors hover:bg-raised sm:hidden">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-warn-soft text-warn">
            <Icon name="sparkles" size={17} />
          </span>
          <span>
            <span className="block text-[13px] font-medium">{t("What can I cook?")}</span>
            <span className="block text-[11px] text-muted">{t("Ideas from what is in stock")}</span>
          </span>
        </button>
      </div>
    </div>
  );
}
