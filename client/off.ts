import type { OffProjectId } from "@shared/types";

/** Display labels shared by every Open Food Facts surface. */
export const OFF_PROJECT_LABELS: Record<OffProjectId, string> = {
  off: "Open Food Facts",
  obf: "Open Beauty Facts",
  opff: "Open Pet Food Facts",
  opf: "Open Products Facts",
};

export const OFF_PROJECT_SHORT_LABELS: Record<OffProjectId, string> = {
  off: "Food",
  obf: "Beauty",
  opff: "Pet food",
  opf: "Products",
};

export function offProjectLabel(project: OffProjectId | null | undefined): string {
  if (!project) return "Food";
  return OFF_PROJECT_SHORT_LABELS[project] ?? String(project);
}
