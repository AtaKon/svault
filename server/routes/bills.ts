import { Router, type Request, type RequestHandler } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { all, get, lockHouseholdLedger, newId, now, parseJson, run, tx } from "../db.js";
import { memberRole, roleAtLeast, requireAuth } from "../auth.js";
import { ApiError, handler, parseBody, requireHouse } from "../http.js";
import { MAX_UPLOAD_BYTES, UPLOAD_DIR } from "../config.js";
import { uploadPath, discardUploads, sniffImage } from "../upload.js";
import { BILL_TYPE_VALUES } from "../../shared/bill-types.js";
import { ELECTRICITY_CONTRACT_COLORS } from "../../shared/types.js";
import type { BillBreakdownLine, UtilityBill } from "../../shared/types.js";

export const billRoutes = Router();
export const singleBillRoutes = Router();
billRoutes.use(requireAuth);
singleBillRoutes.use(requireAuth);

interface BillRow {
  id: string;
  house_id: string;
  name: string;
  bill_type: UtilityBill["billType"];
  contract_color: UtilityBill["contractColor"];
  consumption_kwh: number | null;
  consumption_m3: number | null;
  municipal_charges: number | null;
  state_charges: number | null;
  category: UtilityBill["category"];
  ledger_confirmed: number | boolean;
  amount: number;
  currency: string;
  due_date: string | null;
  paid_by: string | null;
  split_with: string;
  document: string | null;
  notes: string | null;
  subtotal: number | null;
  tax_total: number | null;
  breakdown: string;
  ocr_text: string | null;
  source: string;
  created_at: string;
}

const billDir = path.join(UPLOAD_DIR, "bills");
fs.mkdirSync(billDir, { recursive: true });

const BILL_DOCUMENT_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** Detect a supported bill document from its leading bytes. */
function documentKind(bytes: Buffer): "pdf" | "jpeg" | "png" | "webp" | null {
  // Align with the client's re-read sniffer: short/truncated headers are not
  // treated as valid documents.
  if (bytes.length < 12) return null;
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  const image = sniffImage(bytes);
  if (image === "image/jpeg") return "jpeg";
  if (image === "image/png") return "png";
  if (image === "image/webp") return "webp";
  return null;
}

const billUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, billDir),
    // The real extension is chosen from the sniffed content after the upload,
    // so a misleading client filename can never decide how the file is served.
    filename: (_req, _file, cb) => cb(null, `${Date.now()}-${randomBytes(8).toString("hex")}.upload`),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const accepted = file.mimetype === "application/pdf" ||
      file.mimetype === "image/jpeg" ||
      file.mimetype === "image/png" ||
      file.mimetype === "image/webp" ||
      [".pdf", ".jpg", ".jpeg", ".png", ".webp"].includes(extension);
    if (!accepted) return cb(new ApiError(400, "Upload a PDF or image bill"));
    cb(null, true);
  },
});
const verifyBillDocument: RequestHandler = (req, _res, next) => {
  if (!req.file) return next();
  try {
    const fd = fs.openSync(req.file.path, "r");
    // Every supported format carries its signature at offset 0.
    const prefix = Buffer.alloc(1024);
    let bytesRead: number;
    try { bytesRead = fs.readSync(fd, prefix, 0, prefix.length, 0); } finally { fs.closeSync(fd); }
    const kind = documentKind(prefix.subarray(0, bytesRead));
    if (!kind) throw new ApiError(400, "That file is not a valid PDF or image");

    // Store the extension that matches the real content, not the uploaded name.
    const canonical = `.${{ pdf: "pdf", jpeg: "jpg", png: "png", webp: "webp" }[kind]}`;
    const nextName = `${req.file.filename.replace(/\.[^.]+$/, "")}${canonical}`;
    const nextPath = path.join(billDir, nextName);
    fs.renameSync(req.file.path, nextPath);
    req.file.filename = nextName;
    req.file.path = nextPath;
    req.file.destination = billDir;
    req.file.originalname = nextName;
    req.file.mimetype = BILL_DOCUMENT_MIME[canonical] ?? req.file.mimetype;
  } catch (error) {
    discardUploads(req);
    return next(error instanceof ApiError ? error : new ApiError(400, "That file is not a valid PDF or image"));
  }
  next();
};

