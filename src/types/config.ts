import type { Skill, loadSkills } from "@earendil-works/pi-coding-agent";
import type { GuardrailConfig } from "./guardrails.js";
import type { ObservationalMemorySettingsInput } from "./memory.js";
import type { TurnMode, TurnOptions } from "./protocol.js";
import type { AutoStateCompactionOptions } from "../turn-runner/state-compaction.js";

/** Directly mirrors pi-coding-agent's loadSkills options. */
export type SkillDiscoveryOptions = Partial<Parameters<typeof loadSkills>[0]>;

export interface TurnRunnerConfig extends TurnOptions {
  /**
   * Session that owns this runner. Plumbed into newly-written observations
   * so the memory loader can split them into the local layer (current
   * session) and the global layer (every other session). Sub-agents
   * spawned for state-machine work derive their own id from this one
   * (`<parent>:sub:<nanoid>`) so their scratch observations stay scoped
   * to the sub-agent and do not pollute the parent's local layer.
   *
   * Optional only because direct TurnRunner construction (tests, one-shot
   * tools) may not have a session. Real CLI/Session callers always set it.
   */
  sessionId?: string;
  /**
   * Target ceiling, in tokens, for the actor model's per-turn input. Every
   * memory budget (raw-message compaction trigger, raw-tail buffer,
   * reflection trigger and buffer, global pack budget) is derived from this
   * single number via fixed ratios in `deriveMemoryBudgets`; see
   * `MEMORY_BUDGET_RATIOS` in `src/memory/observational.ts` for the table.
   *
   * Defaults to 200_000. The runner clamps the resolved value to
   * `min(effectiveContext, model.contextWindow)` at use-time so a user
   * value larger than the model's hard window silently caps at the window
   * instead of overflowing.
   */
  effectiveContext?: number;
  memory?: ObservationalMemorySettingsInput;
  /**
   * PGlite database directory for durable observational memories.
   * SessionManager defaults this to
   * `~/.duet/memory.db`; pass `false` to keep memories in process only.
   */
  memoryDbPath?: string | false;
  cwd?: string;
  /** Default mode for TurnRunner.turn. "auto" lets the runner classify each prompt. */
  mode?: TurnMode;
  guardrails?: GuardrailConfig[];
  systemInstructions?: string;
  /**
   * Files loaded from `cwd` and appended to the base system prompt.
   *
   * Defaults to `["AGENTS.md"]` so repository-local agent guidance is included
   * automatically. Set to `[]` to disable file loading, or provide an explicit
   * ordered list to replace the default.
   */
  systemPromptFiles?: string[];
  skills?: Skill[];
  /**
   * Controls filesystem skill discovery. Defaults search both Duet-specific
   * `.duet/skills` and standard `.agents/skills` directories in `cwd` and the
   * user's home directory; set `includeDefaults: false` to rely only on
   * explicit `skills` or `skillPaths`.
   */
  skillDiscovery?: SkillDiscoveryOptions;
  /**
   * Auto state compaction. When enabled, the runner caps emitted/returned
   * `TurnState` at `maxBytes` (default 100 MB) by evicting the oldest agent
   * messages first. Applied inside `snapshotState`, so every event, terminal
   * payload, and `getState()` return value is already trimmed before it
   * leaves the runner. Down-stream persistence (e.g. `state.json`) inherits
   * the cap for free.
   *
   * - `true` or omitted enables the cap at `DEFAULT_STATE_MAX_BYTES`.
   * - `false` disables compaction entirely.
   * - Pass `{ maxBytes }` to override the ceiling for this runner.
   *
   * On by default with a 100 MB ceiling — `state.json` is otherwise unbounded
   * and a runaway transcript will eventually wedge persistence. Opt out per-
   * runner (`autoStateCompaction: false`) when a test or short-lived session
   * needs the full transcript verbatim.
   */
  autoStateCompaction?: AutoStateCompactionOptions | boolean;
}
