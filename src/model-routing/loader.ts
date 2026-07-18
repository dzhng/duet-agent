import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { walkAncestors } from "../lib/walk-ancestors.js";
import { Value } from "typebox/value";
import {
  BUILT_IN_ROUTING_TABLE,
  RoutingTableSchema,
  validateRoutingTable,
  type RoutingCatalogAdapter,
  type RoutingTable,
} from "./table.js";

const ROUTING_TABLE_RELATIVE_PATH = join(".duet", "models.json");

/** Options for loading the optional project-local routing table. */
export interface LoadRoutingTableOptions {
  /**
   * Directory the discovery walk starts from. Candidates are
   * `<ancestor>/.duet/models.json` for cwd and every parent up to the
   * filesystem root (home excluded from the walk), then `~/.duet/models.json`
   * as the global fallback — the same project-then-global scoping skills
   * discovery uses. The nearest existing file wins outright as a complete
   * replacement; an invalid winner fails loudly rather than falling through.
   */
  cwd: string;
  /** Concrete catalog used for collision, dangling-target, and vision validation. */
  catalogAdapter: RoutingCatalogAdapter;
  /** Home directory override for tests; defaults to the real home. */
  homeDir?: string;
}

/** Provenance attached to the active routing table. */
export type LoadedRoutingTable =
  | { table: RoutingTable; source: "built-in" }
  | { table: RoutingTable; source: "file"; path: string };

/** Options for writing the built-in table to a project for customization. */
export interface ExportRoutingTableOptions {
  /** Project directory where `.duet/models.json` should be written. */
  cwd: string;
  /** Allows replacement of an existing file when explicitly set. */
  force: boolean;
}

/** Result of exporting the built-in routing table. */
export interface ExportedRoutingTable {
  /** Absolute or cwd-relative path, matching the supplied cwd, of the written file. */
  path: string;
  /** The complete built-in replacement serialized to the file. */
  table: RoutingTable;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertSchema(value: unknown, path: string): asserts value is RoutingTable {
  if (Value.Check(RoutingTableSchema, value)) return;
  const details = [...Value.Errors(RoutingTableSchema, value)]
    .map((error) => `${error.instancePath || "/"}: ${error.message}`)
    .join("; ");
  throw new Error(`Invalid routing table at ${path}: ${details}`);
}

function assertDomain(
  table: RoutingTable,
  path: string,
  catalogAdapter: RoutingCatalogAdapter,
): void {
  const issues = validateRoutingTable(table, catalogAdapter);
  if (issues.length === 0) return;
  throw new Error(
    `Invalid routing table at ${path}:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`,
  );
}

/**
 * Load the nearest `.duet/models.json` as a complete replacement, or use the
 * built-in table when no override exists anywhere on the discovery path.
 */
export async function loadRoutingTable(
  options: LoadRoutingTableOptions,
): Promise<LoadedRoutingTable> {
  const home = options.homeDir ?? homedir();
  const candidates = [
    ...walkAncestors(options.cwd, home).map((dir) => join(dir, ROUTING_TABLE_RELATIVE_PATH)),
    join(home, ROUTING_TABLE_RELATIVE_PATH),
  ];

  for (const path of candidates) {
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) continue;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse routing table at ${path}: ${detail}`, { cause: error });
    }
    assertSchema(parsed, path);
    assertDomain(parsed, path, options.catalogAdapter);
    return { table: parsed, source: "file", path };
  }

  assertDomain(BUILT_IN_ROUTING_TABLE, "built-in routing table", options.catalogAdapter);
  return { table: BUILT_IN_ROUTING_TABLE, source: "built-in" };
}

/** Export the complete built-in table as deterministic, two-space-indented JSON. */
export async function exportRoutingTable(
  options: ExportRoutingTableOptions,
): Promise<ExportedRoutingTable> {
  const directory = join(options.cwd, ".duet");
  const path = join(options.cwd, ROUTING_TABLE_RELATIVE_PATH);
  await mkdir(directory, { recursive: true });
  const contents = `${JSON.stringify(BUILT_IN_ROUTING_TABLE, null, 2)}\n`;
  try {
    await writeFile(path, contents, { encoding: "utf8", flag: options.force ? "w" : "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Routing table already exists at ${path}; pass force to overwrite it.`, {
        cause: error,
      });
    }
    throw error;
  }
  return { path, table: BUILT_IN_ROUTING_TABLE };
}
