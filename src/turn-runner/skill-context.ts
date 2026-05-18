import type { Skill } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { toXML } from "../lib/xml.js";
import type { TurnRunnerConfig } from "../types/config.js";
import type { TurnAgentFile } from "../types/protocol.js";
import type { StateMachineAgentState } from "../types/state-machine.js";
import { createSystemPromptWithAppendedLayers } from "./prompts.js";
import {
  loadDiscoveredSkills,
  mergeSkillsByName,
  prepareExplicitSkills,
  readSkillInstructions,
  type SkillCollision,
} from "./skills.js";

export class SkillContext {
  private skills: Skill[];
  private collisions: SkillCollision[] = [];
  private loaded = false;

  constructor(private readonly config: TurnRunnerConfig) {
    this.skills = config.skills ? prepareExplicitSkills(config.skills) : [];
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    const discovered = loadDiscoveredSkills(
      this.config.skillDiscovery,
      this.config.cwd ?? process.cwd(),
    );
    this.skills = mergeSkillsByName(this.skills, discovered.skills);
    this.collisions = discovered.collisions;
  }

  getSkills(): readonly Skill[] {
    return [...this.skills];
  }

  getSkillCollisions(): readonly SkillCollision[] {
    return this.collisions;
  }

  getSkillInstructions(skillId: string): string {
    const skill = this.skills.find((s) => s.name === skillId);
    return skill ? readSkillInstructions(skill) : "";
  }

  resolveStateAgentSkills(state: StateMachineAgentState): Skill[] | undefined {
    if (!state.allowedSkills) return undefined;

    const skillsByName = new Map(this.skills.map((skill) => [skill.name, skill]));
    const missing = state.allowedSkills.filter((name) => !skillsByName.has(name));
    if (missing.length > 0) {
      throw new Error(`Unknown allowedSkills for state "${state.name}": ${missing.join(", ")}`);
    }

    return state.allowedSkills.map((name) => skillsByName.get(name)!);
  }

  resolveSlashSkillPrompt(prompt: string): string {
    const slash = parseSlashCommands(prompt);
    if (slash.commands.length === 0) return prompt;

    const skillBlocks: string[] = [];
    for (const command of slash.commands) {
      const skill = this.skills.find((item) => item.name === command);
      if (!skill) continue;

      const instructions = readSkillInstructions(skill).trim();
      skillBlocks.push(
        [
          `<skill name="${skill.name}">`,
          "Use the following skill instructions for this request.",
          "<instructions>",
          instructions,
          "</instructions>",
          "</skill>",
        ].join("\n"),
      );
    }

    if (skillBlocks.length === 0) return prompt;

    return [prompt, ...skillBlocks].join("\n\n");
  }

  createSystemPromptWithAppendedLayers(input?: {
    append?: Array<string | undefined>;
    skills?: readonly Skill[];
  }): string {
    return createSystemPromptWithAppendedLayers({
      config: this.config,
      skills: input?.skills ?? this.skills,
      systemPromptFiles: this.readSystemPromptFileLayers(),
      append: input?.append ?? [],
    });
  }

  /** System-prompt files (AGENTS.md by default) that exist on disk. */
  getResolvedAgentFiles(): TurnAgentFile[] {
    const cwd = this.config.cwd ?? process.cwd();
    const fileNames = this.config.systemPromptFiles ?? ["AGENTS.md"];
    const resolved: TurnAgentFile[] = [];
    for (const fileName of fileNames) {
      // Hosts like the chat-app agent-gateway pass an absolute path to a
      // session-scoped system-prompt file that lives outside `cwd`. `join`
      // would strip the leading slash and turn it into a non-existent path
      // under `cwd`, silently dropping the layer, so honor absolute paths
      // verbatim and only join when the caller passed a relative name.
      const path = isAbsolute(fileName) ? fileName : join(cwd, fileName);
      if (existsSync(path)) {
        resolved.push({ name: isAbsolute(fileName) ? basename(fileName) : fileName, path });
      }
    }
    return resolved;
  }

  private readSystemPromptFileLayers(): string[] {
    const layers: string[] = [];
    for (const file of this.getResolvedAgentFiles()) {
      layers.push(
        toXML({
          system_prompt_file: {
            _attrs: { path: file.name },
            content: readFileSync(file.path, "utf-8").trim(),
          },
        }),
      );
    }
    return layers;
  }
}

function parseSlashCommands(prompt: string): {
  commands: string[];
} {
  const tokens = prompt.trim().split(/\s+/);
  const commands: string[] = [];

  for (const token of tokens) {
    const match = token.match(/^\/([A-Za-z0-9_.-]+)$/);
    if (match) {
      commands.push(match[1]!);
    }
  }

  return { commands };
}
