import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "@/api";
import { useAuth, useHouse } from "@/state";
import { useI18n } from "@/i18n";
import { Badge, Button, Card, Field, IconButton, Input, Select, Sheet, Spinner, Textarea, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { qty } from "@/format";
import {
  ESPRESSO_ROAST_LEVELS,
  type EspressoBeanSummary,
  type EspressoEquipment,
  type EspressoEquipmentKind,
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

/** Accept both "18.5" and "18,5" so a decimal comma never becomes an empty field. */
function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const parsed = Number(trimmed.replace(/,/g, "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function decimalInput(value: number | null | undefined): string {
  return value == null ? "" : String(value);
}

/** In-progress legacy free text, kept as a selectable option while editing. */
const LEGACY_TEXT_PREFIX = "text:";

function equipmentPick(id: string | null | undefined, text: string | null | undefined): string {
  if (id) return id;
  return text ? `${LEGACY_TEXT_PREFIX}${text}` : "";
}

function equipmentPayload(pick: string): { id: string | null; text: string | null } {
  if (!pick) return { id: null, text: null };
  if (pick.startsWith(LEGACY_TEXT_PREFIX)) {
    return { id: null, text: pick.slice(LEGACY_TEXT_PREFIX.length) };
  }
  return { id: pick, text: null };
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

/* --------------------------------------------------------------- equipment */

/** Dropdown for saved equipment with an inline "new machine/grinder" form. */
function EquipmentSelect({
  kind,
  label,
  value,
  onChange,
  equipment,
  onCreated,
  onRefresh,
  canCreate,
}: {
  kind: EspressoEquipmentKind;
  label: string;
  value: string;
  onChange: (next: string) => void;
  equipment: EspressoEquipment[];
  onCreated: (created: EspressoEquipment) => void;
  onRefresh: () => Promise<EspressoEquipment[]>;
  canCreate: boolean;
}) {
  const { t } = useI18n();
  const { house } = useHouse();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const created = await api<EspressoEquipment>(`/api/houses/${house.id}/espresso-equipment`, {
        method: "POST",
        body: { kind, name: trimmed },
      });
      toast.success(kind === "machine" ? t("Machine added") : t("Grinder added"));
      setCreating(false);
      setName("");
      onCreated(created);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // The name exists already, so pick it instead of leaving the form open.
        const list = await onRefresh();
        const existing = list.find(
          (entry) => entry.kind === kind && entry.name.trim().toLowerCase() === trimmed.toLowerCase(),
        );
        if (existing) onChange(existing.id);
        setCreating(false);
        setName("");
        toast.push(t("That name already exists; pick it from the list."));
      } else {
        toast.error(error instanceof Error ? t(error.message) : t("Could not save the equipment"));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{label}</span>
        {canCreate && (
          <button
            type="button"
            onClick={() => setCreating((current) => !current)}
            className="text-[11px] font-medium text-brand hover:underline"
          >
            {creating ? t("Cancel") : t("New")}
          </button>
        )}
      </div>
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t("Not recorded")}</option>
        {value.startsWith(LEGACY_TEXT_PREFIX) && (
          <option value={value}>{value.slice(LEGACY_TEXT_PREFIX.length)}</option>
        )}
        {equipment.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
            {entry.brand ? ` · ${entry.brand}` : ""}
          </option>
        ))}
      </Select>
      {creating && (
        <div className="mt-2 flex gap-2">
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void create();
              }
            }}
            placeholder={t(kind === "machine" ? "e.g. Lelit Mara X" : "e.g. Eureka Mignon")}
            maxLength={80}
          />
          <Button type="button" size="sm" onClick={() => void create()} loading={saving} disabled={!name.trim()}>
            {t("Add")}
          </Button>
        </div>
      )}
    </div>
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
  const [roastLevel, setRoastLevel] = useState<EspressoRoastLevel | "">("");
  const [grindSetting, setGrindSetting] = useState("");
  const [grindSeconds, setGrindSeconds] = useState("");
  const [doseGrams, setDoseGrams] = useState("");
  const [yieldGrams, setYieldGrams] = useState("");
  const [extractionSeconds, setExtractionSeconds] = useState("");
  const [waterTempC, setWaterTempC] = useState("");
  const [pressureBar, setPressureBar] = useState("");
  const [tdsPercent, setTdsPercent] = useState("");
  const [grinderPick, setGrinderPick] = useState("");
  const [machinePick, setMachinePick] = useState("");
  const [tastingNotes, setTastingNotes] = useState("");
  const [tags, setTags] = useState("");
  const [notes, setNotes] = useState("");
  const [equipment, setEquipment] = useState<EspressoEquipment[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { house, can } = useHouse();
  const canManage = can("member");

  const loadEquipment = useCallback(async (): Promise<EspressoEquipment[]> => {
    try {
      const list = await api<EspressoEquipment[]>(`/api/houses/${house.id}/espresso-equipment`);
      setEquipment(list);
      return list;
    } catch {
      // The sheet still works without saved equipment; logging a shot should not block.
      return [];
    }
  }, [house.id]);

  useEffect(() => {
    if (open) void loadEquipment();
  }, [open, loadEquipment]);

  const addEquipment = (created: EspressoEquipment) => {
    setEquipment((current) =>
      [...current.filter((entry) => entry.id !== created.id), created].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    );
    if (created.kind === "grinder") setGrinderPick(created.id);
    else setMachinePick(created.id);
  };
  const machines = equipment.filter((entry) => entry.kind === "machine");
  const grinders = equipment.filter((entry) => entry.kind === "grinder");

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
      setGrindSeconds(decimalInput(shot.grindSeconds));
      setDoseGrams(decimalInput(shot.doseGrams));
      setYieldGrams(decimalInput(shot.yieldGrams));
      setExtractionSeconds(decimalInput(shot.extractionSeconds));
      setWaterTempC(decimalInput(shot.waterTempC));
      setPressureBar(decimalInput(shot.pressureBar));
      setTdsPercent(decimalInput(shot.tdsPercent));
      setGrinderPick(equipmentPick(shot.grinderId, shot.grinder));
      setMachinePick(equipmentPick(shot.machineId, shot.machine));
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
      setGrinderPick("");
      setMachinePick("");
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
    if (!shot && (!itemId || !beans.some((bean) => bean.id === itemId))) {
      toast.error(t("Choose a coffee first"));
      return;
    }
    const brewed = new Date(brewedAt);
    if (Number.isNaN(brewed.getTime())) {
      toast.error(t("Choose a brew date"));
      return;
    }
    const numeric = [grindSeconds, doseGrams, yieldGrams, extractionSeconds, waterTempC, pressureBar, tdsPercent];
    if (numeric.some((value) => value.trim() && numberOrNull(value) == null)) {
      toast.error(t("Use numbers without spaces; a dot or comma is fine for decimals"));
      return;
    }
    const grinder = equipmentPayload(grinderPick);
    const machine = equipmentPayload(machinePick);
    // Leave untouched equipment out of the PATCH so a legacy free-text label is
    // never cleared by an edit that did not change the picker.
    const grinderChanged = !shot || grinderPick !== equipmentPick(shot.grinderId, shot.grinder);
    const machineChanged = !shot || machinePick !== equipmentPick(shot.machineId, shot.machine);
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
        grinderId: grinderChanged ? grinder.id : undefined,
        machineId: machineChanged ? machine.id : undefined,
        grinder: grinderChanged ? grinder.text : undefined,
        machine: machineChanged ? machine.text : undefined,
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
            <Input
              type="datetime-local"
              value={brewedAt}
              min="2000-01-01T00:00"
              max={localInput(new Date(Date.now() + 864e5).toISOString())}
              onChange={(event) => setBrewedAt(event.target.value)}
            />
          </Field>
          <Field label={t("Roast level")}>
            <Select value={roastLevel} onChange={(event) => setRoastLevel(event.target.value as EspressoRoastLevel | "")}>
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
            <Input type="text" inputMode="decimal" autoComplete="off" value={doseGrams} onChange={(event) => setDoseGrams(event.target.value)} placeholder="18.5" />
          </Field>
          <Field label={t("Yield (g)")}>
            <Input type="text" inputMode="decimal" autoComplete="off" value={yieldGrams} onChange={(event) => setYieldGrams(event.target.value)} placeholder="36.5" />
          </Field>
          <Field label={t("Time (s)")}>
            <Input type="text" inputMode="decimal" autoComplete="off" value={extractionSeconds} onChange={(event) => setExtractionSeconds(event.target.value)} placeholder="28.5" />
          </Field>
        </div>

        <p className="text-[10px] text-muted">{t("Decimals are fine, e.g. 18.5 g or 28.4 s.")}</p>

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
            <Input type="text" inputMode="decimal" autoComplete="off" value={grindSeconds} onChange={(event) => setGrindSeconds(event.target.value)} placeholder="12.5" />
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <Field label={t("Water temp. (°C)")}>
            <Input type="text" inputMode="decimal" autoComplete="off" value={waterTempC} onChange={(event) => setWaterTempC(event.target.value)} placeholder="93" />
          </Field>
          <Field label={t("Pressure (bar)")}>
            <Input type="text" inputMode="decimal" autoComplete="off" value={pressureBar} onChange={(event) => setPressureBar(event.target.value)} placeholder="9" />
          </Field>
          <Field label={t("TDS (%)")}>
            <Input type="text" inputMode="decimal" autoComplete="off" value={tdsPercent} onChange={(event) => setTdsPercent(event.target.value)} placeholder="9.2" />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <EquipmentSelect
            kind="grinder"
            label={t("Grinder")}
            value={grinderPick}
            onChange={setGrinderPick}
            equipment={grinders}
            onCreated={addEquipment}
            onRefresh={loadEquipment}
            canCreate={canManage}
          />
          <EquipmentSelect
            kind="machine"
            label={t("Machine")}
            value={machinePick}
            onChange={setMachinePick}
            equipment={machines}
            onCreated={addEquipment}
            onRefresh={loadEquipment}
            canCreate={canManage}
          />
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
    shot.machine ? t("Machine {value}", { value: shot.machine }) : null,
    shot.grinder ? t("Grinder {value}", { value: shot.grinder }) : null,
    shot.waterTempC != null ? `${qty(shot.waterTempC)}°C` : null,
    shot.tdsPercent != null ? `TDS ${qty(shot.tdsPercent)}%` : null,
    shot.extractionYieldPercent != null
      ? t("EY {value}%", { value: qty(shot.extractionYieldPercent) })
      : null,
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

/* ------------------------------------------------------ equipment manager */

function EquipmentSection({
  kind,
  title,
  items,
  onSave,
  onDelete,
}: {
  kind: EspressoEquipmentKind;
  title: string;
  items: EspressoEquipment[];
  onSave: (payload: {
    id?: string;
    kind: EspressoEquipmentKind;
    name: string;
    brand: string | null;
  }) => Promise<boolean>;
  onDelete: (entry: EspressoEquipment) => void;
}) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState("");
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setEditingId("");
    setName("");
    setBrand("");
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    const ok = await onSave({ id: editingId || undefined, kind, name: trimmed, brand: brand.trim() || null });
    setSaving(false);
    if (ok) reset();
  };

  const startEdit = (entry: EspressoEquipment) => {
    setEditingId(entry.id);
    setName(entry.name);
    setBrand(entry.brand ?? "");
  };

  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{title}</h3>
      {items.length === 0 ? (
        <p className="text-xs text-muted">{t("Nothing saved yet.")}</p>
      ) : (
        <div className="divide-y divide-line rounded-xl border border-line">
          {items.map((entry) => (
            <div key={entry.id} className="flex items-center gap-1 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">
                  {entry.name}
                  {entry.brand ? <span className="font-normal text-muted"> · {entry.brand}</span> : null}
                </div>
                <div className="text-[10px] text-muted">{t("{count} shots", { count: entry.shotCount ?? 0 })}</div>
              </div>
              <IconButton icon="pencil" label={t("Rename")} size={15} onClick={() => startEdit(entry)} />
              <IconButton
                icon="trash"
                label={t("Delete")}
                size={15}
                className="text-danger hover:bg-danger-soft"
                onClick={() => onDelete(entry)}
              />
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2 rounded-xl border border-line bg-raised/40 p-3">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t(kind === "machine" ? "e.g. Lelit Mara X" : "e.g. Eureka Mignon")}
          maxLength={80}
        />
        <Input
          value={brand}
          onChange={(event) => setBrand(event.target.value)}
          placeholder={t("Brand (optional)")}
          maxLength={80}
        />
        <div className="flex gap-2">
          <Button type="button" size="sm" onClick={() => void submit()} loading={saving} disabled={!name.trim()}>
            {editingId ? t("Save") : t("Add")}
          </Button>
          {editingId && (
            <Button type="button" size="sm" variant="secondary" onClick={reset}>
              {t("Cancel")}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

/** Manage the saved machines and grinders offered by the shot form. */
export function EspressoEquipmentSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { house, can } = useHouse();
  const toast = useToast();
  const [equipment, setEquipment] = useState<EspressoEquipment[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEquipment(await api<EspressoEquipment[]>(`/api/houses/${house.id}/espresso-equipment`));
    } catch (error) {
      toast.error(error instanceof Error ? t(error.message) : t("Could not load the equipment"));
    } finally {
      setLoading(false);
    }
  }, [house.id, t, toast]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const save = async (payload: {
    id?: string;
    kind: EspressoEquipmentKind;
    name: string;
    brand: string | null;
  }): Promise<boolean> => {
    try {
      if (payload.id) {
        await api(`/api/houses/${house.id}/espresso-equipment/${payload.id}`, {
          method: "PATCH",
          body: { name: payload.name, brand: payload.brand },
        });
      } else {
        await api(`/api/houses/${house.id}/espresso-equipment`, {
          method: "POST",
          body: { kind: payload.kind, name: payload.name, brand: payload.brand },
        });
      }
      toast.success(payload.id ? t("Equipment updated") : t("Equipment added"));
      await load();
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) await load();
      toast.error(error instanceof Error ? t(error.message) : t("Could not save the equipment"));
      return false;
    }
  };

  const remove = async (entry: EspressoEquipment) => {
    if (!window.confirm(t("Delete “{name}”? Shots that used it keep the name.", { name: entry.name }))) return;
    try {
      await api(`/api/houses/${house.id}/espresso-equipment/${entry.id}`, { method: "DELETE" });
      toast.success(t("Equipment deleted"));
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? t(error.message) : t("Could not delete the equipment"));
    }
  };

  const machines = equipment.filter((entry) => entry.kind === "machine");
  const grinders = equipment.filter((entry) => entry.kind === "grinder");

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("Machines & grinders")}
      description={t("Save your setup once, then pick it when logging a shot.")}
    >
      <div className="space-y-5 pb-2">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Spinner size={14} /> {t("Loading…")}
          </div>
        ) : !can("member") ? (
          <p className="text-xs text-muted">{t("Ask a household member to add machines and grinders.")}</p>
        ) : (
          <>
            <EquipmentSection kind="machine" title={t("Espresso machines")} items={machines} onSave={save} onDelete={remove} />
            <EquipmentSection kind="grinder" title={t("Grinders")} items={grinders} onSave={save} onDelete={remove} />
          </>
        )}
      </div>
    </Sheet>
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
  const [sheetSession, setSheetSession] = useState(0);

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

  const canEdit = (shot: EspressoShot) =>
    !!user && can("member") && (shot.userId === user.id || can("admin"));

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
        {can("member") && item.espresso && (
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            onClick={() => {
              setEditing(null);
              setSheetSession((current) => current + 1);
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
                  setSheetSession((current) => current + 1);
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
        key={sheetSession}
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
