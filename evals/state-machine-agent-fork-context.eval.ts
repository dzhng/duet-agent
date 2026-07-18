import { describe, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnTerminalEvent } from "../src/types/protocol.js";
import type {
  StateMachineDefinition,
  StateMachineSessionEvent,
} from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * Live eval for the `forkContext` flag on agent states (turn-runner
 * `createStateSubagentRun`). A unit test could prove the helper returns the
 * parent's messages; this eval proves the live state-machine path actually
 * seeds the sub-agent with the parent's transcript when the flag is on, and
 * does NOT when it is off (or omitted), and that the override path can flip
 * it at transition time.
 *
 * Airtight design: an unguessable sentinel is placed in the *parent's* prompt
 * — the user message that starts the turn — not in the state's own prompt,
 * not in any skill, and not in any file on disk. The state prompt asks the
 * sub-agent to reply with the sentinel it should find "in the conversation
 * above" and forbids tool use. A forked sub-agent sees the parent's messages
 * and can reply with the sentinel using zero tool calls. A fresh sub-agent
 * has no transcript to read, so the only realistic ways it could produce the
 * exact sentinel are a tool call (which the assertion rejects) or a random
 * hallucination collision. So:
 *   - forkContext true  ⟹ output contains the sentinel AND zero tool calls.
 *   - forkContext false ⟹ output does NOT contain the sentinel (fresh context).
 *   - override flips false→true ⟹ output contains the sentinel.
 *
 * Prompt-cache note: when forkContext is true the sub-agent reuses the
 * parent's exact system prompt and message history as the cached prefix, so
 * only the new tail user turn is uncached. The live wiring makes that
 * economical; this eval does not measure cache hit rate directly but
 * exercises the same path that produces it.
 */
