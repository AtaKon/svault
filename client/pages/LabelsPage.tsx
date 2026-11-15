import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, qs } from "@/api";
import { useHouse } from "@/state";
import { useI18n } from "@/i18n";
import { Button, Card, EmptyState, Input, PageHeader, Select, Skeleton, Switch, useDebounced } from "@/components/ui";
import { useToast } from "@/components/toast";
import { useQrMatrices } from "@/components/QrCode";
import {
  A4_SHEET,
  LABEL_PRESETS,
  LABEL_STYLES,
  LabelSheet,
  labelsPerSheet,
  type LabelEntry,
  type LabelFields,
  type LabelPresetId,
} from "@/components/LabelSheet";
import { labelUrl, type LabelKind } from "@shared/label-links";
import type { Item, ItemDetail, Location } from "@shared/types";

/** CSS defines 1mm as 96/25.4 px; the preview uses the same value to scale an A4 sheet. */
const PX_PER_MM = 96 / 25.4;

interface SelectedLabel {
  kind: LabelKind;
  id: string;
}

export function LabelsPage() {
  const { house } = useHouse();
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [items, setItems] = useState<Item[] | null>(null);
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [publicBase, setPublicBase] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedLabel[]>([]);
  const [itemPlaces, setItemPlaces] = useState<Record<string, string | null>>({});
  const [search, setSearch] = useState("");
  const query = useDebounced(search, 200).trim().toLocaleLowerCase();
  const [presetId, setPresetId] = useState<LabelPresetId>("a4");
  const [fields, setFields] = useState<LabelFields>({ name: true, place: true, unit: true, house: false });
  const [scale, setScale] = useState(0.4);
  const previewRef = useRef<HTMLDivElement | null>(null);

  const preset = LABEL_PRESETS.find((entry) => entry.id === presetId) ?? LABEL_PRESETS[LABEL_PRESETS.length - 1];

  useEffect(() => {
    let live = true;
    Promise.all([
      api<{ items: Item[]; total: number }>(`/api/houses/${house.id}/items${qs({ sort: "name", limit: 500 })}`),
      api<Location[]>(`/api/houses/${house.id}/locations`),
      api<{ baseUrl: string | null }>("/api/labels"),
    ])
      .then(([list, places, config]) => {
        if (!live) return;
        setItems(list.items);
        setLocations(places);
        setPublicBase(config.baseUrl ?? "");
      })
      .catch((err) => {
        if (!live) return;
        setItems([]);
        setLocations([]);
        setLoadError(err instanceof Error ? t(err.message) : t("Could not load labels"));
      });
    return () => {
      live = false;
    };
  }, [house.id, t]);

  // Deep links from the item page and from a place's "Print label" button.
  useEffect(() => {
    if (!items || !locations) return;
    if (!params.has("item") && !params.has("place")) return;
    const wantedItems = params.getAll("item").filter((id) => items.some((item) => item.id === id));
    const wantedPlaces = params.getAll("place").filter((id) => locations.some((place) => place.id === id));
    if (wantedItems.length || wantedPlaces.length) {
      setSelected([
        ...wantedItems.map((id) => ({ kind: "item" as const, id })),
        ...wantedPlaces.map((id) => ({ kind: "place" as const, id })),
      ]);
    }
    const next = new URLSearchParams(params);
    next.delete("item");
    next.delete("place");
    setParams(next, { replace: true });
  }, [items, locations, params, setParams]);

  // "Show place" needs the batch location, which only the item detail carries.
  const selectedItemIds = useMemo(
    () => selected.filter((entry) => entry.kind === "item").map((entry) => entry.id),
    [selected],
  );
  const selectedItemKey = selectedItemIds.join("\n");
  useEffect(() => {
    if (!fields.place) return;
    const missing = selectedItemKey ? selectedItemKey.split("\n").filter((id) => !(id in itemPlaces)) : [];
    if (missing.length === 0) return;
    let live = true;
    void Promise.all(
      missing.map(async (id) => {
        try {
          const detail = await api<ItemDetail>(`/api/items/${id}`);
          const lot = detail.lots.find((entry) => entry.quantity > 0 && entry.locationName) ?? detail.lots.find((entry) => entry.locationName);
          return [id, lot?.locationName ?? null] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    ).then((pairs) => {
      if (!live) return;
      setItemPlaces((current) => {
        const next = { ...current };
        for (const [id, name] of pairs) next[id] = name;
        return next;
      });
    });
    return () => {
      live = false;
    };
  }, [fields.place, selectedItemKey, itemPlaces]);

  const filteredItems = useMemo(() => {
    if (!items) return [];
    if (!query) return items;
    return items.filter((item) => `${item.name} ${item.brand ?? ""}`.toLocaleLowerCase().includes(query));
  }, [items, query]);
  const filteredPlaces = useMemo(() => {
    if (!locations) return [];
    if (!query) return locations;
    return locations.filter((place) => place.name.toLocaleLowerCase().includes(query));
  }, [locations, query]);

  const isSelected = (kind: LabelKind, id: string) => selected.some((entry) => entry.kind === kind && entry.id === id);
  const toggle = (kind: LabelKind, id: string) => {
    setSelected((current) =>
      current.some((entry) => entry.kind === kind && entry.id === id)
        ? current.filter((entry) => !(entry.kind === kind && entry.id === id))
        : [...current, { kind, id }],
    );
  };

  const entries = useMemo<LabelEntry[]>(
    () =>
      selected.flatMap((choice): LabelEntry[] => {
        if (choice.kind === "item") {
          const item = items?.find((entry) => entry.id === choice.id);
          if (!item) return [];
          return [
            {
              key: `item:${item.id}`,
              kind: "item" as const,
              name: item.name,
              place: itemPlaces[item.id] ?? null,
              unit: item.unit,
              url: labelUrl({ kind: "item", id: item.id, houseId: house.id, publicBase }),
            },
          ];
        }
        const place = locations?.find((entry) => entry.id === choice.id);
        if (!place) return [];
        return [
          {
            key: `place:${place.id}`,
            kind: "place" as const,
            name: place.name,
            place: null,
            unit: null,
            url: labelUrl({ kind: "place", id: place.id, houseId: house.id, publicBase }),
          },
        ];
      }),
    [selected, items, locations, itemPlaces, house.id, publicBase],
  );

  const qr = useQrMatrices(entries.map((entry) => entry.url));
  const canPrint = entries.length > 0 && !qr.loading && !qr.failed;

  useEffect(() => {
    const element = previewRef.current;
    if (!element) return;
    const apply = () => {
      const width = element.clientWidth;
      if (width > 0) setScale(Math.min(1, width / (A4_SHEET.widthMm * PX_PER_MM)));
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    return () => observer.disconnect();
  }, [entries.length]);

  const print = () => {
    if (!canPrint) return;
    try {
      window.print();
    } catch {
      toast.error(t("Could not open the print dialog"));
    }
  };

  if (!items || !locations) {
    if (loadError) {
      return (
        <EmptyState
          icon="alert"
          title={t("Could not load labels")}
          body={loadError}
          action={<Button onClick={() => navigate("/more")}>{t("Back")}</Button>}
        />
      );
    }
    return <Skeleton className="h-64" />;
  }

  return (
    <div className="space-y-4">
      {entries.length > 0 && <style>{LABEL_STYLES}</style>}
      <PageHeader
        back={() => navigate(-1)}
        eyebrow={t("Print & scan")}
        title={t("Labels")}
        subtitle={t("QR labels for shelves, boxes and places. Scanning one opens the item or place in SVault.")}
        actions={
          <Button icon="printer" onClick={print} disabled={!canPrint}>
            {t("Print")}
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1.05fr_1fr]">
        <div className="space-y-4">
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="font-display text-lg">{t("Choose what to label")}</h2>
              {selected.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                  {t("Clear")}
                </Button>
              )}
            </div>
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("Search items and places")}
              aria-label={t("Search items and places")}
            />

            <section className="mt-4" aria-labelledby="sv-label-items">
              <h3 id="sv-label-items" className="mb-1.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                <span>{t("Items")}</span>
                <span>{filteredItems.length}</span>
              </h3>
              <div className="max-h-56 divide-y divide-line overflow-y-auto rounded-xl border border-line">
                {filteredItems.map((item) => (
                  <label key={item.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-raised">
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0 accent-[var(--sv-brand)]"
                      checked={isSelected("item", item.id)}
                      onChange={() => toggle("item", item.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{item.name}</span>
                      <span className="block truncate text-[11px] text-muted">
                        {[item.brand, itemPlaces[item.id]].filter(Boolean).join(" · ") || item.unit}
                      </span>
                    </span>
                  </label>
                ))}
                {filteredItems.length === 0 && (
                  <p className="px-3 py-3 text-xs text-muted">
                    {items.length === 0 ? t("No items yet.") : t("No items match this search.")}
                  </p>
                )}
              </div>
            </section>

            <section className="mt-4" aria-labelledby="sv-label-places">
              <h3 id="sv-label-places" className="mb-1.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                <span>{t("Places")}</span>
                <span>{filteredPlaces.length}</span>
              </h3>
              <div className="max-h-56 divide-y divide-line overflow-y-auto rounded-xl border border-line">
                {filteredPlaces.map((place) => (
                  <label key={place.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-raised">
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0 accent-[var(--sv-brand)]"
                      checked={isSelected("place", place.id)}
                      onChange={() => toggle("place", place.id)}
                    />
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-raised text-sm" aria-hidden="true">
                      {place.icon ?? "📦"}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{place.name}</span>
                      <span className="block truncate text-[11px] text-muted">
                        {t(place.kind)} · {place.itemCount ?? 0} {t("items")}
                      </span>
                    </span>
                  </label>
                ))}
                {filteredPlaces.length === 0 && (
                  <p className="px-3 py-3 text-xs text-muted">
                    {locations.length === 0 ? t("No places yet.") : t("No places match this search.")}
                  </p>
                )}
              </div>
            </section>
          </Card>

          <Card className="space-y-3 p-4">
            <h2 className="font-display text-lg">{t("Label options")}</h2>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">{t("Label size")}</span>
              <Select value={preset.id} onChange={(event) => setPresetId(event.target.value as LabelPresetId)}>
                {LABEL_PRESETS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {t(option.label)}
                  </option>
                ))}
              </Select>
            </label>
            <div className="space-y-2">
              <Switch checked={fields.name} onChange={(next) => setFields((current) => ({ ...current, name: next }))} label={t("Show name")} />
              <Switch checked={fields.place} onChange={(next) => setFields((current) => ({ ...current, place: next }))} label={t("Show place")} />
              <Switch checked={fields.unit} onChange={(next) => setFields((current) => ({ ...current, unit: next }))} label={t("Show unit")} />
              <Switch checked={fields.house} onChange={(next) => setFields((current) => ({ ...current, house: next }))} label={t("Show house name")} />
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-display text-lg">{t("Preview")}</h2>
              <span className="text-[11px] text-muted">
                {entries.length} {t("labels")} · {labelsPerSheet(preset)} {t("per A4 page")}
              </span>
            </div>
            {entries.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line px-3 py-10 text-center text-xs leading-relaxed text-muted">
                {t("Pick an item or a place to see its label.")}
              </p>
            ) : (
              <div ref={previewRef} className="overflow-hidden rounded-xl border border-line bg-white">
                <div
                  className="overflow-hidden"
                  style={{ width: A4_SHEET.widthMm * PX_PER_MM * scale, height: A4_SHEET.heightMm * PX_PER_MM * scale }}
                  role="img"
                  aria-label={t("Label preview")}
                >
                  <div style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}>
                    <LabelSheet
                      entries={entries}
                      preset={preset}
                      matrices={qr.matrices}
                      fields={fields}
                      houseName={house.name}
                    />
                  </div>
                </div>
              </div>
            )}
            {qr.loading && <p className="mt-2 text-[11px] text-muted" role="status">{t("Preparing QR codes…")}</p>}
            {qr.failed && <p className="mt-2 text-[11px] text-danger">{t("Could not build the QR code.")}</p>}
            <p className="mt-3 text-[11px] leading-relaxed text-muted">
              {t("The QR code only contains a link to this app — no stock, prices or names.")}
            </p>
          </Card>
        </div>
      </div>

      {entries.length > 0 &&
        createPortal(
          <div className="sv-print-root" aria-hidden="true">
            <LabelSheet entries={entries} preset={preset} matrices={qr.matrices} fields={fields} houseName={house.name} />
          </div>,
          document.body,
        )}
    </div>
  );
}
