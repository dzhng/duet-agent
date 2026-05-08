import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { FileAutocompleteItem } from "./autocomplete.js";

// Ceiling on how many files the @-picker indexes. Large repos can easily
// exceed this; we'd rather cap the index than block the TUI on startup.
const MAX_INDEXED_FILES = 5000;
const MAX_DEPTH = 8;

const IGNORED_DIRECTORY_NAMES = new Set<string>([
  "node_modules",
  ".git",
  ".duet",
  ".agents",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".vercel",
  ".cache",
  "target",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
]);

/**
 * Enumerate plain files under `root` for the `@`-mention picker.
 *
 * Walks breadth-first with conservative ignores (build outputs, VCS
 * metadata) and a hard ceiling so even huge repos return promptly. Hidden
 * dotfiles are skipped; users can still mention them by typing the path
 * by hand.
 */
export async function buildFileIndex(root: string): Promise<FileAutocompleteItem[]> {
  const results: FileAutocompleteItem[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];

  while (queue.length > 0 && results.length < MAX_INDEXED_FILES) {
    const { dir, depth } = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= MAX_DEPTH) continue;
        if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
        queue.push({ dir: fullPath, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = toPosix(relative(root, fullPath));
      if (!relativePath || relativePath.startsWith("..")) continue;
      results.push({ name: entry.name, relativePath });
      if (results.length >= MAX_INDEXED_FILES) break;
    }
  }

  // Stable alphabetical order so the picker is deterministic before any
  // query is typed (matchers re-rank by relevance once a query exists).
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
