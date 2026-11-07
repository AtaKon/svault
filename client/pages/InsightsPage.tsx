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

interface HouseholdData {
  currency: string;
  members: { userId: string; name: string; role: string }[];
  balances: HouseholdBalance[];
  settlements: HouseholdSettlement[];
  receipts: HouseholdReceipt[];
}

export function InsightsPage() {
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
      const message = err instanceof Error ? err.message : "Could not load insights";
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [house.id, toast]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const saveSettings = async () => {
    const budgetValue = budget.trim() === "" ? 0 : Number(budget);
    const thresholdValue = Number(threshold);
    if (!Number.isFinite(budgetValue) || budgetValue < 0) {
      toast.error("Enter a monthly budget of 0 or more.");
      return;
    }
    if (!Number.isFinite(thresholdValue) || thresholdValue < 1 || thresholdValue > 500) {
      toast.error("The price-alert threshold must be between 1 and 500%.");
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
      toast.success("Budget updated");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the budget");
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
      toast.success(result.created ? `${result.created} new price reminder${result.created === 1 ? "" : "s"}` : "No new price alerts");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not check prices");
    } finally {
      setBusy(false);
    }
  };

  const setPayer = async (receipt: HouseholdReceipt, paidBy: string) => {
    try {
      await api(`/api/receipts/${receipt.id}`, { method: "PATCH", body: { paidBy: paidBy || null } });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change the payer");
    }
  };

  const shareWithEveryone = async (receipt: HouseholdReceipt) => {
    try {
      // House membership, not the balance rows: a member with no receipts yet
      // still shares the cost.
      const everyone = household?.members.map((member) => member.userId) ?? [];
      if (!everyone.length) {
        toast.error("Could not load the house members. Refresh and try again.");
        return;
      }
      await api(`/api/receipts/${receipt.id}`, { method: "PATCH", body: { splitWith: everyone } });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the split");
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
        <PageHeader eyebrow="Money & shelves" title="Insights" />
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
        <PageHeader eyebrow="Money & shelves" title="Insights" />
        <EmptyState
          icon="price"
          title={loadError ? "Could not load insights" : "Nothing to show yet"}
          body={loadError ?? "Scan a receipt or add stock and the insights will fill in."}
          action={
            loadError ? (
              <Button
                icon="refresh"
                onClick={() => {
                  setLoading(true);
                  void load();
                }}
              >
                Try again
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Money & shelves"
        title="Insights"
        subtitle="Spending, prices, waste and what to use up first"
        actions={
          <Button
            size="sm"
            variant="secondary"
            icon="refresh"
            loading={busy}
            disabled={!can("member")}
            onClick={() => void checkPrices()}
          >
            Check prices
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          label="This month"
          value={money(spend.monthTotal, spend.currency)}
          hint={`${spend.monthReceipts} receipt${spend.monthReceipts === 1 ? "" : "s"}`}
          icon="receipt"
        />
        <Stat
          label={spend.budget > 0 ? "Budget left" : "Monthly average"}
          value={
            spend.budget > 0 && spend.budgetRemaining != null
              ? money(spend.budgetRemaining, spend.currency)
              : money(spend.averagePerMonth, spend.currency)
          }
          hint={spend.budget > 0 ? `of ${money(spend.budget, spend.currency)}` : "over the last 6 months"}
          tone={spend.budgetPercent != null && spend.budgetPercent >= 100 ? "danger" : undefined}
          icon="price"
        />
        <Stat
          label="Wasted"
          value={money(waste.currentMonthCost, waste.currency)}
          hint={`${waste.currentMonth} · ${money(waste.totalCost, waste.currency)} in 6 months`}
          tone="warn"
          icon="trash"
        />
        <Stat
          label="Your balance"
          value={money(myBalance, household.currency)}
          hint={
            household.settlements.length
              ? `${household.settlements.length} transfer${household.settlements.length === 1 ? "" : "s"} to settle`
              : "all square"
          }
          icon="users"
        />
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-display text-lg">Monthly budget</h2>
            <p className="text-[11px] text-muted">
              {spend.budget > 0
                ? `${spend.budgetPercent?.toFixed(0)}% used in ${spend.month}`
                : "Set a budget to track how the month is going."}
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
              {editingBudget ? "Cancel" : "Edit"}
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
              <span>{money(spend.monthTotal, spend.currency)} spent</span>
              <span>{money(spend.budget, spend.currency)} budget</span>
            </div>
          </div>
        )}

        {editingBudget && (
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <Field label={`Monthly budget (${spend.currency})`}>
              <Input value={budget} inputMode="decimal" onChange={(event) => setBudget(event.target.value)} placeholder="300" />
            </Field>
            <Field label="Price alert threshold (%)">
              <Input value={threshold} inputMode="numeric" onChange={(event) => setThreshold(event.target.value)} placeholder="20" />
            </Field>
            <div className="flex items-end">
              <Button block loading={busy} onClick={() => void saveSettings()}>
                Save
              </Button>
            </div>
          </div>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="font-display text-lg">Spending by month</h2>
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
          <h2 className="font-display text-lg">Where it goes</h2>
          <div className="mt-2 space-y-1.5">
            {spend.byShop.slice(0, 5).map((shop) => (
              <div key={shop.vendorName} className="flex items-center gap-2 text-sm">
                <Icon name="store" size={14} className="text-muted" />
                <span className="min-w-0 flex-1 truncate">{shop.vendorName}</span>
                <span className="text-[11px] text-muted">{shop.receipts}×</span>
                <span className="tabular-nums">{money(shop.total, spend.currency)}</span>
              </div>
            ))}
            {!spend.byShop.length && <p className="text-[12px] text-muted">No receipts this month yet.</p>}
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
            <h2 className="font-display text-lg">Price alerts</h2>
            <p className="text-[11px] text-muted">
              Purchases more than {spend.settings.priceAlertPercent}% above your usual price
            </p>
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
                    {alert.vendorName ?? "A shop"} · {shortDate(alert.purchasedAt)}
                  </span>
                </span>
                <span className="text-right text-[11px]">
                  <span className="block font-medium text-warn">+{alert.percent}%</span>
                  <span className="block text-muted">
                    {alert.price.toFixed(2)} vs {alert.averagePrice.toFixed(2)}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-[12px] text-muted">No recent purchase is clearly above your usual price.</p>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-lg">Use it up</h2>
            <p className="text-[11px] text-muted">Expiring in the next {useItUp.days} days, with recipes that use them</p>
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
                        {item.quantity} {item.unit ?? ""} · {item.locationName ?? "no place"}
                      </span>
                    </span>
                    <Badge tone={days <= 1 ? "danger" : "warn"}>
                      {days <= 0 ? "expired" : days === 1 ? "tomorrow" : `${days} days`}
                    </Badge>
                  </div>
                );
              })}
            </div>
            {useItUp.recipes.length > 0 && (
              <div className="mt-3 space-y-1">
                <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Cook this</div>
                {useItUp.recipes.slice(0, 5).map((recipe) => (
                  <Link
                    key={recipe.recipeId}
                    to={`/recipes/${recipe.recipeId}`}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-raised"
                  >
                    <Icon name="utensils" size={14} className="text-muted" />
                    <span className="min-w-0 flex-1 truncate">{recipe.title}</span>
                    <span className="text-[11px] text-muted">uses {recipe.matched.length}</span>
                    <Icon name="chevronRight" size={13} className="text-muted" />
                  </Link>
                ))}
              </div>
            )}
          </>
        ) : (
          <p className="mt-3 text-[12px] text-muted">Nothing expires soon. The fridge is under control.</p>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="font-display text-lg">Waste</h2>
          <p className="text-[11px] text-muted">Value of stock written off over the last {waste.months} months</p>
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
          <h2 className="font-display text-lg">Household split</h2>
          <p className="text-[11px] text-muted">Who paid for receipts and who still owes what</p>
          <div className="mt-3 space-y-1.5">
            {household.balances.map((member) => (
              <div key={member.userId} className="flex items-center gap-2 text-sm">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-soft text-[10px] font-semibold text-brand">
                  {member.name.slice(0, 2).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate">{member.name}</span>
                <span className="text-[11px] text-muted">paid {money(member.paid, household.currency)}</span>
                <span className={cn("w-20 text-right tabular-nums", member.balance > 0.009 ? "text-brand" : member.balance < -0.009 ? "text-danger" : "text-muted")}>
                  {member.balance > 0.009 ? "+" : ""}
                  {money(member.balance, household.currency)}
                </span>
              </div>
            ))}
          </div>
          {household.settlements.length > 0 && (
            <div className="mt-3 rounded-lg bg-raised/60 p-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">Settle up</div>
              {household.settlements.map((settlement, index) => (
                <div key={index} className="mt-1 text-[12px]">
                  {settlement.fromName} → {settlement.toName} · <span className="font-medium">{money(settlement.amount, household.currency)}</span>
                </div>
              ))}
            </div>
          )}

          {household.receipts.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                Recent receipts
              </summary>
              <div className="mt-2 space-y-1.5">
                {household.receipts.slice(0, 8).map((receipt) => (
                  <div key={receipt.id} className="flex items-center gap-2 rounded-lg border border-line px-2 py-1.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px]">{receipt.vendorName ?? "Receipt"}</span>
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
                      <option value="">Default (receipt owner)</option>
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
                      title="Share with everyone"
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
          <h2 className="font-display text-lg">Cheapest shops for your list</h2>
          <p className="text-[11px] text-muted">Best unit price seen on a receipt in the last 6 months</p>
        </div>
        <Button size="sm" variant="ghost" icon="refresh" loading={loading} onClick={() => void load()}>
          Refresh
        </Button>
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
            ? "Could not load price hints. Try refreshing."
            : hints
              ? "Add lines to the shopping list and buy them once to see price hints."
              : "Loading…"}
        </p>
      )}
    </Card>
  );
}
