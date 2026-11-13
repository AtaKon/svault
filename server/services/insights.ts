import { all, get, parseJson, run } from "../db.js";
import type { DatabaseSession } from "../database/types.js";
import { convert, round } from "../units.js";
import { createNotification } from "./notifications.js";
import { normalizeName } from "./shopping.js";
import { heuristicReceipt, normaliseReceiptDraft } from "./receipt-local.js";
import { reconcileReceipt } from "../../shared/receipt-reconcile.js";
import { splitAmountEvenly } from "../../shared/bill-splitting.js";
import type {
  HouseBudgetSettings,
  HouseholdBalance,
  HouseholdSettlement,
  PriceAlert,
  ReceiptDraft,
  ShoppingPriceHint,
  SpendInsight,
  UseItUpRecipe,
  UseItUpItem,
  WasteInsight,
} from "../../shared/types.js";

const DAY = 864e5;

export const DEFAULT_PRICE_ALERT_PERCENT = 20;
export const DEFAULT_MONTHLY_BUDGET = 0;
export const DEFAULT_USE_IT_UP_DAYS = 7;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function money(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? round(n, 2) : 0;
}

function addEvenShares(owed: Map<string, number>, total: number, splitWith: string[]) {
  if (!splitWith.length) return;
  const shares = splitAmountEvenly(total, splitWith.length);
  if (shares.length !== splitWith.length) {
    throw new Error("Household ledger split did not return one cent-exact share per member");
  }
  for (let index = 0; index < splitWith.length; index++) {
    const userId = splitWith[index]!;
    owed.set(userId, (owed.get(userId) ?? 0) + shares[index]!);
  }
}

