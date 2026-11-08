import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { get } from "../../db.js";
import { APP_VERSION, UPLOAD_DIR } from "../../config.js";
import { ApiError } from "../../http.js";
import type {
  OffCandidateKind,
  OffContributionKind,
  OffPriceCandidate,
  OffProduct,
  OffProjectId,
  OffReportCandidate,
} from "../../../shared/types.js";
import { fetchOffProduct } from "../openfoodfacts.js";
import { contributionCandidates } from "./eligibility.js";
import { OFF_PROJECTS } from "./projects.js";
import { offDryRun, offWritesEnabled, type OffContributionIdentity } from "./auth.js";
import { OffWriteError } from "./errors.js";
import { priceCandidates, submitPrice } from "./prices.js";
import { submitReport } from "./reports.js";

/**
 * Builds the exact Open Food Facts form from local data.
 *
 * The client never supplies a raw payload. It selects field names; the server
 * re-runs eligibility, re-reads the item and builds an allow-listed form. That
 * keeps a compromised client from writing arbitrary OFF fields.
 */

const CONTACT = String(process.env.SV_OFF_CONTACT ?? "").trim();
const USER_AGENT = `SVault/${APP_VERSION} (self-hosted household inventory; https://github.com/AtaKon/svault${
  CONTACT ? `; ${CONTACT}` : ""
})`;

export interface PreparedContribution {
  project: OffProjectId;
  code: string;
  kind: OffContributionKind;
  fields: string[];
  form: Record<string, string>;
  imageField: "front" | "ingredients" | "nutrition" | "packaging" | null;
  values: Record<string, string | null>;
  price?: OffPriceCandidate | null;
  report?: OffReportCandidate | null;
}

function firstBrand(value: string | null | undefined): string {
  return String(value ?? "").split(",")[0].trim().slice(0, 80);
}

function nutritionForm(product: OffProduct | null): Record<string, string> {
  const nutrition = product?.nutrition;
  if (!nutrition) return {};
  const form: Record<string, string> = {
    nutrition_data_per: nutrition.basis === "100ml" ? "100ml" : "100g",
  };
  const values: [string, number | null][] = [
    ["energy-kcal", nutrition.energyKcal],
    ["energy-kj", nutrition.energyKj],
    ["fat", nutrition.fat],
    ["saturated-fat", nutrition.saturatedFat],
    ["carbohydrates", nutrition.carbohydrates],
    ["sugars", nutrition.sugars],
    ["fiber", nutrition.fiber],
    ["proteins", nutrition.proteins],
    ["salt", nutrition.salt],
    ["sodium", nutrition.sodium],
  ];
  for (const [key, value] of values) {
    if (value != null && Number.isFinite(Number(value))) form[`nutriment_${key}`] = String(value);
  }
  return form;
}

async function localeFor(userId: string, houseId: string): Promise<{ lc: string; cc: string }> {
  const user = await get<{ language: string | null }>("SELECT language FROM users WHERE id = ?", [userId]);
  const house = await get<{ settings: string | null }>("SELECT settings FROM houses WHERE id = ?", [houseId]);
  let settings: any = {};
  try {
    settings = JSON.parse(house?.settings ?? "{}");
  } catch {
    settings = {};
  }
  const lc = /^[a-z]{2}$/.test(String(user?.language ?? "")) ? String(user!.language) : "en";
  const cc = String(settings?.purchases?.country ?? "").trim().toUpperCase().slice(0, 2);
  return { lc, cc };
}

