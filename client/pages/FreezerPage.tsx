import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "@/api";
import { useHouse } from "@/state";
import { useI18n } from "@/i18n";
import { Badge, Button, Card, EmptyState, PageHeader, Select, Skeleton, Stat, Tabs } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { daysUntil, qty, relativeTime, shortDate } from "@/format";
import type { FreezerBatch, FreezerView, Location } from "@shared/types";

type Status = "all" | "frozen" | "thawed";

/** Urgency tone and label for a batch's eat-by date. */
function urgency(days: number | null): { tone: "neutral" | "brand" | "warn" | "danger"; label: string } {
  if (days == null) return { tone: "neutral", label: "no date" };
  if (days < 0) return { tone: "danger", label: "overdue" };
  if (days === 0) return { tone: "danger", label: "eat today" };
  if (days <= 3) return { tone: "warn", label: "soon" };
  if (days <= 7) return { tone: "brand", label: "this week" };
  return { tone: "neutral", label: "later" };
}

export function FreezerPage() {
  const { house, can } = useHouse();
  const { t } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState<FreezerView | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("all");
  const [place, setPlace] = useState("");
  const [useSoonOnly, setUseSoonOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [view, places] = await Promise.all([
        api<FreezerView>(`/api/houses/${house.id}/freezer`),
        api<Location[]>(`/api/houses/${house.id}/locations`),
      ]);
      setData(view);
      setLocations(places);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? t(err.message) : t("Could not load the freezer"));
    }
  }, [house.id, t]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const act = async (batch: FreezerBatch, path: "take-out" | "thaw") => {
    setBusy(`${path}:${batch.id}`);
    try {
      await api(`/api/houses/${house.id}/freezer/${path}`, {
        method: "POST",
        body: path === "take-out" ? { itemId: batch.itemId, lotId: batch.id, portions: 1 } : { itemId: batch.itemId, lotId: batch.id },
      });
      toast.success(path === "take-out" ? t("Took out one portion of {name}", { name: batch.itemName }) : t("{name} is thawing", { name: batch.itemName }));
      await load();
      window.dispatchEvent(new Event("sv:refresh-badges"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not update the freezer"));
    } finally {
      setBusy(null);
    }
  };

  const batches = useMemo(() => {
    if (!data) return [];
    return data.batches.filter((batch) => {
      if (status === "frozen" && batch.thawedOn) return false;
      if (status === "thawed" && !batch.thawedOn) return false;
      if (place === "__none" && batch.locationId) return false;
      if (place && place !== "__none" && batch.locationId !== place) return false;
      if (useSoonOnly) {
        const days = daysUntil(batch.effectiveExpiresAt);
        if (days == null || days > (data?.useSoonDays ?? 7)) return false;
      }
      return true;
    });
  }, [data, status, place, useSoonOnly]);

  const groups = useMemo(() => {
    const map = new Map<string, { locationId: string; name: string; isFreezer: boolean; batches: FreezerBatch[] }>();
    for (const batch of batches) {
      const key = batch.locationId ?? "";
      const group = map.get(key) ?? {
        locationId: key,
        name: batch.locationName ?? t("No place"),
        isFreezer: batch.inFreezerPlace,
        batches: [],
      };
      group.batches.push(batch);
      map.set(key, group);
    }
    return [...map.values()].sort((a, b) => {
      if (a.isFreezer !== b.isFreezer) return a.isFreezer ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [batches, t]);

  const useFirst = (data?.batches ?? []).filter((batch) => {
    const days = daysUntil(batch.effectiveExpiresAt);
    return days != null && days <= (data?.useSoonDays ?? 7);
  }).slice(0, 6);

  const portions = (batch: FreezerBatch) => batch.portions ?? batch.quantity;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={t("Kitchen")}
        title={t("Freezer")}
        subtitle={t("What is waiting in the cold, and what to eat first.")}
        back={() => navigate("/more")}
        actions={
          <Button variant="secondary" icon="box" onClick={() => navigate("/items?sort=name")}>
            {t("Browse inventory")}
          </Button>
        }
      />

      {!data ? (
        error ? (
          <Card className="p-4 text-sm text-danger">{error}</Card>
        ) : (
          <div className="space-y-2">
            <Skeleton className="h-24" />
            <Skeleton className="h-40" />
          </div>
        )
      ) : data.totals.batches === 0 ? (
        <EmptyState
          icon="clock"
          title={t("Nothing in the freezer")}
          body={t("Freeze leftovers from cook mode, or open a batch on an item page and choose Freeze.")}
          action={<Button variant="secondary" icon="book" onClick={() => navigate("/recipes")}>{t("Open recipes")}</Button>}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label={t("Batches")} value={qty(data.totals.batches)} hint={t("in the freezer")} icon="box" />
            <Stat label={t("Portions")} value={qty(data.totals.portions)} hint={t("ready to eat")} icon="grid" />
            <Stat
              label={t("Use soon")}
              value={qty(data.totals.useSoon)}
              hint={t("within {count} days", { count: data.useSoonDays })}
              icon="alert"
              tone={data.totals.useSoon > 0 ? "warn" : "brand"}
            />
          </div>

          {useFirst.length > 0 && (
            <Card className="overflow-hidden">
              <div className="border-b border-line bg-warn-soft/60 px-4 py-2.5">
                <h2 className="font-display text-base text-warn">{t("Use first")}</h2>
              </div>
              <div className="flex flex-wrap gap-2 p-3">
                {useFirst.map((batch) => {
                  const days = daysUntil(batch.effectiveExpiresAt);
                  return (
                    <Link
                      key={batch.id}
                      to={`/items/${batch.itemId}`}
                      className="flex min-w-0 items-center gap-2 rounded-xl border border-line bg-bg px-3 py-2 text-sm transition-colors hover:bg-raised"
                    >
                      <span aria-hidden="true">❄️</span>
                      <span className="min-w-0 truncate font-medium">{batch.itemName}</span>
                      <Badge tone={urgency(days).tone === "neutral" ? "outline" : urgency(days).tone}>
                        {days != null && days < 0
                          ? t("{count} days overdue", { count: Math.abs(days) })
                          : days === 0
                            ? t("today")
                            : t("in {count} days", { count: days ?? 0 })}
                      </Badge>
                    </Link>
                  );
                })}
              </div>
            </Card>
          )}

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Tabs
              value={status}
              onChange={(value) => setStatus(value as Status)}
              items={[
                { value: "all", label: t("All"), count: data.batches.length },
                { value: "frozen", label: t("Frozen"), count: data.batches.filter((batch) => !batch.thawedOn).length },
                { value: "thawed", label: t("Thawed"), count: data.batches.filter((batch) => batch.thawedOn).length },
              ]}
            />
            <div className="flex flex-1 flex-wrap items-center gap-2 sm:justify-end">
              <label className="min-w-[9rem] flex-1 sm:max-w-[13rem]">
                <span className="sr-only">{t("Place")}</span>
                <Select value={place} onChange={(event) => setPlace(event.target.value)}>
                  <option value="">{t("All places")}</option>
                  {locations
                    .filter((location) => data.batches.some((batch) => batch.locationId === location.id))
                    .sort((a, b) => Number(b.isFreezer) - Number(a.isFreezer) || a.name.localeCompare(b.name))
                    .map((location) => (
                      <option key={location.id} value={location.id}>{location.isFreezer ? `❄️ ${location.name}` : location.name}</option>
                    ))}
                  {data.batches.some((batch) => !batch.locationId) && <option value="__none">{t("No place")}</option>}
                </Select>
              </label>
              <label className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={useSoonOnly} onChange={(event) => setUseSoonOnly(event.target.checked)} />
                {t("Use soon only")}
              </label>
            </div>
          </div>

          {groups.length === 0 ? (
            <EmptyState icon="filter" title={t("No batches match these filters")} body={t("Clear a filter to see the rest of the freezer.")} />
          ) : (
            <div className="space-y-4">
              {groups.map((group) => (
                <section key={group.locationId || "none"}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h2 className="flex min-w-0 items-center gap-1.5 font-display text-lg">
                      <Icon name="mapPin" size={15} className="shrink-0 text-muted" />
                      <span className="truncate">{group.isFreezer ? `❄️ ${group.name}` : group.name}</span>
                    </h2>
                    <span className="shrink-0 text-[11px] text-muted">{t("{count} batches", { count: group.batches.length })}</span>
                  </div>
                  <div className="space-y-2">
                    {group.batches.map((batch) => {
                      const days = daysUntil(batch.effectiveExpiresAt);
                      const tone = urgency(days);
                      const thawing = Boolean(batch.thawedOn);
                      return (
                        <Card key={batch.id} className="p-3.5">
                          <div className="flex flex-wrap items-start gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <Link to={`/items/${batch.itemId}`} className="min-w-0 break-words font-medium hover:underline">
                                  {batch.itemName}
                                </Link>
                                {thawing ? <Badge tone="warn">{t("Thawed")}</Badge> : <Badge tone="neutral">{t("Frozen")}</Badge>}
                                <Badge tone={tone.tone}>
                                  {tone.label === "overdue"
                                    ? t("{count} days overdue", { count: Math.abs(days ?? 0) })
                                    : tone.label === "eat today"
                                      ? t("Eat today")
                                      : tone.label === "soon"
                                        ? t("Eat in {count} days", { count: days ?? 0 })
                                        : tone.label === "this week"
                                          ? t("Eat in {count} days", { count: days ?? 0 })
                                          : t("no date")}
                                </Badge>
                              </div>
                              <div className="mt-1 text-xs text-muted">
                                {t("{count} portions", { count: qty(portions(batch)) })}
                                {` · `}
                                {thawing
                                  ? t("thawed {ago}", { ago: relativeTime(batch.thawedOn) })
                                  : t("frozen {ago}", { ago: relativeTime(batch.frozenOn) })}
                                {batch.effectiveExpiresAt ? ` · ${t("eat by {date}", { date: shortDate(batch.effectiveExpiresAt) })}` : ""}
                              </div>
                              {batch.cookedOn && (
                                <div className="mt-0.5 text-[11px] text-muted">{t("cooked {date}", { date: shortDate(batch.cookedOn) })}</div>
                              )}
                              {batch.sourceRecipeId && (
                                <Link to={`/recipes/${batch.sourceRecipeId}`} className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-brand hover:underline">
                                  <Icon name="book" size={12} />
                                  {batch.sourceRecipeTitle ?? t("Open recipe")}
                                </Link>
                              )}
                            </div>
                            {can("member") && (
                              <div className="flex shrink-0 flex-wrap gap-1.5">
                                <Button
                                  size="sm"
                                  variant="soft"
                                  disabled={busy !== null}
                                  loading={busy === `take-out:${batch.id}`}
                                  onClick={() => void act(batch, "take-out")}
                                >
                                  {t("Take out 1")}
                                </Button>
                                {!thawing && (
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    disabled={busy !== null}
                                    loading={busy === `thaw:${batch.id}`}
                                    onClick={() => void act(batch, "thaw")}
                                  >
                                    {t("Thaw")}
                                  </Button>
                                )}
                              </div>
                            )}
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-muted">
            {t("Take out removes a portion from stock now. Thawing switches the eat-by date to the short thaw window ({count} days by default). Refreezing is not offered.", { count: 2 })}
          </p>
        </>
      )}
    </div>
  );
}
