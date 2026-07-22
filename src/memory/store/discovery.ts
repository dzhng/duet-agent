import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { walkAncestors } from "../../lib/walk-ancestors.js";

const MEMORY_ROOT_NAMES = [".duet", ".agents", ".claude"] as const;

/**
 * Find real memory-store directories from cwd toward the filesystem root.
 * Nearest ancestors win naturally because callers consume this order first;
 * `$HOME` remains excluded by the shared project-scope ancestor walk.
 */
export async function discoverMemoryStores(cwd: string): Promise<string[]> {
  const stores: string[] = [];
  for (const ancestor of walkAncestors(cwd)) {
    for (const rootName of MEMORY_ROOT_NAMES) {
      const storeDir = join(ancestor, rootName, "memories");
      const status = await lstat(storeDir).catch((error: unknown) => {
        if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return undefined;
        throw error;
      });
      if (!status) continue;
      if (status.isSymbolicLink()) throw new Error(`Memory stores cannot be symlinks: ${storeDir}`);
      if (!status.isDirectory()) throw new Error(`Memory store is not a directory: ${storeDir}`);
      stores.push(storeDir);
    }
  }
  return stores;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
