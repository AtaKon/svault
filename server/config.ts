import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root (works both from server/ during dev and dist/server/ once built). */
export const ROOT = path.resolve(here, here.includes(`${path.sep}dist${path.sep}`) ? "../.." : "..");

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, "data"));
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
export const DB_FILE = path.join(DATA_DIR, "svault.db");
export const PORT = Number(process.env.PORT ?? 4000);
export const IS_PROD = process.env.NODE_ENV === "production";
export const CLIENT_DIR = path.join(ROOT, "dist", "client");
export const SESSION_DAYS = 30;
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 20) * 1024 * 1024;

export const AI_ENV = {
  baseUrl: process.env.OPENAI_BASE_URL ?? process.env.SVAI_BASE_URL ?? "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY ?? process.env.SVAI_API_KEY ?? "",
  model: process.env.OPENAI_MODEL ?? process.env.SVAI_MODEL ?? "gpt-4o-mini",
  visionModel: process.env.OPENAI_VISION_MODEL ?? process.env.SVAI_VISION_MODEL ?? "",
};

export function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(path.join(UPLOAD_DIR, "photos"), { recursive: true });
  fs.mkdirSync(path.join(UPLOAD_DIR, "items"), { recursive: true });
  fs.mkdirSync(path.join(UPLOAD_DIR, "recipes"), { recursive: true });
  fs.mkdirSync(path.join(UPLOAD_DIR, "receipts"), { recursive: true });
}
