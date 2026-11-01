import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, prepareImage } from "@/api";
import { useHouse } from "@/state";
import { Badge, Button, Card, Field, Input, PageHeader, Spinner, Textarea, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { ocrImage } from "@/ocr";
import { minutesLabel, plural, qty } from "@/format";
import type { Recipe } from "@shared/types";

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
}

export function RecipeScanPage() {
  const { house } = useHouse();
  const navigate = useNavigate();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [preview, setPreview] = useState<string | null>(null);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [text, setText] = useState("");
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrStatus, setOcrStatus] = useState("");
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [provider, setProvider] = useState<"ai" | "local" | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleFile = async (file: File | null) => {
    if (!file) return;
    setOcrError(null);
    setDraft(null);
    setWarning(null);
    const prepared = await prepareImage(file, { maxSize: 2200, quality: 0.9 });
    const url = URL.createObjectURL(prepared);
    setPreview(url);
    setText("");
    setUploading(true);
    try {
      const form = new FormData();
      form.append("image", prepared);
      const data = await api<{ path: string }>(`/api/houses/${house.id}/recipes/upload`, { method: "POST", body: form });
      setUploadedPath(data.path);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not upload the photo");
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
    setOcrStatus("Starting OCR");
    setOcrError(null);
    try {
      const result = await ocrImage(target, (progress, status) => {
        setOcrProgress(progress);
        setOcrStatus(status);
      });
      setText(result.trim());
      if (!result.trim()) setOcrError("No text was detected. Try a sharper, brighter photo or type the recipe.");
    } catch (err) {
      setOcrError(err instanceof Error ? err.message : "OCR failed");
    } finally {
      setOcrRunning(false);
    }
  };

  const digitize = async () => {
    if (!text.trim() && !uploadedPath) {
      toast.error("Add a photo or paste some text first");
      return;
    }
    setBusy(true);
    try {
      const data = await api<{ provider: "ai" | "local"; warning: string | null; draft: Draft }>(
        `/api/houses/${house.id}/recipes/scan`,
        { method: "POST", body: { text, image: uploadedPath } },
      );
      setDraft(data.draft);
      setProvider(data.provider);
      setWarning(data.warning);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not read the recipe");
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
      toast.success("Recipe digitised");
      navigate(`/recipes/${recipe.id}`, { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the recipe");
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setPreview(null);
    setUploadedPath(null);
    setText("");
    setDraft(null);
    setProvider(null);
    setWarning(null);
    setOcrError(null);
    setOcrProgress(0);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="space-y-4">
      <PageHeader
        back={() => navigate("/recipes")}
        eyebrow="Digitise a recipe"
        title="Scan grandma's recipe"
        subtitle="Photograph the card or notebook page. We read the text, fix OCR mistakes and rebuild the steps."
        actions={
          preview ? (
            <Button variant="ghost" size="sm" icon="refresh" onClick={reset}>
              Start over
            </Button>
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
              <div className="font-display text-xl">Take a photo of the recipe</div>
              <div className="mt-1 text-xs text-muted">JPG, PNG or HEIC · text goes through on-device OCR first</div>
            </div>
            <span className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-medium">Choose photo / camera</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_1.05fr]">
          <Card className="overflow-hidden">
            <img src={preview} alt="Recipe scan" className="max-h-[420px] w-full object-contain bg-raised" />
            <div className="flex items-center justify-between px-3 py-2 text-[11px] text-muted">
              <span>{uploading ? "Uploading scan…" : uploadedPath ? "Scan stored" : "Local only"}</span>
              <button type="button" onClick={() => fileRef.current?.click()} className="font-medium text-brand hover:underline">
                Replace photo
              </button>
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
                <h2 className="font-display text-lg">Recognised text</h2>
                {ocrRunning && (
                  <span className="flex items-center gap-1.5 text-[11px] text-muted">
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
                  {ocrError} You can still type the text below, or let AI read the photo.
                </div>
              )}
              <Textarea
                rows={9}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="The recipe text appears here. Fix any OCR mistakes before digitising — AI does the rest."
                className="mt-2 text-[13px]"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="secondary" icon="refresh" onClick={() => void runOcr()} disabled={ocrRunning}>
                  Re-run OCR
                </Button>
                <Button type="button" size="sm" icon="sparkles" loading={busy} onClick={() => void digitize()}>
                  Digitise recipe
                </Button>
              </div>
              {!text.trim() && uploadedPath && (
                <p className="mt-2 text-[11px] text-muted">
                  No OCR text? You can still digitise — if a vision-capable AI model is configured, it will read the photo itself.
                </p>
              )}
            </Card>

            {draft && (
              <Card className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-display text-lg">Ready to save</h2>
                  <Badge tone={provider === "ai" ? "brand" : "neutral"}>{provider === "ai" ? "AI cleaned" : "local parse"}</Badge>
                </div>
                {warning && (
                  <p className="mt-2 rounded-xl bg-raised px-3 py-2 text-[11px] leading-relaxed text-muted">{warning}</p>
                )}
                <div className="mt-3 space-y-3">
                  <Field label="Title" required>
                    <Input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} maxLength={160} />
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
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Ingredients</div>
                      <ul className="mt-1 space-y-0.5 text-[13px]">
                        {draft.ingredients.map((ingredient, index) => (
                          <li key={index} className="truncate">
                            {ingredient.quantity != null ? `${qty(ingredient.quantity)} ` : ""}
                            {ingredient.unit ? `${ingredient.unit} ` : ""}
                            {ingredient.name}
                            {ingredient.optional && <span className="text-[11px] text-muted"> (optional)</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {draft.steps.length > 0 && (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Steps</div>
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
                      <span className="font-semibold text-ink">AI notes: </span>
                      {draft.aiNotes}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button type="button" block loading={saving} onClick={() => void save()}>
                      Save recipe
                    </Button>
                    <Button type="button" variant="secondary" onClick={() => void digitize()} disabled={busy}>
                      Retry
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted">You can fine-tune every field after saving.</p>
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
          OCR runs in your browser. Clean-up uses the AI provider configured under{" "}
          <button onClick={() => navigate("/settings?tab=ai")} className="font-medium text-brand hover:underline">
            Settings → AI
          </button>
          . Without a key, SVault still splits ingredients and steps locally — no data leaves the house.
        </div>
      </Card>
    </div>
  );
}
