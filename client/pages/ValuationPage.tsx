import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/api";
import { useHouse } from "@/state";
import { useI18n } from "@/i18n";
import { Badge, Button, Card, Field, Input, PageHeader, Select, Skeleton, Stat, Switch, cn, useDebounced } from "@/components/ui";
import { Icon } from "@/components/icons";
import { money, qty, shortDate } from "@/format";
import type {
  Category,
  Location,
  ValuationBasis,
  ValuationItem,
  ValuationReport,
} from "@shared/types";

/** Print tables with thousands of rows freeze the browser; the CSV is complete. */
const MAX_PRINT_ROWS = 2_000;

const DOWNLOAD_CLASS =
  "inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-medium text-ink transition-colors hover:bg-raised active:bg-brand-soft/50";

export function ValuationPage() {
  const { t } = useI18n();
  const { house } = useHouse();
  const navigate = useNavigate();
  const [basis, setBasis] = useState<ValuationBasis>("latest");
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [tags, setTags] = useState("");
  const [minValue, setMinValue] = useState("");
  const [warrantyOnly, setWarrantyOnly] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [includeDocuments, setIncludeDocuments] = useState(false);
  const [includePhotos, setIncludePhotos] = useState(false);
  const [attributeKeys, setAttributeKeys] = useState<string[]>([]);

  const [categories, setCategories] = useState<Category[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [report, setReport] = useState<ValuationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<Category[]>(`/api/houses/${house.id}/categories`),
      api<Location[]>(`/api/houses/${house.id}/locations`),
    ])
      .then(([nextCategories, nextLocations]) => {
        if (cancelled) return;
        setCategories(nextCategories);
        setLocations(nextLocations);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load filters");
      });
    return () => {
      cancelled = true;
    };
  }, [house.id]);

  const search = useMemo(() => {
    const params = new URLSearchParams();
    params.set("basis", basis);
    if (categoryIds.length) params.set("categories", categoryIds.join(","));
    if (locationIds.length) params.set("places", locationIds.join(","));
    if (tags.trim()) params.set("tags", tags.trim());
    if (minValue.trim()) params.set("minValue", minValue.trim().replace(",", "."));
    if (warrantyOnly) params.set("warranty", "1");
    if (includeArchived) params.set("archived", "1");
    if (includeDocuments) params.set("documents", "1");
    return params.toString();
  }, [basis, categoryIds, locationIds, tags, minValue, warrantyOnly, includeArchived, includeDocuments]);

  const debouncedSearch = useDebounced(search, 300);
  const csvHref = `/api/houses/${house.id}/reports/valuation?${search}&format=csv`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<ValuationReport>(`/api/houses/${house.id}/reports/valuation?${debouncedSearch}`)
      .then((next) => {
        if (cancelled) return;
        setReport(next);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the valuation report");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [house.id, debouncedSearch]);

  const attributeOptions = useMemo(() => {
    const keys = new Set<string>();
    for (const item of report?.items ?? []) {
      for (const key of Object.keys(item.attributes)) keys.add(key);
    }
    return [...keys].sort((a, b) => a.localeCompare(b));
  }, [report]);

  const { groups, shownItems } = useMemo(() => {
    const items = (report?.items ?? []).slice(0, MAX_PRINT_ROWS).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const map = new Map<string, { key: string; name: string; items: ValuationItem[] }>();
    for (const item of items) {
      const key = item.categoryId ?? "";
      const group = map.get(key) ?? { key, name: item.categoryName ?? "", items: [] };
      group.items.push(item);
      map.set(key, group);
    }
    const sorted = [...map.values()].sort((a, b) => {
      if (a.key === b.key) return 0;
      if (!a.key) return 1;
      if (!b.key) return -1;
      return a.name.localeCompare(b.name);
    });
    return { groups: sorted, shownItems: items.length };
  }, [report]);

  const toggle = (values: string[], setValues: (next: string[]) => void, value: string) => {
    setValues(values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value]);
  };

  const categoryLabel = (category: Category) => category.name;
  const locationLabel = (location: Location) => location.name;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={t("House")}
        title={t("Valuation report")}
        subtitle={t("A dated record of what you own, for insurance claims or moving house.")}
        back={() => navigate("/more")}
        actions={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <a href={csvHref} download className={DOWNLOAD_CLASS}>
              <Icon name="download" size={16} />
              {t("Download CSV")}
            </a>
            <Button icon="printer" onClick={() => window.print()} disabled={!report}>
              {t("Print")}
            </Button>
          </div>
        }
      />

      <Card className="space-y-4 p-4 print:hidden">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg">{t("Filters")}</h2>
          <Badge tone="outline">{t("Read only")}</Badge>
        </div>

        <Field label={t("Value basis")} hint={t("How each unit value is derived")}>
          <Select value={basis} onChange={(event) => setBasis(event.target.value as ValuationBasis)}>
            <option value="latest">{t("Latest purchase price")}</option>
            <option value="average">{t("Average purchase price")}</option>
            <option value="stockCost">{t("Stock cost")}</option>
          </Select>
        </Field>

        {categories.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
              {t("Categories")}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {categories.map((category) => (
                <FilterChip
                  key={category.id}
                  label={categoryLabel(category)}
                  active={categoryIds.includes(category.id)}
                  onClick={() => toggle(categoryIds, setCategoryIds, category.id)}
                />
              ))}
            </div>
          </div>
        )}

        {locations.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
              {t("Places")}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {locations.map((location) => (
                <FilterChip
                  key={location.id}
                  label={locationLabel(location)}
                  active={locationIds.includes(location.id)}
                  onClick={() => toggle(locationIds, setLocationIds, location.id)}
                />
              ))}
            </div>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Tags")} hint={t("Comma separated")}>
            <Input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder={t("electronics, tools")}
              maxLength={200}
            />
          </Field>
          <Field label={t("Minimum value")} hint={house.currency}>
            <Input
              value={minValue}
              onChange={(event) => setMinValue(event.target.value.replace(/[^0-9.,]/g, ""))}
              inputMode="decimal"
              placeholder="0"
            />
          </Field>
        </div>

        <div className="space-y-3">
          <Switch
            checked={warrantyOnly}
            onChange={setWarrantyOnly}
            label={t("Only items with warranty")}
            description={t("Warranty end date is today or later")}
          />
          <Switch
            checked={includeArchived}
            onChange={setIncludeArchived}
            label={t("Include archived items")}
          />
          <Switch
            checked={includeDocuments}
            onChange={setIncludeDocuments}
            label={t("Include documents list")}
            description={t("File names and types only — never the file contents")}
          />
          <Switch
            checked={includePhotos}
            onChange={setIncludePhotos}
            label={t("Include photos in the print view")}
          />
        </div>

        {attributeOptions.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
              {t("Attributes to show in print")}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {attributeOptions.map((key) => (
                <FilterChip
                  key={key}
                  label={key}
                  active={attributeKeys.includes(key)}
                  onClick={() => toggle(attributeKeys, setAttributeKeys, key)}
                />
              ))}
            </div>
          </div>
        )}

        <p className="text-[11px] text-muted">
          {t("Filters are combined. Values never leave this server.")}
        </p>
      </Card>

      {error && (
        <Card className="border-danger/40 bg-danger-soft/40 p-4 text-sm text-danger" role="alert">
          {t(error)}
        </Card>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 print:hidden">
        <Stat label={t("Grand total")} value={money(report?.grandTotal ?? 0, report?.currency ?? house.currency)} />
        <Stat label={t("Items")} value={qty(report?.itemCount ?? 0)} />
        <Stat
          label={t("Items without value")}
          value={qty(report?.itemsWithoutValue ?? 0)}
          tone={report?.itemsWithoutValue ? "warn" : undefined}
        />
        <Stat label={t("Report date")} value={shortDate(report?.reportDate ?? null)} />
      </div>

      {loading && !report ? (
        <Skeleton className="h-64 w-full" />
      ) : report && report.items.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted print:hidden">
          {t("No items match these filters.")}
        </Card>
      ) : null}

      {report?.truncated && (
        <Card className="border-warn/40 bg-warn-soft/40 p-3 text-[12px] text-warn print:hidden" role="status">
          {t("This house has more items than the report cap; narrow the filters for the complete list.")}
        </Card>
      )}

      {report && report.items.length > 0 && (
        <div className="valuation-report rounded-2xl border border-line bg-surface p-4 shadow-soft sm:p-6">
          <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-3">
            <div>
              <h2 className="font-display text-xl leading-tight">{report.houseName}</h2>
              <p className="text-xs text-muted">
                {t("Valuation report")} · {shortDate(report.reportDate)} · {report.currency}
              </p>
            </div>
            <div className="text-right text-xs text-muted">
              <div>
                {t("Value basis")}: {t(basisLabel(report.basis))}
              </div>
              <div>
                {t("Items")}: {qty(report.itemCount)} · {t("Items without value")}:{" "}
                {qty(report.itemsWithoutValue)}
              </div>
            </div>
          </header>

          <p className="mb-4 text-[12px] text-muted">
            {t("Values are estimates from your own records, not an appraisal.")}
          </p>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-[12px]">
              <thead>
                <tr className="border-b border-line text-[10px] uppercase tracking-[0.08em] text-muted">
                  <th className="py-1.5 pr-2 font-semibold">{t("Item")}</th>
                  {includePhotos && <th className="py-1.5 pr-2 font-semibold">{t("Photo")}</th>}
                  <th className="py-1.5 pr-2 font-semibold">{t("Places")}</th>
                  <th className="py-1.5 pr-2 text-right font-semibold">{t("Quantity")}</th>
                  <th className="py-1.5 pr-2 text-right font-semibold">{t("Unit value")}</th>
                  <th className="py-1.5 pr-2 text-right font-semibold">{t("Total value")}</th>
                  <th className="py-1.5 pr-2 font-semibold">{t("Purchased")}</th>
                  <th className="py-1.5 pr-2 font-semibold">{t("Shop")}</th>
                  <th className="py-1.5 pr-2 font-semibold">{t("Warranty until")}</th>
                  <th className="py-1.5 pr-2 font-semibold">{t("Documents")}</th>
                  {attributeKeys.map((key) => (
                    <th key={key} className="py-1.5 pr-2 font-semibold">
                      {key}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => {
                  const subtotal = report.categoryTotals.find(
                    (entry) => (entry.categoryId ?? "") === group.key,
                  );
                  return (
                    <FragmentGroup
                      key={group.key || "uncategorised"}
                      name={group.name || t("Uncategorised")}
                      items={group.items}
                      currency={report.currency}
                      includePhotos={includePhotos}
                      includeDocuments={report.includeDocuments}
                      attributeKeys={attributeKeys}
                      subtotal={subtotal ? { count: subtotal.itemCount, total: subtotal.total } : null}
                      columnCount={9 + (includePhotos ? 1 : 0) + attributeKeys.length}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>

          {report.items.length > shownItems && (
            <p className="mt-3 text-[11px] text-muted">
              {t("Showing the first {count} items. Download the CSV for the full list.", { count: shownItems })}
            </p>
          )}

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <section>
              <h3 className="mb-2 font-display text-sm">{t("Totals by category")}</h3>
              <table className="w-full border-collapse text-left text-[12px]">
                <tbody>
                  {report.categoryTotals.map((entry) => (
                    <tr key={entry.categoryId ?? "none"} className="border-b border-line/60">
                      <td className="py-1 pr-2">{entry.categoryName ?? t("Uncategorised")}</td>
                      <td className="py-1 pr-2 text-right text-muted">{qty(entry.itemCount)}</td>
                      <td className="py-1 text-right font-medium">{money(entry.total, report.currency)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="py-1.5 pr-2 font-semibold">{t("Grand total")}</td>
                    <td className="py-1.5 pr-2" />
                    <td className="py-1.5 text-right font-semibold">
                      {money(report.grandTotal, report.currency)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </section>
            <section>
              <h3 className="mb-2 font-display text-sm">{t("Totals by place")}</h3>
              <table className="w-full border-collapse text-left text-[12px]">
                <tbody>
                  {report.placeTotals.map((entry) => (
                    <tr key={entry.locationId ?? "none"} className="border-b border-line/60">
                      <td className="py-1 pr-2">{entry.locationName ?? t("No place")}</td>
                      <td className="py-1 pr-2 text-right text-muted">{qty(entry.itemCount)}</td>
                      <td className="py-1 text-right font-medium">{money(entry.total, report.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          <footer className="mt-6 border-t border-line pt-3 text-[11px] text-muted">
            {t("Generated by SVault on {date}.", { date: shortDate(report.reportDate) })} ·{" "}
            {t("Values are estimates from your own records, not an appraisal.")}
          </footer>
        </div>
      )}

      <style>{`
        @media print {
          @page { margin: 12mm; }
          .valuation-report {
            border: 0 !important;
            box-shadow: none !important;
            background: #fff !important;
            color: #111 !important;
            padding: 0 !important;
            font-size: 10pt;
          }
          .valuation-report .text-muted { color: #444 !important; }
          .valuation-report table { width: 100% !important; border-collapse: collapse; }
          .valuation-report th,
          .valuation-report td { border-bottom: 1px solid #bbb !important; padding: 3px 4px !important; }
          .valuation-report thead { display: table-header-group; }
          .valuation-report tr { break-inside: avoid; }
          .valuation-category-row { break-after: avoid; }
          .valuation-subtotal { break-after: avoid; }
          .valuation-subtotal td { font-weight: 600; background: #f2f2f2 !important; }
          .valuation-report img { max-width: 44px; max-height: 44px; }
        }
      `}</style>
    </div>
  );
}

function basisLabel(basis: ValuationBasis): string {
  if (basis === "average") return "Average purchase price";
  if (basis === "stockCost") return "Stock cost";
  return "Latest purchase price";
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-[12px] transition-colors",
        active
          ? "border-brand bg-brand-soft text-brand"
          : "border-line bg-surface text-muted hover:bg-raised hover:text-ink",
      )}
    >
      {label}
    </button>
  );
}

function FragmentGroup({
  name,
  items,
  currency,
  includePhotos,
  includeDocuments,
  attributeKeys,
  subtotal,
  columnCount,
}: {
  name: string;
  items: ValuationItem[];
  currency: string;
  includePhotos: boolean;
  includeDocuments: boolean;
  attributeKeys: string[];
  subtotal: { count: number; total: number } | null;
  columnCount: number;
}) {
  const { t } = useI18n();
  return (
    <>
      <tr className="valuation-category-row">
        <td colSpan={columnCount} className="pt-4 pb-1 font-display text-[13px] font-semibold">
          {name}
        </td>
      </tr>
      {items.map((item) => (
        <tr key={item.id} className="border-b border-line/50 align-top">
          <td className="py-1.5 pr-2">
            <span className="font-medium">{item.name}</span>
            {item.brand && <span className="block text-[11px] text-muted">{item.brand}</span>}
            {item.warrantyNote && <span className="block text-[11px] text-muted">{item.warrantyNote}</span>}
          </td>
          {includePhotos && (
            <td className="py-1.5 pr-2">
              {item.image ? (
                <img
                  src={item.image}
                  alt={item.name}
                  loading="lazy"
                  className="h-10 w-10 rounded object-cover"
                />
              ) : (
                <span className="text-muted">—</span>
              )}
            </td>
          )}
          <td className="py-1.5 pr-2 text-muted">
            {item.places.length
              ? item.places
                  .map((place) => `${place.locationName ?? t("No place")} (${qty(place.quantity)})`)
                  .join(", ")
              : "—"}
          </td>
          <td className="py-1.5 pr-2 text-right">
            {qty(item.quantity)} {item.unit}
          </td>
          <td className="py-1.5 pr-2 text-right">
            {item.unitValue == null ? t("No value recorded") : money(item.unitValue, currency)}
          </td>
          <td className="py-1.5 pr-2 text-right font-medium">
            {item.totalValue == null ? t("No value recorded") : money(item.totalValue, currency)}
          </td>
          <td className="py-1.5 pr-2">{item.purchasedAt ? shortDate(item.purchasedAt) : "—"}</td>
          <td className="py-1.5 pr-2">{item.shop ?? "—"}</td>
          <td className="py-1.5 pr-2">{item.warrantyUntil ? shortDate(item.warrantyUntil) : "—"}</td>
          <td className="py-1.5 pr-2 text-muted">
            {item.documentCount}
            {includeDocuments && item.documents?.length ? (
              <span className="block text-[10px]">
                {item.documents.map((document) => `${document.name} (${document.kind})`).join(", ")}
              </span>
            ) : null}
          </td>
          {attributeKeys.map((key) => (
            <td key={key} className="py-1.5 pr-2 text-muted">
              {item.attributes[key] == null || item.attributes[key] === ""
                ? "—"
                : typeof item.attributes[key] === "object"
                  ? JSON.stringify(item.attributes[key])
                  : String(item.attributes[key])}
            </td>
          ))}
        </tr>
      ))}
      {subtotal && (
        <tr className="valuation-subtotal bg-raised/60">
          <td colSpan={3 + (includePhotos ? 1 : 0)} className="py-1.5 pr-2 text-right font-semibold">
            {t("{name} subtotal", { name })} · {t("{count} items", { count: subtotal.count })}
          </td>
          <td className="py-1.5 pr-2" />
          <td className="py-1.5 pr-2 text-right font-semibold">{money(subtotal.total, currency)}</td>
          <td colSpan={4 + attributeKeys.length} />
        </tr>
      )}
    </>
  );
}
