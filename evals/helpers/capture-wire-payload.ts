import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { existsSync } from "node:fs";

import { rebuildMemoryContextPack } from "../../src/memory/context-pack.js";
import { SkillContext } from "../../src/turn-runner/skill-context.js";
import type { TurnRunnerConfig } from "../../src/types/config.js";
import {
  DEFAULT_EFFECTIVE_CONTEXT,
  createObservationalContextTransform,
  resolveObservationalMemorySettings,
  stripObservationalContextMessages,
} from "../../src/memory/observational.js";
import {
  applyEvictionHorizon,
  calculateWireBytes,
  calculateWireTokens,
  createInitialHorizon,
} from "../../src/turn-runner/wire-shaping.js";
import type { Observation } from "../../src/types/memory.js";
import type { WireGuardHorizon } from "../../src/types/protocol.js";
import type { MemoryFixture } from "../../test/helpers/memory-fixture.js";
import { createMemoryFixture } from "../../test/helpers/memory-fixture.js";

/**
 * Raw shape of a row written by `bun run scripts/dump-memory.ts`. Memory
 * dumps for wire-payload reproductions are read straight from the JSON
 * the script emits — no derived seed file required.
 */
interface DumpedRow {
  id: string;
  createdAt: number;
  lastUsedAt: number;
  sessionId?: string;
  kind: Observation["kind"];
  observedDate: string;
  referencedDate?: string;
  relativeDate?: string;
  timeOfDay?: string;
  priority: Observation["priority"];
  source: Observation["source"];
  content: string;
  tags?: string[];
}

/**
 * Subset of `TurnState` that the wire-shaping transform actually reads.
 * Driven from a real session state.json so the captured payload matches
 * what the runner would have dispatched at that moment.
 */
interface MinimalTurnState {
  agent: { messages: AgentMessage[] };
  wireGuardHorizon?: WireGuardHorizon;
}

export interface CapturedWirePayloadOptions {
  /**
   * Parsed `state.json` for the session being reproduced — either pass
   * the whole `TurnState` or `{ state: TurnState }` as written by
   * `~/.duet/sessions/<id>/state.json`.
   */
  turnState: MinimalTurnState | { state: MinimalTurnState };
  /** Parsed `memory-dump.json` (output of `bun run scripts/dump-memory.ts --pretty`). */
  memoryDump: DumpedRow[];
  /** Session id passed to the context-pack loader so its rows land in the local layer. */
  sessionId: string;
  /**
   * Effective context window the runner was using. Drives every
   * derived memory budget. Defaults to the production default
   * (`DEFAULT_EFFECTIVE_CONTEXT`) so a missing value reproduces the
   * 200k-window behavior most sessions experience.
   */
  effectiveContext?: number;
  /**
   * Working directory the original session ran from. Used to rebuild
   * the AGENTS.md system-prompt layer the same way the runner did.
   * Defaults to `process.cwd()` so calling the harness from inside
   * the same repo reproduces that repo's AGENTS.md verbatim.
   * Observations on the session usually carry `cwd="..."` attributes
   * that name the path explicitly.
   */
  cwd?: string;
  /**
   * `systemInstructions` the runner was started with. Most sessions
   * leave this unset (the CLI does not inject extra instructions),
   * but evals can pass a verbatim copy when they know the session
   * was launched with a non-default value.
   */
  systemInstructions?: string;
  /**
   * Skill-discovery overrides. Defaults to production discovery so
   * the captured system prompt includes the same skill block the
   * runner would have rendered. Pass `{ includeDefaults: false }` to
   * keep the prompt cheap when the bug under test does not depend
   * on skills.
   */
  skillDiscovery?: TurnRunnerConfig["skillDiscovery"];
  /**
   * Pinned system prompt string. When set, the harness skips the
   * live `createSystemPromptWithAppendedLayers` rebuild and returns
   * this exact string as `payload.systemPrompt` (with an empty
   * `systemPromptFiles`). Pass the contents of a committed
   * `system-prompt.txt` fixture so the eval reproduces what the
   * model actually saw at capture time — otherwise the rebuild
   * walks the CURRENT cwd's AGENTS.md and discovered skills, which
   * drift independently of the captured session.
   */
  systemPromptOverride?: string;
}

