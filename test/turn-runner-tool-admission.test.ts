import { expect, test } from "bun:test";
import { Type } from "typebox";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testIfDocker } from "./helpers/docker-only.js";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { TurnRunner, type AgentConfigInput } from "../src/turn-runner/turn-runner.js";
import { createAssistantMessage } from "./helpers/messages.js";
import { createStateMachineState } from "./helpers/turn-runner-protocol.js";

class AdmissionRunner extends TurnRunner {
  observedError = "";
  firstCall = {
    name: "select_state_machine_state",
    arguments: {
      decision: { state: "meeting_scheduled" },
      override: { kind: "agent", state: { prompt: "private-sentinel" } },
    } as Record<string, unknown>,
  };
  effects: unknown[] = [];
  protected override createTools(...args: Parameters<TurnRunner["createTools"]>) {
    const tools = super.createTools(...args);
    tools.tools.push({
      name: "fixture",
      label: "Fixture",
      description: "External fixture tool",
      parameters: Type.Object(
        { count: Type.Number(), data: Type.Record(Type.String(), Type.Any()) },
        { additionalProperties: false },
      ),
      execute: async (_id, args) => {
        this.effects.push(args);
        return { content: [{ type: "text", text: "Applied." }], details: {} };
      },
    });
    return tools;
  }
  private calls = 0;
  protected override createAgent(
    input: AgentConfigInput,
    control?: Parameters<TurnRunner["createAgent"]>[1],
  ) {
    const agent = super.createAgent(input, control);
    agent.streamFunction = (_model, context) => {
      this.calls++;
      if (this.calls > 4) throw new Error("Unexpected recovery loop");
      const error = [...context.messages]
        .reverse()
        .find((message) => message.role === "toolResult" && message.isError);
      if (error) this.observedError = JSON.stringify(error.content);
      const message =
        this.calls <= 2
          ? createAssistantMessage({
              extraContent: [
                {
                  type: "toolCall",
                  id: `select-${this.calls}`,
                  ...(this.calls === 1
                    ? this.firstCall
                    : {
                        name: "select_state_machine_state",
                        arguments: { decision: { state: "meeting_scheduled" } },
                      }),
                },
              ],
            })
          : createAssistantMessage({ text: "Recovered." });
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() =>
        stream.push({ type: "done", reason: this.calls <= 2 ? "toolUse" : "stop", message }),
      );
      return stream;
    };
    return agent;
  }
}

test("misplaced relay correction is rejected before selecting, then minimal selection recovers", async () => {
  const runner = new AdmissionRunner({
    model: "anthropic:claude-opus-4-7",
    memoryDbPath: false,
    skillDiscovery: { includeDefaults: false },
  });
  try {
    await runner.start({ type: "start", state: createStateMachineState("wait_before_retry") });
    const result = await runner.turn({ type: "prompt", message: "Finish.", behavior: "follow_up" });
    expect(runner.observedError).toContain("/override");
    expect(runner.observedError).not.toContain("private-sentinel");
    expect(
      result.state.stateMachine?.history.filter((event) => event.type === "runner_decided"),
    ).toHaveLength(1);
    expect(result.state.stateMachine?.terminal?.status).toBe("completed");
  } finally {
    await runner.dispose();
  }
});

test("raw primitive arguments are not coerced before an external tool effect", async () => {
  const runner = new AdmissionRunner({
    model: "anthropic:claude-opus-4-7",
    memoryDbPath: false,
    skillDiscovery: { includeDefaults: false },
  });
  runner.firstCall = {
    name: "fixture",
    arguments: { count: "2", data: { arbitrary: "private-sentinel" } },
  };
  try {
    await runner.start({ type: "start", state: createStateMachineState("wait_before_retry") });
    await runner.turn({ type: "prompt", message: "Finish.", behavior: "follow_up" });
    expect(runner.observedError).toContain("/count");
    expect(runner.observedError).not.toContain("private-sentinel");
    expect(runner.effects).toEqual([]);
  } finally {
    await runner.dispose();
  }
});

test("intentional open records reach the handler unchanged", async () => {
  const runner = new AdmissionRunner({
    model: "anthropic:claude-opus-4-7",
    memoryDbPath: false,
    skillDiscovery: { includeDefaults: false },
  });
  const args = { count: 2, data: { arbitrary: { nested: [true, null, "value"] } } };
  runner.firstCall = { name: "fixture", arguments: args };
  try {
    await runner.start({ type: "start", state: createStateMachineState("wait_before_retry") });
    await runner.turn({ type: "prompt", message: "Finish.", behavior: "follow_up" });
    expect(runner.observedError).toBe("");
    expect(runner.effects).toEqual([args]);
  } finally {
    await runner.dispose();
  }
});

test("terminal selection rejects unused overrides but a minimal terminal remains usable", async () => {
  const runner = new AdmissionRunner({
    model: "anthropic:claude-opus-4-7",
    memoryDbPath: false,
    skillDiscovery: { includeDefaults: false },
  });
  runner.firstCall = {
    name: "select_state_machine_state",
    arguments: {
      decision: {
        state: "meeting_scheduled",
        override: { kind: "agent", state: { cwd: "/nonexistent", prompt: "unused" } },
      },
    },
  };
  try {
    await runner.start({ type: "start", state: createStateMachineState("wait_before_retry") });
    const result = await runner.turn({ type: "prompt", message: "Finish.", behavior: "follow_up" });
    expect(runner.observedError).toContain("Terminal states");
    expect(result.state.stateMachine?.terminal?.status).toBe("completed");
    expect(
      result.state.stateMachine?.history.filter((event) => event.type === "runner_decided"),
    ).toHaveLength(1);
  } finally {
    await runner.dispose();
  }
});

testIfDocker(
  "explicit edit-tool preparation still produces the requested file change",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tool-admission-edit-"));
    const runner = new AdmissionRunner({
      cwd,
      model: "anthropic:claude-opus-4-7",
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
    });
    runner.firstCall = {
      name: "edit",
      arguments: { path: "sample.txt", oldText: "before", newText: "after" },
    };
    try {
      await writeFile(join(cwd, "sample.txt"), "before");
      await runner.start({ type: "start", state: createStateMachineState("wait_before_retry") });
      await runner.turn({ type: "prompt", message: "Finish.", behavior: "follow_up" });
      expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe("after");
      expect(runner.observedError).toBe("");
    } finally {
      await runner.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