// Scaled comparison keeps values near 1e9 valid while still rejecting 1.005.
const twoDecimals = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
const optionalMoney = z.preprocess(
  // Keep undefined (field omitted) distinct from an explicit clear (null/"").
  // Booleans and objects are rejected instead of being coerced to 0/1.
  (value) => {
    if (value === undefined) return undefined;
    if (value == null) return null;
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return null;
      // Reject scientific/hex notation and more than two decimals; accept a
      // comma decimal because multipart clients may use one.
      if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(trimmed)) return Number.NaN;
      return trimmed.replace(",", ".");
    }
    return Number.NaN;
  },
  z.coerce.number().finite().min(0).max(1_000_000_000)
    .refine(twoDecimals, "Enter an amount with up to two decimal places")
    .transform((value) => Math.round(value * 100) / 100)
    .nullable()
    .optional(),
);

const optionalConsumption = z.preprocess((value) => {
  if (value === undefined) return undefined;
  if (value == null || value === "") return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const text = value.trim();
    // Commas are decimal separators; dots are grouping separators only when
    // followed by a comma. Plain 1.234 or 1,234 means 1.234; 1.234,5 means 1234.5.
    if (/^\d+(?:[.,]\d{1,3})?$/.test(text)) return Number(text.replace(",", "."));
    if (/^\d{1,3}(?:\.\d{3})+,\d{1,3}$/.test(text)) return Number(text.replace(/\./g, "").replace(",", "."));
  }
  return Number.NaN;
}, z.number().finite().positive().max(1_000_000_000).refine(value => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-5).nullable().optional());

const breakdownLineInput = z.object({
  description: z.string().trim().min(1).max(160),
  kind: z.enum(["charge", "tax", "discount", "credit"]).default("charge"),
  quantity: z.number().finite().nonnegative().max(1_000_000_000).nullable().optional(),
  unit: z.string().trim().max(20).nullable().optional(),
  unitPrice: z.number().finite().nonnegative().max(1_000_000_000).nullable().optional(),
  amount: z.number().finite().nonnegative().max(1_000_000_000).nullable().optional(),
  taxRate: z.number().finite().min(0).max(100).nullable().optional(),
}).strict().superRefine((line, ctx) => {
  if (line.amount == null) ctx.addIssue({ code: "custom", message: "Breakdown lines need an amount" });
});
const breakdownInput = z.preprocess(
  // Multipart forms send the breakdown as JSON; validate the decoded array so
  // malformed entries are rejected instead of silently dropped.
  (value) => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return value; }
  },
  z.array(breakdownLineInput).max(100).nullable(),
).optional();

/** Normalise a breakdown that Zod has already validated. */
function sanitizeBreakdown(value: z.infer<typeof breakdownLineInput>[] | null | undefined): BillBreakdownLine[] {
  const parsed = value ?? [];
  const rounded = (number: number | null | undefined, scale: number): number | null => {
    if (number == null) return null;
    if (!Number.isFinite(number) || number < 0) return null;
    const factor = 10 ** scale;
    return Math.round(number * factor) / factor;
  };
  return parsed.slice(0, 100).map((line) => ({
    description: line.description.trim().slice(0, 160),
    kind: line.kind,
    quantity: rounded(line.quantity, 3),
    unit: line.unit?.trim() ? line.unit.trim().slice(0, 20) : null,
    unitPrice: rounded(line.unitPrice, 4),
    amount: rounded(line.amount, 2),
    taxRate: rounded(line.taxRate, 2),
  }));
}

/** Tolerant read-side normaliser for legacy or hand-edited stored JSON. */
function normalizeStoredBreakdown(value: unknown): BillBreakdownLine[] {
  const parsed = typeof value === "string" ? parseJson<unknown>(value, []) : value;
  if (!Array.isArray(parsed)) return [];
  const kinds = new Set<BillBreakdownLine["kind"]>(["charge", "tax", "discount", "credit"]);
  const number = (input: unknown, scale: number): number | null => {
    const parsedNumber = typeof input === "number"
      ? input
      : typeof input === "string" && /^\d+(?:\.\d+)?$/.test(input) ? Number(input) : Number.NaN;
    if (input == null || !Number.isFinite(parsedNumber) || parsedNumber < 0) return null;
    const factor = 10 ** scale;
    return Math.round(parsedNumber * factor) / factor;
  };
  return parsed
    .filter((line): line is Record<string, unknown> => Boolean(line) && typeof line === "object")
    .slice(0, 100)
    .map((line) => ({
      description: String(line.description ?? "").trim().slice(0, 160),
      kind: kinds.has(line.kind as BillBreakdownLine["kind"]) ? line.kind as BillBreakdownLine["kind"] : "charge",
      quantity: number(line.quantity, 3),
      unit: typeof line.unit === "string" && line.unit.trim() ? line.unit.trim().slice(0, 20) : null,
      unitPrice: number(line.unitPrice, 4),
      amount: number(line.amount, 2),
      taxRate: number(line.taxRate, 2),
    }))
    .filter((line) => line.description.length > 0 && line.amount != null);
}

