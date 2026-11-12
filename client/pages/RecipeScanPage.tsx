import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, prepareImage } from "@/api";
import { useHouse } from "@/state";
import { Badge, Button, Card, Field, Input, PageHeader, Spinner, Textarea, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { ZoomableImage } from "@/components/ZoomableImage";
import { useToast } from "@/components/toast";
import { ocrImage } from "@/ocr";
import { readableWordRatio } from "@shared/notebook-scan";
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
  source: "manual" | "scan" | "ai";
  aiCost?: number | null;
}

export function RecipeScanPage() {
  const { t } = useI18n();
  const { house } = useHouse();
  const navigate = useNavigate();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [preview, setPreview] = useState<string | null>(null);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [text, setText] = useState("");
  const [rawText, setRawText] = useState("");
  const [ocrConfidence, setOcrConfidence] = useState<number | null>(null);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrStatus, setOcrStatus] = useState("");
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [selected, setSelected] = useState(0);
  const [provider, setProvider] = useState<"ai" | "local" | null>(null);
  const [aiModel, setAiModel] = useState<string | null>(null);
  const [aiModels, setAiModels] = useState<string[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const draft = drafts[selected] ?? null;
  const updateDraft = (patch: Partial<Draft>) =>
    setDrafts((current) => current.map((entry, index) => (index === selected ? { ...entry, ...patch } : entry)));

  const handleFile = async (file: File | null) => {
    if (!file) return;
    setOcrError(null);
    setDrafts([]);
    setSelected(0);
    setWarning(null);
    const prepared = await prepareImage(file, { maxSize: 2200, quality: 0.9 });
    const url = URL.createObjectURL(prepared);
    setPreview(url);
    setText("");
    setRawText("");
    setOcrConfidence(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("image", prepared);
      const data = await api<{ path: string }>(`/api/houses/${house.id}/recipes/upload`, { method: "POST", body: form });
      setUploadedPath(data.path);
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not upload the photo"));
    } finally {
      setUploading(false);
    }
    void runOcr(prepared);
  };

  const runOcr = async (file?: File) => {
    const target = file ?? fileRef.current?.files?.[0];
    if (!target) return;
    setOcrRunning(true);
    setOcrProgress(0);
    setOcrStatus(t("Starting OCR"));
    setOcrError(null);
    try {
      const result = await ocrImage(
        target,
        (progress, status) => {
          setOcrProgress(progress);
          setOcrStatus(t(status));
        },
        // No `script` hint: the page language is not the interface language.
        // Tesseract runs with the Greek and English models together, and the
        // photo decides which one wins.
        {
          mode: "recipe",
          onRawText: (value, meta) => {
            setRawText(value);
            setOcrConfidence(meta.confidence);
          },
        },
      );
      setText(result.trim());
      if (!result.trim()) setOcrError(t("No text was detected. Try a sharper, brighter photo or type the recipe."));
    } catch (err) {
      setOcrError(err instanceof Error ? t(err.message) : t("OCR failed"));
    } finally {
      setOcrRunning(false);
    }
  };

  const digitize = async (preferAi = false) => {
    if (!text.trim() && !uploadedPath) {
      toast.error(t("Add a photo or paste some text first"));
      return;
    }
    setBusy(true);
    try {
      const data = await api<{
        provider: "ai" | "local";
        warning: string | null;
        aiModel?: string | null;
        aiModels?: string[];
        draft?: Draft | null;
        drafts?: Draft[];
        count?: number;
      }>(`/api/houses/${house.id}/recipes/scan`, {
        method: "POST",
        body: { text, image: uploadedPath, preferAi },
      });
      const list = data.drafts?.length ? data.drafts : data.draft ? [data.draft] : [];
      setDrafts(list);
      setSelected(0);
      setProvider(data.provider);
      setAiModel(data.aiModel ?? null);
      setAiModels(data.aiModels ?? []);
      // An empty response must never look like a successful no-op. The server
      // normally explains the reason, but keep a generic empty state if it
      // does not (and so the user is not left with a blank screen).
      setWarning(list.length ? data.warning : (data.warning || t("No recipe could be read from this page")));
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not read the recipe"));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const recipe = await api<Recipe>(`/api/houses/${house.id}/recipes`, {
        method: "POST",
        body: {
          ...draft,
          source: "scan",
          sourceImage: uploadedPath,
          ocrText: text,
        },
      });
      toast.success(t("Recipe digitised"));
      // Another recipe on the same page stays selected instead of vanishing.
      if (drafts.length > 1) {
        setDrafts((current) => current.filter((_entry, index) => index !== selected));
        setSelected(0);
        toast.success(t("Saved one recipe. Pick the next one from this page to digitise it too."));
        return;
      }
      navigate(`/recipes/${recipe.id}`, { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not save the recipe"));
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setPreview(null);
    setUploadedPath(null);
    setText("");
    setRawText("");
    setOcrConfidence(null);
    setDrafts([]);
    setSelected(0);
    setProvider(null);
    setWarning(null);
    setOcrError(null);
    setOcrProgress(0);
    if (fileRef.current) fileRef.current.value = "";
  };

  // Tesseract returns high confidence while reading the ruled lines themselves.
  // Judge the reading by whether it contains real words, not by confidence.
  // Real handwriting scored 38–55 % confidence in the evaluation; printed text
  // sits well above 70 %. Confidence alone is not proof, so words are checked too.
  const ocrLooksUnreadable =
    Boolean(text.trim()) &&
    (readableWordRatio(text) < 0.5 || (ocrConfidence != null && ocrConfidence < 70));
  const rawDiffersFromText = Boolean(rawText.trim()) && rawText.trim() !== text.trim();

  return (
    <div className="space-y-4">
      <PageHeader
        back={() => navigate("/recipes")}
        eyebrow={t("Digitise a recipe")}
        title={t("Scan grandma's recipe")}
        subtitle={t("Photograph the card or notebook page. The configured vision model reads the photo; OCR runs on this device as the private fallback.")}
        actions={
          preview ? (
            <Button variant="ghost" size="sm" icon="refresh" onClick={reset}>
              {t("Start over ")}</Button>
          ) : undefined
        }
      />

      {!preview ? (
        <Card className="overflow-hidden">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex w-full flex-col items-center justify-center gap-3 bg-grid px-6 py-14 text-center transition-colors hover:bg-raised"
          >
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand text-brand-ink shadow-soft">
              <Icon name="camera" size={28} />
            </span>
            <div>
              <div className="font-display text-xl">{t("Take a photo of the recipe")}</div>
              <div className="mt-1 text-xs text-muted">{t("JPG, PNG or HEIC · English & Greek OCR on this device first")}</div>
            </div>
            <span className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-medium">{t("Choose photo / camera")}</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_1.05fr]">
          <Card className="overflow-hidden">
            <ZoomableImage src={preview} alt={t("Recipe scan")} className="max-h-[420px] w-full bg-raised object-contain" />
            <div className="flex items-center justify-between px-3 py-2 text-[11px] text-muted">
              <span>{uploading ? t("Uploading scan…") : uploadedPath ? t("Scan stored") : t("Local only")}</span>
              <button type="button" onClick={() => fileRef.current?.click()} className="font-medium text-brand hover:underline">
                {t("Replace photo ")}</button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
            />
          </Card>

          <div className="space-y-3">
            <Card className="p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-lg">{t("Recognised text")}</h2>
                {ocrRunning && (
                  <span role="status" className="flex items-center gap-1.5 text-[11px] text-muted">
                    <Spinner size={12} /> {Math.round(ocrProgress * 100)}%
                  </span>
                )}
              </div>
              {ocrRunning && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
                  <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${Math.max(4, ocrProgress * 100)}%` }} />
                </div>
              )}
              {ocrRunning && <p className="mt-1.5 text-[11px] text-muted">{ocrStatus}</p>}
              {ocrError && (
                <div className="mt-2 rounded-xl bg-warn-soft px-3 py-2 text-[11px] text-warn">
                  {t(ocrError)} {' '}{t(" You can still type the text below, or let AI read the photo. ")}</div>
              )}
              {!ocrRunning && (ocrLooksUnreadable || (!text.trim() && uploadedPath)) && (
                <div className="mt-2 rounded-xl bg-warn-soft px-3 py-2 text-[11px] leading-relaxed text-warn">
                  <p>{t("This looks handwritten, and on-device OCR cannot read handwriting reliably. A vision model reads the photo itself — the recognised text below is only a hint.")}</p>
                  {uploadedPath ? (
                    <Button type="button" size="sm" icon="sparkles" className="mt-2" loading={busy} disabled={ocrRunning} onClick={() => void digitize(true)}>
                      {t("Read the photo with AI ")}</Button>
                  ) : null}
                </div>
              )}
              <Textarea
                rows={9}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={t("The recipe text appears here. Fix any OCR mistakes before digitising — AI does the rest.")}
                className="mt-2 text-[13px]"
              />
              {rawDiffersFromText && (
                <details className="mt-2 rounded-xl border border-line bg-raised px-3 py-2 text-[11px]">
                  <summary className="cursor-pointer font-medium text-ink">{t("Raw OCR text (before cleanup)")}</summary>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted">{rawText}</pre>
                  <p className="mt-2 text-muted">{t("Cleanup only removes the printed diary frame and repeated rows. Nothing is deleted from the photo.")}</p>
                  <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={() => setText(rawText)}>
                    {t("Use the raw text ")}</Button>
                </details>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="secondary" icon="refresh" onClick={() => void runOcr()} disabled={ocrRunning}>
                  {t("Re-run OCR ")}</Button>
                <Button type="button" size="sm" icon="sparkles" loading={busy} disabled={ocrRunning} onClick={() => void digitize()}>
                  {t("Digitise recipe ")}</Button>
                {uploadedPath && (
                  <Button type="button" size="sm" variant="secondary" icon="sparkles" loading={busy} disabled={ocrRunning} onClick={() => void digitize(true)}>
                    {t("Read the photo with AI ")}</Button>
                )}
              </div>
              {!text.trim() && uploadedPath && (
                <p className="mt-2 text-[11px] text-muted">
                  {t("No OCR text? You can still digitise — the photo is sent to the configured AI model, which reads it directly. ")}</p>
              )}
            </Card>

            {!draft && warning && (
              <Card className="p-4">
                <p className="rounded-xl bg-raised px-3 py-2 text-[11px] leading-relaxed text-muted">{t(warning)}</p>
              </Card>
            )}

            {drafts.length > 1 && (
              <Card className="p-4">
                <h2 className="font-display text-lg">{t("This page holds more than one recipe")}</h2>
                <p className="mt-1 text-[11px] leading-relaxed text-muted">
                  {t("Each recipe is kept separate — nothing is merged into one list. Pick one to review and save, then come back for the next.")}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {drafts.map((entry, index) => (
                    <button
                      key={`${entry.title}-${index}`}
                      type="button"
                      onClick={() => setSelected(index)}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-[11px] font-medium",
                        index === selected ? "border-brand bg-brand-soft text-brand" : "border-line bg-surface text-muted hover:text-ink",
                      )}
                    >
                      {index + 1}. {entry.title}
                    </button>
                  ))}
                </div>
              </Card>
            )}

            {draft && (
              <Card className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-display text-lg">{t("Ready to save")}</h2>
                  <div className="flex items-center gap-1.5">
                    <Badge tone={provider === "ai" ? "brand" : "neutral"}>{provider === "ai" ? t("AI cleaned") : t("local parse")}</Badge>
                    {provider === "ai" && aiModel && <Badge tone="outline">{aiModel}</Badge>}
                    {draft.aiCost != null && <Badge tone="outline">{aiCostLabel(draft.aiCost)}</Badge>}
                  </div>
                </div>
                {warning && (
                  <p className="mt-2 rounded-xl bg-raised px-3 py-2 text-[11px] leading-relaxed text-muted">{t(warning)}</p>
                )}
                {provider === "ai" && aiModels.length > 1 && (
                  <p className="mt-1 text-[10px] text-muted">{aiModels.join(" → ")}</p>
                )}
                <div className="mt-3 space-y-3">
                  <Field label={t("Title")} required>
                    <Input value={draft.title} onChange={(event) => updateDraft({ title: event.target.value })} maxLength={160} />
                  </Field>
                  <div className="flex flex-wrap gap-1.5">
                    {draft.servings ? <Badge tone="outline">{plural(draft.servings, "serving")}</Badge> : null}
                    {draft.prepMinutes || draft.cookMinutes ? (
                      <Badge tone="outline">{minutesLabel((draft.prepMinutes ?? 0) + (draft.cookMinutes ?? 0))}</Badge>
                    ) : null}
                    <Badge tone="outline">{plural(draft.ingredients.length, "ingredient")}</Badge>
                    <Badge tone="outline">{plural(draft.steps.length, "step")}</Badge>
                  </div>
                  {draft.ingredients.length > 0 && (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{t("Ingredients")}</div>
                      <ul className="mt-1 space-y-0.5 text-[13px]">
                        {draft.ingredients.map((ingredient, index) => (
                          <li key={index} className="truncate">
                            {ingredient.quantity != null ? `${qty(ingredient.quantity)} ` : ""}
                            {ingredient.unit ? `${ingredient.unit} ` : ""}
                            {ingredient.name}
                            {ingredient.optional && <span className="text-[11px] text-muted"> {' '}{t(" (optional)")}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {draft.steps.length > 0 && (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{t("Steps")}</div>
                      <ol className="mt-1 max-h-40 space-y-1 overflow-y-auto pr-1 text-[12px] leading-relaxed text-muted">
                        {draft.steps.map((step, index) => (
                          <li key={index} className={cn("flex gap-2")}>
                            <span className="shrink-0 font-semibold text-ink">{index + 1}.</span>
                            <span>{step.text}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                  {draft.aiNotes && (
                    <div className="rounded-xl border border-line bg-raised p-2.5 text-[11px] leading-relaxed text-muted">
                      <span className="font-semibold text-ink">{t("AI notes: ")}{' '}</span>
                      {draft.aiNotes}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button type="button" block loading={saving} onClick={() => void save()}>
                      {t("Save recipe ")}</Button>
                    <Button type="button" variant="secondary" onClick={() => void digitize()} disabled={busy}>
                      {t("Retry ")}</Button>
                  </div>
                  <p className="text-[11px] text-muted">{t("You can fine-tune every field after saving.")}</p>
                </div>
              </Card>
            )}
          </div>
        </div>
      )}

      <Card className="flex items-start gap-3 p-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
          <Icon name="key" size={17} />
        </span>
        <div className="text-[11px] leading-relaxed text-muted">
          {t("OCR runs in your browser. Clean-up uses the AI provider configured under")}{" "}
          <button onClick={() => navigate("/settings?tab=ai")} className="font-medium text-brand hover:underline">
            {t("Settings → AI ")}</button>
          {t(". Without a key, SVault still splits ingredients and steps locally — no data leaves the house. ")}
          {t("Handwriting is only read reliably by a vision model; printed cards work on-device.")}</div>
      </Card>
    </div>
  );
}
