import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ResourceDiagnostic, Skill } from "@earendil-works/pi-coding-agent";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import type { SkillDiscoveryOptions } from "../types/config.js";
import { walkAncestors } from "../lib/walk-ancestors.js";
import {
  getBuiltInSkillInstructions,
  isBuiltInSkill,
  listBuiltInSkills,
} from "./built-in-skills.js";

export interface SkillCollision {
  /** Skill name that collided. */
  name: string;
  /** Path that won (this is the skill that's actually loaded). */
  winnerPath: string;
  /** Path that was skipped due to the collision. */
  loserPath: string;
}

export interface DiscoveredSkillsResult {
  skills: Skill[];
  collisions: SkillCollision[];
}

const SKILL_SHELL_EXPANSION_PATTERN = /!`([\s\S]*?)`/g;
const DEFAULT_SKILL_DIR_NAMES = [".duet", ".agents", ".claude"] as const;

function buildSkillDiscoveryOptions(options: SkillDiscoveryOptions | undefined, cwd: string) {
  const effectiveCwd = options?.cwd ?? cwd;
  const globalSkillRoots = options?.agentDir
    ? [options.agentDir]
    : DEFAULT_SKILL_DIR_NAMES.map((dirName) => join(homedir(), dirName));
  const includeDefaults = options?.includeDefaults ?? true;
  return {
    cwd: effectiveCwd,
    agentDir: globalSkillRoots[0],
    includeDefaults: false,
    skillPaths: uniquePaths([
      ...(includeDefaults ? defaultSkillPaths(globalSkillRoots, effectiveCwd) : []),
      ...(options?.skillPaths ?? []),
    ]),
  };
}

function defaultSkillPaths(globalSkillRoots: string[], cwd: string): string[] {
  // Project before global so a project-local skill can shadow a same-named
  // global one. Within each scope, .duet > .agents > .claude (first scanned
  // wins on name collisions). Project scope walks from cwd up to the
  // filesystem root so skills declared in any ancestor directory (e.g. a
  // repo root or workspace root above the current package) are discovered
  // — nearer directories win on collisions because they appear first.
  const ancestorPaths: string[] = [];
  for (const ancestor of walkAncestors(cwd)) {
    for (const dirName of DEFAULT_SKILL_DIR_NAMES) {
      ancestorPaths.push(join(ancestor, dirName, "skills"));
    }
  }
  return [...ancestorPaths, ...globalSkillRoots.map((root) => join(root, "skills"))];
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

const SKILL_SHELL_EXPANSION_TIMEOUT_MS = 30_000;
/** Overlap hung metadata commands without stampeding a resource-constrained runner host. */
const SKILL_METADATA_EXPANSION_CONCURRENCY = 4;
const SKILL_SHELL_EXPANSION_OPTIONS = {
  encoding: "utf-8",
  maxBuffer: 1024 * 1024,
  timeout: SKILL_SHELL_EXPANSION_TIMEOUT_MS,
} as const;

function expandSkillShellCommandsSync(content: string, cwd: string): string {
  return content.replace(SKILL_SHELL_EXPANSION_PATTERN, (match, command: string) => {
    try {
      const output = execFileSync("bash", ["-lc", command], {
        cwd,
        ...SKILL_SHELL_EXPANSION_OPTIONS,
      });
      return output.trimEnd();
    } catch (error) {
      return failedSkillShellExpansion(match, error);
    }
  });
}

async function expandSkillShellCommands(content: string, cwd: string): Promise<string> {
  const matches = [...content.matchAll(SKILL_SHELL_EXPANSION_PATTERN)];
  if (matches.length === 0) return content;

  // Expansions within one description retain their historical left-to-right
  // ordering because later commands may consume side effects from earlier ones.
  // Concurrency belongs between independent skills, not within one skill.
  const expansions: string[] = [];
  for (const match of matches) {
    expansions.push(await runSkillShellCommand(match[0], match[1]!, cwd));
  }

  // `replace` re-walks the same matches in the same order, so splicing the
  // results back in stays the sync path's mechanism rather than a second
  // hand-rolled one. A function replacement is inserted literally, so `$&`
  // in command output cannot be reinterpreted.
  let next = 0;
  return content.replace(SKILL_SHELL_EXPANSION_PATTERN, () => expansions[next++]!);
}

function runSkillShellCommand(match: string, command: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-lc", command],
      {
        cwd,
        ...SKILL_SHELL_EXPANSION_OPTIONS,
      },
      (error, stdout) => {
        resolve(error ? failedSkillShellExpansion(match, error) : stdout.trimEnd());
      },
    );
  });
}

