import { Router, type Request, type RequestHandler } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { all, get, newId, now, parseJson, run } from "../db.js";
import { memberRole, roleAtLeast, requireAuth } from "../auth.js";
import { ApiError, handler, parseBody, requireHouse } from "../http.js";
import { MAX_UPLOAD_BYTES, UPLOAD_DIR } from "../config.js";
import { uploadPath, discardUploads } from "../upload.js";
import { BILL_TYPE_VALUES } from "../../shared/bill-types.js";
import type { UtilityBill } from "../../shared/types.js";

export const billRoutes = Router();
export const singleBillRoutes = Router();
billRoutes.use(requireAuth);
singleBillRoutes.use(requireAuth);

interface BillRow {
  id: string;
  house_id: string;
  name: string;
  bill_type: UtilityBill["billType"];
  category: UtilityBill["category"];
  amount: number;
  currency: string;
  due_date: string | null;
  paid_by: string | null;
  split_with: string;
  document: string | null;
  notes: string | null;
  created_at: string;
}

const billDir = path.join(UPLOAD_DIR, "bills");
fs.mkdirSync(billDir, { recursive: true });
const pdfUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, billDir),
    filename: (_req, _file, cb) => cb(null, `${Date.now()}-${randomBytes(8).toString("hex")}.pdf`),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => file.mimetype === "application/pdf" || path.extname(file.originalname).toLowerCase() === ".pdf"
    ? cb(null, true)
    : cb(new ApiError(400, "Upload a PDF bill")),
});
const verifyPdf = (req: any, _res: any, next: (error?: unknown) => void) => {
  if (!req.file) return next();
  try {
    const fd = fs.openSync(req.file.path, "r");
    const prefix = Buffer.alloc(1024);
    let bytesRead: number;
    try { bytesRead = fs.readSync(fd, prefix, 0, prefix.length, 0); } finally { fs.closeSync(fd); }
    if (!prefix.subarray(0, bytesRead).subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      throw new ApiError(400, "That file is not a valid PDF");
    }
  } catch (error) {
    discardUploads(req);
    return next(error instanceof ApiError ? error : new ApiError(400, "That file is not a valid PDF"));
  }
  next();
};

const input = z.object({
  name: z.string().trim().min(1).max(120).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Remove control characters from the bill name"),
  billType: z.enum(BILL_TYPE_VALUES).default("other"),
  category: z.enum(["to_split", "personal"]).default("personal"),
  amount: z.coerce.number().finite().positive().max(1_000_000_000)
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7, "Enter an amount with up to two decimal places")
    .transform((value) => Math.round(value * 100) / 100),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).optional(),
  dueDate: z.preprocess((value) => value === "" ? null : value, z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).refine((date) => {
    const parsed = new Date(`${date}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  }, "Enter a valid due date").nullable().optional()),
  paidBy: z.preprocess((value) => value === "" ? null : value, z.string().max(60).nullable().optional()),
  splitWith: z.union([z.string(), z.array(z.string())]).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});
const patchInput = input.partial().omit({ currency: true }).strict();

function serialize(row: BillRow): UtilityBill {
  return {
    id: row.id,
    name: row.name,
    billType: row.bill_type ?? "other",
    category: row.category,
    amount: Number(row.amount),
    currency: row.currency,
    dueDate: row.due_date ?? null,
    paidBy: row.paid_by ?? null,
    splitWith: parseJson<string[]>(row.split_with, []),
    document: row.document ? `/api/houses/${row.house_id}/bills/${row.id}/document` : null,
    notes: row.notes ?? null,
    createdAt: row.created_at,
  };
}
function splitList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
async function billRow(id: string, houseId?: string) {
  return houseId
    ? get<BillRow>("SELECT * FROM bills WHERE id = ? AND house_id = ?", [id, houseId])
    : get<BillRow>("SELECT * FROM bills WHERE id = ?", [id]);
}
async function requireBillRow(id: string, houseId: string): Promise<BillRow> {
  const row = await billRow(id, houseId);
  if (!row) throw new ApiError(404, "Bill not found");
  return row;
}
const requireHouseBillMember: RequestHandler = (req, _res, next) => {
  // This guard runs before Multer, so unauthorized uploads never touch disk.
  void requireHouse(req, "member").then(() => next(), next);
};
const requireBillDocumentMember: RequestHandler = (req, _res, next) => {
  // Check both house membership and bill ownership before accepting the file.
  void (async () => {
    const { houseId } = await requireHouse(req, "member");
    if (!await billRow(String(req.params.billId), houseId)) throw new ApiError(404, "Bill not found");
  })().then(() => next(), next);
};
async function billAccess(req: Request, minRole: "viewer" | "member" = "viewer") {
  const bill = await billRow(String(req.params.billId));
  if (!bill) throw new ApiError(404, "Bill not found");
  const role = await memberRole(req.user!.id, bill.house_id);
  if (!role) throw new ApiError(404, "Bill not found");
  if (!roleAtLeast(role, minRole)) throw new ApiError(403, `Requires ${minRole} access`);
  return { bill, houseId: bill.house_id as string };
}
async function deleteDocument(filename?: string | null) {
  if (filename) await fs.promises.rm(uploadPath("bills", filename), { force: true }).catch(() => undefined);
}
async function validatePeople(houseId: string, paidBy: string | null | undefined, splitWith: string[]) {
  const members = await all<{ user_id: string }>("SELECT user_id FROM house_members WHERE house_id = ?", [houseId]);
  const ids = new Set(members.map((member) => member.user_id));
  if (paidBy && !ids.has(paidBy)) throw new ApiError(400, "That person is not in this house");
  if (splitWith.some((id) => !ids.has(id))) throw new ApiError(400, "Everyone sharing the bill must be in this house");
  return [...new Set(splitWith)];
}

billRoutes.get("/:houseId/bills", handler(async (req, res) => {
  const { houseId } = await requireHouse(req);
  const rows = await all<BillRow>("SELECT * FROM bills WHERE house_id = ? ORDER BY due_date IS NULL, due_date DESC, created_at DESC", [houseId]);
  res.json(rows.map(serialize));
}));

billRoutes.post("/:houseId/bills", requireHouseBillMember, pdfUpload.single("document"), verifyPdf, handler(async (req, res) => {
  const filename = req.file?.filename ?? null;
  let created = false;
  try {
    const houseId = String(req.params.houseId);
    const body = parseBody(input, req.body);
    const house = await get<any>("SELECT currency FROM houses WHERE id = ?", [houseId]);
    const currency = String(house?.currency ?? "EUR").toUpperCase();
    if (body.currency && body.currency.toUpperCase() !== currency) {
      throw new ApiError(400, "Bills must use the house currency");
    }
    const splitWith = body.category === "to_split" ? splitList(body.splitWith) : [];
    const members = await all<{ user_id: string }>("SELECT user_id FROM house_members WHERE house_id = ?", [houseId]);
    const paidBy = body.paidBy ?? req.user!.id;
    const people = await validatePeople(houseId, paidBy, splitWith.length ? splitWith : (body.category === "to_split" ? members.map((m) => m.user_id) : []));
    const id = newId("bil");
    await run(`INSERT INTO bills (id, house_id, name, bill_type, category, amount, currency, due_date, paid_by, split_with, document, notes, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id, houseId, body.name, body.billType, body.category, body.amount, currency,
      body.dueDate || null, paidBy, JSON.stringify(people), filename, body.notes || null, req.user!.id, now(),
    ]);
    created = true;
    res.status(201).json(serialize(await requireBillRow(id, houseId)));
  } catch (error) {
    if (!created) discardUploads(req);
    throw error;
  }
}));

