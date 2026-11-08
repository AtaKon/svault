import fs from "node:fs";
import path from "node:path";
import { all } from "../../db.js";
import { APP_VERSION, UPLOAD_DIR } from "../../config.js";
import type { OffContributionCandidate, OffPriceCandidate, OffPriceLocation } from "../../../shared/types.js";
import { isValidGtin } from "../../lib/redact.js";
import { instanceServiceBearer, serviceBearer } from "./auth.js";
import { OffWriteError } from "./errors.js";

/** Open Prices is a separate Open Food Facts service with its own bearer auth. */

const BASE = "https://prices.openfoodfacts.org";
const USER_AGENT = `SVault/${APP_VERSION} (self-hosted household inventory; https://github.com/AtaKon/svault)`;

interface PriceRow {
  receipt_line_id: string;
  receipt_id: string;
  item_id: string | null;
  description: string;
  barcode: string | null;
  off_code: string | null;
  unit_price: number | null;
  quantity: number | null;
  unit: string | null;
  line_total: number | null;
  currency: string;
  purchased_at: string | null;
  image: string | null;
  vendor_name: string | null;
}

function receiptImagePath(url: string): { file: string; name: string; mime: string } | null {
  const match = /^\/uploads\/receipts\/([^/?#]+)$/.exec(String(url ?? ""));
  if (!match) return null;
  const name = path.basename(match[1]);
  const file = path.join(UPLOAD_DIR, "receipts", name);
  if (!fs.existsSync(file)) return null;
  const ext = path.extname(name).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return { file, name, mime };
}

export async function priceCandidates(houseId: string, limit = 20): Promise<OffContributionCandidate[]> {
  const rows = await all<PriceRow>(
    `SELECT rl.id AS receipt_line_id, rl.receipt_id, rl.item_id, rl.description, rl.barcode, rl.off_code,
            rl.unit_price, rl.quantity, rl.unit, rl.line_total, r.currency, r.purchased_at, r.image,
            v.name AS vendor_name
     FROM receipt_lines rl
     JOIN receipts r ON r.id = rl.receipt_id
     LEFT JOIN vendors v ON v.id = r.vendor_id
     WHERE r.house_id = ? AND r.image IS NOT NULL AND r.image <> ''
       AND (rl.barcode IS NOT NULL OR rl.off_code IS NOT NULL)
       AND COALESCE(rl.unit_price, rl.line_total, 0) > 0
     ORDER BY COALESCE(r.purchased_at, r.created_at) DESC
     LIMIT 250`,
    [houseId],
  );
  const candidates: OffContributionCandidate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const code = [row.barcode, row.off_code]
      .map((value) => String(value ?? "").replace(/\D/g, ""))
      .find((value) => isValidGtin(value));
    if (!code || !receiptImagePath(row.image ?? "")) continue;
    const key = `${code}:${row.receipt_line_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const quantity = Number(row.quantity ?? 1) || 1;
    const amount = Number(row.unit_price ?? (row.line_total != null ? row.line_total / quantity : 0));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const price: OffPriceCandidate = {
      code,
      receiptLineId: row.receipt_line_id,
      receiptId: row.receipt_id,
      amount,
      currency: row.currency || "EUR",
      date: row.purchased_at,
      vendor: row.vendor_name,
      productName: row.description,
      receiptImage: row.image!,
      quantity,
      unit: row.unit,
      unitPrice: row.unit_price == null ? null : Number(row.unit_price),
      locationId: null,
      locationName: null,
    };
    candidates.push({
      id: `price:off:${code}:${row.receipt_line_id}`,
      kind: "price",
      project: "off",
      code,
      itemId: row.item_id ?? row.receipt_line_id,
      itemName: row.description,
      score: 50,
      fields: ["price"],
      values: {
        price: `${amount.toFixed(2)} ${price.currency}${price.vendor ? ` · ${price.vendor}` : ""}${price.date ? ` · ${price.date}` : ""}`,
      },
      product: null,
      image: row.image,
      price,
      ready: true,
      blocked: [],
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

async function bearerFor(userId: string): Promise<string | null> {
  return (await serviceBearer(userId, "prices")) ?? (await instanceServiceBearer("prices"));
}

export async function searchPriceLocations(query: string): Promise<OffPriceLocation[]> {
  const q = String(query ?? "").trim();
  if (q.length < 2) return [];
  try {
    const response = await fetch(
      `${BASE}/api/v1/locations?osm_name__like=${encodeURIComponent(q)}&size=10&order_by=-price_count`,
      { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) return [];
    const json: any = await response.json();
    const items = Array.isArray(json?.items) ? json.items : [];
    return items.map((item: any) => ({
      id: Number(item.id),
      name: String(item.osm_name ?? item.osm_display_name ?? "Shop"),
      city: item.osm_address_city ?? null,
      country: item.osm_address_country ?? null,
    }));
  } catch {
    return [];
  }
}

export async function submitPrice(
  userId: string,
  price: OffPriceCandidate,
): Promise<{ remoteStatus: string; remoteMessage: string | null; remoteId: string | null }> {
  const token = await bearerFor(userId);
  if (!token) throw new OffWriteError("Connect Open Prices to share a price", { retryable: false });
  const image = receiptImagePath(price.receiptImage);
  if (!image) throw new OffWriteError("The receipt image is missing", { retryable: false });

  const proof = new FormData();
  proof.append("file", new Blob([fs.readFileSync(image.file)], { type: image.mime }), image.name);
  proof.append("type", "RECEIPT");
  if (price.date) proof.append("date", price.date);
  if (price.currency) proof.append("currency", price.currency);
  if (price.locationId != null) proof.append("location_id", String(price.locationId));
  let proofResponse: Response;
  try {
    proofResponse = await fetch(`${BASE}/api/v1/proofs/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "user-agent": USER_AGENT },
      body: proof,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new OffWriteError("Could not reach Open Prices", { retryable: true });
  }
  const proofJson: any = await proofResponse.json().catch(() => null);
  if (!proofResponse.ok || proofJson?.id == null) {
    throw new OffWriteError(
      proofJson?.detail || proofJson?.error || `Proof upload failed (${proofResponse.status})`,
      { retryable: proofResponse.status === 429 || proofResponse.status >= 500 },
    );
  }

  const body: Record<string, unknown> = {
    product_code: price.code,
    product_name: price.productName.slice(0, 200),
    price: price.amount,
    price_per: /^(kg|kilo|kilogram)/i.test(String(price.unit ?? ""))
      ? "KILOGRAM"
      : /^(l|lt|liter|litre)/i.test(String(price.unit ?? ""))
        ? "LITER"
        : "UNIT",
    type: "PRODUCT",
    proof_id: proofJson.id,
    receipt_quantity: price.quantity,
  };
  if (price.currency) body.currency = price.currency;
  if (price.date) body.date = price.date;
  if (price.locationId != null) body.location_id = price.locationId;
  let response: Response;
  try {
    response = await fetch(`${BASE}/api/v1/prices`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new OffWriteError("Could not reach Open Prices", { retryable: true });
  }
  const json: any = await response.json().catch(() => null);
  if (!response.ok || json?.id == null) {
    throw new OffWriteError(
      json?.detail || json?.error || `Open Prices rejected the price (${response.status})`,
      { retryable: response.status === 429 || response.status >= 500 },
    );
  }
  return {
    remoteStatus: "created",
    remoteMessage: `Price shared${price.vendor ? ` from ${price.vendor}` : ""}`,
    remoteId: String(json.id),
  };
}
