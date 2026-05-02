import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@mariozechner/pi-coding-agent";
import { loadSkills } from "@mariozechner/pi-coding-agent";
import type { SkillDiscoveryOptions } from "../types/config.js";

const SKILL_SHELL_EXPANSION_PATTERN = /!`([^`\r\n]+)`/g;

function buildSkillDiscoveryOptions(options: SkillDiscoveryOptions | undefined, cwd: string) {
  const agentDir = options?.agentDir ?? join(homedir(), ".agents");
  const includeDefaults = options?.includeDefaults ?? true;
  return {
    cwd: options?.cwd ?? cwd,
    agentDir,
    includeDefaults: false,
    skillPaths: [
      ...(includeDefaults
        ? [join(agentDir, "skills"), join(options?.cwd ?? cwd, ".agents", "skills")]
        : []),
      ...(options?.skillPaths ?? []),
    ],
  };
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