describe("state machine agent state forkContext", () => {
  testIfDocker(
    "seeds the sub-agent with the parent transcript when forkContext is true",
    async () => {
      const workDir = await createTempWorkDir("sm-fork-true-");
      const sentinel = createSentinel("FORK");
      try {
        const definition: StateMachineDefinition = {
          name: "fork_context_true_eval",
          prompt: "Validate that a forked agent state sees the parent transcript.",
          states: [
            {
              kind: "agent",
              name: "recall_secret",
              forkContext: true,
              prompt: [
                "Earlier in this conversation the user set a secret token.",
                "Find that token in the conversation history above you and reply with",
                "exactly the token and nothing else. Do not call any tools.",
              ].join("\n"),
            },
            {
              kind: "terminal",
              name: "done",
              status: "completed",
              reason: "Fork-context true eval completed.",
            },
          ],
        };

        const runner = new TurnRunner({
          model,
          cwd: workDir,
          mode: definition,
          skillDiscovery: { includeDefaults: false },
          systemInstructions: [
            "This is a live eval. Use select_state_machine_state for every transition.",
            "On the initial prompt, select recall_secret without input.",
            "After recall_secret completes, select done.",
          ].join("\n"),
        });

        const subAgentToolCalls: string[] = [];
        runner.subscribe((event: TurnEvent) => {
          if (event.type !== "step") return;
          if (event.origin?.kind !== "state_machine_agent") return;
          if (event.step.type === "tool_call_start") {
            subAgentToolCalls.push(event.step.toolName);
          }
        });

        const started = await startTurn(runner, {
          mode: definition,
          // The sentinel lives only here — in the parent prompt. A forked
          // sub-agent inherits this message; a fresh one never sees it.
          prompt: `Start the fork-context eval. The secret token is ${sentinel}.`,
        });
        const terminal = await started.turn;

        expectCompleted(terminal);
        expect(terminal.state.stateMachine?.terminal).toMatchObject({
          state: "done",
          status: "completed",
        });
        // Only a sub-agent that inherited the parent transcript can echo the
        // exact sentinel, and only without resorting to tools (which the state
        // prompt forbids and this assertion rejects).
        expect(completedOutput(terminal, "recall_secret")).toContain(sentinel);
        expect(subAgentToolCalls).toEqual([]);
      } finally {
        await removeTempWorkDir(workDir);
      }
    },
    150_000,
  );

  testIfDocker(
    "starts the sub-agent with a fresh transcript when forkContext is omitted",
    async () => {
      const workDir = await createTempWorkDir("sm-fork-default-");
      const sentinel = createSentinel("FRESH");
      try {
        const definition: StateMachineDefinition = {
          name: "fork_context_default_eval",
          prompt: "Validate that an agent state without forkContext starts fresh.",
          states: [
            {
              kind: "agent",
              name: "recall_secret",
              // forkContext intentionally OMITTED: this is the default,
              // and the default must stay fresh-context behavior.
              prompt: [
                "Earlier in this conversation the user set a secret token.",
                "Find that token in the conversation history above you and reply",
                "with exactly the token and nothing else. If there is no prior",
                "conversation history, reply with the single word NONE. Do not",
                "call any tools.",
              ].join("\n"),
            },
            {
              kind: "terminal",
              name: "done",
              status: "completed",
              reason: "Fork-context default eval completed.",
            },
          ],
        };

        const runner = new TurnRunner({
          model,
          cwd: workDir,
          mode: definition,
          skillDiscovery: { includeDefaults: false },
          systemInstructions: [
            "This is a live eval. Use select_state_machine_state for every transition.",
            "On the initial prompt, select recall_secret without input.",
            "After recall_secret completes, select done.",
          ].join("\n"),
        });

        const subAgentToolCalls: string[] = [];
        runner.subscribe((event: TurnEvent) => {
          if (event.type !== "step") return;
          if (event.origin?.kind !== "state_machine_agent") return;
          if (event.step.type === "tool_call_start") {
            subAgentToolCalls.push(event.step.toolName);
          }
        });

        const started = await startTurn(runner, {
          mode: definition,
          prompt: `Start the fork-context eval. The secret token is ${sentinel}.`,
        });
        const terminal = await started.turn;

        expectCompleted(terminal);
        expect(terminal.state.stateMachine?.terminal).toMatchObject({
          state: "done",
          status: "completed",
        });
        // A fresh sub-agent has no transcript to read, so it cannot produce
        // the exact random sentinel from the parent prompt. This is the
        // falsification leg: if forkContext silently defaulted to true (or
        // the fork path fired when it should not), the sentinel would appear.
        expect(completedOutput(terminal, "recall_secret")).not.toContain(sentinel);
        expect(subAgentToolCalls).toEqual([]);
      } finally {
        await removeTempWorkDir(workDir);
      }
    },
    150_000,
  );

  testIfDocker(
    "flips forkContext on at transition time via select_state_machine_state override",
    async () => {
      const workDir = await createTempWorkDir("sm-fork-override-");
      const sentinel = createSentinel("OVERRIDE");
      try {
        const definition: StateMachineDefinition = {
          name: "fork_context_override_eval",
          prompt: "Validate that an override can enable forkContext at transition time.",
          states: [
            {
              kind: "agent",
              name: "recall_secret",
              // Defined WITHOUT forkContext; only the parent's runtime
              // override can flip it on for this transition.
              prompt: [
                "Earlier in this conversation the user set a secret token.",
                "Find that token in the conversation history above you and reply",
                "with exactly the token and nothing else. Do not call any tools.",
              ].join("\n"),
            },
            {
              kind: "terminal",
              name: "done",
              status: "completed",
              reason: "Fork-context override eval completed.",
            },
          ],
        };

        const runner = new TurnRunner({
          model,
          cwd: workDir,
          mode: definition,
          skillDiscovery: { includeDefaults: false },
          systemInstructions: [
            "This is a live eval. Use select_state_machine_state for every transition.",
            "On the initial prompt, select recall_secret with an override that",
            'enables forkContext. Use override kind "agent" with state',
            `{"forkContext":true}.`,
            "After recall_secret completes, select done.",
          ].join("\n"),
        });

        const subAgentToolCalls: string[] = [];
        runner.subscribe((event: TurnEvent) => {
          if (event.type !== "step") return;
          if (event.origin?.kind !== "state_machine_agent") return;
          if (event.step.type === "tool_call_start") {
            subAgentToolCalls.push(event.step.toolName);
          }
        });

        const started = await startTurn(runner, {
          mode: definition,
          prompt: `Start the fork-context override eval. The secret token is ${sentinel}.`,
        });
        const terminal = await started.turn;

        expectCompleted(terminal);
        expect(terminal.state.stateMachine?.terminal).toMatchObject({
          state: "done",
          status: "completed",
        });
        expect(completedOutput(terminal, "recall_secret")).toContain(sentinel);
        expect(subAgentToolCalls).toEqual([]);
      } finally {
        await removeTempWorkDir(workDir);
      }
    },
    150_000,
  );
});

function expectCompleted(event: TurnTerminalEvent): void {
  expect(event.type).toBe("complete");
  expect(event.type === "complete" ? event.status : undefined).toBe("completed");
}

function completedOutput(event: TurnTerminalEvent, selectedState: string): string {
  const stateCompleted = [...(event.state.stateMachine?.history ?? [])]
    .reverse()
    .find(
      (historyEvent): historyEvent is StateMachineSessionEvent & { type: "state_completed" } =>
        historyEvent.type === "state_completed" && historyEvent.state === selectedState,
    );
  if (!stateCompleted) {
    throw new Error(`Expected state_completed for ${selectedState}`);
  }
  const output = stateCompleted.output;
  if (
    output &&
    typeof output === "object" &&
    "result" in output &&
    typeof output.result === "string"
  ) {
    return output.result;
  }
  return output === undefined ? "" : JSON.stringify(output);
}

function createSentinel(prefix: string): string {
  return `${prefix}_SENTINEL_${randomUUID().replaceAll("-", "")}`;
}

async function createTempWorkDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function removeTempWorkDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
