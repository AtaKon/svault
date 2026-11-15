import { Router } from "express";
import { z } from "zod";
import { all, get, run } from "../db.js";
import { memberRole, requireAuth, roleAtLeast } from "../auth.js";
import { ApiError, handler, intParam, parseBody, requireHouse } from "../http.js";
import { serializeLoan } from "../serialize.js";
import { createLoan, houseLoanCounts, returnLoan, syncHouseLoans, todayDate } from "../services/loans.js";
import type { LoanBorrower, LoanList, Role } from "../../shared/types.js";

/** House-scoped loan endpoints: list, create, borrower suggestions. */
export const loanRoutes = Router();
loanRoutes.use(requireAuth);

const LOAN_SELECT = `
  SELECT l.*, i.name AS item_name, i.unit AS item_unit, u.name AS created_by_name
  FROM item_loans l
  JOIN items i ON i.id = l.item_id
  LEFT JOIN users u ON u.id = l.created_by
`;

const createBody = z.object({
  itemId: z.string().trim().min(1).max(60),
  borrowerName: z.string().trim().min(1).max(80),
  borrowerUserId: z.string().trim().min(1).max(60).nullish(),
  quantity: z.number().gt(0).max(1e9).optional(),
  lentAt: z.string().trim().max(10).nullish(),
  dueAt: z.string().trim().max(10).nullish(),
  note: z.string().trim().max(500).nullish(),
});

const updateBody = z.object({
  dueAt: z.string().trim().max(10).nullish(),
  note: z.string().trim().max(500).nullish(),
});

/** Resolve a loan and the caller's role in its house without leaking other houses. */
async function loanAccess(req: any, minRole: Role = "viewer") {
  const loan = await get<any>("SELECT * FROM item_loans WHERE id = ?", [req.params.loanId]);
  if (!loan) throw new ApiError(404, "Loan not found");
  const role = await memberRole(req.user!.id, loan.house_id);
  if (!role) throw new ApiError(404, "Loan not found");
  if (!roleAtLeast(role, minRole)) throw new ApiError(403, `Requires ${minRole} access`);
  return { loan, houseId: loan.house_id as string, role };
}

async function loanDetail(loanId: string) {
  const row = await get<any>(`${LOAN_SELECT} WHERE l.id = ?`, [loanId]);
  return serializeLoan(row, todayDate());
}

loanRoutes.get(
  "/:houseId/loans",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    const status = String(req.query.status ?? "all");
    if (!["open", "overdue", "returned", "all"].includes(status)) {
      throw new ApiError(400, "Invalid loan status filter");
    }
    const itemId = typeof req.query.itemId === "string" ? req.query.itemId.trim() : "";
    const limit = intParam(req.query.limit, 200, 500);
    const today = todayDate();
    const conditions = ["l.house_id = ?"];
    const params: unknown[] = [houseId];
    if (itemId) {
      conditions.push("l.item_id = ?");
      params.push(itemId);
    }
    if (status === "open") conditions.push("l.returned_at IS NULL");
    if (status === "overdue") {
      conditions.push("l.returned_at IS NULL AND l.due_at IS NOT NULL AND l.due_at < ?");
      params.push(today);
    }
    if (status === "returned") conditions.push("l.returned_at IS NOT NULL");
    const rows = await all<any>(
      `${LOAN_SELECT} WHERE ${conditions.join(" AND ")}
       ORDER BY CASE WHEN l.returned_at IS NOT NULL THEN 2 WHEN l.due_at IS NULL THEN 1 ELSE 0 END,
         l.due_at ASC, l.created_at DESC LIMIT ?`,
      [...params, limit],
    );
    const counts = await houseLoanCounts(houseId);
    const result: LoanList = { loans: rows.map((row) => serializeLoan(row, today)), counts };
    res.json(result);
  }),
);

