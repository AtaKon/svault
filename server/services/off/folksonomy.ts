import { APP_VERSION } from "../../config.js";
import type { OffProjectId } from "../../../shared/types.js";
import { instanceServiceBearer, serviceBearer } from "./auth.js";

/**
 * Folksonomy Engine stores key/value properties outside the product schema.
 * The API is explicitly experimental, so this is exposed as an advanced action
 * and never used by the automatic product flow.
 */

const BASE = process.env.FOLKSONOMY_API_BASE ?? "https://api.folksonomy.openfoodfacts.org";
const USER_AGENT = `SVault/${APP_VERSION} (self-hosted household inventory; https://github.com/AtaKon/svault)`;

export async function addFolksonomyProperty(opts: {
  userId: string;
  project: OffProjectId;
  code: string;
  key: string;
  value: string;
}): Promise<{ key: string; value: string }> {
  const token = (await serviceBearer(opts.userId, "folksonomy")) ?? (await instanceServiceBearer("folksonomy"));
  if (!token) throw new Error("Connect Folksonomy first");
  const response = await fetch(`${BASE}/product`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({
      product: opts.code,
      k: opts.key,
      v: opts.value,
      version: 1,
      owner: null,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const json: any = await response.json().catch(() => null);
  if (response.status === 409) {
    // The key exists. Read the current version and update it.
    const current = await fetch(`${BASE}/product/${encodeURIComponent(opts.code)}/${encodeURIComponent(opts.key)}`, {
      headers: { authorization: `Bearer ${token}`, "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    const existing: any = await current.json().catch(() => null);
    if (existing?.version != null) {
      const update = await fetch(`${BASE}/product`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({
          product: opts.code,
          k: opts.key,
          v: opts.value,
          version: Number(existing.version) + 1,
          owner: null,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (update.ok) return { key: opts.key, value: opts.value };
    }
  }
  if (!response.ok) {
    throw new Error(json?.detail || `Folksonomy returned ${response.status}`);
  }
  return { key: opts.key, value: opts.value };
}
