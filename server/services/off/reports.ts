import { APP_VERSION } from "../../config.js";
import type { OffReportCandidate } from "../../../shared/types.js";
import { contributionIdentity } from "./auth.js";
import { OffWriteError } from "./errors.js";
import { OFF_PROJECTS } from "./projects.js";

/** NutriPatrol accepts product/image reports. It expects the OFF session cookie. */

const BASE = "https://nutripatrol.openfoodfacts.org";
const USER_AGENT = `SVault/${APP_VERSION} (self-hosted household inventory; https://github.com/AtaKon/svault)`;

export async function submitReport(
  userId: string,
  code: string,
  report: OffReportCandidate,
): Promise<{ remoteStatus: string; remoteMessage: string | null; remoteId: string | null }> {
  // Reports about any project are filed with the Open Food Facts session.
  const identity = await contributionIdentity(userId, "off");
  if (!identity) throw new OffWriteError("Connect an Open Food Facts account to report a product");
  const body = {
    barcode: code,
    type: report.type,
    url: `${OFF_PROJECTS[report.flavor].site}/product/${code}`,
    user_id: identity.username,
    source: "web",
    flavor: report.flavor,
    reason: report.reason,
    comment: report.comment.slice(0, 1000) || null,
  };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
  };
  if (identity.mode === "session" && identity.cookie) headers.cookie = identity.cookie;
  let response: Response;
  try {
    response = await fetch(`${BASE}/api/v1/flags`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new OffWriteError("Could not reach NutriPatrol", { retryable: true });
  }
  const json: any = await response.json().catch(() => null);
  if (!response.ok) {
    throw new OffWriteError(
      json?.detail || json?.error || `NutriPatrol returned ${response.status}`,
      { retryable: response.status === 429 || response.status >= 500 },
    );
  }
  return {
    remoteStatus: "reported",
    remoteMessage: "Report sent to the Open Food Facts moderators",
    remoteId: json?.id != null ? String(json.id) : null,
  };
}

export const REPORT_REASONS = [
  { value: "wrong_barcode", label: "Wrong barcode" },
  { value: "wrong_data", label: "Incorrect data" },
  { value: "missing_data", label: "Missing data" },
  { value: "wrong_project", label: "Wrong product type" },
  { value: "other", label: "Something else" },
] as const;
