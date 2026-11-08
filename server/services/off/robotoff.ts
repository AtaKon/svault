import { APP_VERSION } from "../../config.js";
import type { OffProjectId, OffRobotoffQuestion } from "../../../shared/types.js";
import { OFF_PROJECTS } from "./projects.js";

/**
 * Robotoff asks people to confirm facts extracted from photos. It is optional:
 * the service can be unavailable, and no product write depends on it.
 */

const BASE = process.env.ROBOTOFF_API_BASE ?? "https://robotoff.openfoodfacts.org";
const USER_AGENT = `SVault/${APP_VERSION} (self-hosted household inventory; https://github.com/AtaKon/svault)`;

function safeImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (!/(^|\.)openfoodfacts\.org$/i.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function robotoffQuestions(
  project: OffProjectId,
  count = 1,
  lang = "en",
): Promise<OffRobotoffQuestion[]> {
  const params = new URLSearchParams({
    server_type: project,
    count: String(Math.min(Math.max(count, 1), 10)),
    lang,
    order_by: "popularity",
  });
  try {
    const response = await fetch(`${BASE}/api/v1/questions?${params}`, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return [];
    const json: any = await response.json();
    const questions = Array.isArray(json?.questions) ? json.questions : [];
    return questions.map((question: any) => ({
      barcode: String(question.barcode ?? ""),
      insightId: String(question.insight_id ?? ""),
      insightType: String(question.insight_type ?? ""),
      question: String(question.question ?? ""),
      value: question.value == null ? null : String(question.value),
      valueTag: question.value_tag == null ? null : String(question.value_tag),
      sourceImageUrl: safeImageUrl(question.source_image_url),
      refImageUrl: safeImageUrl(question.ref_image_url),
    }));
  } catch {
    return [];
  }
}

export async function answerRobotoff(insightId: string, annotation: 1 | 0 | -1): Promise<boolean> {
  if (!insightId) return false;
  try {
    const response = await fetch(`${BASE}/api/v1/insights/annotate`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": USER_AGENT,
      },
      body: new URLSearchParams({
        insight_id: insightId,
        annotation: String(annotation),
        update: "true",
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function robotoffProjectSupported(project: OffProjectId): boolean {
  return OFF_PROJECTS[project].capabilities.robotoff;
}
