import { all, get, lockHouseholdLedger, newId, now, run, tx } from "../db.js";
import { ApiError } from "../http.js";
import { round } from "../units.js";
import { createNotification } from "./notifications.js";

/**
 * Lending tracker. A loan is a record of who has borrowed a non-consumable item
 * (tools, books, gear). It never writes stock: the item stays on the shelf, and
 * the quantity available to use is the on-hand quantity minus the open loans.
 * `returned_quantity` closes a loan in parts, so a hammer can come back one
 * piece at a time. Low-stock and run-out forecasts deliberately keep using the
 * on-hand quantity: lending is not consumption and does not change what the
 * house owns.
 */

/** Calendar dates are compared as UTC day strings, like expiry reminders. */
export function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isDateOnly(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

/** Quantity of an item that is out on loan and not yet returned. */
export async function itemOnLoan(itemId: string): Promise<number> {
  const row = await get<{ q: number }>(
    `SELECT COALESCE(SUM(quantity - returned_quantity), 0) AS q
     FROM item_loans WHERE item_id = ? AND returned_at IS NULL`,
    [itemId],
  );
  return Math.max(0, round(Number(row?.q ?? 0)));
}

/**
 * On-hand quantity that is not promised to a borrower. The stock engine uses
 * this as the consume guard so FIFO can never silently eat loaned units.
 */
export async function itemAvailableToUse(itemId: string): Promise<number> {
  const row = await get<{ q: number }>(
    "SELECT COALESCE(SUM(quantity), 0) AS q FROM stock_lots WHERE item_id = ?",
    [itemId],
  );
  const onHand = round(Number(row?.q ?? 0));
  return round(onHand - (await itemOnLoan(itemId)));
}

export async function houseLoanCounts(houseId: string): Promise<{
  openCount: number;
  overdueCount: number;
  returnedCount: number;
  unitsOnLoan: number;
}> {
  const today = todayDate();
  const open = await get<{ n: number; q: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(quantity - returned_quantity), 0) AS q
     FROM item_loans WHERE house_id = ? AND returned_at IS NULL`,
    [houseId],
  );
  const overdue = await get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM item_loans
     WHERE house_id = ? AND returned_at IS NULL AND due_at IS NOT NULL AND due_at < ?`,
    [houseId, today],
  );
  const returned = await get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM item_loans WHERE house_id = ? AND returned_at IS NOT NULL",
    [houseId],
  );
  return {
    openCount: Number(open?.n ?? 0),
    overdueCount: Number(overdue?.n ?? 0),
    returnedCount: Number(returned?.n ?? 0),
    unitsOnLoan: Math.max(0, round(Number(open?.q ?? 0))),
  };
}

export interface CreateLoanInput {
  houseId: string;
  itemId: string;
  userId: string;
  borrowerName: string;
  borrowerUserId?: string | null;
  quantity: number;
  lentAt?: string | null;
  dueAt?: string | null;
  note?: string | null;
}

/**
 * Record a loan. The quantity may not exceed what is free, so the same hammer
 * cannot be promised to two people. The check-and-insert runs under the house
 * ledger lock so two concurrent requests cannot both pass the guard.
 */
