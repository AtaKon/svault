import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/api";
import { useHouse } from "@/state";
import { Badge, Button, Card, Field, Input, PageHeader, Spinner, Textarea } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { aiCostLabel, minutesLabel, plural, qty } from "@/format";
import type { Recipe } from "@shared/types";
import { useI18n } from "@/i18n";

interface Draft {
  title: string;
  description: string | null;
  servings: number | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  tags: string[];
  steps: { text: string; timerSeconds?: number | null }[];
  ingredients: { name: string; quantity: number | null; unit: string | null; optional: boolean; note: string | null }[];
  aiNotes: string | null;
  image: string | null;
  sourceImage: string | null;
  ocrText: string | null;
  sourceUrl: string | null;
  source: "manual" | "scan" | "ai" | "import";
  aiCost?: number | null;
}

interface ImportResponse {
  provider: "structured" | "html" | "ai";
  warning: string | null;
  aiCost: number | null;
  saved: boolean;
  sourceUrl: string;
  image: string | null;
  pageTitle: string | null;
  draft: Draft;
}

export function RecipeImportPage() {
  const { t } = useI18n();
  const { house } = useHouse();
  const navigate = useNavigate();
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const runImport = async () => {
    if (!url.trim()) {
      toast.error(t("Paste a link to the recipe first"));
      return;
    }
    setBusy(true);
    try {
      const data = await api<ImportResponse>(`/api/houses/${house.id}/recipes/import`, {
        method: "POST",
        body: { url: url.trim() },
      });
      setResult(data);
      setDraft(data.draft);
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not import the recipe"));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft || !result) return;
    setSaving(true);
    try {
      const recipe = await api<Recipe>(`/api/houses/${house.id}/recipes`, {
        method: "POST",
        body: { ...draft, source: "import", sourceUrl: result.sourceUrl, image: result.image, aiCost: result.aiCost },
      });
      toast.success(t("Recipe imported"));
      navigate(`/recipes/${recipe.id}`, { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not save the recipe"));
    } finally {
      setSaving(false);
    }
  };

  const providerLabel =
    result?.provider === "structured" ? t("Structured recipe") : result?.provider === "ai" ? t("AI cleaned") : t("text parse");

  return (
    <div className="space-y-4">
      <PageHeader
        back={() => navigate("/recipes")}
        eyebrow={t("Import a recipe")}
        title={t("Paste a recipe link")}
        subtitle={t("Bring a recipe from a cooking site into your kitchen. Ingredients, steps and times are read from the page.")}
        actions={
          url ? (
            <Button variant="ghost" size="sm" icon="refresh" onClick={() => { setUrl(""); setResult(null); setDraft(null); }}>
              {t("Start over")}
            </Button>
          ) : undefined
        }
      />

      <Card className="p-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !busy) void runImport();
            }}
            placeholder={t("https://example.com/recipe")}
            inputMode="url"
            autoFocus
            className="flex-1"
            aria-label={t("Recipe link")}
          />
          <Button icon="download" loading={busy} onClick={() => void runImport()}>
            {t("Import")}
          </Button>
        </div>
        {busy && (
          <div role="status" className="mt-3 flex items-center gap-2 rounded-xl bg-brand-soft px-3 py-2.5 text-xs text-brand">
            <Spinner size={14} /> {t("Reading the page and picking out the recipe…")}
          </div>
        )}
        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          {t("Most recipe sites publish structured data, so this is exact. Otherwise SVault reads the page text and, when AI is configured, tidies it up.")}
        </p>
      </Card>

      {result && draft && (
        <div className="grid gap-4 lg:grid-cols-[1.05fr_1fr]">
          <Card className="overflow-hidden">
            {result.image ? (
              <img src={result.image} alt={draft.title} className="max-h-64 w-full object-cover" referrerPolicy="no-referrer" />
            ) : (
              <div className="flex h-32 items-center justify-center bg-raised text-muted">
                <Icon name="image" size={26} />
              </div>
            )}
            <div className="space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={result.provider === "structured" ? "brand" : result.provider === "ai" ? "brand" : "warn"}>{providerLabel}</Badge>
                {draft.servings ? <Badge tone="outline">{plural(draft.servings, "serving")}</Badge> : null}
                {draft.prepMinutes || draft.cookMinutes ? (
                  <Badge tone="outline">{minutesLabel((draft.prepMinutes ?? 0) + (draft.cookMinutes ?? 0))}</Badge>
                ) : null}
                {result.aiCost != null && <Badge tone="outline">{aiCostLabel(result.aiCost)}</Badge>}
              </div>
              {result.warning && (
                <p className="rounded-xl bg-warn-soft px-3 py-2 text-[11px] leading-relaxed text-warn">{t(result.warning)}</p>
              )}
              <Field label={t("Title")} required>
                <Input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} maxLength={160} />
              </Field>
              <Field label={t("Description")}>
                <Textarea rows={2} value={draft.description ?? ""} onChange={(event) => setDraft({ ...draft, description: event.target.value || null })} maxLength={2000} />
              </Field>
              <a
                href={result.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] font-medium text-brand hover:underline"
              >
                <Icon name="arrowUpRight" size={12} /> {t("Open the original page")}
              </a>
            </div>
          </Card>

          <div className="space-y-4">
            <Card className="p-4">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="font-display text-lg">{t("Ingredients")}</h2>
                <span className="text-[11px] text-muted">{draft.ingredients.length}</span>
              </div>
              {draft.ingredients.length === 0 ? (
                <p className="text-sm text-muted">{t("No ingredients were found on the page.")}</p>
              ) : (
                <ul className="max-h-64 divide-y divide-line overflow-y-auto pr-1 text-[13px]">
                  {draft.ingredients.map((ingredient, index) => (
                    <li key={index} className="flex items-baseline gap-2 py-2">
                      <span className="min-w-0 flex-1">
                        {ingredient.name}
                        {ingredient.optional && <span className="text-[11px] text-muted"> {' '}{t("(optional)")}</span>}
                      </span>
                      <span className="shrink-0 text-[12px] text-muted">
                        {ingredient.quantity != null ? qty(ingredient.quantity) : ""} {ingredient.unit ?? ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="p-4">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="font-display text-lg">{t("Method")}</h2>
                <span className="text-[11px] text-muted">{plural(draft.steps.length, "step")}</span>
              </div>
              {draft.steps.length === 0 ? (
                <p className="text-sm text-muted">{t("No steps were found on the page.")}</p>
              ) : (
                <ol className="max-h-64 space-y-2 overflow-y-auto pr-1 text-[12px] leading-relaxed">
                  {draft.steps.map((step, index) => (
                    <li key={index} className="flex gap-2">
                      <span className="shrink-0 font-semibold text-muted">{index + 1}.</span>
                      <span>{step.text}</span>
                    </li>
                  ))}
                </ol>
              )}
            </Card>

            <div className="flex gap-2">
              <Button block loading={saving} disabled={!draft.title.trim()} onClick={() => void save()}>
                {t("Save recipe")}
              </Button>
              <Button variant="secondary" onClick={() => void runImport()} disabled={busy}>
                {t("Retry")}
              </Button>
            </div>
            <p className="text-[11px] text-muted">{t("You can fine-tune every field after saving.")}</p>
          </div>
        </div>
      )}

      <Card className="flex items-start gap-3 p-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
          <Icon name="key" size={17} />
        </span>
        <div className="text-[11px] leading-relaxed text-muted">
          {t("Import fetches the public page only. If the site blocks automated visits, open the recipe in your browser and paste its text in")}{" "}
          <button onClick={() => navigate("/recipes/scan")} className="font-medium text-brand hover:underline">
            {t("recipe scanner")}
          </button>
          .
        </div>
      </Card>
    </div>
  );
}
