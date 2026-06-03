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

  /**
   * Re-run skill discovery so newly installed skills show up without
   * restarting the session. The initial explicit skill list from
   * `config.skills` is preserved; on-disk discovery is re-read.
   */
  async reload(): Promise<void> {
    const baseline = this.config.skills ? prepareExplicitSkills(this.config.skills) : [];
    const discovered = loadDiscoveredSkills(
      this.config.skillDiscovery,
      this.config.cwd ?? process.cwd(),
    );
    this.skills = mergeSkillsByName(baseline, discovered.skills);
    this.collisions = discovered.collisions;
    this.loaded = true;
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

  /**
   * Expand `/skill` slash commands in a prompt into injected `<skill>` blocks.
   * `skills` scopes which skills are eligible to expand; callers pass a
   * restricted set (e.g. a state's `allowedSkills`) so a background agent only
   * expands skills it actually has. Defaults to every discovered skill, which
   * is what the parent prompt path wants. Passing `undefined` (the result of
   * `resolveStateAgentSkills` for an unrestricted state) also falls through to
   * the full set.
   */
  resolveSlashSkillPrompt(prompt: string, skills: readonly Skill[] = this.skills): string {
    const slash = parseSlashCommands(prompt);
    if (slash.commands.length === 0) return prompt;

    const skillBlocks: string[] = [];
    for (const command of slash.commands) {
      const skill = skills.find((item) => item.name === command);
      if (!skill) continue;

      const instructions = readSkillInstructions(skill).trim();
      skillBlocks.push(
        [
          // path= lets the agent edit the SKILL.md directly without a
          // discovery step when the user asks to modify the skill itself
          // (e.g. "add this rule to /review").
          `<skill name="${skill.name}" path="${skill.filePath}">`,
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
    prepend?: Array<string | undefined>;
    append?: Array<string | undefined>;
    skills?: readonly Skill[];
  }): string {
    return createSystemPromptWithAppendedLayers({
      config: this.config,
      skills: input?.skills ?? this.skills,
      systemPromptFiles: this.readSystemPromptFileLayers(),
      prepend: input?.prepend ?? [],
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

// Matches the self-closing `<Skill name="..." path="..." />` tag that the
// chat-app compose-bar `/` skill picker emits on both web and mobile when a
// user selects a skill (see
// apps/web/components/chat/compose-bar/primitives/input/features/mention/mention-markdown-codec.ts
// and apps/mobile/src/lib/markdown.ts). We honor the tag as an alias for the
// bare `/<name>` slash command so picker-driven activations get the same
// SKILL.md injection as keyboard-typed ones. The tag spelling is fixed by
// the chat-app codec, so capitalization is exact and the regex stays loose
// only around the `name="..."` attribute position so other attributes (like
// `path="..."`) can sit on either side.
const SKILL_TAG_PATTERN = /<Skill\b[^>]*\bname="([A-Za-z0-9_.-]+)"[^>]*\/>/g;

function parseSlashCommands(prompt: string): {
  commands: string[];
} {
  const commands: string[] = [];

  const tokens = prompt.trim().split(/\s+/);
  for (const token of tokens) {
    const match = token.match(/^\/([A-Za-z0-9_.-]+)$/);
    if (match) {
      commands.push(match[1]!);
    }
  }

  for (const match of prompt.matchAll(SKILL_TAG_PATTERN)) {
    const name = match[1];
    if (name) commands.push(name);
  }

  return { commands };
}
