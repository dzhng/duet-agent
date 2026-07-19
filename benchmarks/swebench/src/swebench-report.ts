/** Normalized official scorer outcome lists. */
export interface SwebenchReport {
  resolvedIds: string[];
  unresolvedIds: string[];
  errorIds: string[];
  emptyPatchIds: string[];
}

/** Narrow parser isolating the harness's snake_case report schema. */
export function parseSwebenchReport(value: unknown): SwebenchReport {
  if (!value || typeof value !== "object") throw new Error("SWE-bench report must be an object.");
  const report = value as Record<string, unknown>;
  return {
    resolvedIds: stringArray(report.resolved_ids, "resolved_ids"),
    unresolvedIds: stringArray(report.unresolved_ids, "unresolved_ids"),
    errorIds: stringArray(report.error_ids, "error_ids"),
    emptyPatchIds: stringArray(report.empty_patch_ids, "empty_patch_ids"),
  };
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`SWE-bench report field ${field} must be a string array.`);
  }
  return [...value];
}
