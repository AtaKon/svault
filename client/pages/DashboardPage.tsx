import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "@/api";
import { useAuth, useHouse } from "@/state";
import { useI18n } from "@/i18n";
import { Badge, Button, Card, PageHeader, Skeleton, Stat, cn } from "@/components/ui";import { Icon, type IconName } from "@/components/icons";
import { ItemCard } from "@/components/ItemCard";
import { useToast } from "@/components/toast";
import { compactMoney, daysUntil, qty, relativeTime, shortDate } from "@/format";
import type { Dashboard, Item, ItemDetail, Movement, Recipe, StockLot } from "@shared/types";

interface DashboardData extends Omit<Dashboard, "recent"> {
  recent: (Movement & { itemName?: string })[];
  expiring: (StockLot & { itemName: string; itemId: string })[];
  recentRecipe: Recipe | null;
}

export function DashboardPage() {
  const { house, can } = useHouse();
  const { user } = useAuth();
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api<DashboardData>(`/api/houses/${house.id}/dashboard`);
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? t(err.message) : t("Could not load the dashboard"));
    }
  }, [house.id, t]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const onItemUpdated = (detail: ItemDetail) => {
    setData((current) =>
      current
        ? {
            ...current,
            lowStock: detail.isLow
              ? current.lowStock.map((item) => (item.id === detail.id ? detail : item))
              : current.lowStock.filter((item) => item.id !== detail.id),
          }
        : current,
    );
    const event = new CustomEvent("sv:refresh-badges");
    window.dispatchEvent(event);
  };

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const name = user?.name.split(" ")[0];

  const addLowStock = async () => {
    try {
      const result = await api<{ added: number; merged: number }>(`/api/houses/${house.id}/shopping/from-low-stock`, {
        method: "POST",
        body: {},
      });
      const count = result.added + result.merged;
      toast.success(count
        ? t(count === 1 ? "Added {count} line to the shopping list" : "Added {count} lines to the shopping list", { count })
        : t("Nothing new to add"));
      if (count) navigate("/shopping");
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not add low-stock items"));
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={new Date().toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" })}
        title={
          <span>
            {t(greeting)}{name ? `, ${name}` : ""}
          </span>
        }
        subtitle={t("Here is what is going on in {house}.", { house: house.name })}
        actions={
          <div className="hidden gap-2 sm:flex">
            <Button variant="secondary" icon="scan" onClick={() => navigate("/scan")}>
              {t("Scan")}
            </Button>
            {can("member") && <Button icon="plus" onClick={() => navigate("/items/new")}>
              {t("Add item")}
            </Button>}
          </div>
        }      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t("Items")} value={qty(data?.itemCount)} hint={t("tracked in this house")} icon="box" />
        <Stat label={t("Batches")} value={qty(data?.batchCount)} hint={t("active stock batches")} icon="grid" />
        <Stat
          label={t("Stock value")}
          value={compactMoney(data?.totalValue, house.currency)}
          hint={t("from purchase prices")}
          icon="price"
        />
        <Stat
          label={t("Running low")}
          value={qty(data?.lowStock.length ?? 0)}
          hint={t("need a restock")}
          icon="alert"
          tone={data?.lowStock.length ? "warn" : "brand"}
        />
      </div>

      {data && data.itemCount === 0 && (
        <Card className="overflow-hidden">
          <div className="relative bg-brand px-5 py-6 text-brand-ink">
            <div className="absolute inset-0 bg-grid opacity-20" />
            <div className="relative">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] opacity-70">{t("Let's get started")}</div>
              <div className="mt-1 font-display text-2xl">{t("Your shelves are waiting")}</div>
              <p className="mt-1.5 max-w-md text-sm opacity-80">
                {t("Add the first thing you own, scan a barcode, or set up a room in this house. Everything else builds from here.")}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {can("member") && <Button variant="secondary" icon="plus" onClick={() => navigate("/items/new")}>
                  {t("Add an item")}
                </Button>}
                <Button variant="secondary" icon="scan" onClick={() => navigate("/scan")}>
                  {t("Scan a barcode")}
                </Button>
                <Button variant="secondary" icon="settings" onClick={() => navigate("/settings?tab=places")}>
                  {t("Set up rooms")}
                </Button>
              </div>
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          <section>
            <div className="mb-2.5 flex items-center justify-between">
              <h2 className="font-display text-xl">{t("Running low")}</h2>
              <div className="flex items-center gap-3">
                {can("member") && data && data.lowStock.length > 0 && (
                  <button onClick={() => void addLowStock()} className="text-xs font-medium text-brand hover:underline">
                    {t("Add to list")}
                  </button>
                )}
                <Link to="/items?low=1" className="text-xs font-medium text-brand hover:underline">
                  {t("See all")}
                </Link>
              </div>
            </div>
            {!data ? (
              <div className="space-y-2">
                <Skeleton className="h-[70px]" />
                <Skeleton className="h-[70px]" />
              </div>
            ) : data.lowStock.length === 0 ? (
              <Card className="flex items-center gap-3 p-4">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-soft text-brand">
                  <Icon name="check" size={19} />
                </span>
                <div>
                  <div className="text-sm font-medium">{t("Everything is stocked")}</div>
                  <div className="text-[11px] text-muted">{t("Set a reorder point on items you never want to run out of.")}</div>
                </div>
              </Card>
            ) : (
              <div className="space-y-2">
                {data.lowStock.slice(0, 4).map((item) => (
                  <ItemCard key={item.id} item={item} onUpdated={onItemUpdated} compact />
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="mb-2.5 flex items-center justify-between">
              <h2 className="font-display text-xl">{t("Rooms & places")}</h2>
              <Link to="/settings?tab=places" className="text-xs font-medium text-brand hover:underline">
                {t("Manage")}
              </Link>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {(data?.locations ?? []).slice(0, 6).map((location) => (
                <Link
                  key={location.id}
                  to={`/items?location=${location.id}`}
                  className="group flex items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2.5 transition-colors hover:border-brand/40 hover:bg-raised"
                >
                  <span className="text-lg">{location.icon ?? "📦"}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{location.name}</span>
                    <span className="block text-[11px] text-muted">{t("{count} items", { count: location.itemCount ?? 0 })}</span>
                  </span>
                </Link>
              ))}
              {data && data.locations.length === 0 && (
                <Link to="/settings?tab=places" className="col-span-full rounded-xl border border-dashed border-line px-3 py-4 text-center text-xs text-muted">
                  {t("No places yet — add a fridge, shelf or cabin.")}
                </Link>
              )}
            </div>
          </section>
        </div>

        <div className="min-w-0 space-y-5">
          <section>
            <div className="mb-2.5 flex items-center justify-between">
              <h2 className="font-display text-xl">{t("Use it up")}</h2>
              <Link to="/items?expiring=1" className="text-xs font-medium text-brand hover:underline">
                {t("Expiring")}
              </Link>
            </div>
            {!data ? (
              <Skeleton className="h-24" />
            ) : data.expiring.length === 0 ? (
              <Card className="p-4 text-sm text-muted">{t("Nothing expires in the next two weeks.")}</Card>
            ) : (
              <Card className="divide-y divide-line">
                {data.expiring.slice(0, 4).map((lot) => {
                  const days = daysUntil(lot.expiresAt);
                  return (
                    <button
                      key={lot.id}
                      onClick={() => navigate(`/items/${lot.itemId}`)}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-raised"
                    >
                      <span className={cn("flex h-8 w-8 items-center justify-center rounded-lg", days != null && days < 0 ? "bg-danger-soft text-danger" : days != null && days <= 3 ? "bg-warn-soft text-warn" : "bg-raised text-muted")}>
                        <Icon name="clock" size={15} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{lot.itemName}</span>
                        <span className="block text-[11px] text-muted">
                          {qty(lot.quantity)} {lot.unit} · {shortDate(lot.expiresAt)}
                        </span>
                      </span>
                      <Badge tone={days != null && days < 0 ? "danger" : "warn"}>
                        {days == null ? "" : days < 0 ? t("{count}d ago", { count: Math.abs(days) }) : days === 0 ? t("today") : t("{count}d", { count: days })}
                      </Badge>
                    </button>
                  );
                })}
              </Card>
            )}
          </section>

          <section>
            <div className="mb-2.5 flex items-center justify-between">
              <h2 className="font-display text-xl">{t("This week")}</h2>
              <Link to="/plan" className="text-xs font-medium text-brand hover:underline">
                {t("Open plan")}
              </Link>
            </div>
            <Card className="flex items-center gap-3 p-3.5">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-warn-soft text-warn">
                <Icon name="calendar" size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {t((data?.plan?.week ?? 0) === 1 ? "{count} meal planned" : "{count} meals planned", { count: qty(data?.plan?.week ?? 0) })}
                </div>
                <div className="text-[11px] text-muted">
                  {t("{count} today · turn the missing ingredients into a list", { count: qty(data?.plan?.today ?? 0) })}
                </div>
              </div>
              <Link
                to="/shopping"
                className="rounded-lg border border-line px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:text-brand"
              >
                {t("Shop")}
              </Link>
            </Card>
          </section>

          <section>
            <div className="mb-2.5 flex items-center justify-between">
              <h2 className="font-display text-xl">{t("Cook something")}</h2>
              <Link to="/ideas" className="text-xs font-medium text-brand hover:underline">
                {t("Get ideas")}
              </Link>
            </div>
            {data?.recentRecipe ? (
              <Card className="p-4">
                <button onClick={() => navigate(`/recipes/${data.recentRecipe!.id}`)} className="w-full text-left">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{t("From your recipes")}</div>
                      <div className="mt-1 break-words font-display text-lg leading-tight">{data.recentRecipe.title}</div>
                    </div>
                    {data.recentRecipe.match && (
                      <Badge tone={data.recentRecipe.match.coverage >= 0.75 ? "brand" : "warn"} className="shrink-0">
                        {Math.round(data.recentRecipe.match.coverage * 100)}% {t("in stock")}
                      </Badge>
                    )}
                  </div>
                  {data.recentRecipe.match && data.recentRecipe.match.missing.length > 0 && (
                    <p className="mt-2 text-xs text-muted">
                      {t("Missing: {items}", { items: data.recentRecipe.match.missing.slice(0, 3).map((m) => m.name).join(", ") })}
                    </p>
                  )}
                </button>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="soft" icon="sparkles" onClick={() => navigate("/ideas")}>
                    {t("What can I cook?")}
                  </Button>
                  <Button size="sm" variant="ghost" icon="book" onClick={() => navigate("/recipes/scan")}>
                    {t("Scan a recipe")}
                  </Button>
                </div>
              </Card>
            ) : (
              <Card className="p-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-warn-soft text-warn">
                    <Icon name="utensils" size={19} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{t("No recipes yet")}</div>
                    <div className="text-[11px] text-muted">{t("Scan a handwritten recipe and let AI tidy it up.")}</div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" icon="camera" onClick={() => navigate("/recipes/scan")}>
                    {t("Scan recipe")}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => navigate("/recipes/new")}>
                    {t("Write one")}
                  </Button>
                </div>
              </Card>
            )}
          </section>

          <section>
            <div className="mb-2.5 flex items-center justify-between">
              <h2 className="font-display text-xl">{t("Recent activity")}</h2>
              <button onClick={() => void load()} className="text-muted transition-colors hover:text-ink" aria-label={t("Refresh activity")}>
                <Icon name="refresh" size={15} />
              </button>
            </div>
            {!data ? (
              <Skeleton className="h-32" />
            ) : data.recent.length === 0 ? (
              <Card className="p-4 text-sm text-muted">{t("Stock changes will show up here.")}</Card>
            ) : (
              <Card className="divide-y divide-line">
                {data.recent.slice(0, 5).map((movement) => (
                  <ActivityRow key={movement.id} movement={movement} />
                ))}
              </Card>
            )}
          </section>

          <div className="grid grid-cols-2 gap-2">
            <Link to="/photos" className="flex items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-3 transition-colors hover:bg-raised">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-raised text-muted">
                <Icon name="image" size={17} />
              </span>
              <span>
                <span className="block text-[13px] font-medium">{t("{count} photos", { count: qty(data?.counts.photos ?? 0) })}</span>
                <span className="block text-[11px] text-muted">{t("{count} to label", { count: qty(data?.counts.unlabeledPhotos ?? 0) })}</span>
              </span>
            </Link>
            <Link to="/recipes" className="flex items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-3 transition-colors hover:bg-raised">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-raised text-muted">
                <Icon name="book" size={17} />
              </span>
              <span>
                <span className="block text-[13px] font-medium">{t("{count} recipes", { count: qty(data?.counts.recipes ?? 0) })}</span>
                <span className="block text-[11px] text-muted">{t("family collection")}</span>
              </span>
            </Link>
          </div>
        </div>
      </div>

      {error && <div className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>}

      <div className="sm:hidden">
        {can("member") && <Button block icon="plus" onClick={() => navigate("/items/new")}>
          {t("Add item")}
        </Button>}
      </div>
    </div>
  );
}

const MOVEMENT_META: Record<Movement["type"], { icon: IconName; label: string; tone: string }> = {
  in: { icon: "plus", label: "added", tone: "bg-brand-soft text-brand" },
  out: { icon: "minus", label: "used", tone: "bg-raised text-muted" },
  adjust: { icon: "pencil", label: "counted", tone: "bg-raised text-muted" },
  waste: { icon: "trash", label: "wasted", tone: "bg-danger-soft text-danger" },
  move: { icon: "mapPin", label: "moved", tone: "bg-raised text-muted" },
};

function ActivityRow({ movement }: { movement: Movement & { itemName?: string } }) {
  const { t } = useI18n();
  const meta = MOVEMENT_META[movement.type];
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span className={cn("flex h-8 w-8 items-center justify-center rounded-lg", meta.tone)}>
        <Icon name={meta.icon} size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px]">
          <span className="font-medium">{movement.userName?.split(" ")[0] ?? t("Someone")}</span> {t(meta.label)}{" "}
          <span className="font-medium">{qty(Math.abs(movement.delta))} {movement.unit}</span>{" "}
          {movement.itemName ? <span className="text-muted">{t("of {item}", { item: movement.itemName })}</span> : null}
        </div>
        <div className="text-[11px] text-muted">{relativeTime(movement.createdAt)}</div>
      </div>
    </div>
  );
}

export type { DashboardData, Item };
