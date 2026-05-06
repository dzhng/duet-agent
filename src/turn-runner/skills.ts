import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@mariozechner/pi-coding-agent";
import { loadSkills } from "@mariozechner/pi-coding-agent";
import type { SkillDiscoveryOptions } from "../types/config.js";

const SKILL_SHELL_EXPANSION_PATTERN = /!`([\s\S]*?)`/g;
const DEFAULT_SKILL_DIR_NAMES = [".duet", ".agents"] as const;

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
  return [
    ...globalSkillRoots.map((root) => join(root, "skills")),
    ...DEFAULT_SKILL_DIR_NAMES.map((dirName) => join(cwd, dirName, "skills")),
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
): Skill[] {
  const { skills } = loadSkills(buildSkillDiscoveryOptions(discoveryOptions, cwd));
  return skills.map(expandSkillMetadata);
}

/**
 * Discover installed skills without running shell-expansion in their metadata.
 * Intended for read-only listing (e.g. `duet skills`) where executing the
 * skills' shell commands would be a side effect users don't want.
 */
export function discoverInstalledSkills(cwd: string): Skill[] {
  const { skills } = loadSkills(buildSkillDiscoveryOptions(undefined, cwd));
  return skills;
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
