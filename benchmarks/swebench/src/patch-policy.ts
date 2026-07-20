/** Exact path-level patch-policy result shared by rollout admission and reporting. */
export interface PatchLint {
  /** Paths staged into the final baseline-relative patch. */
  paths: string[];
  /** Human-readable findings, including scoreable model outcomes such as emptiness. */
  violations: string[];
  /** Integrity violations that block export; an empty model answer remains scoreable. */
  admissionViolations: string[];
}

/** Record score-relevant patch facts without imposing a benchmark-owned path policy. */
export function lintPatch(patch: string, paths: readonly string[], maxBytes: number): PatchLint {
  const violations: string[] = [];
  const bytes = Buffer.byteLength(patch);
  if (bytes === 0) violations.push("patch is empty");
  if (bytes > maxBytes) violations.push(`patch is ${bytes} bytes (limit ${maxBytes})`);
  return {
    paths: [...paths],
    violations,
    admissionViolations: violations.filter((violation) => violation !== "patch is empty"),
  };
}