export interface CapturedWirePayload {
  /**
   * Full system prompt the runner would have sent on this turn.
   * When `systemPromptOverride` is set on the options, this is
   * that pinned string verbatim; otherwise it is composed via the
   * production `createSystemPromptWithAppendedLayers` over the
   * captured `cwd`'s AGENTS.md and discovered skills. Pair with
   * `dispatched` to reproduce the exact provider request.
   */
  systemPrompt: string;
  /**
   * Absolute paths of every AGENTS.md / system-prompt file that
   * resolved on disk for this capture. Empty when
   * `systemPromptOverride` skipped the live rebuild, since a pinned
   * snapshot has no on-disk provenance.
   */
  systemPromptFiles: string[];
  /** Eviction horizon read off the input state before the transform ran. */
  horizonBefore: number;
  /** Eviction horizon after the transform ran. Differs only when the transform itself advanced it (token/byte trigger fired). */
  horizonAfter: number;
  /** Raw transcript message count before the horizon was applied. */
  rawMessageCount: number;
  /**
   * Real (non-synthetic) message count that survived the horizon.
   * Zero is the failure shape: every real user/tool message got evicted.
   */
  retainedMessageCount: number;
  /**
   * The two synthetic user messages the transform prepends: the
   * `<observations>` block and the `<continuation hint>`. Captured by
   * byte length + a short preview so assertions can check "memory pack
   * is non-empty" without dumping the entire rendered prefix.
   */
  syntheticPrepends: Array<{
    role: AgentMessage["role"];
    kind: "observation-context" | "continuation-hint" | "other";
    bytes: number;
    preview: string;
  }>;
  /** Exact AgentMessage[] that would hit the provider on this turn. */
  dispatched: AgentMessage[];
  dispatchedBytes: number;
  dispatchedTokens: number;
  /** Whether the dispatch contains any real `user` role from the original transcript (post-horizon). */
  dispatchedHasRealUser: boolean;
}

const OBSERVATION_PREFIX = "<system-reminder>";

function unwrapTurnState(input: CapturedWirePayloadOptions["turnState"]): MinimalTurnState {
  if ("state" in input && (input as { state?: unknown }).state) {
    return (input as { state: MinimalTurnState }).state;
  }
  return input as MinimalTurnState;
}

function classifyPrepend(
  message: AgentMessage,
): "observation-context" | "continuation-hint" | "other" {
  if (message.role !== "user") return "other";
  const text = messageText(message);
  if (!text.startsWith(OBSERVATION_PREFIX)) return "other";
  // The continuation reminder is a single short system-reminder line;
  // the observations reminder carries the rendered `<observations>` block.
  if (text.includes("<observations>")) return "observation-context";
  return "continuation-hint";
}

function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "",
      )
      .join("");
  }
  return "";
}

function messageBytes(message: AgentMessage): number {
  return calculateWireBytes([message]);
}