const input = z.object({
  name: z.string().trim().min(1).max(120).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Remove control characters from the bill name"),
  billType: z.enum(BILL_TYPE_VALUES).default("other"),
  contractColor: z.preprocess((value) => value === "" ? null : value, z.enum(ELECTRICITY_CONTRACT_COLORS).nullable().optional()),
  consumptionKwh: optionalConsumption,
  consumptionM3: optionalConsumption,
  municipalCharges: optionalMoney,
  stateCharges: optionalMoney,
  category: z.enum(["to_split", "personal"]).default("personal"),
  amount: z.coerce.number().finite().positive().max(1_000_000_000)
    .refine(twoDecimals, "Enter an amount with up to two decimal places")
    .transform((value) => Math.round(value * 100) / 100),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).optional(),
  dueDate: z.preprocess((value) => value === "" ? null : value, z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).refine((date) => {
    const parsed = new Date(`${date}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  }, "Enter a valid due date").nullable().optional()),
  paidBy: z.preprocess((value) => value === "" ? null : value, z.string().max(60).nullable().optional()),
  splitWith: z.union([z.string(), z.array(z.string())]).optional(),
  ledgerConfirmed: z.union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")]).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  subtotal: optionalMoney,
  taxTotal: optionalMoney,
  breakdown: breakdownInput,
  ocrText: z.string().max(50_000).nullable().optional(),
});
const patchInput = z.object({
  name: input.shape.name.optional(),
  billType: z.enum(BILL_TYPE_VALUES).optional(),
  contractColor: input.shape.contractColor,
  consumptionKwh: optionalConsumption,
  consumptionM3: optionalConsumption,
  municipalCharges: optionalMoney,
  stateCharges: optionalMoney,
  category: z.enum(["to_split", "personal"]).optional(),
  amount: input.shape.amount.optional(),
  dueDate: input.shape.dueDate.optional(),
  paidBy: input.shape.paidBy.optional(),
  splitWith: input.shape.splitWith.optional(),
  ledgerConfirmed: input.shape.ledgerConfirmed.optional(),
  notes: input.shape.notes.optional(),
  subtotal: optionalMoney,
  taxTotal: optionalMoney,
  breakdown: breakdownInput,
  ocrText: z.string().max(50_000).nullable().optional(),
}).strict();

/** Provenance is derived from the stored OCR data, never trusted from clients. */
function derivedSource(breakdown: BillBreakdownLine[], ocrText: string | null | undefined): "manual" | "scan" {
  return breakdown.length > 0 || Boolean(ocrText?.trim()) ? "scan" : "manual";
}

function serialize(row: BillRow): UtilityBill {
  const parsedBreakdown = parseJson<unknown>(row.breakdown, []);
  return {
    id: row.id,
    name: row.name,
    billType: (BILL_TYPE_VALUES as readonly string[]).includes(row.bill_type) ? row.bill_type : "other",
    contractColor: row.bill_type === "electricity" && (ELECTRICITY_CONTRACT_COLORS as readonly string[]).includes(row.contract_color ?? "") ? row.contract_color : null,
    consumptionKwh: row.consumption_kwh == null ? null : Number(row.consumption_kwh),
    consumptionM3: row.consumption_m3 == null ? null : Number(row.consumption_m3),
    municipalCharges: row.municipal_charges == null ? null : Number(row.municipal_charges),
    stateCharges: row.state_charges == null ? null : Number(row.state_charges),
    category: row.category,
    amount: Number(row.amount),
    currency: row.currency,
    dueDate: row.due_date ?? null,
    paidBy: row.paid_by ?? null,
    splitWith: parseJson<string[]>(row.split_with, []),
    document: row.document ? `/api/houses/${row.house_id}/bills/${row.id}/document` : null,
    notes: row.notes ?? null,
    subtotal: row.subtotal == null ? null : Number(row.subtotal),
    taxTotal: row.tax_total == null ? null : Number(row.tax_total),
    breakdown: normalizeStoredBreakdown(parsedBreakdown),
    ocrText: row.ocr_text ?? null,
    source: row.source === "scan" ? "scan" : "manual",
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
    const bill = await billRow(String(req.params.billId));
    if (!bill || bill.house_id !== houseId) throw new ApiError(404, "Bill not found");
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
  if (!filename) return;
  try {
    const referenced = await get("SELECT 1 FROM bills WHERE document = ? LIMIT 1", [filename]);
    if (!referenced) await fs.promises.rm(uploadPath("bills", filename), { force: true });
  } catch {
    // Keep the file if the database cannot confirm it is unreferenced.
  }
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

billRoutes.post("/:houseId/bills", requireHouseBillMember, billUpload.single("document"), verifyBillDocument, handler(async (req, res) => {
  const filename = req.file?.filename ?? null;
  const houseId = String(req.params.houseId);
  let created: BillRow;
  try {
    const body = parseBody(input, req.body);
    if (body.contractColor && body.billType !== "electricity") throw new ApiError(400, "Contract color is only available for electricity bills");
    if (body.billType !== "electricity" && body.billType !== "natural_gas" && [body.consumptionKwh, body.consumptionM3, body.municipalCharges, body.stateCharges].some(value => value != null)) throw new ApiError(400, "Energy metrics are only available for electricity and gas bills");
    if (body.billType !== "natural_gas" && body.consumptionM3 != null) throw new ApiError(400, "Cubic meter consumption is only available for gas bills");
    const house = await get<any>("SELECT currency FROM houses WHERE id = ?", [houseId]);
    const currency = String(house?.currency ?? "EUR").toUpperCase();
    if (body.currency && body.currency.toUpperCase() !== currency) {
      throw new ApiError(400, "Bills must use the house currency");
    }
    if (body.category === "to_split" && body.ledgerConfirmed !== true) {
      throw new ApiError(400, "Confirm this bill is not also recorded as a purchase receipt");
    }
    const splitWith = body.category === "to_split" ? splitList(body.splitWith) : [];
    const members = await all<{ user_id: string }>("SELECT user_id FROM house_members WHERE house_id = ?", [houseId]);
    const paidBy = body.paidBy ?? req.user!.id;
    const people = await validatePeople(houseId, paidBy, splitWith.length ? splitWith : (body.category === "to_split" ? members.map((m) => m.user_id) : []));
    const breakdown = sanitizeBreakdown(body.breakdown);
    created = {
      id: newId("bil"),
      house_id: houseId,
      name: body.name,
      bill_type: body.billType,
      contract_color: body.contractColor ?? null,
      consumption_kwh: body.consumptionKwh ?? null,
      consumption_m3: body.consumptionM3 ?? null,
      municipal_charges: body.municipalCharges ?? null,
      state_charges: body.stateCharges ?? null,
      category: body.category,
      ledger_confirmed: body.category === "to_split" && body.ledgerConfirmed === true ? 1 : 0,
      amount: body.amount,
      currency,
      due_date: body.dueDate || null,
      paid_by: paidBy,
      split_with: JSON.stringify(people),
      document: filename,
      notes: body.notes || null,
      subtotal: body.subtotal ?? null,
      tax_total: body.taxTotal ?? null,
      breakdown: JSON.stringify(breakdown),
      ocr_text: body.ocrText?.trim() || null,
      source: derivedSource(breakdown, body.ocrText),
      created_at: now(),
    };
  } catch (error) {
    // Validation and pre-insert reads cannot have committed a bill, so remove
    // the Multer file directly even if the database is unavailable.
    discardUploads(req);
    throw error;
  }

  try {
    await tx(async (session) => {
      if (!await lockHouseholdLedger(session, created.house_id)) throw new ApiError(404, "House not found");
      await run(`INSERT INTO bills (id, house_id, name, bill_type, contract_color, consumption_kwh, consumption_m3, municipal_charges, state_charges, category, ledger_confirmed, amount, currency, due_date, paid_by, split_with, document, notes, subtotal, tax_total, breakdown, ocr_text, source, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        created.id, created.house_id, created.name, created.bill_type, created.contract_color, created.consumption_kwh, created.consumption_m3, created.municipal_charges, created.state_charges, created.category, created.ledger_confirmed, created.amount, created.currency,
        created.due_date, created.paid_by, created.split_with, created.document, created.notes, created.subtotal, created.tax_total,
        created.breakdown, created.ocr_text, created.source, req.user!.id, created.created_at,
      ]);
    }, { writeLock: true });
  } catch (error) {
    // Rollback normally removes the row. A commit error can be ambiguous, so
    // retain the document if a follow-up query cannot prove it is unreferenced.
    if (filename) {
      try {
        const reference = await get("SELECT id FROM bills WHERE house_id = ? AND document = ?", [created.house_id, filename]);
        if (!reference) await deleteDocument(filename);
      } catch {
        // Keep the upload when the database outcome cannot be confirmed.
      }
    }
    throw error;
  }
  // Return the validated insert values directly; a post-insert read is both
  // unnecessary and unsafe to compensate-delete after an ambiguous DB error.
  res.status(201).json(serialize(created));
}));