export async function buildContribution(opts: {
  userId: string;
  houseId: string;
  itemId?: string;
  receiptLineId?: string;
  locationId?: number;
  kind: OffCandidateKind;
  code?: string;
  fields?: string[];
}): Promise<PreparedContribution> {
  if (opts.kind === "price") {
    const prices = await priceCandidates(opts.houseId, 250);
    const match = prices.find(
      (candidate) =>
        candidate.price &&
        (!opts.receiptLineId || candidate.price.receiptLineId === opts.receiptLineId) &&
        (!opts.code || candidate.code === opts.code),
    );
    if (!match?.price) {
      throw new ApiError(400, "This price is no longer eligible. Refresh the list and try again.");
    }
    return {
      project: match.project,
      code: match.code,
      kind: "price",
      fields: ["price"],
      form: {},
      imageField: null,
      values: match.values,
      price: opts.locationId != null ? { ...match.price, locationId: opts.locationId } : match.price,
    };
  }

  const candidates = await contributionCandidates(opts.houseId, 250, opts.itemId);
  const match = candidates.find(
    (candidate) =>
      (!opts.itemId || candidate.itemId === opts.itemId) &&
      candidate.kind === opts.kind &&
      (!opts.code || candidate.code === opts.code),
  );
  if (!match) {
    throw new ApiError(400, "This item is no longer eligible for that contribution. Refresh the list and try again.");
  }
  if (match.kind === "wrong_project" && match.report) {
    return {
      project: match.report.flavor,
      code: match.code,
      kind: "report",
      fields: ["report"],
      form: {},
      imageField: null,
      values: match.values,
      report: match.report,
    };
  }
  if (match.kind === "report" && match.report) {
    return {
      project: match.report.flavor,
      code: match.code,
      kind: "report",
      fields: ["report"],
      form: {},
      imageField: null,
      values: match.values,
      report: match.report,
    };
  }

  const requested = Array.isArray(opts.fields) ? opts.fields.map(String) : [];
  const unknown = requested.filter((field) => !match.fields.includes(field));
  if (unknown.length) throw new ApiError(400, `Fields cannot be contributed: ${unknown.join(", ")}`);
  const fields = requested.length ? requested : match.fields;
  if (!fields.length) throw new ApiError(400, "Choose at least one field to contribute");

  const item = await get<any>(
    `SELECT i.*, c.name AS category_name FROM items i
     LEFT JOIN categories c ON c.id = i.category_id
     WHERE i.id = ? AND i.house_id = ?`,
    [opts.itemId, opts.houseId],
  );
  if (!item) throw new ApiError(404, "Item not found");
  const { lc, cc } = await localeFor(opts.userId, opts.houseId);
  const form: Record<string, string> = {
    code: match.code,
    app_name: "SVault",
    app_version: APP_VERSION,
    comment: `SVault ${APP_VERSION} user ${createHash("sha256").update(opts.userId).digest("hex").slice(0, 12)}`,
    lc,
  };
  if (cc) form.cc = cc;

  let imageField: PreparedContribution["imageField"] = null;
  for (const field of fields) {
    switch (field) {
      case "name":
        form.product_name = item.name.slice(0, 120);
        form[`product_name_${lc}`] = item.name.slice(0, 120);
        break;
      case "brand": {
        const brand = firstBrand(item.brand);
        if (brand) form.add_brands = brand;
        break;
      }
      case "description":
        form[`generic_name_${lc}`] = String(item.description ?? "").slice(0, 500);
        break;
      case "category":
        if (item.category_name) form.add_categories = String(item.category_name).slice(0, 120);
        break;
      case "nutrition": {
        const parsed = (() => {
          try {
            return JSON.parse(item.nutrition ?? "null");
          } catch {
            return null;
          }
        })();
        if (parsed) Object.assign(form, nutritionForm({ ...(match.product ?? {}), nutrition: parsed } as OffProduct));
        break;
      }
      case "image":
        imageField = "front";
        break;
      default:
        break;
    }
  }

  return {
    project: match.project,
    code: match.code,
    kind: match.kind as OffContributionKind,
    fields,
    form,
    imageField,
    values: Object.fromEntries(fields.map((field) => [field, match.values[field] ?? null])),
    price: match.price ?? null,
    report: match.report ?? null,
  };
}