function preview(message: AgentMessage, limit = 200): string {
  const text =
    messageText(message) || JSON.stringify((message as { content?: unknown }).content ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

async function seedDump(fixture: MemoryFixture, dump: DumpedRow[]): Promise<void> {
  for (const row of dump) {
    const observation = await fixture.append({
      ...(row.sessionId !== undefined ? { sessionId: row.sessionId } : {}),
      kind: row.kind,
      observedDate: row.observedDate,
      ...(row.referencedDate !== undefined ? { referencedDate: row.referencedDate } : {}),
      ...(row.relativeDate !== undefined ? { relativeDate: row.relativeDate } : {}),
      ...(row.timeOfDay !== undefined ? { timeOfDay: row.timeOfDay } : {}),
      priority: row.priority,
      source: row.source,
      content: row.content,
      tags: row.tags ?? [],
    });
    // Preserve the original timestamps from the dump so recency-bias
    // scoring in `loadGlobalPack` reproduces the relative ordering the
    // failing session actually saw.
    await fixture.session.withDb(
      async (db: { query: (sql: string, params: unknown[]) => Promise<unknown> }) => {
        await db.query("UPDATE observations SET created_at = $1, last_used_at = $2 WHERE id = $3", [
          row.createdAt,
          row.lastUsedAt,
          observation.id,
        ]);
      },
    );
  }
}

/**
 * Reproduce the exact `AgentMessage[]` the runner would have dispatched
 * to the provider on the next turn of a saved session.
 *
 * Builds a fresh `MemorySession` populated from a `dump-memory.ts`
 * fixture, calls `rebuildMemoryContextPack` with the failing session id
 * so global + local layers split the same way they did live, then runs
 * `createObservationalContextTransform` over the session's stored
 * messages with the persisted `wireGuardHorizon`. The returned wire
 * payload is the same shape pi-agent would send — useful for evals
 * that need to assert what the model actually saw at the failure
 * moment instead of guessing from logs.
 *
 * Callers must `dispose()` the returned fixture handle so the temp
 * memory.db is removed.
 */
export async function capturedWirePayload(
  options: CapturedWirePayloadOptions,
): Promise<{ payload: CapturedWirePayload; dispose: () => Promise<void> }> {
  const turnState = unwrapTurnState(options.turnState);
  const effectiveContext = options.effectiveContext ?? DEFAULT_EFFECTIVE_CONTEXT;
  const settings = resolveObservationalMemorySettings(effectiveContext);
  const fixture = await createMemoryFixture();
  try {
    await seedDump(fixture, options.memoryDump);
    await rebuildMemoryContextPack({
      session: fixture.session,
      cache: fixture.cache,
      settings,
      sessionId: options.sessionId,
    });

    const horizon: WireGuardHorizon = turnState.wireGuardHorizon
      ? { ...turnState.wireGuardHorizon }
      : createInitialHorizon();
    const horizonBefore = horizon.evictionHorizon;

    const transform = createObservationalContextTransform({
      memory: fixture.cache,
      effectiveContext,
      horizon,
    });

    const dispatched = await transform(turnState.agent.messages);
    const stripped = stripObservationalContextMessages(dispatched);
    const synthetic = dispatched.filter((m) => !stripped.includes(m));
    const retained = applyEvictionHorizon(
      stripObservationalContextMessages(turnState.agent.messages),
      horizon.evictionHorizon,
    );

    const { systemPrompt, systemPromptFiles } =
      options.systemPromptOverride !== undefined
        ? { systemPrompt: options.systemPromptOverride, systemPromptFiles: [] as string[] }
        : await buildSystemPrompt({
            cwd: options.cwd ?? process.cwd(),
            ...(options.systemInstructions !== undefined
              ? { systemInstructions: options.systemInstructions }
              : {}),
            ...(options.skillDiscovery !== undefined
              ? { skillDiscovery: options.skillDiscovery }
              : {}),
          });

    const payload: CapturedWirePayload = {
      systemPrompt,
      systemPromptFiles,
      horizonBefore,
      horizonAfter: horizon.evictionHorizon,
      rawMessageCount: turnState.agent.messages.length,
      retainedMessageCount: retained.length,
      syntheticPrepends: synthetic.map((m) => ({
        role: m.role,
        kind: classifyPrepend(m),
        bytes: messageBytes(m),
        preview: preview(m),
      })),
      dispatched,
      dispatchedBytes: calculateWireBytes(dispatched),
      dispatchedTokens: calculateWireTokens(dispatched),
      dispatchedHasRealUser: stripped.some((m) => m.role === "user"),
    };

    return {
      payload,
      dispose: async () => {
        await fixture.dispose();
      },
    };
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}

/**
 * Reproduce the runner-shaped system prompt for a captured session.
 *
 * Mirrors what `TurnRunner.createBaseSystemPromptWithAppendedLayers`
 * does: assemble `systemInstructions` + the resolved AGENTS.md layers
 * (walked from the captured cwd) + the tool-execution prompt + the
 * skills block + the current-date layer, via the same exported
 * `createSystemPromptWithAppendedLayers` the runner uses. The skills
 * are discovered with production defaults so the rendered prompt
 * matches what the runner would have sent for the same cwd today.
 *
 * Note: this is a best-effort snapshot — if AGENTS.md or installed
 * skills changed between the original session and the capture run,
 * the system prompt will reflect the current state rather than the
 * historical one. Pin known historical values via `systemInstructions`
 * or commit the original AGENTS.md alongside the fixture when fidelity
 * matters.
 */
async function buildSystemPrompt(input: {
  cwd: string;
  systemInstructions?: string;
  skillDiscovery?: TurnRunnerConfig["skillDiscovery"];
}): Promise<{ systemPrompt: string; systemPromptFiles: string[] }> {
  const config: TurnRunnerConfig = {
    cwd: input.cwd,
    ...(input.systemInstructions !== undefined
      ? { systemInstructions: input.systemInstructions }
      : {}),
    ...(input.skillDiscovery !== undefined ? { skillDiscovery: input.skillDiscovery } : {}),
  };
  const skillContext = new SkillContext(config);
  await skillContext.ensureLoaded();
  const systemPrompt = skillContext.createSystemPromptWithAppendedLayers();
  const systemPromptFiles = skillContext
    .getResolvedAgentFiles()
    .map((file) => file.path)
    .filter((path) => existsSync(path));
  return { systemPrompt, systemPromptFiles };
}
