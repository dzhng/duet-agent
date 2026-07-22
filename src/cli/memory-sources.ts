import type {
  MemorySourceFlags,
  MemorySources,
  MemoryWriteTarget,
} from "../memory/store/sources.js";
import { resolveUserPath, usageError } from "./shared.js";

export const WRITE_TARGET_USAGE_ERROR =
  "Memory writes require exactly one --store <folder> or --db <file>; pass only one write target.";

/** Source flags removed from an argv vector before command-specific parsing. */
export interface LexedMemorySourceFlags {
  /** Arguments not consumed as `--store` / `--db` pairs. */
  args: string[];
  /** Resolved backend paths, retaining command-line order within each family. */
  flags: MemorySourceFlags;
}

/**
 * Extract the closed, repeatable memory-backend flag language from an argv
 * vector. Command-specific parsers consume the returned remainder, keeping
 * path validation and resolution identical across train and memory add.
 */
export function lexMemorySourceFlags(
  args: readonly string[],
  cwd: string = process.cwd(),
): LexedMemorySourceFlags {
  const remaining: string[] = [];
  const flags: MemorySourceFlags = { stores: [], dbs: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg !== "--store" && arg !== "--db") {
      remaining.push(arg);
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("-")) usageError(`Missing value for ${arg}`);
    const path = resolveUserPath(value, cwd);
    if (arg === "--store") flags.stores.push(path);
    else flags.dbs.push(path);
  }
  return { args: remaining, flags };
}

/** Enforce the create-command grammar while allowing flagless discovery. */
export function requireSingleExplicitWriteTarget(flags: MemorySourceFlags): void {
  const explicitCount = flags.stores.length + flags.dbs.length;
  if (explicitCount > 1) usageError(WRITE_TARGET_USAGE_ERROR);
}

/** Narrow the resolver's read/write union for commands that always create. */
export function requireWriteTarget(sources: MemorySources): MemoryWriteTarget {
  if (!sources.writeTarget) usageError(WRITE_TARGET_USAGE_ERROR);
  return sources.writeTarget;
}
