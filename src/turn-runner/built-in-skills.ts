import dedent from "dedent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";

/**
 * Synthetic marker prefix for built-in skill paths. Real skills live under
 * a discoverable `baseDir` on disk; built-ins are shipped inside the
 * package itself, so their `filePath`/`baseDir` are virtual sentinels.
 * They must be unique and stable so `readSkillInstructions` and
 * `resolveSkillScope` can detect a built-in without filesystem access.
 */
const BUILTIN_PATH_PREFIX = "<duet-builtin>";

export interface BuiltInSkill {
  /** Skill metadata exposed through the standard discovery API. */
  skill: Skill;
  /** Inline SKILL.md body. Returned by `readSkillInstructions`. */
  instructions: string;
}

/**
 * Body of the built-in `/relay` skill. Renders into the prompt verbatim
 * inside the standard `<skill>` wrapper when the user types `/relay`
 * anywhere in their message.
 */
const RELAY_INSTRUCTIONS = dedent`
  The user requested relay mode for this prompt. Strongly prefer the
  state-machine tools (\`create_state_machine_definition\` or
  \`select_state_machine_state\`) over handling the work inline.

  - If no state machine is active, create one with agent/script/poll/timer/terminal
    states sized to the request.
  - If a state machine is already active, select the next state instead of
    replying directly.
  - Only fall back to a plain answer when the request is genuinely a
    one-shot question that cannot be expressed as a state.
`;

const RELAY_DESCRIPTION =
  "Inline anywhere in a prompt to nudge the agent into state-machine (relay) mode.";

function buildBuiltIn(name: string, description: string, instructions: string): BuiltInSkill {
  const baseDir = `${BUILTIN_PATH_PREFIX}/${name}`;
  const filePath = `${baseDir}/SKILL.md`;
  return {
    skill: {
      name,
      description,
      filePath,
      baseDir,
      sourceInfo: createSyntheticSourceInfo(filePath, {
        source: "duet:builtin",
        scope: "user",
        origin: "top-level",
        baseDir,
      }),
      disableModelInvocation: false,
    },
    instructions,
  };
}

/**
 * Registry of built-in skills shipped with the turn runner. They appear
 * in skill discovery alongside user/project skills and can be shadowed
 * by a same-named skill installed under any discovery root.
 */
export const BUILT_IN_SKILLS: readonly BuiltInSkill[] = [
  buildBuiltIn("relay", RELAY_DESCRIPTION, RELAY_INSTRUCTIONS),
];

const BUILT_IN_BY_PATH = new Map(
  BUILT_IN_SKILLS.map(({ skill, instructions }) => [skill.filePath, instructions]),
);

/**
 * Return the in-memory SKILL.md body for a built-in skill, or `undefined`
 * when the skill is not a built-in (so the caller can fall back to
 * reading from disk).
 */
export function getBuiltInSkillInstructions(filePath: string): string | undefined {
  return BUILT_IN_BY_PATH.get(filePath);
}

export function isBuiltInSkill(skill: Skill): boolean {
  return BUILT_IN_BY_PATH.has(skill.filePath);
}

/** Snapshot of built-in skills as plain `Skill` records for merging into discovery results. */
export function listBuiltInSkills(): Skill[] {
  return BUILT_IN_SKILLS.map(({ skill }) => skill);
}
