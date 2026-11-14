import { Router, type Request } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { all, get, newId, now, run } from "../db.js";
import { memberRole, requireAuth, roleAtLeast } from "../auth.js";
import { ApiError, handler } from "../http.js";
import { MAX_UPLOAD_BYTES, UPLOAD_DIR } from "../config.js";
import { sniffImage } from "../upload.js";
import { DOCUMENT_EXTENSIONS } from "../../shared/bill-document.js";
import { removeUnreferencedUploads } from "../services/upload-cleanup.js";

export const itemDocumentRoutes = Router();
itemDocumentRoutes.use(requireAuth);
const dir = path.join(UPLOAD_DIR, "item-documents");
fs.mkdirSync(dir, { recursive: true });
const upload = multer({ storage: multer.diskStorage({ destination: dir, filename: (_req, _file, cb) => cb(null, randomBytes(20).toString("hex") + ".upload") }), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
async function access(req: Request, minimum: "viewer" | "member" = "viewer") {
  const item = await get<{ id: string; house_id: string }>("SELECT id, house_id FROM items WHERE id = ?", [req.params.itemId]);
  if (!item) throw new ApiError(404, "Item not found");
  const role = await memberRole(req.user!.id, item.house_id);
  if (!role) throw new ApiError(404, "Item not found");
  if (!roleAtLeast(role, minimum)) throw new ApiError(403, "Requires member access");
  return item;
}
const serialize = (row: any) => ({ id: row.id, itemId: row.item_id, originalName: row.original_name, mime: row.mime, size: row.size, kind: row.kind, uploadedBy: row.uploaded_by, createdAt: row.created_at });
itemDocumentRoutes.get("/:itemId/documents", handler(async (req, res) => {
  const item = await access(req);
  res.json((await all<any>("SELECT * FROM item_documents WHERE item_id = ? AND house_id = ? ORDER BY created_at DESC", [item.id, item.house_id])).map(serialize));
}));
itemDocumentRoutes.post("/:itemId/documents", (req, _res, next) => { void access(req, "member").then(() => next(), next); }, upload.single("document"), handler(async (req, res) => {
  if (!req.file) throw new ApiError(400, "Choose a PDF or image");
  let filename = req.file.filename;
  try {
    const item = await access(req, "member");
    const kind = req.body.kind || "other";
    if (!["manual", "receipt", "warranty", "other"].includes(kind)) throw new ApiError(400, "Invalid document kind");
    const fd = fs.openSync(req.file.path, "r");
    const bytes = Buffer.alloc(1024); let length: number;
    try { length = fs.readSync(fd, bytes, 0, bytes.length, 0); } finally { fs.closeSync(fd); }
    const prefix = bytes.subarray(0, length);
    const mime = length >= 12 ? (prefix.subarray(0, 5).toString("latin1") === "%PDF-" ? "application/pdf" : sniffImage(prefix)) : null;
    const ext = mime && DOCUMENT_EXTENSIONS[mime];
    if (!mime || !ext) throw new ApiError(400, "That file is not a valid PDF or image");
    filename = filename.replace(/\.upload$/, `.${ext}`);
    fs.renameSync(req.file.path, path.join(dir, filename));
    const row = { id: newId("doc"), house_id: item.house_id, item_id: item.id, filename, original_name: path.basename(req.file.originalname).slice(0, 255), mime, size: req.file.size, kind, uploaded_by: req.user!.id, created_at: now() };
    await run("INSERT INTO item_documents (id, house_id, item_id, filename, original_name, mime, size, kind, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", Object.values(row));
    res.status(201).json(serialize(row));
  } catch (error) { fs.rmSync(path.join(dir, filename), { force: true }); throw error; }
}));
itemDocumentRoutes.get("/:itemId/documents/:documentId", handler(async (req, res) => {
  const item = await access(req);
  const row = await get<any>("SELECT * FROM item_documents WHERE id = ? AND item_id = ? AND house_id = ?", [req.params.documentId, item.id, item.house_id]);
  if (!row || path.basename(row.filename) !== row.filename || !DOCUMENT_EXTENSIONS[row.mime] || !fs.existsSync(path.join(dir, row.filename))) throw new ApiError(404, "Document not found");
  res.setHeader("Content-Type", row.mime);
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(row.original_name)}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.sendFile(path.join(dir, row.filename));
}));
itemDocumentRoutes.delete("/:itemId/documents/:documentId", handler(async (req, res) => {
  const item = await access(req, "member");
  const row = await get<any>("SELECT * FROM item_documents WHERE id = ? AND item_id = ? AND house_id = ?", [req.params.documentId, item.id, item.house_id]);
  if (!row) throw new ApiError(404, "Document not found");
  await run("DELETE FROM item_documents WHERE id = ? AND item_id = ?", [row.id, item.id]);
  await removeUnreferencedUploads([`/uploads/item-documents/${row.filename}`]);
  res.json({ ok: true });
}));
