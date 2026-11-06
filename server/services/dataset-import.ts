import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import JSZip from "jszip";
import { newId, now, run } from "../db.js";
import { uploadPath } from "../upload.js";

export type DatasetKind = "yolo" | "coco";
export type DatasetSplit = "unassigned" | "train" | "val" | "test";

interface DatasetBox {
  classIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DatasetImage {
  path: string;
  name: string;
  split: DatasetSplit;
  width: number | null;
  height: number | null;
  labels: DatasetBox[];
  labelled: boolean;
}

export interface DatasetInspection {
  kind: DatasetKind;
  classes: string[];
  images: DatasetImage[];
  errors: string[];
  splits: Record<DatasetSplit, number>;
  labelled: number;
}

export interface DatasetImportResult {
  collectionId: string;
  imported: number;
  skipped: number;
  labels: number;
  errors: { file: string; error: string }[];
}

const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
};

function safeName(name: string): boolean {
  const normalized = name.replace(/\\/g, "/");
  return !normalized.startsWith("/") && !normalized.split("/").includes("..");
}

function splitOf(name: string): DatasetSplit {
  const parts = name.replace(/\\/g, "/").split("/");
  const first = parts.find((part) => part === "train" || part === "val" || part === "test" || part === "valid" || part === "validation");
  if (first === "train") return "train";
  if (first === "val" || first === "valid" || first === "validation") return "val";
  if (first === "test") return "test";
  return "unassigned";
}

function isImage(name: string) {
  return Boolean(IMAGE_TYPES[path.extname(name).toLowerCase()]);
}

function parseYamlNames(text: string): string[] {
  const inline = text.match(/names\s*:\s*\[([^\]]*)\]/i);
  if (inline) {
    return inline[1]
      .split(",")
      .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  const lines = text.split(/\r?\n/);
  const names: string[] = [];
  let inNames = false;
  for (const line of lines) {
    if (/^\s*names\s*:\s*$/.test(line)) {
      inNames = true;
      continue;
    }
    if (inNames) {
      const match = line.match(/^\s*-\s*(.+?)\s*$/);
      if (match) names.push(match[1].replace(/^['"]|['"]$/g, ""));
      else if (/^\s*\S/.test(line) && !/^\s*-/.test(line)) inNames = false;
    }
  }
  return names;
}

function dimensions(buffer: Buffer): { width: number | null; height: number | null } {
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return { width: null, height: null };
}

function labelPathFor(imagePath: string): string[] {
  const normalized = imagePath.replace(/\\/g, "/");
  const ext = path.extname(normalized);
  const without = normalized.slice(0, -ext.length);
  const candidates = [`${without}.txt`];
  if (without.includes("/images/")) candidates.unshift(without.replace("/images/", "/labels/") + ".txt");
  if (without.startsWith("images/")) candidates.unshift(`labels/${without.slice("images/".length)}.txt`);
  return candidates;
}

function parseYoloLabels(text: string): { boxes: DatasetBox[]; errors: string[] } {
  const boxes: DatasetBox[] = [];
  const errors: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/).map(Number);
    if (parts.length < 5 || parts.some((value) => !Number.isFinite(value))) {
      errors.push(`Invalid YOLO label line: ${trimmed.slice(0, 80)}`);
      continue;
    }
    const [classIndex, x, y, w, h] = parts;
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x > 1 || y > 1 || w > 1 || h > 1) {
      errors.push(`Out-of-range YOLO box: ${trimmed.slice(0, 80)}`);
      continue;
    }
    boxes.push({ classIndex: Math.floor(classIndex), x, y, w, h });
  }
  return { boxes, errors };
}

