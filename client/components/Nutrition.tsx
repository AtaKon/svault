import { Badge, Button, Card, Field, Input, Select } from "@/components/ui";
import type { NutritionBasis, NutritionFacts, NutritionValues } from "@shared/types";

const FIELDS: { key: keyof NutritionValues; label: string; unit: string }[] = [
  { key: "energyKcal", label: "Energy", unit: "kcal" },
  { key: "energyKj", label: "Energy", unit: "kJ" },
  { key: "fat", label: "Fat", unit: "g" },
  { key: "saturatedFat", label: "of which saturates", unit: "g" },
  { key: "carbohydrates", label: "Carbohydrate", unit: "g" },
  { key: "sugars", label: "of which sugars", unit: "g" },
  { key: "fiber", label: "Fibre", unit: "g" },
  { key: "proteins", label: "Protein", unit: "g" },
  { key: "salt", label: "Salt", unit: "g" },
  { key: "sodium", label: "Sodium", unit: "g" },
];

export interface NutritionDraft {
  basis: NutritionBasis;
  energyKcal: string;
  energyKj: string;
  fat: string;
  saturatedFat: string;
  carbohydrates: string;
  sugars: string;
  fiber: string;
  proteins: string;
  salt: string;
  sodium: string;
  servingSize: string;
  servingQuantity: string;
  source: "openfoodfacts" | "manual";
}

function stringValue(value: number | null | undefined): string {
  return value == null ? "" : String(value);
}

export function emptyNutritionDraft(): NutritionDraft {
  return {
    basis: "100g",
    energyKcal: "",
    energyKj: "",
    fat: "",
    saturatedFat: "",
    carbohydrates: "",
    sugars: "",
    fiber: "",
    proteins: "",
    salt: "",
    sodium: "",
    servingSize: "",
    servingQuantity: "",
    source: "manual",
  };
}

export function nutritionDraft(nutrition: NutritionFacts | null | undefined): NutritionDraft {
  if (!nutrition) return emptyNutritionDraft();
  return {
    basis: nutrition.basis,
    energyKcal: stringValue(nutrition.energyKcal),
    energyKj: stringValue(nutrition.energyKj),
    fat: stringValue(nutrition.fat),
    saturatedFat: stringValue(nutrition.saturatedFat),
    carbohydrates: stringValue(nutrition.carbohydrates),
    sugars: stringValue(nutrition.sugars),
    fiber: stringValue(nutrition.fiber),
    proteins: stringValue(nutrition.proteins),
    salt: stringValue(nutrition.salt),
    sodium: stringValue(nutrition.sodium),
    servingSize: nutrition.servingSize ?? "",
    servingQuantity: stringValue(nutrition.servingQuantity),
    source: nutrition.source,
  };
}