loanRoutes.get(
  "/:houseId/loans/borrowers",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    // People who borrowed before come first, then every household member.
    const past = await all<{ borrower_name: string; borrower_user_id: string | null; n: number }>(
      `SELECT MIN(borrower_name) AS borrower_name, MAX(borrower_user_id) AS borrower_user_id, COUNT(*) AS n
       FROM item_loans WHERE house_id = ? GROUP BY lower(borrower_name)
       ORDER BY n DESC, lower(MIN(borrower_name)) LIMIT 50`,
      [houseId],
    );
    const members = await all<{ id: string; name: string }>(
      `SELECT u.id, u.name FROM house_members m JOIN users u ON u.id = m.user_id
       WHERE m.house_id = ? ORDER BY lower(u.name)`,
      [houseId],
    );
    const seen = new Set<string>();
    const borrowers: LoanBorrower[] = [];
    for (const member of members) {
      seen.add(member.id);
      const previous = past.find((entry) => entry.borrower_user_id === member.id);
      borrowers.push({
        name: member.name,
        userId: member.id,
        loanCount: Number(previous?.n ?? 0),
        member: true,
      });
    }
    for (const entry of past) {
      if (entry.borrower_user_id && seen.has(entry.borrower_user_id)) continue;
      const key = String(entry.borrower_name).toLowerCase();
      if (borrowers.some((borrower) => borrower.name.toLowerCase() === key && !borrower.userId)) continue;
      borrowers.push({
        name: entry.borrower_name,
        userId: entry.borrower_user_id ?? null,
        loanCount: Number(entry.n ?? 0),
        member: false,
      });
    }
    res.json({ borrowers });
  }),
);

loanRoutes.post(
  "/:houseId/loans",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(createBody, req.body ?? {});
    const id = await createLoan({
      houseId,
      itemId: body.itemId,
      userId: req.user!.id,
      borrowerName: body.borrowerName,
      borrowerUserId: body.borrowerUserId ?? null,
      quantity: body.quantity ?? 1,
      lentAt: body.lentAt ?? null,
      dueAt: body.dueAt ?? null,
      note: body.note ?? null,
    });
    // A new loan can turn a loan overdue immediately, and returning one clears
    // its reminder; re-evaluate this house's loan reminders on every change.
    await syncHouseLoans(houseId);
    res.status(201).json({ loan: await loanDetail(id) });
  }),
);

/** Loan-scoped endpoints: edit, return (fully or in part), delete a mistake. */
export const singleLoanRoutes = Router();
singleLoanRoutes.use(requireAuth);

singleLoanRoutes.patch(
  "/:loanId",
  handler(async (req, res) => {
    const { loan, houseId } = await loanAccess(req, "member");
    const body = parseBody(updateBody, req.body ?? {});
    const dueAt = body.dueAt === undefined ? loan.due_at : body.dueAt;
    const note = body.note === undefined ? loan.note : body.note;
    if (dueAt != null && !/^\d{4}-\d{2}-\d{2}$/.test(dueAt)) throw new ApiError(400, "Invalid due date");
    await run("UPDATE item_loans SET due_at = ?, note = ? WHERE id = ?", [dueAt ?? null, note ?? null, loan.id]);
    await syncHouseLoans(houseId);
    res.json({ loan: await loanDetail(loan.id) });
  }),
);

singleLoanRoutes.post(
  "/:loanId/return",
  handler(async (req, res) => {
    const { loan, houseId } = await loanAccess(req, "member");
    const body = parseBody(
      z.object({ quantity: z.number().gt(0).max(1e9).nullish() }),
      req.body ?? {},
    );
    await returnLoan({ loanId: loan.id, houseId, quantity: body.quantity ?? null });
    await syncHouseLoans(houseId);
    res.json({ loan: await loanDetail(loan.id) });
  }),
);

singleLoanRoutes.delete(
  "/:loanId",
  handler(async (req, res) => {
    const { loan, houseId, role } = await loanAccess(req, "member");
    // A wrong loan is deleted by whoever recorded it, or by a house admin.
    if (loan.created_by !== req.user!.id && !roleAtLeast(role, "admin")) {
      throw new ApiError(403, "Only the person who recorded the loan or a house admin can delete it");
    }
    await run("DELETE FROM item_loans WHERE id = ?", [loan.id]);
    await syncHouseLoans(houseId);
    res.json({ ok: true });
  }),
);