async function inspectYolo(zip: JSZip, errors: string[]): Promise<DatasetInspection> {
  let classes: string[] = [];
  const classFile = zip.file("classes.txt");
  if (classFile) classes = (await classFile.async("string")).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!classes.length) {
    const yamlFile = zip.file(/(^|\/)data\.ya?ml$/i)[0];
    if (yamlFile) classes = parseYamlNames(await yamlFile.async("string"));
  }
  const images: DatasetImage[] = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !isImage(entry.name) || !safeName(entry.name)) continue;
    if (/^(classes\.txt|data\.ya?ml)$/i.test(entry.name)) continue;
    const split = splitOf(entry.name);
    let labels: DatasetBox[] = [];
    let labelled = false;
    for (const candidate of labelPathFor(entry.name)) {
      const labelFile = zip.file(candidate);
      if (!labelFile) continue;
      labelled = true;
      const parsed = parseYoloLabels(await labelFile.async("string"));
      labels = parsed.boxes;
      errors.push(...parsed.errors.map((message) => `${candidate}: ${message}`));
      break;
    }
    images.push({
      path: entry.name,
      name: path.basename(entry.name),
      split,
      width: null,
      height: null,
      labels,
      labelled,
    });
  }
  return finishInspection("yolo", classes, images, errors);
}

function finishInspection(kind: DatasetKind, classes: string[], images: DatasetImage[], errors: string[]): DatasetInspection {
  const splits = { unassigned: 0, train: 0, val: 0, test: 0 };
  for (const image of images) splits[image.split]++;
  return {
    kind,
    classes,
    images,
    errors,
    splits,
    labelled: images.filter((image) => image.labels.length > 0 || image.labelled).length,
  };
}

async function inspectCoco(zip: JSZip, errors: string[]): Promise<DatasetInspection> {
  const annotationEntry =
    zip.file("annotations.json") ??
    zip.file("annotations.coco.json") ??
    Object.values(zip.files).find(
      (entry) =>
        !entry.dir &&
        safeName(entry.name) &&
        /(^|\/)(annotations|instances[^/]*)\.json$/i.test(entry.name) &&
        !entry.name.includes("/labels/"),
    );
  if (!annotationEntry) throw new Error("No COCO annotations.json found in the archive");
  const payload = JSON.parse(await annotationEntry.async("string"));
  const categories = Array.isArray(payload.categories) ? payload.categories : [];
  const classes = categories.map((category: any) => String(category.name ?? `class_${category.id}`));
  const classById = new Map<number, number>();
  categories.forEach((category: any, index: number) => classById.set(Number(category.id), index));
  const byImage = new Map<number, DatasetBox[]>();
  for (const annotation of Array.isArray(payload.annotations) ? payload.annotations : []) {
    const bbox = annotation.bbox;
    if (!Array.isArray(bbox) || bbox.length < 4) continue;
    const image = (Array.isArray(payload.images) ? payload.images : []).find((entry: any) => entry.id === annotation.image_id);
    if (!image?.width || !image?.height) continue;
    const [x, y, w, h] = bbox.map(Number);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
    const list = byImage.get(annotation.image_id) ?? [];
    list.push({
      classIndex: classById.get(Number(annotation.category_id)) ?? 0,
      x: Math.max(0, x / Number(image.width)),
      y: Math.max(0, y / Number(image.height)),
      w: Math.min(1, w / Number(image.width)),
      h: Math.min(1, h / Number(image.height)),
    });
    byImage.set(annotation.image_id, list);
  }
  const images: DatasetImage[] = [];
  for (const image of Array.isArray(payload.images) ? payload.images : []) {
    const name = String(image.file_name ?? "").replace(/\\/g, "/");
    if (!name || !isImage(name) || !safeName(name)) {
      errors.push(`Unsafe or unsupported COCO image path: ${name}`);
      continue;
    }
    const entry = zip.file(name) ?? zip.file(`images/${name}`) ?? zip.file(`images/${path.basename(name)}`);
    if (!entry) {
      errors.push(`Image listed in annotations is missing: ${name}`);
      continue;
    }
    images.push({
      path: entry.name,
      name: path.basename(name),
      split: splitOf(name),
      width: Number(image.width) || null,
      height: Number(image.height) || null,
      labels: byImage.get(image.id) ?? [],
      labelled: byImage.has(image.id),
    });
  }
  return finishInspection("coco", classes, images, errors);
}