singleBillRoutes.patch("/:billId", handler(async (req, res) => {
  const { houseId, bill: current } = await billAccess(req, "member");
  const body = parseBody(patchInput, req.body);
  const nextBillType = body.billType ?? current.bill_type;
  if (body.contractColor && nextBillType !== "electricity") throw new ApiError(400, "Contract color is only available for electricity bills");
  if (nextBillType !== "electricity" && nextBillType !== "natural_gas" && [body.consumptionKwh, body.consumptionM3, body.municipalCharges, body.stateCharges].some(value => value != null)) throw new ApiError(400, "Energy metrics are only available for electricity and gas bills");
  if (nextBillType !== "natural_gas" && body.consumptionM3 != null) throw new ApiError(400, "Cubic meter consumption is only available for gas bills");
  const contractColor = nextBillType !== "electricity" ? null : body.contractColor === undefined ? current.contract_color : body.contractColor;
  const category = body.category ?? current.category;
  if (current.category !== "to_split" && category === "to_split" && body.ledgerConfirmed !== true) {
    throw new ApiError(400, "Confirm this bill is not also recorded as a purchase receipt");
  }
  const ledgerConfirmed = category === "to_split"
    ? (body.ledgerConfirmed === undefined ? Boolean(current.ledger_confirmed) : body.ledgerConfirmed)
    : false;
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
  const storedBreakdown = parseJson<unknown>(current.breakdown, []);
  const providedBreakdown = body.breakdown === undefined ? undefined : body.breakdown ?? [];
  const breakdown = providedBreakdown === undefined
    ? normalizeStoredBreakdown(storedBreakdown)
    : sanitizeBreakdown(providedBreakdown);
  // Derive provenance from the effective OCR data. Clients may send `source`
  // for compatibility, but it is ignored; legacy values are normalised too.
  const nextOcrText = body.ocrText === undefined ? current.ocr_text : body.ocrText?.trim() || null;
  const source = providedBreakdown !== undefined || body.ocrText !== undefined
    ? derivedSource(breakdown, nextOcrText)
    : (current.source === "scan" ? "scan" : "manual");
  const clearScanTotals = providedBreakdown !== undefined && breakdown.length === 0;
  const nextSubtotal = body.subtotal === undefined ? (clearScanTotals ? null : current.subtotal) : body.subtotal;
  const nextTaxTotal = body.taxTotal === undefined ? (clearScanTotals ? null : current.tax_total) : body.taxTotal;
  await tx(async (session) => {
    if (!await lockHouseholdLedger(session, houseId)) throw new ApiError(404, "House not found");
    await run(`UPDATE bills SET name = ?, bill_type = ?, contract_color = ?, consumption_kwh = ?, consumption_m3 = ?, municipal_charges = ?, state_charges = ?, category = ?, ledger_confirmed = ?, amount = ?, due_date = ?, paid_by = ?, split_with = ?, notes = ?,
      subtotal = ?, tax_total = ?, breakdown = ?, ocr_text = ?, source = ? WHERE id = ?`, [
      body.name ?? current.name, nextBillType ?? "other", contractColor ?? null,
      body.consumptionKwh === undefined ? current.consumption_kwh : body.consumptionKwh,
      body.consumptionM3 === undefined ? current.consumption_m3 : body.consumptionM3,
      body.municipalCharges === undefined ? current.municipal_charges : body.municipalCharges,
      body.stateCharges === undefined ? current.state_charges : body.stateCharges,
      category, ledgerConfirmed ? 1 : 0, body.amount ?? current.amount,
      body.dueDate === undefined ? current.due_date : body.dueDate || null, paidBy ?? null, JSON.stringify(people),
      body.notes === undefined ? current.notes : body.notes || null,
      nextSubtotal,
      nextTaxTotal,
      JSON.stringify(breakdown),
      nextOcrText,
      source,
      current.id,
    ]);
  }, { writeLock: true });
  res.json(serialize(await requireBillRow(current.id, houseId)));
}));

