/** Exact path-level patch-policy result shared by rollout admission and reporting. */
export interface PatchLint {
  /** Paths staged into the final baseline-relative patch. */
  paths: string[];
  /** Human-readable findings, including scoreable model outcomes such as emptiness. */
  violations: string[];
  /** Integrity violations that block export; an empty model answer remains scoreable. */
  admissionViolations: string[];
}

/** Paths that may be useful while working but must never enter an official prediction. */
export function isExcludedSubmissionPath(path: string): boolean {
  return submissionPathViolation(path) !== undefined;
}

function submissionPathViolation(path: string): string | undefined {
  const segments = path.toLowerCase().split("/");
  const filename = segments.at(-1) ?? "";
  if (
    segments.some((segment) => ["test", "tests", "__tests__"].includes(segment)) ||
    /(?:^|[._-])test(?:[._-]|$)/.test(filename)
  ) {
    return `test file modified: ${path}`;
  }
  if (segments.includes(".duet") || path.toLowerCase().startsWith("opt/duet/")) {
    return `runtime file leaked: ${path}`;
  }
  return undefined;
}

/** Check exact staged paths rather than guessing from diff text. */
export function lintPatch(patch: string, paths: readonly string[], maxBytes: number): PatchLint {
  const violations: string[] = [];
  const bytes = Buffer.byteLength(patch);
  if (bytes === 0) violations.push("patch is empty");
  if (bytes > maxBytes) violations.push(`patch is ${bytes} bytes (limit ${maxBytes})`);
  for (const path of paths) {
    const violation = submissionPathViolation(path);
    if (violation) violations.push(violation);
  }
  return {
    paths: [...paths],
    violations,
    admissionViolations: violations.filter((violation) => violation !== "patch is empty"),
  };
}