export async function inspectDataset(buffer: Buffer): Promise<DatasetInspection> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error("This file is not a readable zip archive");
  }
  for (const name of Object.keys(zip.files)) {
    if (!safeName(name)) throw new Error(`Unsafe archive path: ${name}`);
  }
  const errors: string[] = [];
  const hasCoco = Object.values(zip.files).some(
    (entry) => !entry.dir && /(^|\/)(annotations|instances[^/]*)\.json$/i.test(entry.name),
  );
  const hasYolo = Object.values(zip.files).some((entry) => !entry.dir && /\.txt$/i.test(entry.name));
  const inspection = hasCoco && !hasYolo ? await inspectCoco(zip, errors) : await inspectYolo(zip, errors);
  if (!inspection.images.length) throw new Error("The archive does not contain any supported images");
  if (inspection.images.length > 2000) throw new Error("Import at most 2000 images at a time");
  return inspection;
}

export async function importDataset(opts: {
  houseId: string;
  userId: string;
  buffer: Buffer;
  mapping?: Record<string, string>;
  collectionName?: string;
  splitOverride?: DatasetSplit | null;
}): Promise<DatasetImportResult> {
  const zip = await JSZip.loadAsync(opts.buffer);
  const inspection = await inspectDataset(opts.buffer);
  const collectionId = newId("col");
  await run("INSERT INTO photo_collections (id, house_id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    collectionId,
    opts.houseId,
    (opts.collectionName ?? "Imported dataset").slice(0, 80),
    `Imported ${inspection.kind.toUpperCase()} dataset`,
    opts.userId,
    now(),
  ]);

  const mapping = opts.mapping ?? {};
  const targetLabel = (name: string) => {
    if (Object.prototype.hasOwnProperty.call(mapping, name)) return mapping[name];
    return name;
  };

  const errors: { file: string; error: string }[] = [];
  let imported = 0;
  let skipped = 0;
  let labels = 0;

  for (const image of inspection.images) {
    try {
      const entry = zip.file(image.path);
      if (!entry) throw new Error("Image is missing from the archive");
      const data = await entry.async("nodebuffer");
      const ext = path.extname(image.path).toLowerCase();
      const mime = IMAGE_TYPES[ext];
      if (!mime) throw new Error(`Unsupported image type: ${ext}`);
      const filename = `ds_${randomBytes(10).toString("hex")}${ext}`;
      fs.writeFileSync(uploadPath("photos", filename), data);
      const dims = image.width && image.height ? { width: image.width, height: image.height } : dimensions(data);
      const photoId = newId("pho");
      await run(
        `INSERT INTO photos (id, house_id, collection_id, filename, original_name, mime, size, width, height, notes,
           item_id, split, captured_at, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
        [
          photoId,
          opts.houseId,
          collectionId,
          filename,
          image.name.slice(0, 200),
          mime,
          data.length,
          dims.width,
          dims.height,
          `Imported from ${inspection.kind.toUpperCase()} dataset`,
          opts.splitOverride ?? image.split,
          opts.userId,
          now(),
        ],
      );
      for (const box of image.labels) {
        const className = inspection.classes[box.classIndex];
        if (!className) continue;
        const label = targetLabel(className).trim();
        if (!label || label === "__skip") continue;
        await run("INSERT INTO photo_labels (id, photo_id, house_id, label, x, y, w, h, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
          newId("lbl"),
          photoId,
          opts.houseId,
          label.slice(0, 80),
          box.x,
          box.y,
          box.w,
          box.h,
          now(),
        ]);
        labels++;
      }
      imported++;
    } catch (error) {
      skipped++;
      errors.push({ file: image.path, error: error instanceof Error ? error.message : "Import failed" });
    }
  }

  return { collectionId, imported, skipped, labels, errors };
}
