import { DietWarnings } from "@/components/diet-profile";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/api";
import { useHouse } from "@/state";
import { Badge, Button, Card, EmptyState, PageHeader, Skeleton, Textarea, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { minutesLabel, plural, relativeTime } from "@/format";
import type { IdeaResponse } from "@shared/types";
import { useI18n } from "@/i18n";

interface IdeaRun extends IdeaResponse {
  id: string;
  prompt: string | null;
  createdAt: string;
  warning?: string | null;
}

const QUICK_PROMPTS = [
  "Something quick for tonight",
  "Use up the vegetables",
  "Vegetarian comfort food",
  "High protein, low effort",
  "Breakfast ideas",
  "Something for the kids",
];

export function IdeasPage() {
  const { t } = useI18n();
  const { house, can } = useHouse();
  const navigate = useNavigate();
  const toast = useToast();
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<IdeaRun | null>(null);
  const [history, setHistory] = useState<IdeaRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingIndex, setSavingIndex] = useState<number | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const data = await api<IdeaRun[]>(`/api/houses/${house.id}/ideas`);
      setHistory(data);
    } catch {
      setHistory([]);
    }
  }, [house.id]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const generate = async (override?: string) => {
    const text = (override ?? prompt).trim();
    setLoading(true);
    try {
      const data = await api<IdeaRun>(`/api/houses/${house.id}/ideas`, {
        method: "POST",
        body: { prompt: text || undefined },
      });
      setResult(data);
      setPrompt(text);
      void loadHistory();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not generate ideas"));
    } finally {
      setLoading(false);
    }
  };

  const saveIdea = async (index: number) => {
    if (!result) return;
    setSavingIndex(index);
    try {
      const data = await api<{ recipeId: string }>(`/api/ideas/${result.id}/save`, {
        method: "POST",
        body: { index },
      });
      toast.success(t("Saved to your recipes"));
      navigate(`/recipes/${data.recipeId}`);
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not save the idea"));
    } finally {
      setSavingIndex(null);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        back={() => navigate("/recipes")}
        eyebrow={t("From your shelves")}
        title={t("What can I cook?")}
        subtitle={t("Recommendations built from what is actually in this house — saved recipes first.")}
      />

      <Card className="p-4">
        <Textarea
          rows={2}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t("Anything you fancy? “Something quick with the spinach”, “dinner for four”, “no oven”…")}
          maxLength={500}
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {QUICK_PROMPTS.map((entry) => (
            <button
              key={entry}
              onClick={() => {
                setPrompt(entry);
                void generate(entry);
              }}
              className="rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-brand/40 hover:text-brand"
            >
              {t(entry)}
            </button>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[11px] text-muted">
            {can("member") ? t("Ideas use current stock, quantities and saved recipes.") : t("Read-only — ask a member to generate ideas.")}
          </span>
          <Button icon="sparkles" loading={loading} onClick={() => void generate()} disabled={!can("member")}>
            {t("Get ideas ")}</Button>
        </div>
      </Card>

      {loading && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-40" />
          ))}
        </div>
      )}

      {!loading && result && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={result.provider === "ai" ? "brand" : "neutral"}>
              {result.provider === "ai" ? t("AI chef") : t("Local suggestions")}
            </Badge>
            <span className="text-sm text-muted">{result.summary}</span>
          </div>
          {result.warning && (
            <div className="flex items-start gap-2 rounded-xl border border-line bg-raised px-3 py-2 text-[11px] leading-relaxed text-muted">
              <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
              {t(result.warning)}
            </div>
          )}
          {result.ideas.length === 0 ? (
            <EmptyState
              icon="utensils"
              title={t("No ideas this time")}
              body={t("Add a few items or save a recipe, then ask again.")}
              action={<Button onClick={() => navigate("/items/new")}>{t("Add an item")}</Button>}
            />
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {result.ideas.map((idea, index) => (
                <Card key={`${idea.title}-${index}`} className="flex flex-col p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-display text-lg leading-tight">{idea.title}</div>
                    <Badge tone="outline">{idea.source === "recipe" ? t("saved recipe") : t("new idea")}</Badge>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted">{idea.rationale}</p>
      <DietWarnings warnings={idea.warnings} dietCompatibility={idea.dietCompatibility} />
                  <div className="mt-2 flex gap-2 text-[11px] text-muted">
                    {idea.timeMinutes ? <span>⏱ {minutesLabel(idea.timeMinutes)}</span> : null}
                    {idea.servings ? <span>· {plural(idea.servings, "serving")}</span> : null}
                    <span>· {plural(idea.uses.length, "ingredient")} {' '}{t(" from home")}</span>
                  </div>

                  {idea.uses.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap gap-1">
                      {idea.uses.slice(0, 6).map((use) => (
                        <span key={use.name} className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-medium text-brand">
                          <Icon name="check" size={9} /> {use.name}
                        </span>
                      ))}
                    </div>
                  )}
                  {idea.missing.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {idea.missing.map((item) => (
                        <span key={item.name} className="rounded-full bg-warn-soft px-2 py-0.5 text-[10px] font-medium text-warn">
                          + {item.name}
                        </span>
                      ))}
                    </div>
                  )}

                  {idea.steps.length > 0 && (
                    <details className="mt-3 text-sm">
                      <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                        {t("Method (")}{idea.steps.length})
                      </summary>
                      <ol className="mt-2 space-y-1.5">
                        {idea.steps.map((step, stepIndex) => (
                          <li key={stepIndex} className="flex gap-2 text-[13px] leading-relaxed text-muted">
                            <span className="shrink-0 font-semibold text-ink">{stepIndex + 1}.</span>
                            <span>{step}</span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}

                  <div className="mt-3 flex gap-2">
                    {idea.recipeId ? (
                      <Button size="sm" variant="secondary" icon="book" onClick={() => navigate(`/recipes/${idea.recipeId}`)}>
                        {t("Open recipe ")}</Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="soft"
                      icon="plus"
                      className="ml-auto"
                      loading={savingIndex === index}
                      disabled={!can("member") || savingIndex !== null}
                      onClick={() => void saveIdea(index)}
                    >
                      {t("Save as recipe ")}</Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {!loading && !result && (
        <Card className="relative overflow-hidden p-6">
          <div className="absolute inset-0 bg-grid opacity-40" />
          <div className="relative">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
              <Icon name="utensils" size={14} /> {' '}{t(" How it works ")}</div>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              {[
                { title: "We read your stock", body: "Quantities, categories and expiry are taken into account." },
                { title: "We check saved recipes", body: "Recipes you already own are preferred when ingredients line up." },
                { title: "You get a short list", body: "Missing ingredients are kept to essentials, so dinner stays easy." },
              ].map((step, index) => (
                <div key={step.title} className="rounded-xl border border-line bg-surface p-3">
                  <div className="font-display text-lg text-brand">{String(index + 1).padStart(2, "0")}</div>
                  <div className="mt-1 text-[13px] font-medium">{t(step.title)}</div>
                  <div className="mt-0.5 text-[11px] leading-relaxed text-muted">{t(step.body)}</div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button icon="sparkles" onClick={() => void generate()} disabled={!can("member")}>
                {t("Try it now ")}</Button>
              <Button variant="secondary" onClick={() => navigate("/settings?tab=ai")}>
                {t("AI settings ")}</Button>
            </div>
          </div>
        </Card>
      )}

      {history.length > 0 && (
        <Card className="p-4">
          <h2 className="mb-2 font-display text-lg">{t("Earlier ideas")}</h2>
          <div className="divide-y divide-line">
            {history.slice(0, 6).map((run) => (
              <button
                key={run.id}
                onClick={() => setResult(run)}
                className={cn(
                  "flex w-full items-center gap-3 py-2 text-left transition-colors hover:bg-raised",
                  result?.id === run.id && "text-brand",
                )}
              >
                <Icon name="sparkles" size={15} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{run.prompt || t("General suggestions")}</span>
                  <span className="block text-[11px] text-muted">
                    {run.ideas.length} {' '}{t(" ideas · ")}{' '}{relativeTime(run.createdAt)}
                  </span>
                </span>
                <Icon name="chevronRight" size={14} className="text-muted" />
              </button>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
