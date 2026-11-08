import multer from "multer";
import type { Request, RequestHandler } from "express";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { MAX_UPLOAD_BYTES, UPLOAD_DIR } from "./config.js";
import { ApiError, requireHouse } from "./http.js";
import type { Role } from "../shared/types.js";

export type UploadPrefix = "photos" | "items" | "recipes" | "receipts" | "bills";

/**
 * The only image types SVault accepts. The stored extension always comes from
 * this table, never from the client's file name, so a crafted upload cannot
 * end up as `.html` or `.svg` under `/uploads`.
 */
const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/pjpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/bmp": ".bmp",
  "image/tiff": ".tif",
};

/** Extensions that may be served inline from `/uploads`. Everything else is a download. */
export const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".avif",
  ".heic",
  ".heif",
  ".bmp",
  ".tif",
  ".tiff",
]);

const HEIF_BRANDS = new Set(["avif", "avis", "heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

/**
 * Identify an image from its magic bytes. Returns a MIME type for the formats
 * SVault accepts, or null for anything else (HTML, SVG, scripts, archives...).
 */
export function sniffImage(head: Buffer): string | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  const ascii = (start: number, end: number) => head.subarray(start, end).toString("latin1");
  if (head.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (head.length >= 12 && ascii(4, 8) === "ftyp" && HEIF_BRANDS.has(ascii(8, 12))) {
    return ascii(8, 12).startsWith("avi") ? "image/avif" : "image/heic";
  }
  if (head.length >= 2 && ascii(0, 2) === "BM") return "image/bmp";
  if (head.length >= 4 && (head.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
    head.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))) {
    return "image/tiff";
  }
  return null;
}

function readHead(file: string, bytes = 32): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function requestFiles(req: Request): Express.Multer.File[] {
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === "object") return Object.values(req.files).flat();
  return [];
}

/** Delete every file multer stored for this request. */
export function discardUploads(req: Request) {
  const uploadRoot = path.resolve(UPLOAD_DIR);
  for (const file of requestFiles(req)) {
    if (!file.path) continue;
    const resolved = path.resolve(file.path);
    const relative = path.relative(uploadRoot, resolved);
    // Multer writes inside UPLOAD_DIR. Never let a malformed request object
    // turn this cleanup helper into an arbitrary file deletion primitive.
    if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      fs.rmSync(resolved, { force: true });
    }
  }
}

/** Reject uploads whose content is not one of the accepted image formats. */
const verifyImages: RequestHandler = (req, _res, next) => {
  const files = requestFiles(req);
  for (const file of files) {
    let ok = false;
    try {
      ok = Boolean(file.path && sniffImage(readHead(file.path)));
    } catch {
      ok = false;
    }
    if (!ok) {
      discardUploads(req);
      next(new ApiError(400, "That file is not a supported image (JPEG, PNG, WebP, GIF, AVIF, HEIC, BMP or TIFF)"));
      return;
    }
  }
  next();
};

/** Who may upload: a minimum house role (checked against `:houseId`) or a custom check. */
export type UploadAccess = Role | ((req: Request) => Promise<unknown> | unknown);

/** Run an access check before multer touches the request body. */
export function accessGuard(access: UploadAccess): RequestHandler {
  return (req, _res, next) => {
    Promise.resolve()
      .then(() => (typeof access === "function" ? access(req) : requireHouse(req, access)))
      .then(() => next(), next);
  };
}

export interface ImageUploader {
  single(field: string): RequestHandler[];
  array(field: string, maxCount?: number): RequestHandler[];
}

/**
 * Multer for house images. The access check runs before multer so a user who
 * cannot write to the house never gets a byte onto disk, and every stored file
 * is checked against its magic bytes afterwards.
 */
export function uploader(prefix: UploadPrefix, access: UploadAccess = "member"): ImageUploader {
  const dest = path.join(UPLOAD_DIR, prefix);
  fs.mkdirSync(dest, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, dest),
      filename: (_req, file, cb) => {
        cb(null, `${Date.now()}-${randomBytes(6).toString("hex")}${MIME_EXT[file.mimetype] ?? ".img"}`);
      },
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 30 },
    fileFilter: (_req, file, cb) => {
      if (MIME_EXT[file.mimetype]) cb(null, true);
      else cb(new ApiError(400, "Only JPEG, PNG, WebP, GIF, AVIF, HEIC, BMP or TIFF images are supported"));
    },
  });
  const guard = accessGuard(access);
  return {
    single: (field) => [guard, upload.single(field), verifyImages],
    array: (field, maxCount) => [guard, upload.array(field, maxCount), verifyImages],
  };
}

/** A temporary directory for large archive uploads (restore, dataset import). */
export function archiveUploadDir(): string {
  const dir = path.join(os.tmpdir(), "svault-uploads");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Multer for a single archive written to a temp file (`req.file.path`). The
 * file is removed automatically once the response has been sent.
 */
export function archiveUploader(field: string, maxBytes: number, access: UploadAccess): RequestHandler[] {
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, archiveUploadDir()),
      filename: (_req, _file, cb) => cb(null, `${Date.now()}-${randomBytes(8).toString("hex")}.zip`),
    }),
    limits: { fileSize: maxBytes, files: 1 },
  });
  const cleanup: RequestHandler = (req, res, next) => {
    res.on("close", () => discardUploads(req));
    next();
  };
  return [accessGuard(access), cleanup, upload.single(field)];
}

export function uploadPath(prefix: UploadPrefix, filename: string): string {
  return path.join(UPLOAD_DIR, prefix, path.basename(filename));
}