function failedSkillShellExpansion(match: string, error: unknown): string {
  // Keep the literal token visible on failure so the model can see what was
  // attempted. Node reports timeout termination through the child signal.
  const signal = (error as { signal?: string } | null)?.signal;
  const note =
    signal === "SIGTERM"
      ? `timed out after ${SKILL_SHELL_EXPANSION_TIMEOUT_MS / 1000}s`
      : `failed: ${error instanceof Error ? error.message : String(error)}`;
  return `${match} (${note})`;
}

async function expandSkillMetadata(skill: Skill): Promise<Skill> {
  return {
    ...skill,
    description: await expandSkillShellCommands(skill.description, skill.baseDir),
  };
}

export function prepareExplicitSkills(skills: readonly Skill[]): Promise<Skill[]> {
  return expandSkillMetadataConcurrently(skills);
}

export async function loadDiscoveredSkills(
  discoveryOptions: SkillDiscoveryOptions | undefined,
  cwd: string,
): Promise<DiscoveredSkillsResult> {
  const { skills, diagnostics } = loadSkills(buildSkillDiscoveryOptions(discoveryOptions, cwd));
  // User/project skills win on name collisions, so built-ins are merged
  // last and silently dropped when shadowed.
  return {
    skills: mergeSkillsByName(await expandSkillMetadataConcurrently(skills), listBuiltInSkills()),
    collisions: extractSkillCollisions(diagnostics),
  };
}

async function expandSkillMetadataConcurrently(skills: readonly Skill[]): Promise<Skill[]> {
  const expanded: Skill[] = [];
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(SKILL_METADATA_EXPANSION_CONCURRENCY, skills.length) },
    async () => {
      while (nextIndex < skills.length) {
        const index = nextIndex++;
        expanded[index] = await expandSkillMetadata(skills[index]!);
      }
    },
  );
  await Promise.all(workers);
  return expanded;
}

/**
 * Discover installed skills without running shell-expansion in their metadata.
 * Intended for read-only listing (e.g. `duet skills`) where executing the
 * skills' shell commands would be a side effect users don't want.
 */
export function discoverInstalledSkills(cwd: string): DiscoveredSkillsResult {
  const { skills, diagnostics } = loadSkills(buildSkillDiscoveryOptions(undefined, cwd));
  return {
    skills: mergeSkillsByName(skills, listBuiltInSkills()),
    collisions: extractSkillCollisions(diagnostics),
  };
}

function extractSkillCollisions(diagnostics: ResourceDiagnostic[]): SkillCollision[] {
  const collisions: SkillCollision[] = [];
  for (const diagnostic of diagnostics) {
    const collision = diagnostic.collision;
    if (diagnostic.type !== "collision" || !collision || collision.resourceType !== "skill") {
      continue;
    }
    collisions.push({
      name: collision.name,
      winnerPath: collision.winnerPath,
      loserPath: collision.loserPath,
    });
  }
  return collisions;
}

export function mergeSkillsByName(primary: readonly Skill[], secondary: readonly Skill[]): Skill[] {
  const merged = [...primary];
  const seenNames = new Set(primary.map((skill) => skill.name));
  for (const skill of secondary) {
    if (!seenNames.has(skill.name)) {
      merged.push(skill);
    }
  }
  return merged;
}

export function readSkillInstructions(skill: Skill): string {
  // Built-in skills ship inline with the package, so they have no on-disk
  // SKILL.md to read. Their bodies are static and never contain shell
  // expansions, so we return them verbatim.
  const builtIn = getBuiltInSkillInstructions(skill.filePath);
  if (builtIn !== undefined) return builtIn;
  const content = readFileSync(skill.filePath, "utf-8");
  return expandSkillShellCommandsSync(content, skill.baseDir);
}

/**
 * Resolve the effective scope of a skill based on which discovery root it
 * actually lives under.
 *
 * pi-coding-agent only labels a single user dir + a single project dir as
 * "user"/"project" — anything else routes to "temporary". duet-agent scans
 * three roots (.duet, .agents, .claude) per scope, so we re-label here so
 * downstream consumers get the truth instead of mostly-"temporary".
 */
export function resolveSkillScope(
  skill: Skill,
  cwd: string,
): "user" | "project" | "temporary" | "builtin" {
  if (isBuiltInSkill(skill)) return "builtin";
  const baseDir = resolve(skill.baseDir);
  const home = homedir();
  for (const dirName of DEFAULT_SKILL_DIR_NAMES) {
    if (isUnderPath(baseDir, join(home, dirName, "skills"))) return "user";
  }
  for (const ancestor of walkAncestors(cwd)) {
    for (const dirName of DEFAULT_SKILL_DIR_NAMES) {
      if (isUnderPath(baseDir, join(ancestor, dirName, "skills"))) return "project";
    }
  }
  return "temporary";
}

function isUnderPath(target: string, root: string): boolean {
  const normalizedRoot = resolve(root);
  if (target === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  return target.startsWith(prefix);
}