singleBillRoutes.patch("/:billId", handler(async (req, res) => {
  const { houseId, bill: current } = await billAccess(req, "member");
  const body = parseBody(patchInput, req.body);
  const category = body.category ?? current.category;
  let splitWith = category === "to_split"
    ? (body.splitWith === undefined ? parseJson<string[]>(current.split_with, []) : splitList(body.splitWith))
    : [];
  const memberIds = new Set((await all<{ user_id: string }>("SELECT user_id FROM house_members WHERE house_id = ?", [houseId])).map((member) => member.user_id));
  if (body.splitWith === undefined) splitWith = splitWith.filter((id) => memberIds.has(id));
  if (category === "to_split" && splitWith.length === 0) {
    splitWith = [...memberIds];
  }
  let paidBy = body.paidBy === undefined ? current.paid_by : body.paidBy;
  if (body.paidBy === undefined && paidBy && !memberIds.has(paidBy)) paidBy = null;
  const people = await validatePeople(houseId, paidBy, splitWith);
  await run(`UPDATE bills SET name = ?, bill_type = ?, category = ?, amount = ?, due_date = ?, paid_by = ?, split_with = ?, notes = ? WHERE id = ?`, [
    body.name ?? current.name, body.billType ?? current.bill_type ?? "other", category, body.amount ?? current.amount,
    body.dueDate === undefined ? current.due_date : body.dueDate || null, paidBy ?? null, JSON.stringify(people),
    body.notes === undefined ? current.notes : body.notes || null, current.id,
  ]);
  res.json(serialize(await requireBillRow(current.id, houseId)));
}));

billRoutes.post("/:houseId/bills/:billId/document", requireBillDocumentMember, pdfUpload.single("document"), verifyPdf, handler(async (req, res) => {
  const houseId = String(req.params.houseId);
  const current = await billRow(String(req.params.billId), houseId);
  if (!current) { discardUploads(req); throw new ApiError(404, "Bill not found"); }
  if (!req.file) throw new ApiError(400, "Choose a PDF file");
  let updated: BillRow | undefined;
  try {
    await run("UPDATE bills SET document = ? WHERE id = ?", [req.file.filename, current.id]);
    updated = await billRow(current.id, houseId);
    if (!updated || updated.document !== req.file.filename) throw new ApiError(404, "Bill not found");
  } catch (error) {
    discardUploads(req);
    throw error;
  }
  await deleteDocument(current.document);
  res.json(serialize(updated));
}));

billRoutes.get("/:houseId/bills/:billId/document", handler(async (req, res) => {
  const { houseId } = await requireHouse(req);
  const bill = await billRow(String(req.params.billId), houseId);
  if (!bill?.document) throw new ApiError(404, "Bill PDF not found");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${bill.name}.pdf`)}`);
  res.sendFile(uploadPath("bills", bill.document));
}));

singleBillRoutes.delete("/:billId", handler(async (req, res) => {
  const { bill } = await billAccess(req, "member");
  await run("DELETE FROM bills WHERE id = ?", [bill.id]);
  await deleteDocument(bill.document);
  res.json({ ok: true });
}));