function monthKeys(count: number): string[] {
  const keys: string[] = [];
  const cursor = new Date();
  cursor.setUTCDate(1);
  cursor.setUTCMonth(cursor.getUTCMonth() - (count - 1));
  for (let index = 0; index < count; index++) {
    keys.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return keys;
}

function monthOf(value: string | null | undefined): string {
  return String(value ?? "").slice(0, 7);
}

function dateOf(value: string | null | undefined): string {
  return String(value ?? "").slice(0, 10);
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
}

export async function readInsightSettings(houseId: string): Promise<HouseBudgetSettings> {
  const house = await get<any>("SELECT settings FROM houses WHERE id = ?", [houseId]);
  const settings = parseJson<Record<string, any>>(house?.settings, {});
  const insights = settings.insights ?? {};
  return {
    monthlyBudget:
      insights.monthlyBudget == null ? DEFAULT_MONTHLY_BUDGET : money(clamp(Number(insights.monthlyBudget), 0, 1e9)),
    priceAlertPercent:
      insights.priceAlertPercent == null
        ? DEFAULT_PRICE_ALERT_PERCENT
        : clamp(Number(insights.priceAlertPercent), 1, 500),
    useItUpDays:
      insights.useItUpDays == null ? DEFAULT_USE_IT_UP_DAYS : clamp(Math.round(Number(insights.useItUpDays)), 1, 60),
  };
}

export async function saveInsightSettings(
  houseId: string,
  patch: Partial<HouseBudgetSettings>,
): Promise<HouseBudgetSettings> {
  const house = await get<any>("SELECT settings FROM houses WHERE id = ?", [houseId]);
  const settings = parseJson<Record<string, any>>(house?.settings, {});
  const current = await readInsightSettings(houseId);
  settings.insights = {
    ...(settings.insights ?? {}),
    ...(patch.monthlyBudget === undefined ? {} : { monthlyBudget: clamp(Number(patch.monthlyBudget), 0, 1e9) }),
    ...(patch.priceAlertPercent === undefined
      ? {}
      : { priceAlertPercent: clamp(Number(patch.priceAlertPercent), 1, 500) }),
    ...(patch.useItUpDays === undefined ? {} : { useItUpDays: clamp(Math.round(Number(patch.useItUpDays)), 1, 60) }),
  };
  await run("UPDATE houses SET settings = ? WHERE id = ?", [JSON.stringify(settings), houseId]);
  return { ...current, ...patch };
}

/* ----------------------------------------------------------------- spend */

export async function spendInsight(houseId: string, months = 6): Promise<SpendInsight> {
  const count = clamp(Math.round(months), 1, 24);
  const keys = monthKeys(count);
  const since = `${keys[0]}-01`;
  const settings = await readInsightSettings(houseId);
  const house = await get<{ currency: string }>("SELECT currency FROM houses WHERE id = ?", [houseId]);
  const currency = house?.currency ?? "EUR";

  const receipts = await all<any>(
    `SELECT r.id, r.total, r.purchased_at, r.created_at, COALESCE(v.name, r.vendor_name) AS vendor_name
     FROM receipts r LEFT JOIN vendors v ON v.id = r.vendor_id
     WHERE r.house_id = ? AND COALESCE(r.purchased_at, substr(r.created_at, 1, 10)) >= ?
     ORDER BY COALESCE(r.purchased_at, r.created_at) DESC`,
    [houseId, since],
  );

  const byMonthMap = new Map<string, { total: number; receipts: number }>(keys.map((key) => [key, { total: 0, receipts: 0 }]));
  for (const receipt of receipts) {
    const key = monthOf(receipt.purchased_at ?? receipt.created_at);
    const bucket = byMonthMap.get(key);
    if (!bucket) continue;
    bucket.total += money(receipt.total);
    bucket.receipts += 1;
  }

  const currentMonth = keys[keys.length - 1];
  const current = receipts.filter((receipt) => monthOf(receipt.purchased_at ?? receipt.created_at) === currentMonth);

  const shops = new Map<string, { vendorName: string; total: number; receipts: number }>();
  for (const receipt of current) {
    const name = String(receipt.vendor_name ?? "Unknown shop");
    const entry = shops.get(name) ?? { vendorName: name, total: 0, receipts: 0 };
    entry.total += money(receipt.total);
    entry.receipts += 1;
    shops.set(name, entry);
  }

  const categories = (await all<any>(
    `SELECT COALESCE(c.name, 'Everything else') AS name,
       SUM(COALESCE(rl.line_total, 0)) AS total,
       COUNT(*) AS lines
     FROM receipt_lines rl
     JOIN receipts r ON r.id = rl.receipt_id
     LEFT JOIN items i ON i.id = rl.item_id
     LEFT JOIN categories c ON c.id = i.category_id AND c.house_id = i.house_id
     WHERE r.house_id = ? AND substr(COALESCE(r.purchased_at, r.created_at), 1, 7) = ?
     GROUP BY COALESCE(c.name, 'Everything else')
     ORDER BY total DESC`,
    [houseId, currentMonth],
  )).map((row) => ({ name: String(row.name), total: money(row.total), lines: Number(row.lines ?? 0) }));

  const monthTotal = money(byMonthMap.get(currentMonth)?.total ?? 0);
  const budget = settings.monthlyBudget;
  const activeMonths = [...byMonthMap.values()].filter((entry) => entry.receipts > 0);

  return {
    currency,
    month: currentMonth,
    monthTotal,
    monthReceipts: current.length,
    budget,
    budgetRemaining: budget > 0 ? money(Math.max(0, budget - monthTotal)) : null,
    budgetPercent: budget > 0 ? Math.round((monthTotal / budget) * 1000) / 10 : null,
    averagePerMonth: activeMonths.length
      ? money(activeMonths.reduce((sum, entry) => sum + entry.total, 0) / activeMonths.length)
      : 0,
    byMonth: keys.map((key) => ({ month: key, total: money(byMonthMap.get(key)?.total ?? 0), receipts: byMonthMap.get(key)?.receipts ?? 0 })),
    byShop: [...shops.values()].sort((a, b) => b.total - a.total).slice(0, 8),
    byCategory: categories.slice(0, 8),
    settings,
  };
}

/* ----------------------------------------------------------------- waste */

export async function wasteInsight(houseId: string, months = 6): Promise<WasteInsight> {
  const count = clamp(Math.round(months), 1, 24);
  const keys = monthKeys(count);
  const since = `${keys[0]}-01`;
  const house = await get<{ currency: string }>("SELECT currency FROM houses WHERE id = ?", [houseId]);
  const rows = await all<any>(
    `SELECT m.id, m.created_at, m.delta, m.unit, m.unit_price, m.normalized_price,
       i.name AS item_name, i.unit AS item_unit, c.name AS category_name
     FROM stock_movements m
     JOIN items i ON i.id = m.item_id
     LEFT JOIN categories c ON c.id = i.category_id AND c.house_id = i.house_id
     WHERE m.house_id = ? AND m.type = 'waste' AND substr(m.created_at, 1, 10) >= ?`,
    [houseId, since],
  );

  const byMonthMap = new Map<string, { cost: number; quantity: number; events: number }>(
    keys.map((key) => [key, { cost: 0, quantity: 0, events: 0 }]),
  );
  const items = new Map<string, { itemId: string | null; itemName: string; unit: string | null; category: string | null; cost: number; quantity: number; events: number }>();
  let totalCost = 0;

  for (const row of rows) {
    const month = monthOf(row.created_at);
    const bucket = byMonthMap.get(month);
    if (!bucket) continue;
    const unitPrice = row.unit_price == null ? row.normalized_price : row.unit_price;
    const quantity = Math.abs(Number(row.delta ?? 0));
    const cost = money(quantity * Number(unitPrice ?? 0));
    bucket.cost += cost;
    bucket.quantity += quantity;
    bucket.events += 1;
    totalCost += cost;

    const key = String(row.item_name ?? "Unknown");
    const entry = items.get(key) ?? {
      itemId: null,
      itemName: key,
      unit: row.item_unit ?? row.unit ?? null,
      category: row.category_name ?? null,
      cost: 0,
      quantity: 0,
      events: 0,
    };
    entry.cost += cost;
    entry.quantity += quantity;
    entry.events += 1;
    items.set(key, entry);
  }

  const currentMonth = keys[keys.length - 1];
  return {
    currency: house?.currency ?? "EUR",
    months: count,
    currentMonth,
    currentMonthCost: money(byMonthMap.get(currentMonth)?.cost ?? 0),
    totalCost: money(totalCost),
    byMonth: keys.map((key) => ({ month: key, cost: money(byMonthMap.get(key)?.cost ?? 0), events: byMonthMap.get(key)?.events ?? 0 })),
    topItems: [...items.values()]
      .map((entry) => ({ ...entry, cost: money(entry.cost), quantity: round(entry.quantity, 3) }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 10),
  };
}

/* ----------------------------------------------------------- price alerts */

interface PricePoint {
  itemId: string;
  itemName: string;
  unit: string | null;
  vendorName: string | null;
  receiptId: string;
  purchasedAt: string;
  price: number;
}

/**
 * Unit price of a receipt line expressed in the item's own unit. Receipt lines
 * in an incompatible unit are skipped rather than compared to something else.
 */
function perItemUnit(row: any): number | null {
  const quantity = Number(row.quantity ?? 0);
  const lineTotal = row.line_total == null ? null : Number(row.line_total);
  const unitPrice = row.unit_price == null ? null : Number(row.unit_price);
  if (quantity <= 0) return null;
  const from = row.line_unit ?? row.item_unit ?? "pcs";
  const to = row.item_unit ?? row.line_unit ?? "pcs";
  const converted = convert(quantity, from, to);
  if (converted == null || converted <= 0) return null;
  if (lineTotal != null) return round(lineTotal / converted, 4);
  if (unitPrice != null) return round((unitPrice * quantity) / converted, 4);
  return null;
}

export async function priceAlerts(houseId: string, thresholdPercent?: number): Promise<PriceAlert[]> {
  const settings = await readInsightSettings(houseId);
  const threshold = thresholdPercent ?? settings.priceAlertPercent;
  const house = await get<{ currency: string }>("SELECT currency FROM houses WHERE id = ?", [houseId]);
  const currency = house?.currency ?? "EUR";

  const rows = await all<any>(
    `SELECT rl.id, rl.item_id, rl.description, rl.quantity, rl.unit AS line_unit, rl.unit_price, rl.line_total,
       i.name AS item_name, i.unit AS item_unit,
       r.id AS receipt_id, COALESCE(r.purchased_at, substr(r.created_at, 1, 10)) AS purchased_at,
       COALESCE(v.name, r.vendor_name) AS vendor_name
     FROM receipt_lines rl
     JOIN receipts r ON r.id = rl.receipt_id
     JOIN items i ON i.id = rl.item_id
     LEFT JOIN vendors v ON v.id = r.vendor_id
     WHERE r.house_id = ? AND rl.item_id IS NOT NULL
       AND COALESCE(r.purchased_at, substr(r.created_at, 1, 10)) >= ?
     ORDER BY purchased_at ASC`,
    [houseId, isoDaysAgo(365)],
  );

  const points = new Map<string, PricePoint>();
  for (const row of rows) {
    const price = perItemUnit(row);
    if (price == null) continue;
    const key = row.item_id;
    const entry = points.get(key) ?? {
      itemId: row.item_id,
      itemName: row.item_name,
      unit: row.item_unit ?? null,
      vendorName: row.vendor_name ?? null,
      receiptId: row.receipt_id,
      purchasedAt: dateOf(row.purchased_at),
      price,
    };
    // rows are ascending, so the last one is the newest purchase.
    points.set(key, {
      ...entry,
      vendorName: row.vendor_name ?? null,
      receiptId: row.receipt_id,
      purchasedAt: dateOf(row.purchased_at),
      price,
    });
  }

  const alerts: PriceAlert[] = [];
  const recentCutoff = isoDaysAgo(45);
  for (const latest of points.values()) {
    if (latest.purchasedAt < recentCutoff) continue;
    const history = rows
      .filter((row) => row.item_id === latest.itemId && dateOf(row.purchased_at) < latest.purchasedAt)
      .map(perItemUnit)
      .filter((value): value is number => value != null);
    if (history.length < 2) continue;
    const average = history.reduce((sum, value) => sum + value, 0) / history.length;
    if (average <= 0) continue;
    const percent = Math.round(((latest.price - average) / average) * 1000) / 10;
    if (percent <= threshold) continue;
    alerts.push({
      itemId: latest.itemId,
      itemName: latest.itemName,
      unit: latest.unit,
      vendorName: latest.vendorName,
      receiptId: latest.receiptId,
      purchasedAt: latest.purchasedAt,
      price: money(latest.price),
      averagePrice: money(average),
      percent,
      sampleSize: history.length,
      currency,
    });
  }
  return alerts.sort((a, b) => b.percent - a.percent).slice(0, 50);
}

/** Create one in-app reminder per item and month, never duplicating a key. */
export async function scanPriceAlerts(houseId: string): Promise<number> {
  const alerts = await priceAlerts(houseId);
  let created = 0;
  for (const alert of alerts) {
    const result = await createNotification({
      houseId,
      type: "price_alert",
      title: `${alert.itemName} is ${alert.percent}% above your usual price`,
      body: `${alert.vendorName ?? "A shop"} charged ${alert.price.toFixed(2)} ${alert.currency} on ${alert.purchasedAt}; your average is ${alert.averagePrice.toFixed(2)} ${alert.currency}.`,
      data: {
        itemId: alert.itemId,
        receiptId: alert.receiptId,
        percent: alert.percent,
        price: alert.price,
        averagePrice: alert.averagePrice,
      },
      dedupeKey: `price:${alert.itemId}:${monthOf(alert.purchasedAt)}`,
    });
    if (result.created) created++;
  }
  return created;
}

/* ------------------------------------------------------------- household */

export async function householdInsight(
  houseId: string,
  session: Pick<DatabaseSession, "all" | "get"> = { all, get },
): Promise<{
  currency: string;
  /** Everyone in the house, including members with no receipts yet. */
  members: { userId: string; name: string; role: string }[];
  balances: HouseholdBalance[];
  settlements: HouseholdSettlement[];
  receipts: {
    id: string;
    purchasedAt: string | null;
    vendorName: string | null;
    total: number | null;
    paidBy: string | null;
    payerName: string | null;
    splitWith: string[];
    participantNames: string[];
  }[];
}> {
  const house = await session.get<{ currency: string }>("SELECT currency FROM houses WHERE id = ?", [houseId]);
  const currency = house?.currency ?? "EUR";
  const members = await session.all<{ id: string; name: string; role: string }>(
    `SELECT u.id, u.name, m.role FROM house_members m JOIN users u ON u.id = m.user_id
     WHERE m.house_id = ? ORDER BY m.created_at`,
    [houseId],
  );
  const memberIds = new Set(members.map((member) => member.id));
  const names = new Map(members.map((member) => [member.id, member.name]));

  const rows = await session.all<any>(
    `SELECT r.id, r.purchased_at, r.created_at, r.total, r.paid_by, r.split_with, r.created_by,
       COALESCE(v.name, r.vendor_name) AS vendor_name
     FROM receipts r LEFT JOIN vendors v ON v.id = r.vendor_id
     WHERE r.house_id = ? AND r.total IS NOT NULL
     ORDER BY COALESCE(r.purchased_at, r.created_at) DESC`,
    [houseId],
  );

  const paid = new Map<string, number>();
  const owed = new Map<string, number>();
  const settled: {
    id: string;
    purchasedAt: string | null;
    vendorName: string | null;
    total: number | null;
    paidBy: string | null;
    payerName: string | null;
    splitWith: string[];
    participantNames: string[];
  }[] = [];

  for (const row of rows) {
    const total = money(row.total);
    const payer = row.paid_by && memberIds.has(row.paid_by) ? row.paid_by : row.created_by;
    const fallback = [...memberIds];
    const parsed = parseJson<unknown>(row.split_with, []);
    const participants = (Array.isArray(parsed) ? parsed : []).filter(
      (id): id is string => typeof id === "string" && memberIds.has(id),
    );
    const splitWith = participants.length ? participants : fallback;
    if (payer && memberIds.has(payer)) paid.set(payer, (paid.get(payer) ?? 0) + total);
    addEvenShares(owed, total, splitWith);
    if (settled.length < 20) {
      settled.push({
        id: row.id,
        purchasedAt: row.purchased_at ?? dateOf(row.created_at),
        vendorName: row.vendor_name ?? null,
        total,
        paidBy: payer ?? null,
        payerName: payer ? names.get(payer) ?? null : null,
        splitWith,
        participantNames: splitWith.map((id) => names.get(id) ?? "Former member"),
      });
    }
  }

  // Utility bills contribute to the household ledger only when explicitly
  // categorised as shared. Personal bills remain visible in Bills & splitting.
  const bills = await session.all<any>(
    `SELECT amount, paid_by, split_with FROM bills
     WHERE house_id = ? AND category = 'to_split' AND ledger_confirmed = 1 ORDER BY created_at`,
    [houseId],
  );
  for (const bill of bills) {
    const total = money(bill.amount);
    const payer = bill.paid_by && memberIds.has(bill.paid_by) ? bill.paid_by : null;
    const participants = parseJson<unknown>(bill.split_with, []);
    const selected = [...new Set((Array.isArray(participants) ? participants : []).filter(
      (id): id is string => typeof id === "string" && memberIds.has(id),
    ))];
    const splitWith = selected.length ? selected : [...memberIds];
    if (!splitWith.length) continue;
    if (payer) paid.set(payer, (paid.get(payer) ?? 0) + total);
    addEvenShares(owed, total, splitWith);
  }

  // Recorded transfers reduce the outstanding balances without changing the
  // original receipts or bills that created those debts.
  const transferRows = await session.all<{ from_user_id: string; to_user_id: string; amount_cents: number }>(
    "SELECT from_user_id, to_user_id, amount_cents FROM household_settlements WHERE house_id = ? ORDER BY created_at",
    [houseId],
  );
  const transferBalance = new Map<string, number>();
  for (const transfer of transferRows) {
    const from = transfer.from_user_id;
    const to = transfer.to_user_id;
    const amountCents = Number(transfer.amount_cents);
    // A transfer only offsets the live household ledger while both parties
    // are represented. Receipt shares are recalculated when someone leaves;
    // retaining only one side of the old transfer could invert the remaining
    // members' suggested obligations. The row is kept and takes effect again
    // if the same member rejoins alongside their original receipt shares.
    if (memberIds.has(from) && memberIds.has(to)) {
      transferBalance.set(from, (transferBalance.get(from) ?? 0) + amountCents);
      transferBalance.set(to, (transferBalance.get(to) ?? 0) - amountCents);
    }
  }

  const balances: HouseholdBalance[] = members.map((member) => {
    const memberPaid = money(paid.get(member.id) ?? 0);
    const memberShare = money(owed.get(member.id) ?? 0);
    const memberSettled = money((transferBalance.get(member.id) ?? 0) / 100);
    // A debtor's outgoing payment raises their negative balance toward zero;
    // the recipient's balance falls by the same amount.
    return {
      userId: member.id,
      name: member.name,
      role: member.role,
      paid: memberPaid,
      share: memberShare,
      settled: memberSettled,
      balance: money(memberPaid - memberShare + memberSettled),
    };
  });

  return {
    currency,
    members: members.map((member) => ({ userId: member.id, name: member.name, role: member.role })),
    balances,
    settlements: settle(balances),
    receipts: settled,
  };
}

/** Greedy "who pays whom" list; positive balances are owed money. */
function settle(balances: HouseholdBalance[]): HouseholdSettlement[] {
  const creditors = balances.filter((b) => b.balance > 0.009).map((b) => ({ ...b }));
  const debtors = balances.filter((b) => b.balance < -0.009).map((b) => ({ ...b, balance: -b.balance }));
  const out: HouseholdSettlement[] = [];
  let ci = 0;
  let di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const amount = Math.min(creditors[ci].balance, debtors[di].balance);
    if (amount > 0.009) {
      out.push({
        fromUserId: debtors[di].userId,
        fromName: debtors[di].name,
        toUserId: creditors[ci].userId,
        toName: creditors[ci].name,
        amount: money(amount),
      });
    }
    creditors[ci].balance = money(creditors[ci].balance - amount);
    debtors[di].balance = money(debtors[di].balance - amount);
    if (creditors[ci].balance <= 0.009) ci++;
    if (debtors[di].balance <= 0.009) di++;
  }
  return out;
}

/* ------------------------------------------------------------- use it up */

export async function useItUp(houseId: string, days?: number): Promise<{
  days: number;
  items: UseItUpItem[];
  recipes: UseItUpRecipe[];
}> {
  const settings = await readInsightSettings(houseId);
  const horizon = clamp(Math.round(days ?? settings.useItUpDays), 1, 60);
  const today = new Date().toISOString().slice(0, 10);
  const until = new Date(Date.now() + horizon * DAY).toISOString().slice(0, 10);
  const earliest = new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10);

  const lots = await all<any>(
    `SELECT l.*, i.name AS item_name, i.unit AS item_unit, i.category_id, loc.name AS location_name
     FROM stock_lots l
     JOIN items i ON i.id = l.item_id
     LEFT JOIN locations loc ON loc.id = l.location_id AND loc.house_id = ?
     WHERE l.house_id = ? AND l.quantity > 0 AND l.expires_at IS NOT NULL
       AND l.expires_at >= ? AND l.expires_at <= ?
     ORDER BY l.expires_at ASC`,
    [houseId, houseId, earliest, until],
  );

  const grouped = new Map<string, UseItUpItem>();
  for (const lot of lots) {
    const key = lot.item_id;
    const existing = grouped.get(key);
    const daysLeft = Math.round((new Date(`${lot.expires_at}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / DAY);
    if (existing) {
      existing.quantity = round(existing.quantity + Number(lot.quantity), 3);
      existing.lots.push({ id: lot.id, quantity: round(Number(lot.quantity), 3), expiresAt: lot.expires_at, locationName: lot.location_name ?? null });
      existing.expiresAt = existing.expiresAt < lot.expires_at ? existing.expiresAt : lot.expires_at;
      existing.daysLeft = Math.min(existing.daysLeft, daysLeft);
      continue;
    }
    grouped.set(key, {
      itemId: lot.item_id,
      name: lot.item_name,
      unit: lot.item_unit ?? lot.unit ?? null,
      quantity: round(Number(lot.quantity), 3),
      expiresAt: lot.expires_at,
      daysLeft,
      locationName: lot.location_name ?? null,
      lots: [{ id: lot.id, quantity: round(Number(lot.quantity), 3), expiresAt: lot.expires_at, locationName: lot.location_name ?? null }],
    });
  }

  const items = [...grouped.values()].sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name));
  const expiringNames = new Set(items.map((item) => normalizeName(item.name)));
  const expiringIds = new Set(items.map((item) => item.itemId));

  const recipes = await all<any>("SELECT id, title, image, servings FROM recipes WHERE house_id = ? ORDER BY favorite DESC, updated_at DESC", [houseId]);
  const ingredients = await all<any>("SELECT * FROM recipe_ingredients WHERE recipe_id IN (SELECT id FROM recipes WHERE house_id = ?)", [houseId]);
  const byRecipe = new Map<string, any[]>();
  for (const ingredient of ingredients) {
    const list = byRecipe.get(ingredient.recipe_id) ?? [];
    list.push(ingredient);
    byRecipe.set(ingredient.recipe_id, list);
  }

  const suggestions: UseItUpRecipe[] = [];
  for (const recipe of recipes) {
    const list = byRecipe.get(recipe.id) ?? [];
    const matched: string[] = [];
    const missing: string[] = [];
    for (const ingredient of list) {
      const name = normalizeName(String(ingredient.name ?? ""));
      const matches =
        (ingredient.item_id && expiringIds.has(ingredient.item_id)) ||
        [...expiringNames].some((expiring) => expiring === name || expiring.includes(name) || name.includes(expiring));
      if (matches) matched.push(ingredient.name);
      else if (!ingredient.optional) missing.push(ingredient.name);
    }
    if (!matched.length) continue;
    suggestions.push({
      recipeId: recipe.id,
      title: recipe.title,
      image: recipe.image ?? null,
      servings: recipe.servings == null ? null : Number(recipe.servings),
      matched,
      missing,
      score: matched.length / Math.max(1, list.length),
    });
  }

  return {
    days: horizon,
    items,
    recipes: suggestions.sort((a, b) => b.score - a.score || a.missing.length - b.missing.length).slice(0, 12),
  };
}

/* -------------------------------------------------------- shopping prices */

export async function shoppingPriceHints(houseId: string): Promise<ShoppingPriceHint[]> {
  const house = await get<{ currency: string }>("SELECT currency FROM houses WHERE id = ?", [houseId]);
  const currency = house?.currency ?? "EUR";
  const open = await all<any>(
    "SELECT id, item_id, name, unit FROM shopping_list_items WHERE house_id = ? AND checked = 0 ORDER BY created_at LIMIT 300",
    [houseId],
  );
  if (!open.length) return [];

  const lines = await all<any>(
    `SELECT rl.item_id, rl.description, rl.unit AS line_unit, rl.unit_price, rl.line_total, rl.quantity,
       COALESCE(r.purchased_at, substr(r.created_at, 1, 10)) AS purchased_at,
       COALESCE(v.name, r.vendor_name) AS vendor_name
     FROM receipt_lines rl
     JOIN receipts r ON r.id = rl.receipt_id
     LEFT JOIN vendors v ON v.id = r.vendor_id
     WHERE r.house_id = ? AND COALESCE(r.purchased_at, substr(r.created_at, 1, 10)) >= ?
     ORDER BY purchased_at DESC LIMIT 4000`,
    [houseId, isoDaysAgo(180)],
  );

  const hints: ShoppingPriceHint[] = [];
  for (const line of open) {
    const wanted = normalizeName(String(line.name));
    const candidates = lines.filter((candidate) => {
      if (line.item_id && candidate.item_id === line.item_id) return true;
      if (candidate.item_id && line.item_id && candidate.item_id !== line.item_id) return false;
      const name = normalizeName(String(candidate.description ?? ""));
      return name === wanted || (name.length >= 4 && wanted.length >= 4 && (name.includes(wanted) || wanted.includes(name)));
    });
    if (!candidates.length) continue;

    const perVendor = new Map<string, { vendorName: string; price: number; purchasedAt: string; unit: string | null }>();
    for (const candidate of candidates) {
      const quantity = Number(candidate.quantity ?? 0);
      if (quantity <= 0) continue;
      let price = candidate.line_total != null ? Number(candidate.line_total) / quantity : Number(candidate.unit_price ?? NaN);
      if (!Number.isFinite(price)) continue;
      if (line.unit && candidate.line_unit && line.unit !== candidate.line_unit) {
        const factor = convert(1, candidate.line_unit, line.unit);
        if (factor == null || factor <= 0) continue;
        price = price / factor;
      }
      const vendorName = String(candidate.vendor_name ?? "Unknown shop");
      const existing = perVendor.get(vendorName);
      // "Cheapest shop" uses the best unit price seen there, not just the
      // latest one, so a one-off expensive week does not hide a deal.
      if (!existing || price < existing.price) {
        perVendor.set(vendorName, {
          vendorName,
          price: round(price, 3),
          purchasedAt: dateOf(candidate.purchased_at),
          unit: line.unit ?? candidate.line_unit ?? null,
        });
      }
    }
    if (!perVendor.size) continue;
    const vendors = [...perVendor.values()].sort((a, b) => a.price - b.price);
    hints.push({
      lineId: line.id,
      itemId: line.item_id ?? null,
      name: line.name,
      unit: line.unit ?? vendors[0].unit,
      currency,
      cheapest: vendors[0],
      vendors: vendors.slice(0, 4),
    });
  }
  return hints;
}

/* ------------------------------------------------------------ e-receipts */

export interface EReceiptParse {
  draft: ReceiptDraft;
  reconciliation: ReturnType<typeof reconcileReceipt>;
  format: "json" | "text";
}

/**
 * Parse the text of an e-receipt (an email body, a PDF's copied text, or an
 * e-invoice JSON payload) into the same draft shape the scan flow returns.
 * Nothing is written; the client reviews it and posts the normal import.
 */
export function parseEReceipt(text: string, fallbackCurrency: string | null = null): EReceiptParse {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) throw new Error("Paste the text of an e-receipt first");
  const looksJson = (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (looksJson) {
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("That looks like JSON but it could not be read");
    }
    const raw = Array.isArray(parsed) ? { lines: parsed, total: null } : parsed;
    const draft = normaliseReceiptDraft(raw, fallbackCurrency);
    if (!draft.lines.length) throw new Error("No product lines were found in that JSON");
    return { draft, reconciliation: reconcileReceipt({ total: draft.total, savings: draft.savings ?? null, lines: draft.lines }), format: "json" };
  }
  const draft = heuristicReceipt(trimmed, fallbackCurrency);
  if (!draft.lines.length) {
    throw new Error("No product lines were found. Paste one product per line, with its price on the same line.");
  }
  return { draft, reconciliation: reconcileReceipt({ total: draft.total, savings: draft.savings ?? null, lines: draft.lines }), format: "text" };
}

export async function receiptHouseCurrency(houseId: string): Promise<string> {
  const house = await get<{ currency: string }>("SELECT currency FROM houses WHERE id = ?", [houseId]);
  return house?.currency ?? "EUR";
}

/** Used by the monthly maintenance job; kept here so the route stays thin. */
export async function scanPriceAlertsForAllHouses(): Promise<number> {
  let created = 0;
  for (const house of await all<{ id: string }>("SELECT id FROM houses")) {
    try {
      created += await scanPriceAlerts(house.id);
    } catch {
      /* one bad house must not stop the rest */
    }
  }
  return created;
}