billRoutes.post("/:houseId/bills/:billId/document", requireBillDocumentMember, billUpload.single("document"), verifyBillDocument, handler(async (req, res) => {
  const houseId = String(req.params.houseId);
  let current: BillRow | undefined;
  try {
    // The authorization middleware reads before Multer, but this second read
    // can still fail after Multer has written the new PDF.
    current = await billRow(String(req.params.billId), houseId);
  } catch (error) {
    await deleteDocument(req.file?.filename);
    throw error;
  }
  if (!current) { await deleteDocument(req.file?.filename); throw new ApiError(404, "Bill not found"); }
  if (!req.file) throw new ApiError(400, "Choose a PDF or image file");
  let updated: BillRow | undefined;
  let updateApplied = false;
  try {
    // A new document invalidates the old read: clear the breakdown so stale
    // text cannot be shown next to the replacement until it is scanned again.
    const result = await run(`UPDATE bills SET document = ?, subtotal = NULL, tax_total = NULL,
      breakdown = '[]', ocr_text = NULL, source = 'manual'
      WHERE id = ? AND house_id = ? AND (document = ? OR (document IS NULL AND ? IS NULL))`, [
      req.file.filename, current.id, houseId, current.document, current.document,
    ]);
    if (result.changes !== 1) throw new ApiError(409, "The bill document changed during upload. Try again.");
    updateApplied = true;
    updated = await billRow(current.id, houseId);
    if (!updated || updated.document !== req.file.filename) throw new ApiError(409, "The bill document changed during upload. Try again.");
  } catch (error) {
    let recoveryReadSucceeded = false;
    if (updateApplied) {
      // A successful UPDATE followed by a transient read error is still a
      // successful replacement if a recovery read confirms the new reference.
      try {
        const recovered = await billRow(current.id, houseId);
        recoveryReadSucceeded = true;
        if (recovered?.document === req.file.filename) {
          await deleteDocument(current.document);
          res.json(serialize(recovered));
          return;
        }
      } catch {
        // Preserve files conservatively below if the committed state is unclear.
      }
    }
    // A failed compare-and-swap belongs to another request; clean only our
    // unadopted upload. If the update applied but recovery couldn't read the
    // row, preserve the new file because the database reference is uncertain.
    // A successful recovery read showing no adoption can safely use the
    // reference-checking cleanup helper.
    if (!updateApplied || recoveryReadSucceeded) await deleteDocument(req.file.filename);
    if (updateApplied) await deleteDocument(current.document);
    throw error;
  }
  await deleteDocument(current.document);
  res.json(serialize(updated));
}));

