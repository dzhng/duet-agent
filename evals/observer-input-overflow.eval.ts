import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { createAssistantMessage } from "../test/helpers/messages.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

/**
 * End-to-end repro for the observer overflowing the memory model's
 * hard context window.
 *
 * Production root cause: `updateObservationalMemory` used to send the
 * entire unobserved message tail to the observer in a single call,
 * and the watermark only advances when the observer actually records
 * an observation (see `getLastObservedMessageIndex`). A run of turns
 * where the observer correctly returns `hasMemory=false` — the
 * agent's own guidelines call for that whenever the exchange just
 * restates re-runnable ground truth like file reads, listings, or
 * grep output — accumulates indefinitely until the next observer
 * call overflows the memory model's 200k-token window.
 *
 * Fix: the runner trims the unobserved tail to
 * `FIXED_OBSERVER_BUDGETS.maxTranscriptTokens` from the oldest end
 * before each observer call, including a partial boundary message.
 * The dropped prefix was already shown to the observer (and rejected
 * as low-signal) on prior turns, so the trim is information-
 * preserving in practice.
 *
 * Eval drives the whole pathway through `TurnRunner.start({state})`
 * + `turn()` — the same entry point the session manager and CLI use
 * — so a regression in any of the runner's memory wiring (the
 * `updateMemoryAfterAgentRun` hook, the memory persistence handle,
 * the actor/memory model split) surfaces here.
 *
 * The trigger is a seeded prior transcript large enough that the
 * unobserved tail at the end of one turn would exceed the memory
 * model's window. The seed mimics a long run of routine
 * file-inspection turns the observer would have marked
 * `hasMemory=false`, which is how the tail grows in production.
 */
const actorModel = process.env.EVAL_MODEL ?? "sonnet-4.6";
const memoryModel = process.env.EVAL_MEMORY_MODEL ?? "haiku-4.5";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("observer input overflow", () => {
  testIfDocker(
    "trims the unobserved tail so the observer call fits the memory model window",
    async () => {
      const sessionStoragePath = await mkdtemp(join(tmpdir(), "duet-observer-overflow-"));
      tempDirs.push(sessionStoragePath);

      // Actor uses a roomy model so wire-shaping handles the seeded
      // history on the actor side without tripping the recovery
      // branch. The observer is pinned to `haiku-4.5`, which has a
      // 200k window — the exact ceiling the production bug overflows.
      const runner = new TurnRunner({
        sessionId: "observer-overflow-eval",
        model: actorModel,
        memoryModel,
        mode: "agent",
        skillDiscovery: { includeDefaults: false },
        memoryDbPath: join(sessionStoragePath, "memory.db"),
        cwd: sessionStoragePath,
        systemInstructions:
          "Reply with exactly one word: ok. Do not call tools and do not elaborate.",
      });

      try {
        await runner.start({
          type: "start",
          state: {
            status: "running",
            mode: "agent",
            agent: { status: "running", messages: buildSeededReReadableHistory() },
          },
        });

        const events: TurnEvent[] = [];
        runner.subscribe((event) => events.push(event));

        const terminal = await runner.turn({
          type: "prompt",
          message: "Reply with exactly one word: ok.",
          behavior: "follow_up",
        });

        expect(terminal.type).toBe("complete");
        if (terminal.type !== "complete") throw new Error("expected complete terminal");
        expect(terminal.status).toBe("completed");
        expect(terminal.result?.toLowerCase()).toContain("ok");

        // The observer pipeline either completes silently or emits a
        // `memory` activity event. What it must NOT do is surface a
        // provider overflow as a system error event — that's the
        // production symptom we're guarding against.
        const overflowErrors = events.filter(
          (event): event is Extract<TurnEvent, { type: "system" }> =>
            event.type === "system" &&
            event.level === "error" &&
            /prompt is too long/i.test(event.message),
        );
        expect(overflowErrors).toEqual([]);
      } finally {
        await runner.dispose();
      }
    },
    300_000,
  );
});

/**
 * Build a seeded prior transcript that mimics a long run of routine
 * "read FILE_N / restate its contents" exchanges. Each turn carries
 * a sizable assistant restatement so the cumulative raw transcript
 * comfortably exceeds the memory model's 200k window — the same way
 * a production session reaches the overflow condition after many
 * `hasMemory=false` turns.
 *
 * The actor never sees this much input verbatim because the runner's
 * wire-shaping evicts the older prefix on its side; the observer,
 * before the fix, did see the whole thing.
 */
function buildSeededReReadableHistory(): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const base = Date.now();
  const turnCount = 16;
  for (let turn = 0; turn < turnCount; turn++) {
    const filePath = `src/modules/module${turn.toString().padStart(2, "0")}.ts`;
    const restatement = buildRestatement(filePath, synthesizeFileBody(turn));
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `Read ${filePath} and tell me what's in it.`,
        },
      ],
      timestamp: base + turn * 4,
    });
    messages.push(
      createAssistantMessage({
        text: restatement,
        timestamp: base + turn * 4 + 1,
      }),
    );
  }
  return messages;
}

function synthesizeFileBody(turn: number): string {
  const header = `// src/modules/module${turn.toString().padStart(2, "0")}.ts\nexport function module${turn}(input: string): string {\n  return helper(input);\n}\n\n`;
  const filler = Array.from(
    { length: 120 },
    (_, line) =>
      `// line ${line}: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat`,
  ).join("\n");
  return `${header}${filler}\n`;
}

function buildRestatement(filePath: string, fileBody: string): string {
  const intro = `Here's what's in ${filePath}. Routine module file — nothing to remember, you can re-read it any time.\n\n`;
  return `${intro}${fileBody}\n\n${fileBody}\n\n${fileBody}\n\n${fileBody}\n\n${fileBody}`;
}
