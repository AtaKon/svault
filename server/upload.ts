import multer from "multer";
import path from "node:path";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { MAX_UPLOAD_BYTES, UPLOAD_DIR } from "./config.js";

const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/bmp": ".bmp",
  "image/tiff": ".tif",
};

export function uploader(prefix: "photos" | "items" | "recipes" | "receipts") {
  const dest = path.join(UPLOAD_DIR, prefix);
  fs.mkdirSync(dest, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, dest),
      filename: (_req, file, cb) => {
        const ext = MIME_EXT[file.mimetype] ?? path.extname(file.originalname).toLowerCase().slice(0, 8) ?? ".img";
        cb(null, `${Date.now()}-${randomBytes(6).toString("hex")}${ext}`);
      },
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 30 },
    fileFilter: (_req, file, cb) => {
      if (file.mimetype.startsWith("image/")) cb(null, true);
      else cb(new Error("Only image files are supported"));
    },
  });
}

export function uploadPath(prefix: "photos" | "items" | "recipes" | "receipts", filename: string): string {
  return path.join(UPLOAD_DIR, prefix, path.basename(filename));
}
