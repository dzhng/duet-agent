import { afterEach, expect, test } from "bun:test";
import { createAssistantMessageEventStream, type Context } from "@earendil-works/pi-ai";
import { TurnRunner, type AgentConfigInput } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnState } from "../src/types/protocol.js";
import { createAssistantMessage } from "./helpers/messages.js";
import { waitFor } from "./helpers/async.js";
import { ManualRuntimeClock } from "./helpers/manual-runtime-clock.js";

const runners: TurnRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.dispose();
});

class EditingRunner extends TurnRunner {
  readonly workerContexts: Context[] = [];
  readonly events: TurnEvent[] = [];
  holdWorkers = false;
  private readonly heldWorkers: ReturnType<typeof createAssistantMessageEventStream>[] = [];
  releaseWorkers() {
    for (const stream of this.heldWorkers.splice(0)) {
      stream.push({
        type: "done",
        reason: "stop",
        message: createAssistantMessage({ text: "Synthetic work completed." }),
      });
    }
  }
  constructor(
    private readonly replies: ReturnType<typeof createAssistantMessage>[],
    clock: ManualRuntimeClock,
  ) {
    super(
      {
        model: "anthropic:claude-opus-4-7",
        memoryDbPath: false,
        skillDiscovery: { includeDefaults: false },
      },
      { clock },
    );
    runners.push(this);
    this.subscribe((event) => this.events.push(event));
  }
  protected override createAgent(
    input: AgentConfigInput,
    onControlResult?: Parameters<TurnRunner["createAgent"]>[1],
  ) {
    const agent = super.createAgent(input, onControlResult);
    agent.streamFunction = (_model, context) => {
      const child = input.state.mode === "agent";
      if (child) this.workerContexts.push(JSON.parse(JSON.stringify(context)) as Context);
      const message = child
        ? createAssistantMessage({ text: "Synthetic work completed." })
        : this.replies.shift();
      if (!message) throw new Error("Unexpected parent model call");
      const stream = createAssistantMessageEventStream();
      if (child && this.holdWorkers) {
        this.heldWorkers.push(stream);
        return stream;
      }
      queueMicrotask(() =>
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        }),
      );
      return stream;
    };
    return agent;
  }
}
let nextToolCallId = 0;
function call(name: string, args: Record<string, unknown>) {
  return createAssistantMessage({
    extraContent: [{ type: "toolCall", id: `${name}-${++nextToolCallId}`, name, arguments: args }],
  });
}
function sleepingState(wakeAt: number): TurnState {
  return {
    mode: "auto",
    status: "sleeping",
    agent: { status: "completed", messages: [] },
    tasks: [
      {
        id: "t1",
        kind: "scheduled",
        name: "wait",
        label: "Wait",
        ownerScopeId: "turn-1",
        status: "scheduled",
        startedAt: 1000,
        wakeAt,
      },
    ],
    stateMachine: {
      definition: {
        name: "synthetic sync",
        prompt: "After wait, select work, then done.",
        states: [
          { name: "wait", kind: "timer", wakeAt },
          { name: "work", kind: "agent", prompt: "OLD INSTRUCTIONS" },
          { name: "done", kind: "terminal", status: "completed" },
        ],
      },
      prompt: "Run a scheduled synthetic task.",
      currentState: "wait",
      currentInput: { saved: "input" },
      history: [],
      createdAt: 1000,
      updatedAt: 1000,
    },
  };
}

test("editing a sleeping relay preserves its wake and runs revised instructions once after restart", async () => {
  const clock = new ManualRuntimeClock(1000);
  const wakeAt = 61_000;
  const original = sleepingState(wakeAt);
  const editing = new EditingRunner(
    [
      call("update_state_machine_state", {
        state: "work",
        override: { kind: "agent", state: { prompt: "REVISED INSTRUCTIONS" } },
      }),
      createAssistantMessage({ text: "Saved the instructions for the next scheduled run." }),
    ],
    clock,
  );
  await editing.start({ type: "start", state: original });
  const sleep = await editing.turn({
    type: "prompt",
    message: "Update future work instructions without running it now.",
    behavior: "follow_up",
  });
  expect(sleep.type).toBe("sleep");
  expect(
    sleep.state.stateMachine?.definition.states.find((state) => state.name === "work"),
  ).toMatchObject({ prompt: "REVISED INSTRUCTIONS" });
  expect(sleep.state.tasks).toEqual(original.tasks);
  expect(sleep.state.stateMachine?.currentState).toBe("wait");
  expect(sleep.state.stateMachine?.currentInput).toEqual({ saved: "input" });
  expect(editing.workerContexts).toEqual([]);
  expect(editing.events.filter((event) => event.type === "task_started")).toEqual([]);

  const resumed = new EditingRunner(
    [
      call("select_state_machine_state", { decision: { state: "work" } }),
      call("select_state_machine_state", { decision: { state: "done" } }),
      createAssistantMessage({ text: "Finished the revised task." }),
    ],
    clock,
  );
  await resumed.start({ type: "start", state: JSON.parse(JSON.stringify(sleep.state)) });
  await clock.advanceBy(wakeAt - clock.now());
  const complete = await resumed.turn({ type: "wake" });
  expect(complete).toMatchObject({ type: "complete", status: "completed" });
  expect(resumed.workerContexts).toHaveLength(1);
  expect(JSON.stringify(resumed.workerContexts[0])).toContain("REVISED INSTRUCTIONS");
  expect(JSON.stringify(resumed.workerContexts[0])).not.toContain("OLD INSTRUCTIONS");
});

