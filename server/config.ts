import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root (works both from server/ during dev and dist/server/ once built). */
export const ROOT = path.resolve(here, here.includes(`${path.sep}dist${path.sep}`) ? "../.." : "..");

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, "data"));
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
export const BACKUP_DIR = path.join(DATA_DIR, "backups");
export const DB_FILE = path.join(DATA_DIR, "svault.db");
export const PORT = Number(process.env.PORT ?? 4000);
export const IS_PROD = process.env.NODE_ENV === "production";
export const CLIENT_DIR = path.join(ROOT, "dist", "client");
export const SESSION_DAYS = 30;
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 20) * 1024 * 1024;
export const APP_VERSION = process.env.SV_VERSION ?? "1.2.0";
export const SCHEMA_VERSION = 2;

/** WebAuthn relying party. Both must match the browser origin. */
export const RP_ID = process.env.RP_ID ?? "";
export const RP_ORIGIN = process.env.ORIGIN ?? process.env.RP_ORIGIN ?? "";

/** Optional OpenID Connect provider. Everything is server-side. */
export const OIDC = {
  issuer: process.env.OIDC_ISSUER ?? "",
  clientId: process.env.OIDC_CLIENT_ID ?? "",
  clientSecret: process.env.OIDC_CLIENT_SECRET ?? "",
  redirectUri: process.env.OIDC_REDIRECT_URI ?? "",
  allowedDomains: (process.env.OIDC_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean),
  autoProvision: process.env.OIDC_AUTO_PROVISION !== "false",
  defaultHouseId: process.env.OIDC_DEFAULT_HOUSE_ID ?? "",
  label: process.env.OIDC_LABEL ?? "Single sign-on",
};

/** OpenFoodFacts is read through a small local cache so receipts and scans stay fast. */
export const OFF_API_BASE = process.env.OFF_API_BASE ?? "https://world.openfoodfacts.org";
export const OFF_SEARCH_BASE = process.env.OFF_SEARCH_BASE ?? "https://search.openfoodfacts.org";
export const OFF_TIMEOUT_MS = Number(process.env.OFF_TIMEOUT_MS ?? 6000);
export const OFF_CACHE_DAYS = Number(process.env.OFF_CACHE_DAYS ?? 30);

/** Optional public catalogue file used by "Sync catalogue" in Settings → Data. */
export const CATALOG_URL = process.env.SV_CATALOG_URL ?? process.env.CATALOG_URL ?? "";

const optionalNumber = (value: string | undefined): number | null => {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

export const AI_ENV = {
  baseUrl: process.env.OPENAI_BASE_URL ?? process.env.SVAI_BASE_URL ?? "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY ?? process.env.SVAI_API_KEY ?? "",
  model: process.env.OPENAI_MODEL ?? process.env.SVAI_MODEL ?? "gpt-4o-mini",
  visionModel: process.env.OPENAI_VISION_MODEL ?? process.env.SVAI_VISION_MODEL ?? "",
  /** Prices in USD per 1M tokens, used to estimate AI cost when the provider does not report it. */
  inputPrice: optionalNumber(process.env.OPENAI_INPUT_PRICE ?? process.env.SVAI_INPUT_PRICE),
  outputPrice: optionalNumber(process.env.OPENAI_OUTPUT_PRICE ?? process.env.SVAI_OUTPUT_PRICE),
};

export function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(path.join(UPLOAD_DIR, "photos"), { recursive: true });
  fs.mkdirSync(path.join(UPLOAD_DIR, "items"), { recursive: true });
  fs.mkdirSync(path.join(UPLOAD_DIR, "recipes"), { recursive: true });
  fs.mkdirSync(path.join(UPLOAD_DIR, "receipts"), { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}
