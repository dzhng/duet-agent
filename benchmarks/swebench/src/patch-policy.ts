/** Exact path-level patch-policy result shared by rollout admission and reporting. */
export interface PatchLint {
  /** Paths staged into the final baseline-relative patch. */
  paths: string[];
  /** Human-readable policy violations that make the patch inadmissible. */
  violations: string[];
}

/** Check exact staged paths rather than guessing from diff text. */
export function lintPatch(patch: string, paths: readonly string[], maxBytes: number): PatchLint {
  const violations: string[] = [];
  const bytes = Buffer.byteLength(patch);
  if (bytes === 0) violations.push("patch is empty");
  if (bytes > maxBytes) violations.push(`patch is ${bytes} bytes (limit ${maxBytes})`);
  for (const path of paths) {
    const segments = path.toLowerCase().split("/");
    const filename = segments.at(-1) ?? "";
    if (
      segments.some((segment) => ["test", "tests", "__tests__"].includes(segment)) ||
      /(?:^|[._-])test(?:[._-]|$)/.test(filename)
    ) {
      violations.push(`test file modified: ${path}`);
    }
    if (segments.includes(".duet") || path.startsWith("opt/duet/")) {
      violations.push(`runtime file leaked: ${path}`);
    }
  }
  return { paths: [...paths], violations };
}
