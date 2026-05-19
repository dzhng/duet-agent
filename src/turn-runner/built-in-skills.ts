import dedent from "dedent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";

/**
 * Synthetic marker prefix for built-in skill `filePath`/`baseDir`. Real
 * skills live under a discoverable `baseDir` on disk; built-ins ship
 * inside the package, so the prefix is a virtual sentinel that keeps
 * their paths from colliding with anything on the filesystem and gives
 * humans a clear hint when they appear in logs or `duet skills` output.
 * Built-in detection itself goes through the `BUILT_IN_BY_PATH` map, not
 * a prefix match.
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

  ## Running multiple scheduled tasks (cron-style) in ONE state machine

  Only one state machine can be active per session, so when the user wants
  several recurring jobs ("replace my crons", "run these N tasks on
  different cadences"), do NOT try to spin up one relay per task. Build a
  single master relay that multiplexes them all. This pattern is proven
  in production.

  ### Architecture

  - **Schedule file** (e.g. \`~/.duet/relay/schedule.json\`):
    \`{ "<task>": { "interval": <ms>, "next": <unix-ms>, "kind": "agent"|"script" } }\`.
    This is the only source of truth for "what's due when."
  - **Dispatcher script** (e.g. \`~/.duet/relay/dispatch.sh\`): reads
    \`schedule.json\`, sorted by \`next\` ascending. For every due task:
      - If \`kind: "script"\` (shell-only): run inline inside the dispatcher,
        append output to a bounded log, then bump \`next += interval\` and
        keep looking. The orchestrator never wakes for these.
      - If \`kind: "agent"\` (needs an LLM): write the task name to
        \`next-agent.txt\`, echo it on stdout, \`exit 0\` so the poll state
        treats this attempt as successful and wakes the orchestrator.
      - For known-noisy agents (e.g. inbox triage), pre-check cheaply
        from shell first (e.g. count IMAP unread). If there's nothing to
        do, skip the wake and just bump \`next\`.
    If no due task needed a wake: \`exit 1\` (poll keeps polling).
  - **Log file**: always size-bounded (\`tail -n 500\` rotate, or similar).
    Long-running relays will fill any unbounded log.

  ### State machine shape

  - One \`poll\` state with \`intervalMs\` ≥ the platform floor that runs
    the dispatcher script. \`successCodes: [0]\` so it only wakes the
    orchestrator when an agent task is queued.
  - One \`agent\` state **per agent task** (\`run-inbox\`,
    \`run-growth-report\`, etc.). Each prompt is narrow — just that one
    task's instructions — and ends with the same footer:
      1. Bump \`schedule.json\` for this task (\`while next <= now: next += interval\`).
      2. \`rm -f next-agent.txt\` to clear the signal.
      3. Reply with one terse line of result.
  - A \`stop\` terminal so the operator can cancel cleanly.

  ### Orchestrator loop

  On wake: read \`next-agent.txt\` (the dispatcher wrote which agent is due),
  select the matching \`run-*\` state. After the agent completes, re-select
  \`poll\`. That's it — no scheduling logic in the orchestrator; the
  dispatcher and the agent footers own the math.

  ### Why this works

  - The orchestrator only consumes parent-context tokens when there is
    actual agent work to do. Quiet hours cost zero.
  - Shell tasks and zero-work agent checks run silently inside the poll.
  - Bumping \`next\` with the \`while\` loop catches up automatically if a
    task fell several intervals behind (e.g. after sandbox downtime).
  - One file (\`schedule.json\`) plus one script (\`dispatch.sh\`) is the
    whole surface area; adding a new cron is a single JSON entry and a
    branch in the dispatcher (plus, for agent tasks, one new \`run-*\`
    state).
`;

const RELAY_DESCRIPTION =
  "Run durable, multi-step, or recurring work as a state machine of sub-agent, script, poll, and timer states so the work survives session boundaries and progress stays visible to the user.";

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
