import { Router } from "express";
import { z } from "zod";
import fs from "node:fs/promises";
import JSZip from "jszip";
import { all, get, newId, now, run, tx } from "../db.js";
import { memberRole, requireAuth, roleAtLeast } from "../auth.js";
import { ApiError, handler, intParam, parseBody, requireHouse } from "../http.js";
import { serializePhoto } from "../serialize.js";
import { discardUploads, uploader, uploadPath } from "../upload.js";
import type { Role } from "../../shared/types.js";

export const photoRoutes = Router();
export const singlePhotoRoutes = Router();

photoRoutes.use(requireAuth);
singlePhotoRoutes.use(requireAuth);

const splitSchema = z.enum(["unassigned", "train", "val", "test"]);
const boxSchema = z.object({
  label: z.string().trim().min(1).max(80),
  x: z.number().min(0).max(1).nullish(),
  y: z.number().min(0).max(1).nullish(),
  w: z.number().min(0).max(1).nullish(),
  h: z.number().min(0).max(1).nullish(),
});

async function labelsFor(photoIds: string[]) {
  if (!photoIds.length) return new Map<string, any[]>();
  const placeholders = photoIds.map(() => "?").join(",");
  const rows = await all<any>(`SELECT * FROM photo_labels WHERE photo_id IN (${placeholders}) ORDER BY created_at`, photoIds);
  const map = new Map<string, any[]>();
  for (const row of rows) {
    const list = map.get(row.photo_id) ?? [];
    list.push(row);
    map.set(row.photo_id, list);
  }
  return map;
}

async function photoAccess(req: any, minRole: Role = "viewer") {
  const photo = await get<any>("SELECT * FROM photos WHERE id = ?", [req.params.photoId]);
  if (!photo) throw new ApiError(404, "Photo not found");
  const role = await memberRole(req.user!.id, photo.house_id);
  if (!role) throw new ApiError(404, "Photo not found");
  if (!roleAtLeast(role, minRole)) throw new ApiError(403, `Requires ${minRole} access`);
  return { photo, role };
}

photoRoutes.get(
  "/:houseId/collections",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    const rows = await all<any>(
      `SELECT c.*,
        (SELECT COUNT(*) FROM photos p WHERE p.collection_id = c.id AND p.house_id = c.house_id) AS photo_count,
        (SELECT COUNT(*) FROM photos p WHERE p.collection_id = c.id AND p.house_id = c.house_id
           AND EXISTS (SELECT 1 FROM photo_labels l WHERE l.photo_id = p.id)) AS labeled_count
       FROM photo_collections c WHERE c.house_id = ? ORDER BY lower(c.name)`,
      [houseId],
    );
    res.json(
      rows.map((c) => ({
        id: c.id,
        houseId: c.house_id,
        name: c.name,
        description: c.description ?? null,
        photoCount: Number(c.photo_count ?? 0),
        labeledCount: Number(c.labeled_count ?? 0),
        createdAt: c.created_at,
      })),
    );
  }),
);

photoRoutes.post(
  "/:houseId/collections",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const body = parseBody(
      z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(500).nullish() }),
      req.body,
    );
    const id = newId("col");
    await run("INSERT INTO photo_collections (id, house_id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
      id,
      houseId,
      body.name,
      body.description ?? null,
      req.user!.id,
      now(),
    ]);
    res.status(201).json({
      id,
      houseId,
      name: body.name,
      description: body.description ?? null,
      photoCount: 0,
      labeledCount: 0,
      createdAt: now(),
    });
  }),
);

photoRoutes.patch(
  "/:houseId/collections/:collectionId",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    const current = await get<any>("SELECT * FROM photo_collections WHERE id = ? AND house_id = ?", [req.params.collectionId, houseId]);
    if (!current) throw new ApiError(404, "Folder not found");
    const body = parseBody(
      z.object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().trim().max(500).nullish() }),
      req.body,
    );
    await run("UPDATE photo_collections SET name = ?, description = ? WHERE id = ?", [
      body.name ?? current.name,
      body.description === undefined ? current.description : body.description,
      current.id,
    ]);
    res.json({ ok: true });
  }),
);

photoRoutes.delete(
  "/:houseId/collections/:collectionId",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req, "member");
    await run("DELETE FROM photo_collections WHERE id = ? AND house_id = ?", [req.params.collectionId, houseId]);
    res.json({ ok: true });
  }),
);

photoRoutes.get(
  "/:houseId/labels",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    const rows = await all<any>(
      `SELECT label, COUNT(*) AS count FROM photo_labels WHERE house_id = ? GROUP BY label ORDER BY count DESC, label`,
      [houseId],
    );
    res.json(rows.map((r) => ({ label: r.label, count: Number(r.count) })));
  }),
);

