import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

/**
 * Yields cwd, its parent, grandparent, ... up to the filesystem root. The
 * home directory is excluded so global (home-scoped) configuration does not
 * get double-counted as project configuration when cwd lives inside $HOME.
 * Shared by skills discovery and routing-table discovery — the two must agree
 * on what "project scope walks upward" means, so the walk has one owner.
 */
export function walkAncestors(cwd: string, home: string = homedir()): string[] {
  const resolvedHome = resolve(home);
  const seen = new Set<string>();
  const result: string[] = [];
  let current = resolve(cwd);
  while (true) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current !== resolvedHome) result.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}
