import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, qs } from "@/api";
import { useHouse } from "@/state";
import { Badge, Button, Card, EmptyState, Input, PageHeader, Skeleton, Tabs, useDebounced } from "@/components/ui";
import { Icon } from "@/components/icons";
import { minutesLabel, plural, qty } from "@/format";
import type { Recipe } from "@shared/types";

export function RecipesPage() {
  const { house } = useHouse();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [search, setSearch] = useState(params.get("q") ?? "");
  const debounced = useDebounced(search, 250);
  const favorite = params.get("favorite") === "1";
  const tag = params.get("tag") ?? "";

  const load = useCallback(async () => {
    try {
      const data = await api<Recipe[]>(`/api/houses/${house.id}/recipes${qs({ q: params.get("q") ?? "", favorite: favorite ? 1 : undefined, tag: tag || undefined })}`);
      setRecipes(data);
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

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div>
      <PageHeader
        eyebrow={`${qty(recipes?.length ?? 0)} recipes`}
        title="The kitchen"
        subtitle="Family recipes, scanned notes, and what you can cook tonight."
        actions={
          <>
            <div className="hidden sm:block">
              <Button variant="secondary" icon="camera" onClick={() => navigate("/recipes/scan")}>
                Scan recipe
              </Button>
            </div>
            <Button icon="plus" onClick={() => navigate("/recipes/new")}>
              New
            </Button>
          </>
        }
      />

      <div className="mb-4 space-y-2">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Icon name="search" size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search recipes or ingredients" className="pl-9" inputMode="search" />
          </div>
          <Button variant="secondary" icon="sparkles" onClick={() => navigate("/ideas")} className="shrink-0">
            Ideas
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Tabs
            items={[
              { value: "", label: "All" },
              { value: "favorite", label: "Favourites" },
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
          title="No recipes here yet"
          body="Scan a handwritten recipe from a notebook, or write one down. Any ingredients you already own are marked automatically."
          action={
            <div className="flex gap-2">
              <Button icon="camera" onClick={() => navigate("/recipes/scan")}>
                Scan a recipe
              </Button>
              <Button variant="secondary" onClick={() => navigate("/recipes/new")}>
                Write one
              </Button>
            </div>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {recipes.map((recipe) => {
            const coverage = recipe.match?.coverage ?? 0;
            return (
              <Card key={recipe.id} className="group flex flex-col overflow-hidden transition-colors hover:border-brand/40">
                <Link to={`/recipes/${recipe.id}`} className="flex flex-1 flex-col p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-display text-lg leading-tight">{recipe.title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                        {recipe.servings ? <span>{plural(recipe.servings, "serving")}</span> : null}
                        {recipe.prepMinutes || recipe.cookMinutes ? (
                          <span>· {minutesLabel((recipe.prepMinutes ?? 0) + (recipe.cookMinutes ?? 0))}</span>
                        ) : null}
                        <span>· {plural(recipe.steps.length, "step")}</span>
                      </div>
                    </div>
                    {recipe.favorite && <Icon name="heart" size={16} fill="currentColor" className="shrink-0 text-brand" />}
                  </div>

                  {recipe.description && <p className="mt-2 line-clamp-2 text-xs text-muted">{recipe.description}</p>}

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {recipe.match && (
                      <Badge tone={coverage >= 0.75 ? "brand" : coverage >= 0.4 ? "warn" : "neutral"}>
                        {Math.round(coverage * 100)}% in stock
                      </Badge>
                    )}
                    {(recipe.match?.missing.length ?? 0) > 0 && (
                      <Badge tone="outline">{recipe.match!.missing.length} missing</Badge>
                    )}
                    {recipe.nutrition?.perServing?.energyKcal != null && (
                      <Badge tone="outline">
                        ~{Math.round(recipe.nutrition.perServing.energyKcal)} kcal / portion
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
            <span className="block text-[13px] font-medium">Scan grandma's recipe</span>
            <span className="block text-[11px] text-muted">Photo or note → clean steps</span>
          </span>
        </button>
        <button onClick={() => navigate("/ideas")} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-3 text-left transition-colors hover:bg-raised sm:hidden">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-warn-soft text-warn">
            <Icon name="sparkles" size={17} />
          </span>
          <span>
            <span className="block text-[13px] font-medium">What can I cook?</span>
            <span className="block text-[11px] text-muted">Ideas from what is in stock</span>
          </span>
        </button>
      </div>
    </div>
  );
}