photoRoutes.get(
  "/:houseId/photos",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    const limit = intParam(req.query.limit, 60, 500);
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
    const where = ["p.house_id = ?"];
    const params: unknown[] = [houseId];
    if (req.query.collectionId) {
      where.push("p.collection_id = ?");
      params.push(String(req.query.collectionId));
    }
    if (req.query.split) {
      where.push("p.split = ?");
      params.push(String(req.query.split));
    }
    if (req.query.label) {
      where.push("EXISTS (SELECT 1 FROM photo_labels l WHERE l.photo_id = p.id AND l.label = ?)");
      params.push(String(req.query.label));
    }
    if (req.query.unlabeled === "1") {
      where.push("NOT EXISTS (SELECT 1 FROM photo_labels l WHERE l.photo_id = p.id)");
    }
    if (req.query.itemId) {
      where.push("p.item_id = ?");
      params.push(String(req.query.itemId));
    }
    const total = Number(
      (await get<{ n: number }>(`SELECT COUNT(*) AS n FROM photos p WHERE ${where.join(" AND ")}`, params))?.n ?? 0,
    );
    const rows = await all<any>(
      `SELECT p.* FROM photos p WHERE ${where.join(" AND ")} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const labelMap = await labelsFor(rows.map((r) => r.id));
    res.json({ photos: rows.map((r) => serializePhoto(r, labelMap.get(r.id) ?? [])), total });
  }),
);

photoRoutes.post(
  "/:houseId/photos",
  uploader("photos").array("photos", 30),
  handler(async (req, res) => {
    let photos;
    try {
      const { houseId } = await requireHouse(req, "member");
      const files = (req.files as Express.Multer.File[]) ?? [];
      if (!files.length) throw new ApiError(400, "No photos uploaded");
      const collectionId = req.body.collectionId ? String(req.body.collectionId) : null;
      if (collectionId && !await get("SELECT id FROM photo_collections WHERE id = ? AND house_id = ?", [collectionId, houseId])) {
        throw new ApiError(400, "Folder does not belong to this house");
      }
      if (req.body.itemId && !await get("SELECT id FROM items WHERE id = ? AND house_id = ?", [String(req.body.itemId), houseId])) {
        throw new ApiError(400, "Item does not belong to this house");
      }
      const split = splitSchema.catch("unassigned").parse(req.body.split ?? "unassigned");
      let meta: any[] = [];
      if (req.body.meta) {
        try {
          const parsed: unknown = JSON.parse(String(req.body.meta));
          meta = Array.isArray(parsed) ? parsed : [];
        } catch {
          meta = [];
        }
      }
      photos = await tx(async () => {
        const created: string[] = [];
        for (const [index, file] of files.entries()) {
          const m = meta[index] ?? {};
          const id = newId("pho");
          await run(
            `INSERT INTO photos (id, house_id, collection_id, filename, original_name, mime, size, width, height, notes,
               item_id, split, captured_at, uploaded_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              houseId,
              collectionId,
              file.filename,
              String(m.originalName ?? file.originalname).slice(0, 200),
              file.mimetype,
              file.size,
              m.width ? Number(m.width) : null,
              m.height ? Number(m.height) : null,
              m.notes ? String(m.notes).slice(0, 500) : null,
              req.body.itemId ? String(req.body.itemId) : null,
              split,
              m.capturedAt ? String(m.capturedAt).slice(0, 40) : null,
              req.user!.id,
              now(),
            ],
          );
          created.push(id);
        }
        const rows = await all<any>(`SELECT * FROM photos WHERE id IN (${created.map(() => "?").join(",")})`, created);
        return rows.map((row) => serializePhoto(row, []));
      });
    } catch (err) {
      discardUploads(req);
      throw err;
    }
    res.status(201).json({ photos });
  }),
);

/* ------------------------------------------------------------- single photo */