billRoutes.get("/:houseId/bills/:billId/document", handler(async (req, res) => {
  const { houseId } = await requireHouse(req);
  const bill = await billRow(String(req.params.billId), houseId);
  if (!bill?.document || path.basename(bill.document) !== bill.document) throw new ApiError(404, "Bill document not found");
  const documentPath = uploadPath("bills", bill.document);
  if (!fs.existsSync(documentPath)) throw new ApiError(404, "Bill document not found");
  const mime = BILL_DOCUMENT_MIME[path.extname(bill.document).toLowerCase()];
  if (!mime) throw new ApiError(404, "Bill document not found");
  res.setHeader("Content-Type", mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  const extension = path.extname(bill.document).toLowerCase() === ".jpeg" ? ".jpg" : path.extname(bill.document).toLowerCase();
  // PDFs stay downloads; only sniffed JPEG/PNG/WebP are shown inline, and both
  // nosniff and the sandbox CSP are set above.
  res.setHeader(
    "Content-Disposition",
    `${mime === "application/pdf" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(`${bill.name}${extension}`)}`,
  );
  res.sendFile(documentPath);
}));

singleBillRoutes.delete("/:billId", handler(async (req, res) => {
  const { houseId, bill } = await billAccess(req, "member");
  await tx(async (session) => {
    if (!await lockHouseholdLedger(session, houseId)) throw new ApiError(404, "House not found");
    await run("DELETE FROM bills WHERE id = ?", [bill.id]);
  }, { writeLock: true });
  await deleteDocument(bill.document);
  res.json({ ok: true });
}));
