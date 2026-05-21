import { describe, expect } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { rebuildMemoryContextPack } from "../src/memory/context-pack.js";
import {
  DEFAULT_EFFECTIVE_CONTEXT,
  resolveObservationalMemorySettings,
  updateObservationalMemory,
} from "../src/memory/observational.js";
import { DEFAULT_CLI_MEMORY_MODEL } from "../src/model-resolution/resolver.js";
import { createAssistantMessage } from "../test/helpers/messages.js";
import { createMemoryFixture, type MemoryFixture } from "../test/helpers/memory-fixture.js";
import { testIfDocker } from "../test/helpers/docker-only.js";
import { judgeUserSteersPreserved } from "./helpers/reflection-judge.js";

/**
 * Decision traces (alternatives considered, user steers, conventions
 * applied, prior precedent) have to survive THREE layers before they
 * can help a future agent. The shape is borrowed from Foundation
 * Capital's "Context Graphs: AI's Trillion-Dollar Opportunity":
 *
 *   https://foundationcapital.com/ideas/context-graphs-ais-trillion-dollar-opportunity
 *
 *
 *   1. Observer            — extracts the trace from raw messages
 *   2. In-session reflector — collapses a session's observations
 *                             into one rolled-up blob
 *   3. Global reflector    — atomizes the cross-session pool into
 *                             durable rows via `duet memory reflect`
 *
 * If any layer strips the trace, every layer downstream is starved.
 *
 * The in-session and global reflectors share `buildReflectorSystemPrompt`,
 * so `evals/memory-reflect-units.eval.ts` already gates the reflector
 * prompt against the user-steer-preservation judge for both layers.
 * The remaining layer to gate independently is the OBSERVER itself —
 * if it never writes the steer down, nothing downstream can recover it.
 *
 * This eval drives `updateObservationalMemory` end-to-end against the
 * live observer model with a message stream that contains a clear,
 * verbatim user steer, and asserts the resulting observation row
 * preserves the steer.
 */

const memoryModel = process.env.EVAL_MEMORY_MODEL ?? DEFAULT_CLI_MEMORY_MODEL;
const settings = resolveObservationalMemorySettings(DEFAULT_EFFECTIVE_CONTEXT);

async function readSessionObservations(
  fixture: MemoryFixture,
  sessionId: string,
): Promise<string[]> {
  const result = await fixture.session.withDb(async (db) =>
    db.query<{ content: string }>(
      "SELECT content FROM observations WHERE session_id = $1 ORDER BY created_at DESC",
      [sessionId],
    ),
  );
  return (result?.rows ?? []).map((row) => row.content);
}

async function runObserverTurn(
  fixture: MemoryFixture,
  sessionId: string,
  messages: AgentMessage[],
): Promise<void> {
  await rebuildMemoryContextPack({
    session: fixture.session,
    cache: fixture.cache,
    settings,
    sessionId,
  });

  await updateObservationalMemory({
    session: fixture.session,
    memory: fixture.cache,
    sessionId,
    effectiveContext: DEFAULT_EFFECTIVE_CONTEXT,
    actorModel: memoryModel,
    messages,
  });
}

describe("decision-trace preservation across memory layers", () => {
  testIfDocker(
    "observer captures the user's explicit steer when it overrides a default",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        const sessionId = "session_observer_steer";
        const messages: AgentMessage[] = [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Quick CLI question on duet-agent: where should I put the new " +
                  "`memory inspect` subcommand — under `src/cli/memory.ts` like " +
                  "`reflect`, or in its own `src/cli/memory-inspect.ts`?",
              },
            ],
            timestamp: Date.now(),
          },
          createAssistantMessage({
            text:
              "Two options: (a) extend `src/cli/memory.ts` with the subcommand " +
              "inline, (b) split it into `src/cli/memory-inspect.ts` to mirror " +
              "`src/cli/memory-reflect.ts`. I'd lean toward (a) since the " +
              "command is small.",
            timestamp: Date.now() + 1,
          }),
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "No, please split it into `src/cli/memory-inspect.ts` — I want " +
                  "every memory subcommand in its own file so the CLI surface " +
                  "stays scannable. Treat that as the project convention going " +
                  "forward.",
              },
            ],
            timestamp: Date.now() + 2,
          },
          createAssistantMessage({
            text:
              "Understood. I'll put it in `src/cli/memory-inspect.ts` and route " +
              "the dispatcher in `src/cli/memory.ts` to it, matching " +
              "`memory-reflect.ts`.",
            timestamp: Date.now() + 3,
          }),
        ];

        await runObserverTurn(fixture, sessionId, messages);

        const observations = await readSessionObservations(fixture, sessionId);
        expect(observations.length).toBeGreaterThan(0);

        const steers = [
          "User redirected the CLI placement: every memory subcommand should " +
            "live in its own file (e.g., `src/cli/memory-inspect.ts`), not be " +
            "bundled into `src/cli/memory.ts`. Treat as the project convention " +
            "for future memory subcommands.",
        ];
        const verdict = await judgeUserSteersPreserved(observations, steers);
        expect(verdict.valid, verdict.reason).toBe(true);
      } finally {
        await fixture.dispose();
      }
    },
    360_000,
  );
});