singlePhotoRoutes.patch(
  "/:photoId",
  handler(async (req, res) => {
    const { photo } = await photoAccess(req, "member");
    const body = parseBody(
      z.object({
        collectionId: z.string().trim().min(1).max(60).nullish(),
        notes: z.string().max(1000).nullish(),
        split: splitSchema.optional(),
        itemId: z.string().trim().min(1).max(60).nullish(),
        width: z.number().int().min(1).max(20000).nullish(),
        height: z.number().int().min(1).max(20000).nullish(),
        capturedAt: z.string().max(40).nullish(),
      }),
      req.body,
    );
    if (body.collectionId && !await get("SELECT id FROM photo_collections WHERE id = ? AND house_id = ?", [body.collectionId, photo.house_id])) {
      throw new ApiError(400, "Folder does not belong to this house");
    }
    if (body.itemId && !await get("SELECT id FROM items WHERE id = ? AND house_id = ?", [body.itemId, photo.house_id])) {
      throw new ApiError(400, "Item does not belong to this house");
    }
    await run(
      `UPDATE photos SET collection_id = ?, notes = ?, split = ?, item_id = ?, width = ?, height = ?, captured_at = ?
       WHERE id = ?`,
      [
        body.collectionId === undefined ? photo.collection_id : body.collectionId,
        body.notes === undefined ? photo.notes : body.notes,
        body.split ?? photo.split,
        body.itemId === undefined ? photo.item_id : body.itemId,
        body.width === undefined ? photo.width : body.width,
        body.height === undefined ? photo.height : body.height,
        body.capturedAt === undefined ? photo.captured_at : body.capturedAt,
        photo.id,
      ],
    );
    const labels = (await labelsFor([photo.id])).get(photo.id) ?? [];
    res.json(serializePhoto(await get<any>("SELECT * FROM photos WHERE id = ?", [photo.id]), labels));
  }),
);

singlePhotoRoutes.delete(
  "/:photoId",
  handler(async (req, res) => {
    const { photo } = await photoAccess(req, "admin");
    const file = uploadPath("photos", photo.filename);
    await fs.unlink(file).catch(() => undefined);
    await run("DELETE FROM photos WHERE id = ?", [photo.id]);
    res.json({ ok: true });
  }),
);

singlePhotoRoutes.post(
  "/:photoId/labels",
  handler(async (req, res) => {
    const { photo } = await photoAccess(req, "member");
    const body = parseBody(boxSchema, req.body);
    const id = newId("lbl");
    const hasBox = [body.x, body.y, body.w, body.h].every((v) => v != null);
    await run("INSERT INTO photo_labels (id, photo_id, house_id, label, x, y, w, h, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      id,
      photo.id,
      photo.house_id,
      body.label,
      hasBox ? body.x : null,
      hasBox ? body.y : null,
      hasBox ? body.w : null,
      hasBox ? body.h : null,
      now(),
    ]);
    res.status(201).json({ id, label: body.label, x: body.x ?? null, y: body.y ?? null, w: body.w ?? null, h: body.h ?? null });
  }),
);

singlePhotoRoutes.put(
  "/:photoId/labels",
  handler(async (req, res) => {
    const { photo } = await photoAccess(req, "member");
    const body = parseBody(z.object({ labels: z.array(boxSchema).max(100) }), req.body);
    await run("DELETE FROM photo_labels WHERE photo_id = ?", [photo.id]);
    for (const box of body.labels) {
      const hasBox = [box.x, box.y, box.w, box.h].every((v) => v != null);
      await run("INSERT INTO photo_labels (id, photo_id, house_id, label, x, y, w, h, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
        newId("lbl"),
        photo.id,
        photo.house_id,
        box.label,
        hasBox ? box.x : null,
        hasBox ? box.y : null,
        hasBox ? box.w : null,
        hasBox ? box.h : null,
        now(),
      ]);
    }
    res.json(serializePhoto(await get<any>("SELECT * FROM photos WHERE id = ?", [photo.id]), (await labelsFor([photo.id])).get(photo.id) ?? []));
  }),
);

