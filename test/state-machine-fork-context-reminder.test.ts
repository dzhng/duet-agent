import { describe, expect, test } from "bun:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { TurnRunner, type AgentConfigInput } from "../src/turn-runner/turn-runner.js";
import type { TurnRunnerControlResult } from "../src/turn-runner/tools.js";
import { createForkContextReminder } from "../src/turn-runner/prompts.js";
import type { SubagentRun } from "../src/turn-runner/subagent.js";
import type { StateMachineAgentState } from "../src/types/state-machine.js";
import type { TurnState } from "../src/types/protocol.js";

/**
 * Deterministic guard for the fork-context reminder. When `forkContext` is on,
 * the sub-agent is seeded with the parent's transcript, so it can mistake that
 * conversation for its own and act as the parent. The reminder rides in the
 * tail USER turn (not the system prompt — that stays byte-identical to the
 * parent for prompt-cache reuse), which is why this test captures the prompt
 * argument handed to `agent.prompt`, not the composed system prompt.
 */

const RUNNING_STATE: TurnState = {
  status: "running",
  mode: "agent",
  options: {},
  agent: { status: "running", messages: [] },
};

/**
 * Drives the real createStateSubagentRun path and returns the tail prompt the
 * sub-agent would actually run. `agent.prompt` is stubbed so no network call
 * happens and `retryTransientServerErrors` short-circuits on the clean state.
 */
async function captureTailPrompt(state: StateMachineAgentState): Promise<string> {
  let tail: string | undefined;

  class CapturingTurnRunner extends TurnRunner {
    constructor() {
      super({ model: "anthropic:claude-opus-4-8", skillDiscovery: { includeDefaults: false } });
    }

    protected override createAgent(
      input: AgentConfigInput,
      onControlResult?: (result: TurnRunnerControlResult) => void,
    ): Agent {
      const agent = super.createAgent(input, onControlResult);
      agent.prompt = (async (prompt: string) => {
        tail = prompt;
      }) as typeof agent.prompt;
      return agent;
    }
  }

  const runner = new CapturingTurnRunner();
  (runner as unknown as { state: TurnState }).state = RUNNING_STATE;
  const handle = (
    runner as unknown as {
      createStateSubagentRun: (input: {
        state: StateMachineAgentState;
        prompt: string;
        origin: { taskId: "t1" };
      }) => SubagentRun;
    }
  ).createStateSubagentRun({
    state,
    prompt: state.prompt,
    origin: { taskId: "t1" },
  });

  await handle.prompt();
  if (tail === undefined) throw new Error("agent.prompt was not invoked");
  return tail;
}

describe("fork-context reminder", () => {
  test("the reminder draws the parent/sub-agent line and forbids routing", () => {
    const reminder = createForkContextReminder();
    expect(reminder).toContain("<system-reminder>");
    expect(reminder).toContain("copy of the parent");
    expect(reminder).toContain("You are NOT the parent agent");
    expect(reminder).toContain("fresh sub-agent");
    expect(reminder).toContain("cannot select or route to other states");
  });

  test("a forked agent state leads its tail turn with the reminder", async () => {
    const tail = await captureTailPrompt({
      kind: "agent",
      name: "recall_secret",
      forkContext: true,
      prompt: "Find the token in the conversation above and reply with it.",
    });

    const reminderIndex = tail.indexOf("<system-reminder>");
    const identityIndex = tail.indexOf("state_agent_identity");
    const taskIndex = tail.indexOf("Find the token");

    // The reminder must land first so the model resets its identity before it
    // reads the inherited transcript's identity layer or the task itself.
    expect(tail).toStartWith("<system-reminder>");
    expect(reminderIndex).toBe(0);
    expect(identityIndex).toBeGreaterThan(reminderIndex);
    expect(taskIndex).toBeGreaterThan(identityIndex);
  });

  test("a non-forked agent state has no reminder and no inlined identity", async () => {
    const tail = await captureTailPrompt({
      kind: "agent",
      name: "recall_secret",
      prompt: "Find the token in the conversation above and reply with it.",
    });

    // Fresh-context states carry their identity in the system prompt, so the
    // tail turn is just the task — no reminder, no identity layer inlined.
    expect(tail).not.toContain("<system-reminder>");
    expect(tail).not.toContain("state_agent_identity");
    expect(tail).toBe("Find the token in the conversation above and reply with it.");
  });
});
