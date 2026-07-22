import * as fileSystem from "node:fs/promises";
import { join, resolve } from "node:path";

import { walkAncestors } from "../../lib/walk-ancestors.js";
import { DEFAULT_MEMORY_DB_PATH } from "../paths.js";
import { discoverMemoryStores } from "./discovery.js";

/** Ordered source paths collected from repeatable CLI backend flags. */
export interface MemorySourceFlags {
  /** Explicit memory-file directories, in command-line order. */
  stores: string[];
  /** Explicit PGlite files, in command-line order. */
  dbs: string[];
}

/** The single backend selected for a create operation. */
export interface MemoryWriteTarget {
  /** Selects the file-store or legacy PGlite persistence path. */
  kind: "store" | "db";
  /** Absolute store directory or PGlite data path. */
  path: string;
}

/** Effective read sources plus the create-operation target implied by them. */
export interface MemorySources {
  /** File stores in collision-precedence order. */
  stores: string[];
  /** PGlite paths in collision-precedence order after every file store. */
  dbs: string[];
  /** Present only when the invocation selects exactly one write backend. */
  writeTarget?: MemoryWriteTarget;
}

/** One backend's already-projected listing rows. */
export interface SourceListing<T> {
  /** Absolute backend path; file-store groups stamp it as row provenance. */
  source: string;
  /** Rows returned by this backend before collision resolution. */
  entries: readonly T[];
}

/**
 * Resolve explicit flags or the skills-style flagless source set.
 *
 * Any explicit backend flag replaces discovery. Without flags, reads inherit
 * every existing memory store from cwd toward the filesystem root and then
 * consult the default DB. Writes target the nearest ancestor that owns an
 * `.agents` directory, falling back to cwd when no agent marker exists; the
 * `memories` child itself is allowed to be absent because writers create it.
 */
export async function resolveSources(
  flags: MemorySourceFlags,
  cwd: string,
): Promise<MemorySources> {
  const explicitCount = flags.stores.length + flags.dbs.length;
  if (explicitCount > 0) {
    const stores = unique(flags.stores);
    const dbs = unique(flags.dbs);
    const selected = flags.stores[0] ?? flags.dbs[0];
    const writeTarget: MemoryWriteTarget | undefined =
      explicitCount === 1 && selected
        ? { kind: flags.stores.length === 1 ? "store" : "db", path: selected }
        : undefined;
    return {
      stores,
      dbs,
      ...(writeTarget ? { writeTarget } : {}),
    };
  }

  const stores = await discoverMemoryStores(cwd);
  return {
    stores,
    dbs: [DEFAULT_MEMORY_DB_PATH],
    writeTarget: { kind: "store", path: await nearestAgentMemoryStore(cwd) },
  };
}

/**
 * Merge projected rows under the one canonical ordering policy.
 *
 * File-store groups precede DB groups; within each family the caller supplies
 * nearest-to-root or explicit flag order. The first row for a slug wins that
 * collision. Only after shadowed copies are removed are all winners sorted
 * newest-first, with the precedence order retained for timestamp ties.
 */
export function mergeListings<T extends { slug: string; createdAt: number }>(
  storeEntries: readonly SourceListing<T>[],
  dbEntries: readonly SourceListing<T>[],
): Array<T & { store?: string }> {
  const winners = new Map<string, T & { store?: string }>();
  for (const listing of storeEntries) {
    for (const entry of listing.entries) {
      if (!winners.has(entry.slug)) winners.set(entry.slug, { ...entry, store: listing.source });
    }
  }
  for (const listing of dbEntries) {
    for (const entry of listing.entries) {
      if (!winners.has(entry.slug)) winners.set(entry.slug, { ...entry });
    }
  }
  return Array.from(winners.values()).sort((left, right) => right.createdAt - left.createdAt);
}

async function nearestAgentMemoryStore(cwd: string): Promise<string> {
  for (const ancestor of walkAncestors(cwd)) {
    const agentRoot = join(ancestor, ".agents");
    const status = await fileSystem.lstat(agentRoot).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return undefined;
      throw error;
    });
    if (!status) continue;
    if (status.isSymbolicLink())
      throw new Error(`Agent directories cannot be symlinks: ${agentRoot}`);
    if (!status.isDirectory()) throw new Error(`Agent path is not a directory: ${agentRoot}`);
    return join(agentRoot, "memories");
  }
  return join(resolve(cwd), ".agents", "memories");
}

function unique(paths: readonly string[]): string[] {
  return Array.from(new Set(paths));
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
