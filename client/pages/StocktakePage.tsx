import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "@/api";
import { useHouse } from "@/state";
import { useI18n } from "@/i18n";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  Sheet,
  Textarea,
  cn,
} from "@/components/ui";
import { Icon } from "@/components/icons";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { useToast } from "@/components/toast";
import { money, qty, relativeTime, shortDate } from "@/format";
import type { Category, Location, Stocktake, StocktakeCommitResult, StocktakeLine } from "@shared/types";
import {
  clearPendingCount,
  flushPendingCounts,
  queuePendingCount,
  readPendingCounts,
  type PendingStocktakeCount,
} from "@/stocktake-draft";

type PendingMap = Record<string, PendingStocktakeCount>;

function varianceOf(line: StocktakeLine): number | null {
  return line.countedQty == null ? null : line.countedQty - line.expectedQty;
}

function statusTone(status: Stocktake["status"]): "brand" | "warn" | "neutral" {
  if (status === "draft") return "warn";
  if (status === "committed") return "brand";
  return "neutral";
}

function scopeLabel(stocktake: Stocktake, t: (key: string) => string): string {
  if (stocktake.locationName) return stocktake.locationName;
  if (stocktake.categoryName) return stocktake.categoryName;
  return t("Whole house");
}

export function StocktakePage() {
  const { house, can } = useHouse();
  const { t } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const [list, setList] = useState<Stocktake[] | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [locationId, setLocationId] = useState(params.get("location") ?? "");
  const [categoryId, setCategoryId] = useState(params.get("category") ?? "");
  const [note, setNote] = useState("");
  const [starting, setStarting] = useState(false);
  const member = can("member");

  const load = useCallback(async () => {
    try {
      const [sessions, places, cats] = await Promise.all([
        api<{ stocktakes: Stocktake[] }>(`/api/houses/${house.id}/stocktakes`),
        api<Location[]>(`/api/houses/${house.id}/locations`),
        api<Category[]>(`/api/houses/${house.id}/categories`),
      ]);
      setList(sessions.stocktakes);
      setLocations(places);
      setCategories(cats);
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not load stocktakes"));
      setList([]);
    }
  }, [house.id, toast, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = useMemo(() => list?.find((entry) => entry.status === "draft") ?? null, [list]);
  const history = useMemo(() => (list ?? []).filter((entry) => entry.status !== "draft"), [list]);

  const start = async () => {
    setStarting(true);
    try {
      const result = await api<{ stocktake: Stocktake }>(`/api/houses/${house.id}/stocktakes`, {
        method: "POST",
        body: {
          locationId: locationId || null,
          categoryId: categoryId || null,
          note: note.trim() || null,
        },
      });
      navigate(`/stocktake/${result.stocktake.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const details = (err.details ?? {}) as { stocktakeId?: string };
        if (details.stocktakeId) {
          toast.error(t("A stocktake is already open for this house"));
          navigate(`/stocktake/${details.stocktakeId}`);
          return;
        }
      }
      toast.error(err instanceof Error ? t(err.message) : t("Could not start a stocktake"));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={t("Inventory")}
        title={t("Stocktake")}
        subtitle={t("Count what is really on the shelf, place by place.")}
        back={() => navigate("/more")}
      />

      {open && (
        <Card className="border-warn/40 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Badge tone="warn">{t("Open count")}</Badge>
                <span className="truncate text-[13px] font-medium">{scopeLabel(open, t)}</span>
              </div>
              <div className="mt-1 text-[11px] text-muted">
                {t("Started {date}", { date: relativeTime(open.createdAt) })} ·{" "}
                {t("{counted} of {total} counted", { counted: qty(open.countedCount), total: qty(open.lineCount) })}
              </div>
            </div>
            <Button size="sm" icon="list" onClick={() => navigate(`/stocktake/${open.id}`)}>
              {t("Resume")}
            </Button>
          </div>
        </Card>
      )}

      {!open && (
        <Card className="space-y-3 p-4">
          <div>
            <h2 className="font-display text-lg">{t("Start a count")}</h2>
            <p className="mt-0.5 text-xs text-muted">
              {t("The expected quantity is snapshotted now, so changes made while counting are flagged before commit.")}
            </p>
          </div>
          {member ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("Place")} hint={t("Optional")}>
                  <Select
                    value={locationId}
                    onChange={(event) => {
                      setLocationId(event.target.value);
                      if (event.target.value) setCategoryId("");
                    }}
                  >
                    <option value="">{t("The whole house")}</option>
                    {locations.map((place) => (
                      <option key={place.id} value={place.id}>
                        {place.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("Category")} hint={t("Optional")}>
                  <Select
                    value={categoryId}
                    onChange={(event) => {
                      setCategoryId(event.target.value);
                      if (event.target.value) setLocationId("");
                    }}
                  >
                    <option value="">{t("Every category")}</option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label={t("Note")}>
                <Input
                  value={note}
                  maxLength={300}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={t("Optional note for this count")}
                />
              </Field>
              <Button block icon="check" loading={starting} onClick={() => void start()}>
                {t("Start counting")}
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted">{t("Only household members can start or commit a stocktake. You can review past counts.")}</p>
          )}
        </Card>
      )}

      <div>
        <h2 className="mb-2 px-1 font-display text-lg">{t("Past stocktakes")}</h2>
        {list === null ? (
          <LoadingBlock label={t("Loading")} />
        ) : history.length === 0 ? (
          <EmptyState
            icon="check"
            title={t("No stocktakes yet")}
            body={t("A stocktake compares the shelf with the app and records the differences in one step.")}
          />
        ) : (
          <div className="space-y-2">
            {history.map((entry) => (
              <button
                key={entry.id}
                onClick={() => navigate(`/stocktake/${entry.id}`)}
                className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 text-left transition-colors hover:bg-raised"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium">{scopeLabel(entry, t)}</span>
                    <Badge tone={statusTone(entry.status)}>
                      {t(entry.status === "committed" ? "Committed" : "Cancelled")}
                    </Badge>
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted">
                    {shortDate(entry.committedAt ?? entry.cancelledAt ?? entry.createdAt)} ·{" "}
                    {t("{count} lines", { count: qty(entry.lineCount) })} ·{" "}
                    {t("{count} variances", { count: qty(entry.varianceCount) })}
                  </span>
                </span>
                <Icon name="chevronRight" size={15} className="shrink-0 text-muted" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function StocktakeSessionPage() {
  const { stocktakeId = "" } = useParams();
  const { house, can } = useHouse();
  const { t } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const member = can("member");
  const [detail, setDetail] = useState<Stocktake | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<"count" | "review">("count");
  const [filter, setFilter] = useState("");
  const [hideCounted, setHideCounted] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [confirmedChanged, setConfirmedChanged] = useState<Set<string>>(new Set());
  const [pendingDraft, setPendingDraft] = useState<PendingMap>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [committing, setCommitting] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [focusLineId, setFocusLineId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const scannedFor = useRef<string>("");

  const load = useCallback(async () => {
    try {
      const result = await api<{ stocktake: Stocktake }>(`/api/houses/${house.id}/stocktakes/${stocktakeId}`);
      setDetail(result.stocktake);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? t(err.message) : t("Could not load this stocktake"));
    }
  }, [house.id, stocktakeId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!detail) return;
    setPendingDraft(readPendingCounts(house.id, detail.id));
    setExcluded(new Set());
    setConfirmedChanged(new Set());
  }, [detail?.id, house.id]);

  const flush = useCallback(async () => {
    if (!detail || detail.status !== "draft") return;
    const queued = readPendingCounts(house.id, detail.id);
    if (!Object.keys(queued).length) return;
    const result = await flushPendingCounts(house.id, detail.id);
    if (result.synced > 0) toast.success(t("Counts saved on this device were synced"));
    if (result.dropped > 0) {
      toast.error(t("Some counts saved on this device were refused by the server and discarded"));
    }
    if (result.synced > 0 || result.dropped > 0) await load();
    setPendingDraft(readPendingCounts(house.id, detail.id));
  }, [detail, house.id, load, t, toast]);

  useEffect(() => {
    if (!detail || detail.status !== "draft") return;
    void flush();
    const onOnline = () => void flush();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [detail?.id, detail?.status, flush]);

  useEffect(() => {
    if (!focusLineId) return;
    const element = document.getElementById(`stocktake-line-${focusLineId}`);
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
    const timer = setTimeout(() => setFocusLineId(null), 3000);
    return () => clearTimeout(timer);
  }, [focusLineId]);

  const lines = useMemo(() => {
    const base = detail?.lines ?? [];
    return base.map((line) => {
      const queued = pendingDraft[line.id];
      if (!queued) return line;
      return {
        ...line,
        countedQty: queued.countedQty,
        note: queued.note === undefined ? line.note : queued.note,
      };
    });
  }, [detail, pendingDraft]);
  const countedLines = useMemo(() => lines.filter((line) => line.countedQty != null), [lines]);
  const draft = detail?.status === "draft";

  const applyLine = useCallback((updated: StocktakeLine) => {
    setDetail((previous) =>
      previous
        ? { ...previous, lines: previous.lines?.map((line) => (line.id === updated.id ? updated : line)) }
        : previous,
    );
  }, []);

  const saveLine = useCallback(
    async (line: StocktakeLine, countedQty: number | null, note?: string | null): Promise<boolean> => {
      if (!detail) return false;
      setSaving((previous) => ({ ...previous, [line.id]: true }));
      try {
        const result = await api<{ line: StocktakeLine }>(
          `/api/houses/${house.id}/stocktakes/${detail.id}/lines/${line.id}`,
          {
            method: "PATCH",
            body: { countedQty, ...(note === undefined ? {} : { note }) },
          },
        );
        applyLine(result.line);
        clearPendingCount(house.id, detail.id, line.id);
        setPendingDraft((previous) => {
          if (!(line.id in previous)) return previous;
          const next = { ...previous };
          delete next[line.id];
          return next;
        });
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 0) {
          queuePendingCount(house.id, detail.id, line.id, countedQty, note);
          setPendingDraft(readPendingCounts(house.id, detail.id));
          applyLine({
            ...line,
            countedQty,
            note: note === undefined ? line.note : note,
            countedAt: new Date().toISOString(),
          });
          return true;
        }
        toast.error(err instanceof Error ? t(err.message) : t("Could not save this count"));
        return false;
      } finally {
        setSaving((previous) => {
          const next = { ...previous };
          delete next[line.id];
          return next;
        });
      }
    },
    [applyLine, detail, house.id, t, toast],
  );

  const onScan = async (code: string) => {
    if (!detail || scanning) return;
    setScanOpen(false);
    setScanning(true);
    try {
      if (scannedFor.current === code) return;
      scannedFor.current = code;
      const result = await api<{ item: { id: string; name: string } | null }>(
        `/api/houses/${house.id}/scan?code=${encodeURIComponent(code)}`,
      );
      const line = lines.find((entry) => entry.itemId === result.item?.id);
      if (!line) {
        toast.push(t("That item is not part of this stocktake."));
        return;
      }
      setFilter("");
      setHideCounted(false);
      setFocusLineId(line.id);
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not look up that barcode"));
    } finally {
      setScanning(false);
      setTimeout(() => {
        scannedFor.current = "";
      }, 1500);
    }
  };

  const visibleLines = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return lines.filter((line) => {
      if (hideCounted && line.countedQty != null) return false;
      if (!needle) return true;
      return line.itemName.toLowerCase().includes(needle);
    });
  }, [lines, filter, hideCounted]);

  const selected = useMemo(() => countedLines.filter((line) => !excluded.has(line.id)), [countedLines, excluded]);
  const changedSelected = useMemo(() => selected.filter((line) => line.changed), [selected]);
  const unconfirmed = changedSelected.filter((line) => !confirmedChanged.has(line.id));
  const totalImpact = useMemo(
    () =>
      selected.reduce((sum, line) => {
        const variance = varianceOf(line);
        return sum + (variance != null && line.unitCost != null ? variance * line.unitCost : 0);
      }, 0),
    [selected],
  );

  const commit = async () => {
    if (!detail) return;
    setCommitting(true);
    try {
      const result = await api<StocktakeCommitResult>(
        `/api/houses/${house.id}/stocktakes/${detail.id}/commit`,
        {
          method: "POST",
          body: {
            lineIds: selected.map((line) => line.id),
            confirmChangedLineIds: unconfirmed.length ? [] : changedSelected.map((line) => line.id),
          },
        },
      );
      setDetail(result.stocktake);
      toast.success(t("Stocktake committed"));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const details = (err.details ?? {}) as { code?: string; status?: string; changedLineIds?: string[] };
        if (details.code === "changed-since-snapshot") {
          setConfirmedChanged(new Set());
          await load();
          toast.error(t("Some stock changed since this count started. Confirm the changed lines to commit."));
          return;
        }
        if (details.status) {
          await load();
        }
      }
      toast.error(err instanceof Error ? t(err.message) : t("Could not commit this stocktake"));
    } finally {
      setCommitting(false);
    }
  };

  const cancel = async () => {
    if (!detail) return;
    setCancelling(true);
    try {
      const result = await api<{ stocktake: Stocktake }>(
        `/api/houses/${house.id}/stocktakes/${detail.id}/cancel`,
        { method: "POST", body: {} },
      );
      setDetail(result.stocktake);
      toast.success(t("Stocktake cancelled"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not cancel this stocktake"));
    } finally {
      setCancelling(false);
    }
  };

  if (error && !detail) {
    return (
      <div>
        <PageHeader title={t("Stocktake")} back={() => navigate("/stocktake")} />
        <EmptyState
          icon="alert"
          title={t("Could not load this stocktake")}
          body={error}
          action={<Button onClick={() => navigate("/stocktake")}>{t("Back to stocktakes")}</Button>}
        />
      </div>
    );
  }
  if (!detail) return <LoadingBlock label={t("Loading")} />;

  const countedCount = countedLines.length;
  const percent = detail.lineCount ? Math.round((countedCount / detail.lineCount) * 100) : 0;
  const pendingCount = Object.keys(pendingDraft).length;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={t("Stocktake")}
        title={scopeLabel(detail, t)}
        subtitle={`${shortDate(detail.createdAt)} · ${t("{counted} of {total} counted", {
          counted: qty(countedCount),
          total: qty(detail.lineCount),
        })}`}
        back={() => navigate("/stocktake")}
        actions={
          <>
            <Badge tone={statusTone(detail.status)}>
              {t(detail.status === "draft" ? "In progress" : detail.status === "committed" ? "Committed" : "Cancelled")}
            </Badge>
            {draft && member && (
              <Button size="sm" variant="secondary" icon="scan" onClick={() => setScanOpen(true)} loading={scanning}>
                {t("Scan item")}
              </Button>
            )}
          </>
        }
      />

      {draft && (
        <Card className="space-y-2 p-3.5">
          <div className="flex items-center justify-between text-[11px] text-muted">
            <span>{t("Progress")}</span>
            <span>{percent}%</span>
          </div>
          <div
            className="h-2.5 overflow-hidden rounded-full bg-raised"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={t("Progress")}
          >
            <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${percent}%` }} />
          </div>
          {pendingCount > 0 && (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-warn-soft px-2.5 py-2 text-[11px] text-warn">
              <span>{t("{count} counts wait for a connection and are kept on this device.", { count: pendingCount })}</span>
              <button onClick={() => void flush()} className="shrink-0 font-semibold underline">
                {t("Retry")}
              </button>
            </div>
          )}
        </Card>
      )}

      {draft && member ? (
        stage === "count" ? (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder={t("Find an item")}
                aria-label={t("Find an item")}
                className="sm:max-w-xs"
              />
              <Button
                size="sm"
                variant={hideCounted ? "primary" : "secondary"}
                icon="check"
                onClick={() => setHideCounted((value) => !value)}
              >
                {t("Hide counted")}
              </Button>
            </div>

            {lines.length === 0 ? (
              <EmptyState icon="box" title={t("This count has no lines")} />
            ) : visibleLines.length === 0 ? (
              <EmptyState icon="search" title={t("Nothing matches")} body={t("Try a different search.")} />
            ) : (
              <div className="space-y-2">
                {visibleLines.map((line) => (
                  <CountRow
                    key={line.id}
                    line={line}
                    focused={focusLineId === line.id}
                    saving={Boolean(saving[line.id])}
                    pending={Boolean(pendingDraft[line.id])}
                    onSave={saveLine}
                    onSkip={() => {
                      void saveLine(line, null);
                      const next = lines.find((entry) => entry.id !== line.id && entry.countedQty == null);
                      if (next) setFocusLineId(next.id);
                    }}
                    onFocus={() => setFocusLineId(line.id)}
                  />
                ))}
              </div>
            )}

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button block icon="list" onClick={() => setStage("review")} disabled={!countedCount}>
                {t("Review {count} counted", { count: countedCount })}
              </Button>
              {member && (
                <Button block variant="ghost" loading={cancelling} onClick={() => void cancel()}>
                  {t("Cancel stocktake")}
                </Button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-lg">{t("Review variances")}</h2>
              <Button size="sm" variant="secondary" icon="arrowLeft" onClick={() => setStage("count")}>
                {t("Keep counting")}
              </Button>
            </div>
            {selected.length === 0 ? (
              <EmptyState icon="check" title={t("Nothing selected")} body={t("Select at least one counted line to commit.")} />
            ) : (
              <div className="space-y-2">
                {countedLines.map((line) => {
                  const variance = varianceOf(line);
                  const impact = variance != null && line.unitCost != null ? variance * line.unitCost : null;
                  const included = !excluded.has(line.id);
                  return (
                    <Card key={line.id} className={cn("p-3", !included && "opacity-60")}>
                      <label className="flex cursor-pointer items-start gap-3">
                        <input
                          type="checkbox"
                          checked={included}
                          onChange={(event) =>
                            setExcluded((previous) => {
                              const next = new Set(previous);
                              if (event.target.checked) next.delete(line.id);
                              else next.add(line.id);
                              return next;
                            })
                          }
                          className="mt-0.5 h-5 w-5 shrink-0 accent-brand"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-start justify-between gap-2">
                            <span className="min-w-0 break-words text-[13px] font-medium">{line.itemName}</span>
                            <span
                              className={cn(
                                "shrink-0 text-[13px] font-semibold",
                                variance == null || variance === 0
                                  ? "text-muted"
                                  : variance > 0
                                    ? "text-brand"
                                    : "text-danger",
                              )}
                            >
                              {variance == null ? "—" : `${variance > 0 ? "+" : ""}${qty(variance)} ${line.unit}`}
                            </span>
                          </span>
                          <span className="mt-0.5 block text-[11px] text-muted">
                            {t("Expected {qty} {unit} · counted {counted} {unit}", {
                              qty: qty(line.expectedQty),
                              counted: qty(line.countedQty ?? 0),
                              unit: line.unit,
                            })}
                            {impact != null && ` · ${money(impact)}`}
                          </span>
                        </span>
                      </label>
                      {line.changed && included && (
                        <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-lg bg-warn-soft px-2.5 py-2 text-[11px] text-warn">
                          <input
                            type="checkbox"
                            checked={confirmedChanged.has(line.id)}
                            onChange={(event) =>
                              setConfirmedChanged((previous) => {
                                const next = new Set(previous);
                                if (event.target.checked) next.add(line.id);
                                else next.delete(line.id);
                                return next;
                              })
                            }
                            className="mt-0.5 h-4 w-4 shrink-0 accent-brand"
                          />
                          <span>
                            {t("Stock changed since the snapshot: {current} {unit} now. The variance is applied to the current quantity.", {
                              current: qty(line.currentQty),
                              unit: line.unit,
                            })}
                          </span>
                        </label>
                      )}
                    </Card>
                  );
                })}
              </div>
            )}

            <Card className="space-y-3 p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted">{t("Value impact")}</span>
                <span className="font-semibold">{money(totalImpact)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted">{t("Lines to commit")}</span>
                <span className="font-semibold">{qty(selected.length)}</span>
              </div>
              {unconfirmed.length > 0 && (
                <p className="rounded-lg bg-warn-soft px-2.5 py-2 text-[11px] text-warn">
                  {t("Confirm {count} changed lines before committing.", { count: unconfirmed.length })}
                </p>
              )}
              {member ? (
                <Button
                  block
                  icon="check"
                  loading={committing}
                  disabled={!selected.length || unconfirmed.length > 0}
                  onClick={() => void commit()}
                >
                  {t("Commit stocktake")}
                </Button>
              ) : (
                <p className="text-sm text-muted">{t("Only household members can commit a stocktake.")}</p>
              )}
            </Card>
          </>
        )
      ) : (
        <StocktakeSummary stocktake={detail} />
      )}

      <Sheet open={scanOpen} onClose={() => setScanOpen(false)} title={t("Scan an item")} description={t("The matching line is highlighted.")}>
        <BarcodeScanner onDetected={(code) => void onScan(code)} />
        <p className="mt-3 text-xs text-muted">{t("Barcode scanning needs HTTPS or localhost and camera permission.")}</p>
      </Sheet>
    </div>
  );
}

function CountRow({
  line,
  focused,
  saving,
  pending,
  onSave,
  onSkip,
  onFocus,
}: {
  line: StocktakeLine;
  focused: boolean;
  saving: boolean;
  pending: boolean;
  /** Resolves true when the count reached the server or the offline queue. */
  onSave: (line: StocktakeLine, countedQty: number | null, note?: string | null) => Promise<boolean>;
  onSkip: () => void;
  onFocus: () => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(line.countedQty == null ? "" : String(line.countedQty));
  const [noteOpen, setNoteOpen] = useState(Boolean(line.note));
  const [note, setNote] = useState(line.note ?? "");
  const lastSaved = useRef<number | null>(line.countedQty);

  useEffect(() => {
    setValue(line.countedQty == null ? "" : String(line.countedQty));
    lastSaved.current = line.countedQty;
  }, [line.countedQty]);
  useEffect(() => {
    setNote(line.note ?? "");
  }, [line.note]);

  useEffect(() => {
    const text = value.trim();
    const parsed = text === "" ? null : Number(text);
    if (parsed != null && (!Number.isFinite(parsed) || parsed < 0)) return;
    if (parsed === lastSaved.current) return;
    const timer = setTimeout(() => {
      if (parsed === lastSaved.current) return;
      lastSaved.current = parsed;
      // A refused save must stay retryable: fall back to what the server holds
      // so the next edit or blur sends the count again.
      void onSave(line, parsed, undefined).then((saved) => {
        if (!saved) lastSaved.current = line.countedQty;
      });
    }, 900);
    return () => clearTimeout(timer);
  }, [value, line, onSave]);

  const variance = varianceOf(line);

  return (
    <Card
      id={`stocktake-line-${line.id}`}
      className={cn(
        "scroll-mt-24 p-3 transition-shadow",
        focused && "ring-2 ring-brand/40",
        line.countedQty != null && !focused && "border-brand/30",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <button onClick={onFocus} className="min-w-0 flex-1 text-left">
          <span className="block break-words text-[14px] font-medium">{line.itemName}</span>
          <span className="mt-0.5 block text-[11px] text-muted">
            {t("Expected {qty} {unit}", { qty: qty(line.expectedQty), unit: line.unit })}
            {pending ? ` · ${t("Not synced")}` : ""}
          </span>
        </button>
        {line.countedQty != null && (
          <Badge tone={variance === 0 ? "brand" : variance != null && variance < 0 ? "danger" : "warn"}>
            {variance === 0
              ? t("Matches")
              : `${variance != null && variance > 0 ? "+" : ""}${qty(variance ?? 0)} ${line.unit}`}
          </Badge>
        )}
      </div>
      <div className="mt-2 flex items-stretch gap-2">
        <Button size="sm" variant="secondary" onClick={() => void onSave(line, line.expectedQty, undefined)}>
          {t("Matches")}
        </Button>
        <div className="relative min-w-0 flex-1">
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onFocus={onFocus}
            onBlur={() => {
              const text = value.trim();
              const parsed = text === "" ? null : Number(text);
              if (parsed != null && (!Number.isFinite(parsed) || parsed < 0)) return;
              // Compare with what was last sent, not the server value, so a count the
              // autosave already sent is not sent a second time on blur.
              if (parsed === lastSaved.current) return;
              lastSaved.current = parsed;
              void onSave(line, parsed, undefined).then((saved) => {
                if (!saved) lastSaved.current = line.countedQty;
              });
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.currentTarget.blur();
            }}
            aria-label={t("Counted quantity for {item}", { item: line.itemName })}
            placeholder={t("Count")}
            className="h-12 pr-12 text-lg"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">{line.unit}</span>
        </div>
        <Button size="sm" variant="ghost" onClick={onSkip}>
          {t("Skip")}
        </Button>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted">
        <button onClick={() => setNoteOpen((open) => !open)} className="underline-offset-2 hover:underline">
          {noteOpen ? t("Hide note") : t("Add note")}
        </button>
        <span>{saving ? t("Saving…") : pending ? t("Saved on this device") : line.countedAt ? t("Saved") : ""}</span>
      </div>
      {noteOpen && (
        <Textarea
          rows={2}
          className="mt-1.5 text-[13px]"
          value={note}
          maxLength={300}
          aria-label={t("Note for {item}", { item: line.itemName })}
          placeholder={t("What did you notice?")}
          onChange={(event) => setNote(event.target.value)}
          onBlur={() => {
            if (note === (line.note ?? "")) return;
            void onSave(line, line.countedQty, note);
          }}
        />
      )}
    </Card>
  );
}

function StocktakeSummary({ stocktake }: { stocktake: Stocktake }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const lines = stocktake.lines ?? [];
  const variances = lines.filter((line) => line.countedQty != null && line.countedQty !== line.expectedQty);
  const impact = variances.reduce((sum, line) => {
    if (line.unitCost == null) return sum;
    return sum + (line.countedQty! - line.expectedQty) * line.unitCost;
  }, 0);

  return (
    <>
      {stocktake.status === "draft" && (
        <p className="rounded-xl bg-raised px-3 py-2 text-xs text-muted">
          {t("Only household members can count this stocktake.")}
        </p>
      )}
      <Card className="grid grid-cols-3 gap-2 p-3.5 text-center">
        <div>
          <div className="font-display text-xl">{qty(stocktake.lineCount)}</div>
          <div className="text-[11px] text-muted">{t("Lines")}</div>
        </div>
        <div>
          <div className="font-display text-xl">{qty(stocktake.varianceCount)}</div>
          <div className="text-[11px] text-muted">{t("Variances")}</div>
        </div>
        <div>
          <div className="font-display text-xl">{money(impact)}</div>
          <div className="text-[11px] text-muted">{t("Value impact")}</div>
        </div>
      </Card>

      <div className="space-y-2">
        {lines.map((line) => {
          const variance = varianceOf(line);
          return (
            <Card key={line.id} className="flex items-start justify-between gap-3 p-3">
              <div className="min-w-0">
                <div className="break-words text-[13px] font-medium">{line.itemName}</div>
                <div className="mt-0.5 text-[11px] text-muted">
                  {t("Expected {qty} {unit} · counted {counted} {unit}", {
                    qty: qty(line.expectedQty),
                    counted: qty(line.countedQty ?? 0),
                    unit: line.unit,
                  })}
                  {line.countedAt ? ` · ${relativeTime(line.countedAt)}` : ""}
                </div>
                {line.note && <div className="mt-0.5 text-[11px] italic text-muted">“{line.note}”</div>}
              </div>
              <span
                className={cn(
                  "shrink-0 text-[13px] font-semibold",
                  variance == null || variance === 0 ? "text-muted" : variance > 0 ? "text-brand" : "text-danger",
                )}
              >
                {variance == null ? t("Not counted") : `${variance > 0 ? "+" : ""}${qty(variance)} ${line.unit}`}
              </span>
            </Card>
          );
        })}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button block variant="secondary" icon="arrowLeft" onClick={() => navigate("/stocktake")}>
          {t("Back to stocktakes")}
        </Button>
        <Button block onClick={() => navigate("/items")}>
          {t("Open inventory")}
        </Button>
      </div>
    </>
  );
}
