import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api";
import { useAuth, useHouse } from "@/state";
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Skeleton, Stat, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { daysUntil, money, shortDate } from "@/format";
import type {
  HouseBudgetSettings,
  HouseholdBalance,
  HouseholdReceipt,
  HouseholdSettlement,
  PriceAlert,
  ShoppingPriceHint,
  SpendInsight,
  UseItUpItem,
  UseItUpRecipe,
  WasteInsight,
} from "@shared/types";
import { useI18n } from "@/i18n";

interface HouseholdData {
  currency: string;
  members: { userId: string; name: string; role: string }[];
  balances: HouseholdBalance[];
  settlements: HouseholdSettlement[];
  receipts: HouseholdReceipt[];
}

export function InsightsPage() {
  const { t } = useI18n();
  const { house, can } = useHouse();
  const { user } = useAuth();
  const toast = useToast();
  const [spend, setSpend] = useState<SpendInsight | null>(null);
  const [waste, setWaste] = useState<WasteInsight | null>(null);
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [useItUp, setUseItUp] = useState<{ items: UseItUpItem[]; recipes: UseItUpRecipe[]; days: number } | null>(null);
  const [household, setHousehold] = useState<HouseholdData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settling, setSettling] = useState<string | null>(null);
  const [editingBudget, setEditingBudget] = useState(false);
  const editingBudgetRef = useRef(false);
  const [budget, setBudget] = useState("0");
  const [threshold, setThreshold] = useState("20");

  const load = useCallback(async () => {
    try {
      const [spendData, wasteData, alertData, useItUpData, householdData] = await Promise.all([
        api<SpendInsight>(`/api/houses/${house.id}/insights/spend?months=6`),
        api<WasteInsight>(`/api/houses/${house.id}/insights/waste?months=6`),
        api<{ alerts: PriceAlert[] }>(`/api/houses/${house.id}/insights/price-alerts`),
        api<{ items: UseItUpItem[]; recipes: UseItUpRecipe[]; days: number }>(
          `/api/houses/${house.id}/insights/use-it-up`,
        ),
        api<HouseholdData>(`/api/houses/${house.id}/insights/household`),
      ]);
      setSpend(spendData);
      setWaste(wasteData);
      setAlerts(alertData.alerts);
      setUseItUp(useItUpData);
      setHousehold(householdData);
      setLoadError(null);
      // Never overwrite a budget the admin is in the middle of editing.
      if (!editingBudgetRef.current) {
        setBudget(String(spendData.budget || ""));
        setThreshold(String(spendData.settings.priceAlertPercent));
      }
    } catch (err) {
      const message = err instanceof Error ? t(err.message) : t("Could not load insights");
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [house.id, t, toast]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const saveSettings = async () => {
    const budgetValue = budget.trim() === "" ? 0 : Number(budget);
    const thresholdValue = Number(threshold);
    if (!Number.isFinite(budgetValue) || budgetValue < 0) {
      toast.error(t("Enter a monthly budget of 0 or more."));
      return;
    }
    if (!Number.isFinite(thresholdValue) || thresholdValue < 1 || thresholdValue > 500) {
      toast.error(t("The price-alert threshold must be between 1 and 500%."));
      return;
    }
    setBusy(true);
    try {
      const settings = await api<HouseBudgetSettings>(`/api/houses/${house.id}/insights/settings`, {
        method: "PATCH",
        body: { monthlyBudget: budgetValue, priceAlertPercent: thresholdValue },
      });
      setSpend((current) => (current ? { ...current, budget: settings.monthlyBudget, settings } : current));
      editingBudgetRef.current = false;
      setEditingBudget(false);
      toast.success(t("Budget updated"));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not save the budget"));
    } finally {
      setBusy(false);
    }
  };

  const checkPrices = async () => {
    setBusy(true);
    try {
      const result = await api<{ created: number; alerts: PriceAlert[] }>(
        `/api/houses/${house.id}/insights/price-alerts/scan`,
        { method: "POST", body: {} },
      );
      setAlerts(result.alerts);
      toast.success(result.created ? t("{count} new price alerts", { count: result.created }) : t("No new price alerts"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not check prices"));
    } finally {
      setBusy(false);
    }
  };

  const recordSettlement = async (settlement: HouseholdSettlement) => {
    const key = `${settlement.fromUserId}:${settlement.toUserId}`;
    setSettling(key);
    try {
      const updated = await api<HouseholdData>(`/api/houses/${house.id}/insights/settlements`, {
        method: "POST",
        body: {
          fromUserId: settlement.fromUserId,
          toUserId: settlement.toUserId,
          amount: settlement.amount,
        },
      });
      setHousehold(updated);
      toast.success(t("Payment recorded"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not record the payment"));
      await load();
    } finally {
      setSettling(null);
    }
  };

  const setPayer = async (receipt: HouseholdReceipt, paidBy: string) => {
    try {
      await api(`/api/receipts/${receipt.id}`, { method: "PATCH", body: { paidBy: paidBy || null } });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not change the payer"));
    }
  };

  const shareWithEveryone = async (receipt: HouseholdReceipt) => {
    try {
      // House membership, not the balance rows: a member with no receipts yet
      // still shares the cost.
      const everyone = household?.members.map((member) => member.userId) ?? [];
      if (!everyone.length) {
        toast.error(t("Could not load the house members. Refresh and try again."));
        return;
      }
      await api(`/api/receipts/${receipt.id}`, { method: "PATCH", body: { splitWith: everyone } });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not update the split"));
    }
  };

  const maxMonth = useMemo(
    () => Math.max(1, ...(spend?.byMonth.map((entry) => entry.total) ?? [1])),
    [spend],
  );
  const maxWaste = useMemo(
    () => Math.max(1, ...(waste?.byMonth.map((entry) => entry.cost) ?? [1])),
    [waste],
  );
  const myBalance = household?.balances.find((member) => member.userId === user?.id)?.balance ?? 0;

  if (loading) {
    return (
      <div className="space-y-4">
        <PageHeader eyebrow={t("Money & shelves")} title={t("Insights")} />
        <div className="grid gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!spend || !waste || !useItUp || !household) {
    return (
      <div className="space-y-4">
        <PageHeader eyebrow={t("Money & shelves")} title={t("Insights")} />
        <EmptyState
          icon="price"
          title={loadError ? t("Could not load insights") : t("Nothing to show yet")}
          body={loadError ?? t("Scan a receipt or add stock and the insights will fill in.")}
          action={
            loadError ? (
              <Button
                icon="refresh"
                onClick={() => {
                  setLoading(true);
                  void load();
                }}
              >
                {t("Try again ")}</Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={t("Money & shelves")}
        title={t("Insights")}
        subtitle={t("Spending, prices, waste and what to use up first")}
        actions={
          <Button
            size="sm"
            variant="secondary"
            icon="refresh"
            loading={busy}
            disabled={!can("member")}
            onClick={() => void checkPrices()}
          >
            {t("Check prices ")}</Button>
        }
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          label={t("This month")}
          value={money(spend.monthTotal, spend.currency)}
          hint={t(spend.monthReceipts === 1 ? "{count} receipt" : "{count} receipts", { count: spend.monthReceipts })}
          icon="receipt"
        />
        <Stat
          label={spend.budget > 0 ? t("Budget left") : t("Monthly average")}
          value={
            spend.budget > 0 && spend.budgetRemaining != null
              ? money(spend.budgetRemaining, spend.currency)
              : money(spend.averagePerMonth, spend.currency)
          }
          hint={spend.budget > 0 ? t("of {amount}", { amount: money(spend.budget, spend.currency) }) : t("over the last 6 months")}
          tone={spend.budgetPercent != null && spend.budgetPercent >= 100 ? "danger" : undefined}
          icon="price"
        />
        <Stat
          label={t("Wasted")}
          value={money(waste.currentMonthCost, waste.currency)}
          hint={t("{month} · {amount} in 6 months", { month: waste.currentMonth, amount: money(waste.totalCost, waste.currency) })}
          tone="warn"
          icon="trash"
        />
        <Stat
          label={t("Your balance")}
          value={money(myBalance, household.currency)}
          hint={
            household.settlements.length
              ? t(household.settlements.length === 1 ? "{count} transfer to settle" : "{count} transfers to settle", { count: household.settlements.length })
              : t("all square")
          }
          icon="users"
        />
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-display text-lg">{t("Monthly budget")}</h2>
            <p className="text-[11px] text-muted">
              {spend.budget > 0
                ? t("{percent}% used in {month}", { percent: spend.budgetPercent?.toFixed(0) ?? "0", month: spend.month })
                : t("Set a budget to track how the month is going.")}
            </p>
          </div>
          {can("admin") && (
            <Button
              size="sm"
              variant="ghost"
              icon="pencil"
              onClick={() => {
                editingBudgetRef.current = !editingBudget;
                setEditingBudget(!editingBudget);
              }}
            >
              {editingBudget ? t("Cancel") : t("Edit")}
            </Button>
          )}
        </div>

        {spend.budget > 0 && (
          <div className="mt-3">
            <div className="h-2.5 overflow-hidden rounded-full bg-raised">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  (spend.budgetPercent ?? 0) >= 100 ? "bg-danger" : (spend.budgetPercent ?? 0) >= 80 ? "bg-warn" : "bg-brand",
                )}
                style={{ width: `${Math.min(100, spend.budgetPercent ?? 0)}%` }}
              />
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] text-muted">
              <span>{money(spend.monthTotal, spend.currency)} {' '}{t(" spent")}</span>
              <span>{money(spend.budget, spend.currency)} {' '}{t(" budget")}</span>
            </div>
          </div>
        )}

        {editingBudget && (
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <Field label={t("Monthly budget ({currency})", { currency: spend.currency })}>
              <Input value={budget} inputMode="decimal" onChange={(event) => setBudget(event.target.value)} placeholder="300" />
            </Field>
            <Field label={t("Price alert threshold (%)")}>
              <Input value={threshold} inputMode="numeric" onChange={(event) => setThreshold(event.target.value)} placeholder="20" />
            </Field>
            <div className="flex items-end">
              <Button block loading={busy} onClick={() => void saveSettings()}>
                {t("Save ")}</Button>
            </div>
          </div>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="font-display text-lg">{t("Spending by month")}</h2>
          <div className="mt-3 space-y-2">
            {spend.byMonth.map((entry) => (
              <div key={entry.month} className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[11px] text-muted">{entry.month}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-raised">
                  <div className="h-full rounded-full bg-brand" style={{ width: `${(entry.total / maxMonth) * 100}%` }} />
                </div>
                <span className="w-20 shrink-0 text-right text-[11px] tabular-nums">{money(entry.total, spend.currency)}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-4">
          <h2 className="font-display text-lg">{t("Where it goes")}</h2>
          <div className="mt-2 space-y-1.5">
            {spend.byShop.slice(0, 5).map((shop) => (
              <div key={shop.vendorName} className="flex items-center gap-2 text-sm">
                <Icon name="store" size={14} className="text-muted" />
                <span className="min-w-0 flex-1 truncate">{shop.vendorName}</span>
                <span className="text-[11px] text-muted">{shop.receipts}×</span>
                <span className="tabular-nums">{money(shop.total, spend.currency)}</span>
              </div>
            ))}
            {!spend.byShop.length && <p className="text-[12px] text-muted">{t("No receipts this month yet.")}</p>}
          </div>
          {spend.byCategory.length > 0 && (
            <>
              <div className="my-2 h-px bg-line" />
              <div className="flex flex-wrap gap-1.5">
                {spend.byCategory.slice(0, 6).map((category) => (
                  <Badge key={category.name} tone="neutral">
                    {category.name} · {money(category.total, spend.currency)}
                  </Badge>
                ))}
              </div>
            </>
          )}
        </Card>
      </div>

      <Card className="p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-lg">{t("Price alerts")}</h2>
            <p className="text-[11px] text-muted">
              {t("Purchases more than ")}{' '}{spend.settings.priceAlertPercent}{t("% above your usual price ")}</p>
          </div>
          <Badge tone={alerts.length ? "warn" : "neutral"}>{alerts.length}</Badge>
        </div>
        {alerts.length ? (
          <div className="mt-3 space-y-1.5">
            {alerts.slice(0, 8).map((alert) => (
              <Link
                key={`${alert.itemId}-${alert.receiptId}`}
                to={`/receipts?tab=receipts`}
                className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-2 text-sm transition-colors hover:bg-raised"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-warn-soft text-warn">
                  <Icon name="alert" size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{alert.itemName}</span>
                  <span className="block truncate text-[11px] text-muted">
                    {alert.vendorName ?? t("A shop")} · {shortDate(alert.purchasedAt)}
                  </span>
                </span>
                <span className="text-right text-[11px]">
                  <span className="block font-medium text-warn">+{alert.percent}%</span>
                  <span className="block text-muted">
                    {alert.price.toFixed(2)} {' '}{t(" vs ")}{' '}{alert.averagePrice.toFixed(2)}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-[12px] text-muted">{t("No recent purchase is clearly above your usual price.")}</p>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-lg">{t("Use it up")}</h2>
            <p className="text-[11px] text-muted">{t("Expiring in the next ")}{' '}{useItUp.days} {' '}{t(" days, with recipes that use them")}</p>
          </div>
          <Badge tone={useItUp.items.length ? "warn" : "neutral"}>{useItUp.items.length}</Badge>
        </div>
        {useItUp.items.length ? (
          <>
            <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
              {useItUp.items.slice(0, 10).map((item) => {
                const days = daysUntil(item.expiresAt) ?? 0;
                return (
                  <div key={item.itemId} className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-2">
                    <span className={cn("flex h-7 w-7 items-center justify-center rounded-lg", days <= 1 ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn")}>
                      <Icon name="clock" size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{item.name}</span>
                      <span className="block truncate text-[11px] text-muted">
                        {item.quantity} {item.unit ?? ""} · {item.locationName ?? t("no place")}
                      </span>
                    </span>
                    <Badge tone={days <= 1 ? "danger" : "warn"}>
                      {days <= 0 ? t("expired") : days === 1 ? t("tomorrow") : t("{count} days", { count: days })}
                    </Badge>
                  </div>
                );
              })}
            </div>
            {useItUp.recipes.length > 0 && (
              <div className="mt-3 space-y-1">
                <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">{t("Cook this")}</div>
                {useItUp.recipes.slice(0, 5).map((recipe) => (
                  <Link
                    key={recipe.recipeId}
                    to={`/recipes/${recipe.recipeId}`}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-raised"
                  >
                    <Icon name="utensils" size={14} className="text-muted" />
                    <span className="min-w-0 flex-1 truncate">{recipe.title}</span>
                    <span className="text-[11px] text-muted">{t("uses ")}{' '}{recipe.matched.length}</span>
                    <Icon name="chevronRight" size={13} className="text-muted" />
                  </Link>
                ))}
              </div>
            )}
          </>
        ) : (
          <p className="mt-3 text-[12px] text-muted">{t("Nothing expires soon. The fridge is under control.")}</p>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="font-display text-lg">{t("Waste")}</h2>
          <p className="text-[11px] text-muted">{t("Value of stock written off over the last ")}{' '}{waste.months} {' '}{t(" months")}</p>
          <div className="mt-3 space-y-2">
            {waste.byMonth.map((entry) => (
              <div key={entry.month} className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[11px] text-muted">{entry.month}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-raised">
                  <div className="h-full rounded-full bg-warn" style={{ width: `${(entry.cost / maxWaste) * 100}%` }} />
                </div>
                <span className="w-20 shrink-0 text-right text-[11px] tabular-nums">{money(entry.cost, waste.currency)}</span>
              </div>
            ))}
          </div>
          {waste.topItems.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {waste.topItems.slice(0, 5).map((item) => (
                <Badge key={item.itemName} tone="warn">
                  {item.itemName} · {money(item.cost, waste.currency)}
                </Badge>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-4">
          <h2 className="font-display text-lg">{t("Household split")}</h2>
          <p className="text-[11px] text-muted">{t("Who paid for receipts and who still owes what")}</p>
          <div className="mt-3 space-y-1.5">
            {household.balances.map((member) => (
              <div key={member.userId} className="flex items-center gap-2 text-sm">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-soft text-[10px] font-semibold text-brand">
                  {member.name.slice(0, 2).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate">{member.name}</span>
                <span className="text-[11px] text-muted">{t("paid ")}{' '}{money(member.paid, household.currency)}</span>
                {member.settled !== 0 && <span className="text-[10px] text-muted">{t("net sent ")}{member.settled > 0 ? "+" : ""}{money(member.settled, household.currency)}</span>}
                <span className={cn("w-20 text-right tabular-nums", member.balance > 0.009 ? "text-brand" : member.balance < -0.009 ? "text-danger" : "text-muted")}>
                  {member.balance > 0.009 ? "+" : ""}
                  {money(member.balance, household.currency)}
                </span>
              </div>
            ))}
          </div>
          {household.settlements.length > 0 && (
            <div className="mt-3 rounded-lg bg-raised/60 p-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">{t("Settle up")}</div>
              {household.settlements.map((settlement) => (
                <div key={`${settlement.fromUserId}:${settlement.toUserId}`} className="mt-1 flex items-center gap-2 text-[12px]">
                  <span className="min-w-0 flex-1">{settlement.fromName} → {settlement.toName} · <span className="font-medium">{money(settlement.amount, household.currency)}</span></span>
                  <Button size="sm" variant="secondary" disabled={settling !== null} onClick={() => void recordSettlement(settlement)}>
                    {settling === `${settlement.fromUserId}:${settlement.toUserId}` ? t("Recording…") : t("Record payment")}
                  </Button>
                </div>
              ))}
            </div>
          )}

          {household.receipts.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                {t("Recent receipts ")}</summary>
              <div className="mt-2 space-y-1.5">
                {household.receipts.slice(0, 8).map((receipt) => (
                  <div key={receipt.id} className="flex items-center gap-2 rounded-lg border border-line px-2 py-1.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px]">{receipt.vendorName ?? t("Receipt")}</span>
                      <span className="block text-[10px] text-muted">
                        {receipt.purchasedAt ? shortDate(receipt.purchasedAt) : ""} · {money(receipt.total ?? 0, household.currency)}
                      </span>
                    </span>
                    <select
                      value={receipt.paidBy ?? ""}
                      onChange={(event) => void setPayer(receipt, event.target.value)}
                      disabled={!can("member")}
                      className="h-8 max-w-[120px] rounded-lg border border-line bg-surface px-1.5 text-[11px] disabled:opacity-50"
                    >
                      <option value="">{t("Default (receipt owner)")}</option>
                      {household.members.map((member) => (
                        <option key={member.userId} value={member.userId}>
                          {member.name}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!can("member")}
                      onClick={() => void shareWithEveryone(receipt)}
                      title={t("Share with everyone")}
                    >
                      <Icon name="users" size={14} />
                    </Button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </Card>
      </div>

      <ShoppingPriceCard houseId={house.id} />
    </div>
  );
}

/** Cheapest recent shop for the open shopping-list lines, loaded on demand. */
function ShoppingPriceCard({ houseId }: { houseId: string }) {
  const { t } = useI18n();
  const [hints, setHints] = useState<ShoppingPriceHint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<{ hints: ShoppingPriceHint[] }>(`/api/houses/${houseId}/insights/shopping-prices`);
      setHints(result.hints);
      setError(false);
    } catch {
      setHints([]);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [houseId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="font-display text-lg">{t("Cheapest shops for your list")}</h2>
          <p className="text-[11px] text-muted">{t("Best unit price seen on a receipt in the last 6 months")}</p>
        </div>
        <Button size="sm" variant="ghost" icon="refresh" loading={loading} onClick={() => void load()}>
          {t("Refresh ")}</Button>
      </div>
      {hints?.length ? (
        <div className="mt-3 space-y-1.5">
          {hints.slice(0, 10).map((hint) => (
            <div key={hint.lineId} className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-2">
              <Icon name="list" size={14} className="text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{hint.name}</span>
                <span className="block truncate text-[11px] text-muted">
                  {hint.cheapest.vendorName} · {shortDate(hint.cheapest.purchasedAt)}
                </span>
              </span>
              <span className="text-right text-[12px] font-medium tabular-nums">
                {hint.cheapest.price.toFixed(2)} {hint.currency}
                {hint.unit ? <span className="text-[10px] font-normal text-muted">/{hint.unit}</span> : null}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className={cn("mt-3 text-[12px]", error ? "text-danger" : "text-muted")}>
          {error
            ? t("Could not load price hints. Try refreshing.")
            : hints
              ? t("Add lines to the shopping list and buy them once to see price hints.")
              : t("Loading…")}
        </p>
      )}
    </Card>
  );
}
