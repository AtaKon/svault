import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_VERSION as PACKAGE_VERSION } from "../shared/version.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root (works both from server/ during dev and dist/server/ once built). */
export const ROOT = path.resolve(here, here.includes(`${path.sep}dist${path.sep}`) ? "../.." : "..");

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, "data"));
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
export const BACKUP_DIR = path.join(DATA_DIR, "backups");
export const DB_FILE = path.join(DATA_DIR, "svault.db");

/**
 * Backup retention. Regular backups rotate in BACKUP_DIR; the safety copies
 * taken before a restore live in their own folder and rotate separately, so a
 * burst of regular backups can never delete the copy needed to roll back.
 */
export const BACKUP_KEEP = 5;
export const PRE_RESTORE_DIR = path.join(BACKUP_DIR, "pre-restore");
const preRestoreKeep = Math.floor(Number(process.env.SV_PRE_RESTORE_KEEP ?? 3));
export const PRE_RESTORE_KEEP = Number.isFinite(preRestoreKeep) && preRestoreKeep >= 1 ? preRestoreKeep : 3;

/**
 * Bring-your-own-database configuration.
 *
 * Set DATABASE_URL to a PostgreSQL connection string (or SV_DATABASE_KIND to
 * "postgres") to use an external database. Without either, SVault keeps using
 * the bundled SQLite file, so existing installs need no changes.
 */
export const DATABASE_URL = process.env.DATABASE_URL ?? process.env.SV_DATABASE_URL ?? "";
export const DATABASE_KIND: "sqlite" | "postgres" =
  (process.env.SV_DATABASE_KIND ?? "").trim().toLowerCase() === "postgres" ||
  /^postgres(ql)?:\/\//i.test(DATABASE_URL)
    ? "postgres"
    : "sqlite";
export const PG_POOL_SIZE = Math.max(1, Number(process.env.PG_POOL_SIZE ?? 10));
export const PG_SSL: boolean | { rejectUnauthorized: boolean } | undefined = (() => {
  const mode = (process.env.PGSSLMODE ?? process.env.DATABASE_SSL ?? "").trim().toLowerCase();
  if (!mode || mode === "disable" || mode === "false" || mode === "allow") return undefined;
  if (mode === "no-verify" || mode === "require" || mode === "true" || mode === "prefer") {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
})();

export const PORT = Number(process.env.PORT ?? 4000);
export const IS_PROD = process.env.NODE_ENV === "production";
export const CLIENT_DIR = path.join(ROOT, "dist", "client");
export const SESSION_DAYS = 30;
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 20) * 1024 * 1024;
const megabytes = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : fallback) * 1024 * 1024;
};
/** Backup archives accepted by the restore endpoint (instance admin only). */
export const RESTORE_MAX_BYTES = megabytes(process.env.SV_RESTORE_MAX_MB, 512);
/** YOLO/COCO zip archives accepted by the dataset import. */
export const DATASET_MAX_BYTES = megabytes(process.env.SV_DATASET_MAX_MB, 256);
export const APP_VERSION = process.env.SV_VERSION ?? PACKAGE_VERSION;
export const SCHEMA_VERSION = 4;

/**
 * AI audit trail. Every provider request is stored in `ai_call_logs` so it can
 * be inspected from the app's developer page. Set the retention to 0 to keep
 * entries forever; the preview cap only limits stored prompt/answer text.
 */
const aiLogDays = Number(process.env.SV_AI_LOG_RETENTION_DAYS ?? 90);
const aiLogPreview = Number(process.env.SV_AI_LOG_PREVIEW_CHARS ?? 4000);
export const AI_LOG_RETENTION_DAYS = Number.isFinite(aiLogDays) ? Math.max(0, aiLogDays) : 90;
export const AI_LOG_PREVIEW_CHARS = Number.isFinite(aiLogPreview)
  ? Math.min(20000, Math.max(200, aiLogPreview))
  : 4000;

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
  /**
   * Optional ordered recipe-scan models (comma-separated, at most four). Unset
   * means "use the provider default": the built-in OpenRouter chain there, the
   * single vision model everywhere else. An explicit list is honoured on any
   * endpoint because it is the operator's choice.
   */
  recipeVisionModels: process.env.OPENAI_RECIPE_VISION_MODELS ?? process.env.SVAI_RECIPE_VISION_MODELS ?? "",
  /**
   * Recipe-scan reasoning control: auto (model default), off, low, medium or
   * high. Sent to OpenRouter as its `reasoning` field; other endpoints fall
   * back to a request without it.
   */
  recipeReasoning: process.env.OPENAI_RECIPE_REASONING ?? process.env.SVAI_RECIPE_REASONING ?? "auto",
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