export async function createLoan(input: CreateLoanInput): Promise<string> {
  const borrowerName = input.borrowerName.trim();
  if (!borrowerName) throw new ApiError(400, "Borrower name is required");
  if (borrowerName.length > 80) throw new ApiError(400, "Borrower name is too long");
  const quantity = round(Number(input.quantity));
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new ApiError(400, "Quantity must be greater than zero");
  }
  if (input.lentAt != null && !isDateOnly(input.lentAt)) throw new ApiError(400, "Invalid loan date");
  if (input.dueAt != null && !isDateOnly(input.dueAt)) throw new ApiError(400, "Invalid due date");

  return await tx(async (session) => {
    if (!(await lockHouseholdLedger(session, input.houseId))) throw new ApiError(404, "House not found");
    const item = await get<any>("SELECT * FROM items WHERE id = ? AND house_id = ?", [input.itemId, input.houseId]);
    if (!item) throw new ApiError(404, "Item not found");
    if (input.borrowerUserId) {
      const member = await get(
        "SELECT user_id FROM house_members WHERE house_id = ? AND user_id = ?",
        [input.houseId, input.borrowerUserId],
      );
      if (!member) throw new ApiError(400, "Borrower is not a member of this house");
    }
    const available = await itemAvailableToUse(item.id);
    if (quantity > available) {
      throw new ApiError(400, `Only ${available} ${item.unit} of ${item.name} available to lend`);
    }
    const id = newId("loan");
    await run(
      `INSERT INTO item_loans
        (id, house_id, item_id, borrower_name, borrower_user_id, quantity, returned_quantity,
         lent_at, due_at, note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      [
        id,
        item.house_id,
        item.id,
        borrowerName,
        input.borrowerUserId ?? null,
        quantity,
        input.lentAt || todayDate(),
        input.dueAt ?? null,
        input.note ?? null,
        input.userId,
        now(),
      ],
    );
    await run("UPDATE items SET updated_at = ? WHERE id = ?", [now(), item.id]);
    return id;
  });
}

/** Close all or part of a loan. Returns the remaining quantity after the call. */
export async function returnLoan(opts: {
  loanId: string;
  houseId: string;
  quantity?: number | null;
}): Promise<number> {
  return await tx(async (session) => {
    if (!(await lockHouseholdLedger(session, opts.houseId))) throw new ApiError(404, "House not found");
    const loan = await get<any>(
      "SELECT * FROM item_loans WHERE id = ? AND house_id = ?",
      [opts.loanId, opts.houseId],
    );
    if (!loan) throw new ApiError(404, "Loan not found");
    const total = round(Number(loan.quantity));
    const returned = round(Number(loan.returned_quantity ?? 0));
    const remaining = round(total - returned);
    if (loan.returned_at || remaining <= 0) throw new ApiError(400, "This loan is already returned");
    const amount = opts.quantity == null ? remaining : round(Number(opts.quantity));
    if (!Number.isFinite(amount) || amount <= 0) throw new ApiError(400, "Quantity must be greater than zero");
    if (amount > remaining) {
      throw new ApiError(400, `Only ${remaining} is still on loan`);
    }
    const nowReturned = round(returned + amount);
    const completed = nowReturned >= total;
    await run(
      "UPDATE item_loans SET returned_quantity = ?, returned_at = ? WHERE id = ?",
      completed ? [total, now(), loan.id] : [nowReturned, null, loan.id],
    );
    await run("UPDATE items SET updated_at = ? WHERE id = ?", [now(), loan.item_id]);
    return completed ? 0 : round(total - nowReturned);
  });
}

/**
 * Overdue loans become one reminder per loan per day. The date in the dedupe
 * key means the reminder is not repeated on the timer scan, while a loan that
 * is still out tomorrow gets a fresh one; yesterday's reminder is resolved so
 * the bell never shows the same loan twice. Overdue reminders ride the
 * `expiring` channel preference, which already covers date-based reminders.
 */
export async function syncHouseLoans(houseId: string): Promise<void> {
  const today = todayDate();
  const overdue = await all<any>(
    `SELECT l.*, i.name AS item_name, i.unit AS item_unit FROM item_loans l
     JOIN items i ON i.id = l.item_id
     WHERE l.house_id = ? AND l.returned_at IS NULL AND l.due_at IS NOT NULL
       AND l.due_at < ? AND i.archived = 0`,
    [houseId, today],
  );
  const seen = new Set<string>();
  for (const loan of overdue) {
    const key = `loan:${loan.id}:${today}`;
    seen.add(key);
    const remaining = round(Number(loan.quantity) - Number(loan.returned_quantity ?? 0));
    await createNotification({
      houseId,
      type: "loan_overdue",
      title: `${loan.item_name} is overdue`,
      body: `${loan.borrower_name} still has ${remaining} ${loan.item_unit} (due ${loan.due_at}). Tap to open the loan.`,
      data: {
        itemId: loan.item_id,
        itemName: loan.item_name,
        loanId: loan.id,
        borrowerName: loan.borrower_name,
        dueAt: loan.due_at,
      },
      dedupeKey: key,
    });
  }
  const active = await all<{ id: string; dedupe_key: string }>(
    `SELECT id, dedupe_key FROM notifications
     WHERE house_id = ? AND type = 'loan_overdue' AND user_id IS NULL AND resolved_at IS NULL`,
    [houseId],
  );
  for (const reminder of active) {
    if (seen.has(reminder.dedupe_key)) continue;
    await run("UPDATE notifications SET resolved_at = ? WHERE id = ?", [now(), reminder.id]);
  }
}
