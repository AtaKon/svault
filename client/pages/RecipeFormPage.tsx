import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, prepareImage } from "@/api";
import { useHouse } from "@/state";
import { Badge, Button, Card, Field, Input, LoadingBlock, PageHeader, Textarea } from "@/components/ui";
import { Icon } from "@/components/icons";
import { ZoomableImage } from "@/components/ZoomableImage";
import { useToast } from "@/components/toast";
import { UNIT_OPTIONS } from "@/units";
import type { Recipe } from "@shared/types";
import { useI18n } from "@/i18n";

interface IngredientRow {
  name: string;
  quantity: string;
  unit: string;
  optional: boolean;
}

export function RecipeFormPage() {
  const { t } = useI18n();
  const { recipeId } = useParams();
  const editing = Boolean(recipeId);
  const { house } = useHouse();
  const navigate = useNavigate();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [servings, setServings] = useState("");
  const [prep, setPrep] = useState("");
  const [cook, setCook] = useState("");
  const [tags, setTags] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [source, setSource] = useState<"manual" | "scan" | "ai">("manual");
  const [aiNotes, setAiNotes] = useState<string | null>(null);
  const [favorite, setFavorite] = useState(false);
  const [ingredients, setIngredients] = useState<IngredientRow[]>([{ name: "", quantity: "", unit: "", optional: false }]);
  const [steps, setSteps] = useState<string[]>([""]);

  useEffect(() => {
    if (!editing) return;
    api<Recipe>(`/api/recipes/${recipeId}`)
      .then((recipe) => {
        setTitle(recipe.title);
        setDescription(recipe.description ?? "");
        setServings(recipe.servings ? String(recipe.servings) : "");
        setPrep(recipe.prepMinutes ? String(recipe.prepMinutes) : "");
        setCook(recipe.cookMinutes ? String(recipe.cookMinutes) : "");
        setTags(recipe.tags.join(", "));
        setImage(recipe.image);
        setSourceImage(recipe.sourceImage);
        setOcrText(recipe.ocrText);
        setSource(recipe.source);
        setAiNotes(recipe.aiNotes);
        setFavorite(recipe.favorite);
        setIngredients(
          recipe.ingredients.length
            ? recipe.ingredients.map((ingredient) => ({
                name: ingredient.name,
                quantity: ingredient.quantity != null ? String(ingredient.quantity) : "",
                unit: ingredient.unit ?? "",
                optional: ingredient.optional,
              }))
            : [{ name: "", quantity: "", unit: "", optional: false }],
        );
        setSteps(recipe.steps.length ? recipe.steps.map((step) => step.text) : [""]);
        setLoading(false);
      })
      .catch((err) => {
        toast.error(err instanceof Error ? t(err.message) : t("Could not load the recipe"));
        setLoading(false);
      });
  }, [editing, recipeId, toast]);

  const uploadImage = async (file: File) => {
    setImageBusy(true);
    try {
      const prepared = await prepareImage(file, { maxSize: 1600 });
      const form = new FormData();
      form.append("image", prepared);
      const data = await api<{ path: string }>(`/api/houses/${house.id}/recipes/upload`, { method: "POST", body: form });
      setImage(data.path);
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not upload the photo"));
    } finally {
      setImageBusy(false);
    }
  };

  const updateIngredient = (index: number, patch: Partial<IngredientRow>) => {
    setIngredients((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try {
      const body = {
        title: title.trim(),
        description: description.trim() || null,
        servings: servings ? Number(servings) : null,
        prepMinutes: prep ? Number(prep) : null,
        cookMinutes: cook ? Number(cook) : null,
        tags,
        image,
        sourceImage,
        ocrText,
        source,
        aiNotes,
        favorite,
        steps: steps.map((text) => text.trim()).filter(Boolean).map((text) => ({ text })),
        ingredients: ingredients
          .filter((row) => row.name.trim())
          .map((row) => ({
            name: row.name.trim(),
            quantity: row.quantity ? Number(row.quantity) : null,
            unit: row.unit.trim() || null,
            optional: row.optional,
          })),
      };
      const recipe = editing
        ? await api<Recipe>(`/api/recipes/${recipeId}`, { method: "PATCH", body })
        : await api<Recipe>(`/api/houses/${house.id}/recipes`, { method: "POST", body });
      toast.success(t(editing ? "Recipe saved" : "Recipe added"));
      navigate(`/recipes/${recipe.id}`, { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not save the recipe"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingBlock label={t("Loading recipe")} />;

  return (
    <form onSubmit={submit}>
      <PageHeader
        back={() => navigate(-1)}
        eyebrow={editing ? t("Edit recipe") : t("New recipe")}
        title={editing ? title || t("Untitled recipe") : t("Write a recipe")}
        subtitle={t("Keep it simple — ingredients, steps, and the little notes that matter.")}
        actions={
          <Button type="submit" loading={saving} disabled={!title.trim()}>
            {editing ? t("Save") : t("Create")}
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
        <div className="space-y-4">
          <Card className="space-y-3 p-4">
            <Field label={t("Title")} required>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("Grandma's lemon cake")} autoFocus={!editing} maxLength={160} />
            </Field>
            <Field label={t("Description")} hint={t("optional")}>
              <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("Where it comes from, when you make it…")} maxLength={2000} />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label={t("Servings")}>
                <Input type="number" min="0" value={servings} onChange={(e) => setServings(e.target.value)} placeholder="4" />
              </Field>
              <Field label={t("Prep min")}>
                <Input type="number" min="0" value={prep} onChange={(e) => setPrep(e.target.value)} placeholder="15" />
              </Field>
              <Field label={t("Cook min")}>
                <Input type="number" min="0" value={cook} onChange={(e) => setCook(e.target.value)} placeholder="45" />
              </Field>
            </div>
            <Field label={t("Tags")} hint={t("comma separated")}>
              <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t("dessert, family, baking")} />
            </Field>
          </Card>

          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-lg">{t("Ingredients")}</h2>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                icon="plus"
                onClick={() => setIngredients((current) => [...current, { name: "", quantity: "", unit: "", optional: false }])}
              >
                {t("Add ")}</Button>
            </div>
            <div className="space-y-2">
              {ingredients.map((row, index) => (
                <div key={index} className="flex items-center gap-1.5">
                  <Input
                    value={row.name}
                    onChange={(e) => updateIngredient(index, { name: e.target.value })}
                    placeholder={t("Ingredient")}
                    className="h-10 flex-1 text-[13px]"
                  />
                  <Input
                    value={row.quantity}
                    onChange={(e) => updateIngredient(index, { quantity: e.target.value })}
                    placeholder={t("Qty")}
                    inputMode="decimal"
                    className="h-10 w-16 shrink-0 text-[13px]"
                  />
                  <Input
                    value={row.unit}
                    onChange={(e) => updateIngredient(index, { unit: e.target.value })}
                    placeholder={t("Unit")}
                    list="recipe-units"
                    className="h-10 w-20 shrink-0 text-[13px]"
                  />
                  <button
                    type="button"
                    onClick={() => setIngredients((current) => current.filter((_, i) => i !== index))}
                    className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger"
                    aria-label={t("Remove ingredient")}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              ))}
            </div>
            <datalist id="recipe-units">
              {UNIT_OPTIONS.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
            <p className="mt-2 text-[11px] text-muted">{t("Optional ingredients can be marked after saving.")}</p>
          </Card>

          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-lg">{t("Method")}</h2>
              <Button type="button" size="sm" variant="secondary" icon="plus" onClick={() => setSteps((current) => [...current, ""])}>
                {t("Add step ")}</Button>
            </div>
            <div className="space-y-2">
              {steps.map((step, index) => (
                <div key={index} className="flex items-start gap-1.5">
                  <span className="mt-2.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-raised text-[11px] font-semibold text-muted">
                    {index + 1}
                  </span>
                  <Textarea
                    rows={2}
                    value={step}
                    onChange={(e) => setSteps((current) => current.map((value, i) => (i === index ? e.target.value : value)))}
                    placeholder={index === 0 ? t("Preheat the oven to 180°C…") : t("Next step…")}
                    className="text-[13px]"
                  />
                  <button
                    type="button"
                    onClick={() => setSteps((current) => current.filter((_, i) => i !== index))}
                    className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger"
                    aria-label={t("Remove step")}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="mb-3 font-display text-lg">{t("Photo")}</h2>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-dashed border-line bg-raised text-muted"
              >
                {image ? <img src={image} alt="" className="h-full w-full object-cover" /> : imageBusy ? <Icon name="refresh" size={20} className="animate-spin" /> : <Icon name="camera" size={22} />}
              </button>
              <div className="space-y-2">
                <Button type="button" size="sm" variant="secondary" icon="upload" onClick={() => fileRef.current?.click()} loading={imageBusy}>
                  {image ? t("Replace") : t("Add photo")}
                </Button>
                {image && (
                  <Button type="button" size="sm" variant="ghost" icon="close" onClick={() => setImage(null)}>
                    {t("Remove ")}</Button>
                )}
                <p className="text-[11px] text-muted">{t("Shows at the top of the recipe and in the list.")}</p>
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadImage(file);
              }}
            />
          </Card>

          <Card className="space-y-3 p-4">
            <h2 className="font-display text-lg">{t("Quick options")}</h2>
            <label className="flex items-center justify-between gap-3 text-sm">
              {t("Favourite ")}<input type="checkbox" checked={favorite} onChange={(e) => setFavorite(e.target.checked)} className="h-5 w-5 accent-[var(--sv-brand)]" />
            </label>
            {source !== "manual" && <Badge tone="brand">{t("Imported from ")}{' '}{source === "scan" ? t("a scan") : t("AI")}</Badge>}
            {sourceImage && (
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{t("Original scan")}</div>
                <ZoomableImage
                  src={sourceImage}
                  alt={t("Original recipe scan")}
                  wrapperClassName="mt-1 overflow-hidden rounded-lg border border-line"
                  className="w-full"
                />
              </div>
            )}
            {ocrText && (
              <details className="text-xs text-muted">
                <summary className="cursor-pointer font-medium text-muted">{t("Raw OCR text")}</summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-raised p-2 text-[10px] leading-relaxed">{ocrText}</pre>
              </details>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="font-display text-lg">{t("Faster: scan it")}</h2>
            <p className="mt-1 text-xs text-muted">{t("Photograph a handwritten recipe and let OCR + AI structure it for you.")}</p>
            <Button type="button" variant="secondary" size="sm" icon="camera" className="mt-3" onClick={() => navigate("/recipes/scan")}>
              {t("Open scanner ")}</Button>
          </Card>

          <Button type="submit" block size="lg" loading={saving} disabled={!title.trim()}>
            {editing ? t("Save recipe") : t("Create recipe")}
          </Button>
        </div>
      </div>
    </form>
  );
}