singlePhotoRoutes.delete(
  "/:photoId/labels/:labelId",
  handler(async (req, res) => {
    const { photo } = await photoAccess(req, "member");
    await run("DELETE FROM photo_labels WHERE id = ? AND photo_id = ?", [req.params.labelId, photo.id]);
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------ exports */

interface ExportPhoto {
  id: string;
  filename: string;
  originalName: string;
  width: number | null;
  height: number | null;
  split: string;
  labels: { label: string; x: number | null; y: number | null; w: number | null; h: number | null }[];
}

async function exportBundle(houseId: string, format: "yolo" | "coco", collectionId: string | null) {
  const where = ["p.house_id = ?"];
  const params: unknown[] = [houseId];
  if (collectionId) {
    where.push("p.collection_id = ?");
    params.push(collectionId);
  }
  const rows = await all<any>(`SELECT * FROM photos p WHERE ${where.join(" AND ")} ORDER BY p.created_at`, params);
  const labelMap = await labelsFor(rows.map((r) => r.id));
  const photos: ExportPhoto[] = rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    originalName: r.original_name,
    width: r.width,
    height: r.height,
    split: r.split,
    labels: (labelMap.get(r.id) ?? []).map((l) => ({
      label: l.label,
      x: l.x,
      y: l.y,
      w: l.w,
      h: l.h,
    })),
  }));

  const classes = Array.from(new Set(photos.flatMap((p) => p.labels.map((l) => l.label)))).sort();
  const classIndex = new Map(classes.map((name, i) => [name, i]));

  const zip = new JSZip();
  const dataset = zip.folder("svault-dataset")!;
  dataset.file("classes.txt", classes.join("\n") + (classes.length ? "\n" : ""));
  dataset.file(
    "manifest.csv",
    [
      "file,original_name,split,width,height,labels",
      ...photos.map((p) =>
        [
          p.filename,
          `"${p.originalName.replace(/"/g, "'")}"`,
          p.split,
          p.width ?? "",
          p.height ?? "",
          `"${p.labels.map((l) => l.label).join("|")}"`,
        ].join(","),
      ),
    ].join("\n"),
  );

  const coco = {
    info: { description: `SVault dataset export`, date_created: new Date().toISOString() },
    images: [] as any[],
    annotations: [] as any[],
    categories: classes.map((name, i) => ({ id: i + 1, name, supercategory: "svault" })),
  };
  let annId = 1;

  for (const photo of photos) {
    const split = photo.split === "unassigned" ? "unassigned" : photo.split;
    const buffer = await fs.readFile(uploadPath("photos", photo.filename)).catch(() => null);
    if (!buffer) continue;
    dataset.file(`images/${split}/${photo.filename}`, buffer);

    const yoloLines: string[] = [];
    for (const label of photo.labels) {
      if (label.x == null || label.y == null || label.w == null || label.h == null) continue;
      const cx = label.x + label.w / 2;
      const cy = label.y + label.h / 2;
      yoloLines.push(
        `${classIndex.get(label.label) ?? 0} ${cx.toFixed(6)} ${cy.toFixed(6)} ${label.w.toFixed(6)} ${label.h.toFixed(6)}`,
      );
      if (photo.width && photo.height) {
        coco.annotations.push({
          id: annId++,
          image_id: photo.id,
          category_id: (classIndex.get(label.label) ?? 0) + 1,
          bbox: [
            Math.round(label.x * photo.width),
            Math.round(label.y * photo.height),
            Math.round(label.w * photo.width),
            Math.round(label.h * photo.height),
          ],
          area: Math.round(label.w * photo.width * label.h * photo.height),
          iscrowd: 0,
        });
      }
    }
    dataset.file(`labels/${split}/${photo.filename.replace(/\.[^.]+$/, "")}.txt`, yoloLines.join("\n") + (yoloLines.length ? "\n" : ""));
    coco.images.push({
      id: photo.id,
      file_name: `images/${split}/${photo.filename}`,
      width: photo.width ?? 0,
      height: photo.height ?? 0,
      split,
    });
  }

  dataset.file(
    "data.yaml",
    [
      "path: .",
      "train: images/train",
      "val: images/val",
      "test: images/test",
      "names:",
      ...classes.map((name, i) => `  ${i}: ${name}`),
    ].join("\n") + "\n",
  );
  dataset.file("annotations.coco.json", JSON.stringify(coco, null, 2));
  dataset.file(
    "README.txt",
    [
      "SVault vision dataset export",
      "",
      `Photos: ${photos.length}`,
      `Classes: ${classes.length ? classes.join(", ") : "(none labeled yet)"}`,
      "",
      "YOLO layout: images/<split>/ + labels/<split>/ with normalized boxes.",
      "Photos without a bounding box are classified in manifest.csv but have no YOLO label line.",
      "COCO annotations: annotations.coco.json",
      "",
      "Note: only bounding boxes are exported. A classification-only dataset can use",
      "the label names in manifest.csv together with the images folder.",
    ].join("\n"),
  );

  if (format === "coco") {
    dataset.file("annotations.json", JSON.stringify(coco, null, 2));
  }

  return { buffer: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), photoCount: photos.length };
}

photoRoutes.get(
  "/:houseId/photos/export",
  handler(async (req, res) => {
    const { houseId } = await requireHouse(req);
    const format = req.query.format === "coco" ? "coco" : "yolo";
    const collectionId = req.query.collectionId ? String(req.query.collectionId) : null;
    const { buffer, photoCount } = await exportBundle(houseId, format, collectionId);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="svault-${format}-${new Date().toISOString().slice(0, 10)}.zip"`,
    );
    res.setHeader("X-Photo-Count", String(photoCount));
    res.send(buffer);
  }),
);
