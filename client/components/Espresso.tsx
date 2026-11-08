import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api";
import { useAuth, useHouse } from "@/state";
import { useI18n } from "@/i18n";
import { Badge, Button, Card, Field, IconButton, Input, Select, Sheet, Spinner, Textarea, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { qty } from "@/format";
import {
  ESPRESSO_ROAST_LEVELS,
  type EspressoBeanSummary,
  type EspressoRoastLevel,
  type EspressoShot,
  type EspressoShotList,
  type EspressoShotSummary,
  type ItemDetail,
} from "@shared/types";

const ROAST_LABEL: Record<EspressoRoastLevel, string> = {
  light: "Light roast",
  "medium-light": "Medium-light roast",
  medium: "Medium roast",
  "medium-dark": "Medium-dark roast",
  dark: "Dark roast",
};

function localInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function numberOrNull(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatShotDate(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/* ------------------------------------------------------------------- stars */

export function EspressoStars({
  value,
  onChange,
  size = 15,
  className,
}: {
  value: number;
  onChange?: (next: number) => void;
  size?: number;
  className?: string;
}) {
  const { t } = useI18n();
  const interactive = Boolean(onChange);
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)} aria-label={t("{count} out of 5 stars", { count: value })}>
      {[1, 2, 3, 4, 5].map((star) =>
        interactive ? (
          <button
            key={star}
            type="button"
            onClick={() => onChange?.(star)}
            aria-label={t("{count} out of 5 stars", { count: star })}
            className={cn(
              "rounded p-0.5 transition-colors",
              star <= value ? "text-warn" : "text-line hover:text-warn/60",
            )}
          >
            <Icon name="star" size={size} fill={star <= value ? "currentColor" : "none"} />
          </button>
        ) : (
          <Icon
            key={star}
            name="star"
            size={size}
            className={star <= value ? "text-warn" : "text-line"}
            fill={star <= value ? "currentColor" : "none"}
          />
        ),
      )}
    </span>
  );
}

/* ---------------------------------------------------------------- the sheet */

