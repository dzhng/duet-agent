import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ResourceDiagnostic, Skill } from "@earendil-works/pi-coding-agent";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import type { SkillDiscoveryOptions } from "../types/config.js";

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
  // wins on name collisions).
  return [
    ...DEFAULT_SKILL_DIR_NAMES.map((dirName) => join(cwd, dirName, "skills")),
    ...globalSkillRoots.map((root) => join(root, "skills")),
  ];
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

function expandSkillShellCommands(content: string, cwd: string): string {
  return content.replace(SKILL_SHELL_EXPANSION_PATTERN, (_match, command: string) => {
    const output = execFileSync("bash", ["-lc", command], {
      cwd,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
    return output.trimEnd();
  });
}

function expandSkillMetadata(skill: Skill): Skill {
  return {
    ...skill,
    description: expandSkillShellCommands(skill.description, skill.baseDir),
  };
}

export function prepareExplicitSkills(skills: readonly Skill[]): Skill[] {
  return skills.map(expandSkillMetadata);
}

export function loadDiscoveredSkills(
  discoveryOptions: SkillDiscoveryOptions | undefined,
  cwd: string,
): DiscoveredSkillsResult {
  const { skills, diagnostics } = loadSkills(buildSkillDiscoveryOptions(discoveryOptions, cwd));
  return {
    skills: skills.map(expandSkillMetadata),
    collisions: extractSkillCollisions(diagnostics),
  };
}

/**
 * Discover installed skills without running shell-expansion in their metadata.
 * Intended for read-only listing (e.g. `duet skills`) where executing the
 * skills' shell commands would be a side effect users don't want.
 */
export function discoverInstalledSkills(cwd: string): DiscoveredSkillsResult {
  const { skills, diagnostics } = loadSkills(buildSkillDiscoveryOptions(undefined, cwd));
  return { skills, collisions: extractSkillCollisions(diagnostics) };
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
  const content = readFileSync(skill.filePath, "utf-8");
  return expandSkillShellCommands(content, skill.baseDir);
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
export function resolveSkillScope(skill: Skill, cwd: string): "user" | "project" | "temporary" {
  const baseDir = resolve(skill.baseDir);
  const home = homedir();
  for (const dirName of DEFAULT_SKILL_DIR_NAMES) {
    if (isUnderPath(baseDir, join(home, dirName, "skills"))) return "user";
  }
  for (const dirName of DEFAULT_SKILL_DIR_NAMES) {
    if (isUnderPath(baseDir, join(cwd, dirName, "skills"))) return "project";
  }
  return "temporary";
}

function isUnderPath(target: string, root: string): boolean {
  const normalizedRoot = resolve(root);
  if (target === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  return target.startsWith(prefix);
}