test("a live timer edit is rejected without poisoning a later future-state edit", async () => {
  const original = sleepingState(61_000);
  const runner = new EditingRunner(
    [
      call("update_state_machine_state", {
        state: "wait",
        override: { kind: "timer", state: { wakeAt: 121_000 } },
      }),
      call("update_state_machine_state", {
        state: "work",
        override: { kind: "agent", state: { prompt: "VALID CORRECTION" } },
      }),
      createAssistantMessage({ text: "Only the future instructions were updated." }),
    ],
    new ManualRuntimeClock(1000),
  );
  await runner.start({ type: "start", state: original });
  const result = await runner.turn({
    type: "prompt",
    message: "Edit the relay.",
    behavior: "follow_up",
  });
  expect(result).toMatchObject({ type: "sleep", wakeAt: 61_000 });
  expect(
    result.state.stateMachine?.definition.states.find((state) => state.name === "wait"),
  ).toEqual(original.stateMachine?.definition.states[0]);
  expect(
    result.state.stateMachine?.definition.states.find((state) => state.name === "work"),
  ).toMatchObject({ prompt: "VALID CORRECTION" });
  expect(runner.events).toContainEqual(
    expect.objectContaining({
      type: "step",
      step: expect.objectContaining({
        type: "tool_call",
        toolName: "update_state_machine_state",
        isError: true,
        output: [
          expect.objectContaining({ text: expect.stringContaining("running or scheduled") }),
        ],
      }),
    }),
  );
});

test("editing a running worker is rejected rather than changing only its displayed definition", async () => {
  const state = sleepingState(61_000);
  state.status = "running";
  state.tasks = [];
  const runner = new EditingRunner(
    [
      call("select_state_machine_state", { decision: { state: "work" } }),
      call("update_state_machine_state", {
        state: "work",
        override: { kind: "agent", state: { prompt: "UNAPPLIED CHANGE" } },
      }),
      createAssistantMessage({
        text: "The live worker must be explicitly restarted to change its instructions.",
      }),
      call("select_state_machine_state", { decision: { state: "done" } }),
      createAssistantMessage({ text: "Done." }),
    ],
    new ManualRuntimeClock(1000),
  );
  runner.holdWorkers = true;
  await runner.start({ type: "start", state });
  const turn = runner.turn({ type: "prompt", message: "Run the work.", behavior: "follow_up" });
  try {
    await waitFor(() => runner.workerContexts.length === 1);
    const edit = runner.turn({
      type: "prompt",
      message: "Edit the current worker instructions.",
      behavior: "steer",
    });
    await waitFor(() =>
      runner.events.some(
        (event) =>
          event.type === "step" &&
          event.step.type === "tool_call" &&
          event.step.toolName === "update_state_machine_state",
      ),
    );
    expect(runner.events).toContainEqual(
      expect.objectContaining({
        type: "step",
        step: expect.objectContaining({
          type: "tool_call",
          toolName: "update_state_machine_state",
          isError: true,
        }),
      }),
    );
    expect(
      runner.getState()?.stateMachine?.definition.states.find((item) => item.name === "work"),
    ).toMatchObject({ prompt: "OLD INSTRUCTIONS" });
    runner.releaseWorkers();
    await Promise.all([turn, edit]);
    expect(runner.workerContexts).toHaveLength(1);
  } finally {
    runner.releaseWorkers();
    await turn;
  }
});

test("editing a fixed definition also updates the input contract used by later selections", async () => {
  const state = sleepingState(61_000);
  state.mode = state.stateMachine!.definition;
  const runner = new EditingRunner(
    [
      call("update_state_machine_state", {
        state: "work",
        override: {
          kind: "agent",
          state: {
            prompt: "Use {{ input.value }}",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        },
      }),
      call("select_state_machine_state", { decision: { state: "work" } }),
      createAssistantMessage({ text: "The state now requires an input value." }),
      call("select_state_machine_state", { decision: { state: "done" } }),
      createAssistantMessage({ text: "Done." }),
    ],
    new ManualRuntimeClock(1000),
  );
  await runner.start({ type: "start", state });
  await runner.turn({
    type: "prompt",
    message: "Update the future state input contract.",
    behavior: "follow_up",
  });
  const selection = runner.events.find(
    (event) =>
      event.type === "step" &&
      event.step.type === "tool_call" &&
      event.step.toolName === "select_state_machine_state",
  );
  expect(selection).toMatchObject({ type: "step", step: { isError: true } });
  expect(runner.workerContexts).toEqual([]);
});
