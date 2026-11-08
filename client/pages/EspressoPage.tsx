import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, qs } from "@/api";
import { useAuth, useHouse } from "@/state";
import { useI18n } from "@/i18n";
import { Badge, Button, Card, EmptyState, LoadingBlock, PageHeader, Select, Stat } from "@/components/ui";
import { EspressoShotRow, EspressoShotSheet } from "@/components/Espresso";
import { useToast } from "@/components/toast";
import { qty } from "@/format";
import type { EspressoShot, EspressoShotList } from "@shared/types";

export function EspressoPage() {
  const { t } = useI18n();
  const { house, can } = useHouse();
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [filter, setFilter] = useState(params.get("itemId") ?? "");
  const [data, setData] = useState<EspressoShotList | null>(null);
  const [loading, setLoading] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<EspressoShot | null>(null);
  const [sheetSession, setSheetSession] = useState(0);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const current = ++requestId.current;
    try {
      const result = await api<EspressoShotList>(
        `/api/houses/${house.id}/espresso-shots${qs({ itemId: filter, limit: 500 })}`,
      );
      if (current === requestId.current) setData(result);
    } catch (error) {
      if (current === requestId.current) {
        toast.error(error instanceof Error ? t(error.message) : t("Could not load espresso shots"));
      }
    } finally {
      if (current === requestId.current) setLoading(false);
    }
  }, [house.id, filter, t, toast]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const beans = data?.beans ?? [];
  const loggableBeans = beans.filter((bean) => bean.espresso);
  const summary = data?.summary;
  const canEdit = (shot: EspressoShot) =>
    !!user && can("member") && (shot.userId === user.id || can("admin"));

  if (loading && !data) return <LoadingBlock label={t("Loading espresso shots")} />;

  if (beans.length === 0 && (data?.shots.length ?? 0) === 0) {
    return (
      <div className="space-y-4">
        <PageHeader eyebrow={t("Coffee")} title={t("Espresso log")} subtitle={t("Ratings and dial-in history for your coffee beans.")} />
        <EmptyState
          icon="cup"
          title={t("No espresso coffee yet")}
          body={t("Open a coffee item, turn on “Espresso coffee” and it will get a shot log here.")}
          action={<Button onClick={() => navigate("/items")}>{t("Go to inventory")}</Button>}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={t("Coffee")}
        title={t("Espresso log")}
        subtitle={t("Ratings, grind, dose, yield and extraction history across your coffee beans.")}
        actions={
          can("member") && loggableBeans.length > 0 ? (
            <Button
              icon="plus"
              onClick={() => {
                setEditing(null);
                setSheetSession((current) => current + 1);
                setSheetOpen(true);
              }}
            >
              {t("Log a shot")}
            </Button>
          ) : undefined
        }
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={t("Shots")} value={summary?.count ?? 0} icon="cup" />
        <Stat label={t("Average rating")} value={summary?.averageRating == null ? "—" : qty(summary.averageRating)} icon="star" />
        <Stat label={t("Best rating")} value={summary?.bestRating == null ? "—" : `${summary.bestRating}/5`} icon="star" tone="warn" />
        <Stat
          label={t("Avg. extraction")}
          value={summary?.averageExtractionSeconds == null ? "—" : t("{value} s", { value: qty(summary.averageExtractionSeconds) })}
          icon="clock"
        />
      </div>

      <Card className="flex flex-wrap items-center gap-2 p-3">
        <Select value={filter} onChange={(event) => setFilter(event.target.value)} className="h-9 min-w-[180px] flex-1 text-[13px]" aria-label={t("Filter by coffee")}>
          <option value="">{t("All coffees")}</option>
          {beans.map((bean) => (
            <option key={bean.id} value={bean.id}>
              {bean.name}
              {bean.brand ? ` · ${bean.brand}` : ""} ({bean.shotCount})
            </option>
          ))}
        </Select>
        {summary && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
            <Badge tone="outline">{t("Avg. ratio 1:{value}", { value: summary.averageRatio == null ? "—" : qty(summary.averageRatio) })}</Badge>
            <Badge tone="outline">
              {t("Avg. yield {value} g", { value: summary.averageYieldGrams == null ? "—" : qty(summary.averageYieldGrams) })}
            </Badge>
            <Badge tone="outline">
              {t("Avg. extraction yield {value}%", {
                value: summary.averageExtractionYieldPercent == null ? "—" : qty(summary.averageExtractionYieldPercent),
              })}
            </Badge>
          </div>
        )}
      </Card>

      {loggableBeans.length === 0 && (data?.shots.length ?? 0) > 0 && (
        <Card className="p-3 text-[11px] leading-relaxed text-muted">
          {t("All espresso beans are turned off. Re-enable one to log new shots; the existing history is still shown below.")}
        </Card>
      )}

      <Card className="p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="font-display text-lg">{t("Shots")}</h2>
          <Badge tone="outline">{summary?.count ?? data?.shots.length ?? 0}</Badge>
        </div>
        {loading ? (
          <p className="py-3 text-xs text-muted">{t("Loading…")}</p>
        ) : (data?.shots.length ?? 0) === 0 ? (
          <div className="py-4 text-center">
            <p className="text-sm text-muted">{t("No shots for this coffee yet.")}</p>
            {can("member") && loggableBeans.length > 0 && (
              <Button
                className="mt-3"
                size="sm"
                variant="secondary"
                icon="plus"
                onClick={() => {
                  setEditing(null);
                  setSheetSession((current) => current + 1);
                  setSheetOpen(true);
                }}
              >
                {t("Log the first shot")}
              </Button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-line">
            {data!.shots.map((shot) => (
              <EspressoShotRow
                key={shot.id}
                shot={shot}
                showItem={!filter}
                canEdit={canEdit(shot)}
                onEdit={() => {
                  setEditing(shot);
                  setSheetSession((current) => current + 1);
                  setSheetOpen(true);
                }}
              />
            ))}
          </div>
        )}
      </Card>

      <EspressoShotSheet
        key={sheetSession}
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        shot={editing}
        beans={editing ? beans : loggableBeans}
        initialItemId={filter && loggableBeans.some((bean) => bean.id === filter) ? filter : loggableBeans[0]?.id}
        onSaved={() => void load()}
        onDeleted={() => void load()}
      />
    </div>
  );
}