function draftNumber(value: string): number | null {
  const raw = value.trim();
  if (!raw) return null;
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function draftToNutrition(draft: NutritionDraft): NutritionFacts | null {
  const values: NutritionValues = {
    energyKcal: draftNumber(draft.energyKcal),
    energyKj: draftNumber(draft.energyKj),
    fat: draftNumber(draft.fat),
    saturatedFat: draftNumber(draft.saturatedFat),
    carbohydrates: draftNumber(draft.carbohydrates),
    sugars: draftNumber(draft.sugars),
    fiber: draftNumber(draft.fiber),
    proteins: draftNumber(draft.proteins),
    salt: draftNumber(draft.salt),
    sodium: draftNumber(draft.sodium),
  };
  const servingSize = draft.servingSize.trim() || null;
  const servingQuantity = draftNumber(draft.servingQuantity);
  const hasValues = Object.values(values).some((value) => value != null);
  if (!hasValues && !servingSize && servingQuantity == null) return null;
  return {
    ...values,
    basis: draft.basis,
    servingSize,
    servingQuantity,
    source: draft.source,
  };
}

export function basisLabel(basis: NutritionBasis | null | undefined): string {
  return basis === "100ml" ? "per 100 ml" : "per 100 g";
}

function grams(value: number | null | undefined, unit = "g"): string {
  if (value == null) return "—";
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ${unit}`;
}

function milligrams(value: number | null | undefined): string {
  if (value == null) return "—";
  const mg = Math.round(value * 1000);
  return `${mg} mg`;
}

export function NutritionRows({ values }: { values: NutritionValues }) {
  const rows = [
    {
      label: "Energy",
      value: values.energyKcal != null ? `${Math.round(values.energyKcal)} kcal` : "—",
      detail: values.energyKj != null ? `${Math.round(values.energyKj)} kJ` : null,
    },
    {
      label: "Fat",
      value: grams(values.fat),
      detail: values.saturatedFat != null ? `saturates ${grams(values.saturatedFat)}` : null,
    },
    {
      label: "Carbohydrate",
      value: grams(values.carbohydrates),
      detail: values.sugars != null ? `sugars ${grams(values.sugars)}` : null,
    },
    {
      label: "Fibre",
      value: grams(values.fiber),
      detail: null,
    },
    {
      label: "Protein",
      value: grams(values.proteins),
      detail: null,
    },
    {
      label: "Salt",
      value: grams(values.salt),
      detail: values.sodium != null ? `sodium ${milligrams(values.sodium)}` : null,
    },
  ];
  return (
    <dl className="divide-y divide-line text-[12px]">
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-3 py-1.5">
          <dt className="text-muted">{row.label}</dt>
          <dd className="text-right">
            <span className="font-medium">{row.value}</span>
            {row.detail && <span className="ml-1.5 text-[11px] text-muted">{row.detail}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function NutritionFormCard({
  draft,
  onChange,
}: {
  draft: NutritionDraft;
  onChange: (next: NutritionDraft) => void;
}) {
  const update = (patch: Partial<NutritionDraft>) => onChange({ ...draft, ...patch, source: "manual" });
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-lg">Nutrition</h2>
          <p className="mt-0.5 text-[11px] text-muted">
            Values per 100 g or 100 ml. Linked OpenFoodFacts products fill these automatically.
          </p>
        </div>
        {draft.source === "openfoodfacts" ? <Badge tone="brand">OpenFoodFacts</Badge> : <Badge tone="outline">Manual</Badge>}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Values per">
          <Select value={draft.basis} onChange={(event) => update({ basis: event.target.value as NutritionBasis })}>
            <option value="100g">100 g</option>
            <option value="100ml">100 ml</option>
          </Select>
        </Field>
        <Field label="Serving size" hint="optional, e.g. 30 g">
          <Input value={draft.servingSize} onChange={(event) => update({ servingSize: event.target.value })} maxLength={60} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {FIELDS.map((field) => (
          <Field key={field.key} label={field.label} hint={field.unit}>
            <Input
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={draft[field.key]}
              onChange={(event) => update({ [field.key]: event.target.value })}
              className="h-10 text-[13px]"
            />
          </Field>
        ))}
      </div>
      <Field label={`Serving weight (${draft.basis === "100ml" ? "ml" : "g"})`} hint="used for count-based ingredients">
        <Input
          type="number"
          min="0"
          step="any"
          inputMode="decimal"
          value={draft.servingQuantity}
          onChange={(event) => update({ servingQuantity: event.target.value })}
          placeholder={draft.basis === "100ml" ? "e.g. 330" : "e.g. 30"}
          className="h-10 text-[13px]"
        />
      </Field>
      <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
        <p className="text-[11px] leading-relaxed text-muted">
          Leave everything blank if this product has no nutrition label. Recipe estimates use per-portion values and
          the serving weight when an ingredient is counted in pieces.
        </p>
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange(emptyNutritionDraft())}>
          Clear
        </Button>
      </div>
    </Card>
  );
}