export function EspressoShotSheet({
  open,
  onClose,
  shot,
  beans,
  initialItemId,
  onSaved,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  shot?: EspressoShot | null;
  beans: EspressoBeanSummary[];
  initialItemId?: string;
  onSaved: (shot: EspressoShot) => void;
  onDeleted?: (shot: EspressoShot) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [itemId, setItemId] = useState(initialItemId ?? beans[0]?.id ?? "");
  const [brewedAt, setBrewedAt] = useState(localInput(new Date().toISOString()));
  const [rating, setRating] = useState(0);
  const [roastLevel, setRoastLevel] = useState("");
  const [grindSetting, setGrindSetting] = useState("");
  const [grindSeconds, setGrindSeconds] = useState("");
  const [doseGrams, setDoseGrams] = useState("");
  const [yieldGrams, setYieldGrams] = useState("");
  const [extractionSeconds, setExtractionSeconds] = useState("");
  const [waterTempC, setWaterTempC] = useState("");
  const [pressureBar, setPressureBar] = useState("");
  const [tdsPercent, setTdsPercent] = useState("");
  const [grinder, setGrinder] = useState("");
  const [machine, setMachine] = useState("");
  const [tastingNotes, setTastingNotes] = useState("");
  const [tags, setTags] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Reset when the sheet opens, another shot is selected, or the target item
  // changes. A newly added bean does not reset an in-progress edit.
  useEffect(() => {
    if (!open) return;
    if (shot) {
      setItemId(shot.itemId);
      setBrewedAt(localInput(shot.brewedAt));
      setRating(shot.rating);
      setRoastLevel(shot.roastLevel ?? "");
      setGrindSetting(shot.grindSetting ?? "");
      setGrindSeconds(shot.grindSeconds == null ? "" : String(shot.grindSeconds));
      setDoseGrams(shot.doseGrams == null ? "" : String(shot.doseGrams));
      setYieldGrams(shot.yieldGrams == null ? "" : String(shot.yieldGrams));
      setExtractionSeconds(shot.extractionSeconds == null ? "" : String(shot.extractionSeconds));
      setWaterTempC(shot.waterTempC == null ? "" : String(shot.waterTempC));
      setPressureBar(shot.pressureBar == null ? "" : String(shot.pressureBar));
      setTdsPercent(shot.tdsPercent == null ? "" : String(shot.tdsPercent));
      setGrinder(shot.grinder ?? "");
      setMachine(shot.machine ?? "");
      setTastingNotes(shot.tastingNotes ?? "");
      setTags(shot.tags.join(", "));
      setNotes(shot.notes ?? "");
    } else {
      setItemId(initialItemId ?? beans[0]?.id ?? "");
      setBrewedAt(localInput(new Date().toISOString()));
      setRating(0);
      setRoastLevel("");
      setGrindSetting("");
      setGrindSeconds("");
      setDoseGrams("");
      setYieldGrams("");
      setExtractionSeconds("");
      setWaterTempC("");
      setPressureBar("");
      setTdsPercent("");
      setGrinder("");
      setMachine("");
      setTastingNotes("");
      setTags("");
      setNotes("");
    }
  }, [open, shot?.id, initialItemId]);

  // If the bean list arrives after the sheet opened, seed the selector instead
  // of leaving an empty item id and a disabled save button.
  useEffect(() => {
    if (!open || shot) return;
    if (!itemId && beans.length > 0) setItemId(initialItemId ?? beans[0].id);
  }, [open, shot, itemId, initialItemId, beans]);

  const liveRatio = useMemo(() => {
    const dose = numberOrNull(doseGrams);
    const yieldValue = numberOrNull(yieldGrams);
    return dose != null && dose > 0 && yieldValue != null ? yieldValue / dose : null;
  }, [doseGrams, yieldGrams]);
  const liveExtractionYield = useMemo(() => {
    const dose = numberOrNull(doseGrams);
    const yieldValue = numberOrNull(yieldGrams);
    const tds = numberOrNull(tdsPercent);
    return dose != null && dose > 0 && yieldValue != null && tds != null ? (yieldValue * tds) / dose : null;
  }, [doseGrams, yieldGrams, tdsPercent]);

  const save = async () => {
    if (!rating) {
      toast.error(t("Choose a rating first"));
      return;
    }
    if (!shot && !itemId) {
      toast.error(t("Choose a coffee first"));
      return;
    }
    const brewed = new Date(brewedAt);
    if (Number.isNaN(brewed.getTime())) {
      toast.error(t("Choose a brew date"));
      return;
    }
    setSaving(true);
    try {
      const body = {
        brewedAt: brewed.toISOString(),
        rating,
        roastLevel: roastLevel || null,
        grindSetting: grindSetting.trim() || null,
        grindSeconds: numberOrNull(grindSeconds),
        doseGrams: numberOrNull(doseGrams),
        yieldGrams: numberOrNull(yieldGrams),
        extractionSeconds: numberOrNull(extractionSeconds),
        waterTempC: numberOrNull(waterTempC),
        pressureBar: numberOrNull(pressureBar),
        tdsPercent: numberOrNull(tdsPercent),
        grinder: grinder.trim() || null,
        machine: machine.trim() || null,
        tastingNotes: tastingNotes.trim() || null,
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        notes: notes.trim() || null,
      };
      const saved = shot
        ? await api<EspressoShot>(`/api/items/${shot.itemId}/espresso-shots/${shot.id}`, { method: "PATCH", body })
        : await api<EspressoShot>(`/api/items/${itemId}/espresso-shots`, { method: "POST", body });
      toast.success(shot ? t("Shot updated") : t("Shot logged"));
      onSaved(saved);
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? t(error.message) : t("Could not save the shot"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!shot || !window.confirm(t("Delete this shot? Its tasting notes and brewing settings will be removed."))) return;
    setDeleting(true);
    try {
      await api(`/api/items/${shot.itemId}/espresso-shots/${shot.id}`, { method: "DELETE" });
      toast.success(t("Shot deleted"));
      onDeleted?.(shot);
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? t(error.message) : t("Could not delete the shot"));
    } finally {
      setDeleting(false);
    }
  };

  const beanChoices = !shot && beans.length > 1;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={shot ? t("Edit shot") : t("Log a shot")}
      description={t("Rate the espresso and record how you dialled it in.")}
    >
      <div className="space-y-3 pb-2">
        {beanChoices && (
          <Field label={t("Coffee")} required>
            <Select value={itemId} onChange={(event) => setItemId(event.target.value)}>
              {beans.map((bean) => (
                <option key={bean.id} value={bean.id}>
                  {bean.name}
                  {bean.brand ? ` · ${bean.brand}` : ""}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <div className="rounded-2xl border border-line bg-raised/60 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{t("Rating")}</div>
              <EspressoStars value={rating} onChange={setRating} size={24} className="mt-1" />
            </div>
            <Badge tone={rating >= 4 ? "brand" : "outline"}>{rating ? `${rating}/5` : t("Not rated")}</Badge>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t("Brew date")} required>
            <Input type="datetime-local" value={brewedAt} onChange={(event) => setBrewedAt(event.target.value)} />
          </Field>
          <Field label={t("Roast level")}>
            <Select value={roastLevel} onChange={(event) => setRoastLevel(event.target.value)}>
              <option value="">{t("Not recorded")}</option>
              {ESPRESSO_ROAST_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {t(ROAST_LABEL[level])}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <Field label={t("Dose (g)")}>
            <Input type="number" inputMode="decimal" step="any" min="0" value={doseGrams} onChange={(event) => setDoseGrams(event.target.value)} placeholder="18" />
          </Field>
          <Field label={t("Yield (g)")}>
            <Input type="number" inputMode="decimal" step="any" min="0" value={yieldGrams} onChange={(event) => setYieldGrams(event.target.value)} placeholder="36" />
          </Field>
          <Field label={t("Time (s)")}>
            <Input type="number" inputMode="decimal" step="any" min="0" value={extractionSeconds} onChange={(event) => setExtractionSeconds(event.target.value)} placeholder="28" />
          </Field>
        </div>

        {(liveRatio != null || liveExtractionYield != null) && (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
            {liveRatio != null && (
              <Badge tone="outline">{t("Ratio 1:{value}", { value: qty(Math.round(liveRatio * 10) / 10) })}</Badge>
            )}
            {liveExtractionYield != null && (
              <Badge tone="outline">{t("Extraction yield {value}%", { value: qty(Math.round(liveExtractionYield * 10) / 10) })}</Badge>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label={t("Grind setting")} hint={t("a number or a word")}>
            <Input value={grindSetting} onChange={(event) => setGrindSetting(event.target.value)} placeholder="2.4" maxLength={40} />
          </Field>
          <Field label={t("Grind time (s)")}>
            <Input type="number" inputMode="decimal" step="any" min="0" value={grindSeconds} onChange={(event) => setGrindSeconds(event.target.value)} placeholder="12" />
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <Field label={t("Water temp. (°C)")}>
            <Input type="number" inputMode="decimal" step="any" min="0" value={waterTempC} onChange={(event) => setWaterTempC(event.target.value)} placeholder="93" />
          </Field>
          <Field label={t("Pressure (bar)")}>
            <Input type="number" inputMode="decimal" step="any" min="0" value={pressureBar} onChange={(event) => setPressureBar(event.target.value)} placeholder="9" />
          </Field>
          <Field label={t("TDS (%)")}>
            <Input type="number" inputMode="decimal" step="any" min="0" value={tdsPercent} onChange={(event) => setTdsPercent(event.target.value)} placeholder="9.2" />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t("Grinder")}>
            <Input value={grinder} onChange={(event) => setGrinder(event.target.value)} placeholder="Eureka Mignon" maxLength={80} />
          </Field>
          <Field label={t("Machine")}>
            <Input value={machine} onChange={(event) => setMachine(event.target.value)} placeholder="Lelit Mara X" maxLength={80} />
          </Field>
        </div>

        <Field label={t("Tasting notes")}>
          <Input value={tastingNotes} onChange={(event) => setTastingNotes(event.target.value)} placeholder={t("Cocoa, orange peel, syrupy")} maxLength={500} />
        </Field>
        <Field label={t("Flavour tags")} hint={t("comma separated")}>
          <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder={t("chocolate, citrus, sweet")} maxLength={400} />
        </Field>
        <Field label={t("Notes")} hint={t("optional")}>
          <Textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder={t("What you would change next time…")} maxLength={2000} />
        </Field>

        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="button" onClick={() => void save()} loading={saving} disabled={!rating || (!shot && !itemId)}>
            {shot ? t("Save changes") : t("Log shot")}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("Cancel")}
          </Button>
          {shot && (
            <Button
              type="button"
              variant="ghost"
              className="text-danger hover:bg-danger-soft"
              loading={deleting}
              onClick={() => void remove()}
            >
              {t("Delete")}
            </Button>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/* -------------------------------------------------------------------- rows */

export function EspressoShotRow({
  shot,
  showItem = false,
  canEdit = false,
  onEdit,
}: {
  shot: EspressoShot;
  showItem?: boolean;
  canEdit?: boolean;
  onEdit?: () => void;
}) {
  const { t, locale } = useI18n();
  const details = [
    shot.roastLevel ? t(ROAST_LABEL[shot.roastLevel]) : null,
    shot.grindSetting ? t("Grind {value}", { value: shot.grindSetting }) : null,
    shot.doseGrams != null && shot.yieldGrams != null
      ? `${qty(shot.doseGrams)} g → ${qty(shot.yieldGrams)} g`
      : shot.doseGrams != null
        ? t("{value} g in", { value: qty(shot.doseGrams) })
        : shot.yieldGrams != null
          ? t("{value} g out", { value: qty(shot.yieldGrams) })
          : null,
    shot.extractionSeconds != null ? t("{value} s", { value: qty(shot.extractionSeconds) }) : null,
    shot.ratio != null ? t("1:{value}", { value: qty(shot.ratio) }) : null,
    shot.waterTempC != null ? `${qty(shot.waterTempC)}°C` : null,
    shot.tdsPercent != null ? `TDS ${qty(shot.tdsPercent)}%` : null,
  ].filter(Boolean);

  return (
    <div className="flex items-start gap-3 py-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-warn-soft text-warn">
        <Icon name="cup" size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {showItem && (
              <Link to={`/items/${shot.itemId}`} className="block truncate text-[13px] font-medium hover:underline">
                {shot.itemName ?? t("Coffee")}
                {shot.itemBrand ? <span className="font-normal text-muted"> · {shot.itemBrand}</span> : null}
              </Link>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <EspressoStars value={shot.rating} size={12} />
              {shot.tastingNotes && <span className="truncate text-[12px] text-muted">{shot.tastingNotes}</span>}
            </div>
          </div>
          <span className="shrink-0 text-[10px] text-muted">{formatShotDate(shot.brewedAt, locale)}</span>
        </div>
        {details.length > 0 && <div className="mt-0.5 text-[11px] leading-relaxed text-muted">{details.join(" · ")}</div>}
        {shot.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {shot.tags.map((tag) => (
              <Badge key={tag} tone="outline">
                {tag}
              </Badge>
            ))}
          </div>
        )}
        {shot.notes && <div className="mt-1 text-[11px] italic text-muted">“{shot.notes}”</div>}
        {shot.userName && <div className="mt-1 text-[10px] text-muted">{t("by {name}", { name: shot.userName })}</div>}
      </div>
      {canEdit && onEdit && <IconButton icon="pencil" label={t("Edit shot")} onClick={onEdit} className="mt-0.5" />}
    </div>
  );
}

/* --------------------------------------------------------------- summaries */

export function EspressoSummaryStrip({ summary }: { summary: EspressoShotSummary }) {
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-3 gap-2">
      <div className="rounded-xl bg-raised px-2 py-2 text-center">
        <div className="text-[10px] uppercase tracking-wide text-muted">{t("Average rating")}</div>
        <div className="mt-0.5 text-sm font-medium">
          {summary.averageRating == null ? "—" : qty(summary.averageRating)}
        </div>
      </div>
      <div className="rounded-xl bg-raised px-2 py-2 text-center">
        <div className="text-[10px] uppercase tracking-wide text-muted">{t("Avg. ratio")}</div>
        <div className="mt-0.5 text-sm font-medium">
          {summary.averageRatio == null ? "—" : `1:${qty(summary.averageRatio)}`}
        </div>
      </div>
      <div className="rounded-xl bg-raised px-2 py-2 text-center">
        <div className="text-[10px] uppercase tracking-wide text-muted">{t("Avg. time")}</div>
        <div className="mt-0.5 text-sm font-medium">
          {summary.averageExtractionSeconds == null ? "—" : t("{value} s", { value: qty(summary.averageExtractionSeconds) })}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- item card */

export function EspressoLogCard({ item }: { item: ItemDetail }) {
  const { t } = useI18n();
  const { can } = useHouse();
  const { user } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<EspressoShotList | null>(null);
  const [loading, setLoading] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<EspressoShot | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api<EspressoShotList>(`/api/items/${item.id}/espresso-shots`);
      setData(result);
    } catch (error) {
      toast.error(error instanceof Error ? t(error.message) : t("Could not load espresso shots"));
    } finally {
      setLoading(false);
    }
  }, [item.id, t, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const beans = useMemo<EspressoBeanSummary[]>(
    () => [
      {
        id: item.id,
        name: item.name,
        brand: item.brand,
        espresso: true,
        shotCount: data?.summary.count ?? 0,
        averageRating: data?.summary.averageRating ?? null,
        lastBrewedAt: data?.summary.lastBrewedAt ?? null,
      },
    ],
    [item.id, item.name, item.brand, data?.summary],
  );

  const canEdit = (shot: EspressoShot) => can("member") && (shot.userId === user?.id || can("admin"));

  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-warn-soft text-warn">
            <Icon name="cup" size={16} />
          </span>
          <h2 className="font-display text-lg">{t("Espresso log")}</h2>
          <Badge tone="outline">{data?.summary.count ?? 0}</Badge>
        </div>
        {can("member") && (
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            onClick={() => {
              setEditing(null);
              setSheetOpen(true);
            }}
          >
            {t("Log shot")}
          </Button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-3 text-xs text-muted">
          <Spinner size={14} /> {t("Loading shots")}
        </div>
      ) : (data?.shots.length ?? 0) === 0 ? (
        <p className="py-2 text-xs leading-relaxed text-muted">
          {t("No shots yet. Log the first one to start a tasting history for this coffee.")}
        </p>
      ) : (
        <>
          <EspressoSummaryStrip summary={data!.summary} />
          <div className="mt-2 divide-y divide-line">
            {data!.shots.slice(0, 8).map((shot) => (
              <EspressoShotRow
                key={shot.id}
                shot={shot}
                canEdit={canEdit(shot)}
                onEdit={() => {
                  setEditing(shot);
                  setSheetOpen(true);
                }}
              />
            ))}
          </div>
          {data!.shots.length > 8 && (
            <Link
              to={`/espresso?itemId=${item.id}`}
              className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-brand hover:underline"
            >
              {t("See all shots")} <Icon name="chevronRight" size={12} />
            </Link>
          )}
        </>
      )}

      <EspressoShotSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        shot={editing}
        beans={beans}
        initialItemId={item.id}
        onSaved={() => void load()}
        onDeleted={() => void load()}
      />
    </Card>
  );
}