function imageFile(url: string): { file: string; mime: string; name: string } {
  const match = /^\/uploads\/(items|photos|recipes|receipts)\/([^/?#]+)$/.exec(String(url ?? ""));
  if (!match) throw new OffWriteError("The local image is not a stored upload");
  const prefix = match[1] as "items" | "photos" | "recipes" | "receipts";
  const name = path.basename(match[2]);
  const file = path.join(UPLOAD_DIR, prefix, name);
  if (!fs.existsSync(file)) throw new OffWriteError("The local image file is missing");
  const ext = path.extname(name).toLowerCase();
  const mime =
    ext === ".png"
      ? "image/png"
      : ext === ".webp"
        ? "image/webp"
        : ext === ".gif"
          ? "image/gif"
          : "image/jpeg";
  return { file, mime, name };
}

async function sendForm(
  project: OffProjectId,
  endpoint: string,
  form: Record<string, string>,
  identity: OffContributionIdentity,
): Promise<any> {
  const body = new FormData();
  for (const [key, value] of Object.entries(form)) body.append(key, value);
  body.append("app_uuid", identity.appUuid);
  if (identity.mode === "credentials") {
    body.append("user_id", identity.username);
    body.append("password", identity.password ?? "");
  }
  const headers: Record<string, string> = { "user-agent": USER_AGENT };
  if (identity.mode === "session" && identity.cookie) headers.cookie = identity.cookie;
  let response: Response;
  try {
    response = await fetch(`${OFF_PROJECTS[project].base}${endpoint}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new OffWriteError("Could not reach Open Food Facts", { retryable: true });
  }
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new OffWriteError(
      json?.error || json?.status || `Open Food Facts returned ${response.status}`,
      { retryable, remoteStatus: json?.status ?? String(response.status) },
    );
  }
  if (!json) {
    throw new OffWriteError("Open Food Facts returned an unexpected response", { retryable: false });
  }
  const status = String(json?.status ?? "");
  if (status && !/ok/i.test(status) && json?.status_code !== 0) {
    throw new OffWriteError(
      json?.debug || json?.error || status,
      { retryable: false, remoteStatus: status },
    );
  }
  return json;
}

export interface WriteResult {
  dryRun: boolean;
  remoteStatus: string | null;
  remoteMessage: string | null;
  remoteId: string | null;
}

export async function sendContribution(
  prepared: PreparedContribution,
  identity: OffContributionIdentity,
  userId: string,
): Promise<WriteResult> {
  if (offDryRun()) {
    return { dryRun: true, remoteStatus: "dry_run", remoteMessage: "Dry run: nothing was sent", remoteId: null };
  }
  if (!offWritesEnabled()) {
    throw new OffWriteError("Contributions are disabled on this server", { retryable: false });
  }

  if (prepared.kind === "price" && prepared.price) {
    const result = await submitPrice(userId, prepared.price);
    return { dryRun: false, ...result };
  }
  if (prepared.kind === "report" && prepared.report) {
    const result = await submitReport(userId, prepared.code, prepared.report);
    return { dryRun: false, ...result };
  }

  let remoteStatus = "status ok";
  let remoteMessage: string | null = null;
  let remoteId: string | null = null;

  if (prepared.fields.some((field) => field !== "image")) {
    const json = await sendForm(prepared.project, "/cgi/product_jqm2.pl", prepared.form, identity);
    remoteStatus = String(json?.status ?? "status ok");
    remoteMessage = json?.debug ? String(json.debug) : null;
    remoteId = json?.rev != null ? String(json.rev) : null;
  }

  if (prepared.imageField) {
    const image = imageFile(String(prepared.values.image ?? ""));
    const form = new FormData();
    form.append("code", prepared.code);
    form.append("imagefield", prepared.imageField);
    form.append(`imgupload_${prepared.imageField}`, new Blob([fs.readFileSync(image.file)], { type: image.mime }), image.name);
    form.append("app_name", "SVault");
    form.append("app_version", APP_VERSION);
    form.append("app_uuid", identity.appUuid);
    form.append("comment", prepared.form.comment ?? `SVault ${APP_VERSION}`);
    if (identity.mode === "credentials") {
      form.append("user_id", identity.username);
      form.append("password", identity.password ?? "");
    }
    const headers: Record<string, string> = { "user-agent": USER_AGENT };
    if (identity.mode === "session" && identity.cookie) headers.cookie = identity.cookie;
    let response: Response;
    try {
      response = await fetch(`${OFF_PROJECTS[prepared.project].base}/cgi/product_image_upload.pl`, {
        method: "POST",
        headers,
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new OffWriteError("Could not reach Open Food Facts", { retryable: true });
    }
    const json: any = await response.json().catch(() => null);
    if (!response.ok || !/ok/i.test(String(json?.status ?? ""))) {
      throw new OffWriteError(
        json?.error || json?.status || `Image upload failed (${response.status})`,
        { retryable: response.status === 429 || response.status >= 500, remoteStatus: json?.status ?? String(response.status) },
      );
    }
    remoteStatus = json?.status ?? remoteStatus;
    remoteMessage = [remoteMessage, "Image uploaded"].filter(Boolean).join(" · ");
    remoteId = json?.imgid != null ? String(json.imgid) : remoteId;
  }

  await fetchOffProduct(prepared.code, { force: true, project: prepared.project });
  return { dryRun: false, remoteStatus, remoteMessage, remoteId };
}
