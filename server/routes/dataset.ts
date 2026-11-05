import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { all, get, run } from "../db.js";
import { requireAuth } from "../auth.js";
import { ApiError, handler, parseBody, requireHouse } from "../http.js";
import { serializePhoto } from "../serialize.js";
import { inspectDataset, importDataset, type DatasetSplit } from "../services/dataset-import.js";
import { uploadPath } from "../upload.js";
import fs from "node:fs";

export const datasetRoutes = Router();
datasetRoutes.use(requireAuth);

const datasetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 * 1024 },
}).single("dataset");

function labelsFor(photoIds: string[]) {
  if (!photoIds.length) return new Map<string, any[]>();
  const placeholders = photoIds.map(() => "?").join(",");
  const map = new Map<string, any[]>();
  for (const row of all<any>(`SELECT * FROM photo_labels WHERE photo_id IN (${placeholders}) ORDER BY created_at`, photoIds)) {
    const list = map.get(row.photo_id) ?? [];
    list.push(row);
    map.set(row.photo_id, list);
  }
  return map;
}

datasetRoutes.post(
  "/:houseId/photos/dataset/preview",
  datasetUpload,
  handler(async (req, res) => {
    requireHouse(req, "member");
    if (!req.file) throw new ApiError(400, "Attach a YOLO or COCO zip");
    try {
      const inspection = await inspectDataset(req.file.buffer);
      res.json({
        kind: inspection.kind,
        classes: inspection.classes,
        splits: inspection.splits,
        labelled: inspection.labelled,
        total: inspection.images.length,
        errors: inspection.errors,
        files: inspection.images.slice(0, 500).map((image) => ({
          path: image.path,
          name: image.name,
          split: image.split,
          labels: image.labels.length,
        })),
      });
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : "Could not read the dataset");
    }
  }),
);

datasetRoutes.post(
  "/:houseId/photos/dataset/import",
  datasetUpload,
  handler(async (req, res) => {
    const { houseId } = requireHouse(req, "member");
    if (!req.file) throw new ApiError(400, "Attach a YOLO or COCO zip");
    let mapping: Record<string, string> = {};
    if (req.body?.mapping) {
      try {
        mapping = JSON.parse(String(req.body.mapping));
      } catch {
        throw new ApiError(400, "Class mapping must be JSON");
      }
    }
    try {
      const result = await importDataset({
        houseId,
        userId: req.user!.id,
        buffer: req.file.buffer,
        mapping,
        collectionName: req.body?.collectionName ? String(req.body.collectionName) : undefined,
        splitOverride: req.body?.splitOverride ? (String(req.body.splitOverride) as DatasetSplit) : null,
      });
      res.status(201).json(result);
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : "Could not import the dataset");
    }
  }),
);

datasetRoutes.get(
  "/:houseId/photos/review",
  handler((req, res) => {
    const { houseId } = requireHouse(req);
    const limit = Math.min(Number(req.query.limit ?? 60) || 60, 200);
    const rows = all<any>(
      `SELECT p.*,
         (SELECT COUNT(*) FROM photo_labels l WHERE l.photo_id = p.id) AS label_count,
         (SELECT COUNT(*) FROM photo_labels l WHERE l.photo_id = p.id AND l.x IS NOT NULL AND l.w IS NOT NULL) AS box_count
       FROM photos p WHERE p.house_id = ?
       ORDER BY label_count = 0 DESC, box_count = 0 DESC, p.created_at ASC LIMIT ?`,
      [houseId, limit],
    );
    const labelMap = labelsFor(rows.map((row) => row.id));
    const photos = rows.map((row) => ({
      ...serializePhoto(row, labelMap.get(row.id) ?? []),
      labelCount: Number(row.label_count ?? 0),
      boxCount: Number(row.box_count ?? 0),
      reason:
        Number(row.label_count ?? 0) === 0
          ? "unlabeled"
          : Number(row.box_count ?? 0) === 0
            ? "classification-only"
            : "boxes",
    }));
    res.json({
      counts: {
        unlabeled: photos.filter((photo) => photo.reason === "unlabeled").length,
        classificationOnly: photos.filter((photo) => photo.reason === "classification-only").length,
        total: photos.length,
      },
      photos,
    });
  }),
);

datasetRoutes.post(
  "/:houseId/photos/labels/bulk",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "member");
    const body = parseBody(
      z.object({
        action: z.enum(["rename", "merge", "delete"]),
        from: z.string().trim().min(1).max(80),
        to: z.string().trim().max(80).optional(),
      }),
      req.body,
    );
    if (body.action === "delete") {
      const result = run("DELETE FROM photo_labels WHERE house_id = ? AND label = ?", [houseId, body.from]);
      res.json({ ok: true, affected: Number(result.changes ?? 0) });
      return;
    }
    if (!body.to) throw new ApiError(400, "Choose the target label");
    const result = run("UPDATE photo_labels SET label = ? WHERE house_id = ? AND label = ?", [body.to, houseId, body.from]);
    res.json({ ok: true, affected: Number(result.changes ?? 0) });
  }),
);

datasetRoutes.post(
  "/:houseId/photos/splits",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "member");
    const body = parseBody(
      z.object({
        photoIds: z.array(z.string().max(60)).min(1).max(500),
        split: z.enum(["unassigned", "train", "val", "test"]),
      }),
      req.body,
    );
    for (const id of body.photoIds) {
      run("UPDATE photos SET split = ? WHERE id = ? AND house_id = ?", [body.split, id, houseId]);
    }
    res.json({ ok: true, updated: body.photoIds.length });
  }),
);

datasetRoutes.post(
  "/:houseId/photos/delete-bulk",
  handler((req, res) => {
    const { houseId } = requireHouse(req, "admin");
    const body = parseBody(z.object({ photoIds: z.array(z.string().max(60)).min(1).max(500) }), req.body);
    let deleted = 0;
    for (const id of body.photoIds) {
      const photo = get<any>("SELECT * FROM photos WHERE id = ? AND house_id = ?", [id, houseId]);
      if (!photo) continue;
      try {
        fs.rmSync(uploadPath("photos", photo.filename), { force: true });
      } catch {
        /* missing files are fine */
      }
      run("DELETE FROM photos WHERE id = ?", [photo.id]);
      deleted++;
    }
    res.json({ ok: true, deleted });
  }),
);
