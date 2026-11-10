import multer from "multer";
import type { Request, RequestHandler } from "express";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { MAX_UPLOAD_BYTES, UPLOAD_DIR } from "./config.js";
import { ApiError, requireHouse } from "./http.js";
import { sniffImageBytes } from "../shared/image-sniff.js";
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

/**
 * Identify an image from its magic bytes. Returns a MIME type for the formats
 * SVault accepts, or null for anything else (HTML, SVG, scripts, archives...).
 * The byte-level work lives in `shared/image-sniff.ts` so the server guards and
 * the browser's saved-document re-read cannot drift apart.
 */
export function sniffImage(head: Buffer): string | null {
  return sniffImageBytes(head);
}

function readHead(file: string, bytes = 1024): Buffer {
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
function discardFilesUnder(req: Request, root: string) {
  const uploadRoot = path.resolve(root);
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

export function discardUploads(req: Request) {
  discardFilesUnder(req, UPLOAD_DIR);
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
  // Capture one resolved path for both Multer and the response cleanup hook so
  // the cleanup boundary cannot drift from the directory receiving the file.
  const dest = archiveUploadDir();
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, dest),
      filename: (_req, _file, cb) => cb(null, `${Date.now()}-${randomBytes(8).toString("hex")}.zip`),
    }),
    limits: { fileSize: maxBytes, files: 1 },
  });
  const cleanup: RequestHandler = (req, res, next) => {
    // This callback runs after the route finishes, when Multer has populated
    // req.file and the route has finished reading the archive.
    res.on("close", () => discardFilesUnder(req, dest));
    next();
  };
  return [accessGuard(access), cleanup, upload.single(field)];
}

export function uploadPath(prefix: UploadPrefix, filename: string): string {
  return path.join(UPLOAD_DIR, prefix, path.basename(filename));
}
