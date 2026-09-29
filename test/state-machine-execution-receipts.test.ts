import {
  createStateMachineSession,
  recordAcceptedExecution,
  EXECUTION_INSTRUCTIONS_MAX_BYTES,
} from "../src/turn-runner/state-machine-session.js";
import { afterAll, beforeAll, expect } from "bun:test";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type Context } from "@earendil-works/pi-ai";
import {
  TurnRunner,
  type AgentConfigInput,
  type AgentWorkerInput,
  type AgentWorkerResult,
} from "../src/turn-runner/turn-runner.js";
import type {
  StateMachineDefinition,
  StateMachineExecutionReceipt,
} from "../src/types/state-machine.js";
import type { StateMachineRunnerDecision } from "../src/turn-runner/tools.js";
import { createAssistantMessage } from "./helpers/messages.js";
import { testIfDocker } from "./helpers/docker-only.js";

const previousKey = process.env.DUET_API_KEY;
beforeAll(() => {
  process.env.DUET_API_KEY = "receipt-test-key";
});
afterAll(() => {
  if (previousKey === undefined) delete process.env.DUET_API_KEY;
  else process.env.DUET_API_KEY = previousKey;
});

class ReceiptRunner extends TurnRunner {
  readonly requests: Context[] = [];
  readonly parentPrompts: string[] = [];
  rejectAdmission = false;
  constructor(
    cwd: string,
    readonly decisions: StateMachineRunnerDecision[],
    skillPaths: string[] = [],
  ) {
    super({
      cwd,
      model: "sol",
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false, skillPaths },
    });
  }
  async currentStateView() {
    const tool = this.requireParentAgent().state.tools.find(
      (tool) => tool.name === "get_current_state_machine_state",
    );
    if (!tool) throw new Error("Missing current state tool");
    return tool.execute("inspect", {});
  }
  protected override async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    if (this.rejectAdmission) {
      this.taskManager.openScope(this.requireRootScope());
      await this.taskManager.closeScope(
        this.requireRootScope(),
        "Test scope closed before admission.",
      );
    }
    this.parentPrompts.push(input.prompt ?? "");
    const decision = this.decisions.shift();
    return {
      control: decision ? { type: "select_state_machine_state", decision } : { type: "none" },
      outcome: {
        type: "complete",
        status: "completed",
        result: "Selected.",
        state: { ...input.state, status: "completed" },
      },
    };
  }
  protected override createAgent(
    input: AgentConfigInput,
    control?: Parameters<TurnRunner["createAgent"]>[1],
  ) {
    const agent = super.createAgent(input, control);
    agent.streamFunction = (model, context) => {
      this.requests.push(context);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() =>
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            ...createAssistantMessage({ text: "Worker done." }),
            model: model.id,
            provider: model.provider,
            api: model.api,
          },
        }),
      );
      return stream;
    };
    return agent;
  }
}

testIfDocker(
  "receipt describes constructed worker with one-shot input and resolved cwd",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "execution-receipt-"));
    await mkdir(join(cwd, "child"));
    const definition: StateMachineDefinition = {
      name: "receipt",
      prompt: "Work.",
      states: [
        { kind: "agent", name: "work", prompt: "Original." },
        { kind: "terminal", name: "done", status: "completed" },
      ],
    };
    const runner = new ReceiptRunner(cwd, [
      {
        state: "work",
        input: { task: "corrected task", unused: "not rendered" },
        override: { kind: "agent", state: { prompt: "Do {{ input.task }}.", cwd: "child" } },
        persistOverride: false,
      },
      { state: "done" },
    ]);
    try {
      await runner.start({ type: "start", mode: definition });
      const terminal = await runner.turn({
        type: "prompt",
        message: "Do work.",
        behavior: "follow_up",
      });
      expect(terminal.type).toBe("complete");
      const session = terminal.state.stateMachine!;
      const started = session.history.find(
        (event) => event.type === "state_started" && event.state === "work",
      );
      expect(started).toMatchObject({
        execution: {
          state: "work",
          kind: "agent",
          cwd: join(cwd, "child"),
          forkContext: false,
          suppliedInputKeys: ["task", "unused"],
          renderedInputKeys: ["task"],
          persistOverride: false,
          preview: "Do corrected task.",
          previewTruncated: false,
        },
      });
      const accepted = session.history.find(
        (event) => event.type === "runner_decided" && event.execution,
      );
      expect(accepted && "execution" in accepted ? accepted.execution : undefined).toEqual(
        started && "execution" in started ? started.execution : undefined,
      );
      expect(session.definition.states[0]).toMatchObject({ prompt: "Original." });
      expect(runner.requests[0]!.messages.at(-1)).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "Do corrected task." }],
      });
    } finally {
      await runner.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

testIfDocker(
  "repeated actual work emits a recovery diagnostic before the next decision without blocking",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "execution-retry-"));
    const definition: StateMachineDefinition = {
      name: "retries",
      prompt: "Work.",
      states: [
        { kind: "agent", name: "work", prompt: "Do work." },
        { kind: "terminal", name: "done", status: "completed" },
      ],
    };
    const runner = new ReceiptRunner(cwd, [
      { state: "work", input: { unused: "one" } },
      { state: "work", input: { unused: "two" }, reason: "try again" },
      { state: "work", reason: "still retry" },
      { state: "work", reason: "external condition changed" },
      { state: "done" },
    ]);
    const warnings: string[] = [];
    runner.subscribe((event) => {
      if (event.type === "system" && event.level === "warn") warnings.push(event.message);
    });
    try {
      await runner.start({ type: "start", mode: definition });
      const terminal = await runner.turn({
        type: "prompt",
        message: "Do work.",
        behavior: "follow_up",
      });
      expect(terminal.type).toBe("complete");
      expect(warnings.some((message) => message.includes("UNCHANGED EXECUTION: the last 3"))).toBe(
        true,
      );
      expect(runner.parentPrompts[3]).toContain("UNCHANGED EXECUTION: the last 3");
      expect(runner.requests).toHaveLength(4);
      const receipts = terminal.state.stateMachine!.history.flatMap((event) =>
        event.type === "state_started" && event.execution ? [event.execution] : [],
      );
      expect(receipts[0]!.unchangedFrom).toBeUndefined();
      expect(receipts[1]!.unchangedFrom).toEqual({ id: receipts[0]!.id, outcome: "completed" });
      expect(receipts[2]!.unchangedFrom).toEqual({ id: receipts[1]!.id, outcome: "completed" });
    } finally {
      await runner.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

testIfDocker.each(["agent", "script"] as const)(
  "failed %s task admission cannot claim a worker start",
  async (kind) => {
    const cwd = await mkdtemp(join(tmpdir(), "execution-admission-"));
    const runner = new ReceiptRunner(cwd, [{ state: "work" }]);
    runner.rejectAdmission = true;
    try {
      await runner.start({
        type: "start",
        mode: {
          name: "admission",
          prompt: "Work.",
          states: [
            kind === "agent"
              ? { kind: "agent", name: "work", prompt: "Do work." }
              : { kind: "script", name: "work", command: "printf done" },
          ],
        },
      });
      const terminal = await runner.turn({
        type: "prompt",
        message: "Do work.",
        behavior: "follow_up",
      });
      expect(terminal.type).toBe("complete");
      expect(terminal.state.status).toBe("failed");
      expect(
        terminal.state.stateMachine!.history.filter((event) => event.type === "state_started"),
      ).toEqual([]);
      expect(runner.requests).toEqual([]);
    } finally {
      await runner.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

testIfDocker(
  "fork receipts survive resume and fingerprint inherited content rather than timestamps",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "execution-fork-"));
    const definition: StateMachineDefinition = {
      name: "fork",
      prompt: "Work.",
      states: [
        { kind: "agent", name: "work", prompt: "Original.", forkContext: true },
        { kind: "terminal", name: "done", status: "completed" },
      ],
    };
    const initial = new ReceiptRunner(cwd, []);
    const saved = await initial.start({ type: "start", mode: definition });
    await initial.dispose();
    const receipts = [];
    try {
      for (const [content, timestamp] of [
        ["same user correction", 1],
        ["same user correction", 2],
        ["changed user correction", 2],
      ] as const) {
        const runner = new ReceiptRunner(cwd, [
          {
            state: "work",
            override: { kind: "agent", state: { prompt: "Corrected ".repeat(160) } },
          },
          { state: "done" },
        ]);
        try {
          await runner.start({
            type: "start",
            state: {
              ...saved,
              agent: { ...saved.agent, messages: [{ role: "user", content, timestamp }] },
            },
          });
          const terminal = await runner.turn({
            type: "prompt",
            message: "Continue.",
            behavior: "follow_up",
          });
          const started = terminal.state.stateMachine!.history.find(
            (event) => event.type === "state_started" && event.state === "work",
          );
          if (started?.type !== "state_started" || !started.execution)
            throw new Error("Missing constructed execution receipt");
          receipts.push(started.execution);
          expect(started.execution).toMatchObject({
            forkContext: true,
            persistOverride: true,
            previewTruncated: true,
          });
          expect(started.execution.preview.length).toBeLessThanOrEqual(1200);
          expect(started.execution.inheritedContextHash).toMatch(/^[a-f0-9]{64}$/);
          expect(terminal.state.stateMachine!.definition.states[0]).toMatchObject({
            prompt: "Corrected ".repeat(160),
          });
          expect(runner.requests[0]!.messages).toContainEqual({ role: "user", content, timestamp });
        } finally {
          await runner.dispose();
        }
      }
      expect(receipts[0]!.fingerprint).toBe(receipts[1]!.fingerprint);
      expect(receipts[0]!.inheritedContextHash).toBe(receipts[1]!.inheritedContextHash);
      expect(receipts[2]!.fingerprint).not.toBe(receipts[1]!.fingerprint);
      expect(receipts[2]!.inheritedContextHash).not.toBe(receipts[1]!.inheritedContextHash);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

testIfDocker("script receipts use the command and cwd actually executed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "execution-script-"));
  await mkdir(join(cwd, "child"));
  const runner = new ReceiptRunner(cwd, [
    { state: "work", input: { message: "sentinel", extra: "unused" } },
    { state: "done" },
  ]);
  try {
    await runner.start({
      type: "start",
      mode: {
        name: "script",
        prompt: "Work.",
        states: [
          {
            kind: "script",
            name: "work",
            command: "printf '{{ input.message }}:'; pwd; # " + "script detail ".repeat(120),
            cwd: "child",
          },
          { kind: "terminal", name: "done", status: "completed" },
        ],
      },
    });
    const terminal = await runner.turn({
      type: "prompt",
      message: "Do work.",
      behavior: "follow_up",
    });
    const history = terminal.state.stateMachine!.history;
    expect(
      history.find((event) => event.type === "runner_decided" && event.execution),
    ).toMatchObject({
      executionInstructions: "printf 'sentinel:'; pwd; # " + "script detail ".repeat(120),
    });
    expect(
      history.find((event) => event.type === "state_started" && event.state === "work"),
    ).toMatchObject({
      execution: {
        kind: "script",
        cwd: join(cwd, "child"),
        preview: ("printf 'sentinel:'; pwd; # " + "script detail ".repeat(120)).slice(0, 1200),
        renderedInputKeys: ["message"],
        suppliedInputKeys: ["extra", "message"],
      },
    });
    expect(
      history.find((event) => event.type === "state_completed" && event.state === "work"),
    ).toMatchObject({ output: { stdout: `sentinel:${join(cwd, "child")}` } });
  } finally {
    await runner.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

testIfDocker("delivered input corrections reset the execution streak", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "execution-correction-"));
  const runner = new ReceiptRunner(cwd, [
    { state: "work", input: { task: "first" } },
    { state: "work", input: { task: "first" } },
    { state: "work", input: { task: "corrected" } },
    { state: "done" },
  ]);
  const warnings: string[] = [];
  runner.subscribe((event) => {
    if (event.type === "system" && event.level === "warn") warnings.push(event.message);
  });
  try {
    await runner.start({
      type: "start",
      mode: {
        name: "correction",
        prompt: "Work.",
        states: [
          { kind: "agent", name: "work", prompt: "Do {{ input.task }}." },
          { kind: "terminal", name: "done", status: "completed" },
        ],
      },
    });
    const terminal = await runner.turn({
      type: "prompt",
      message: "Do work.",
      behavior: "follow_up",
    });
    const receipts = terminal.state.stateMachine!.history.flatMap((event) =>
      event.type === "state_started" && event.execution ? [event.execution] : [],
    );
    expect(receipts.map((receipt) => receipt.preview)).toEqual([
      "Do first.",
      "Do first.",
      "Do corrected.",
    ]);
    expect(receipts[1]!.unchangedFrom).toEqual({ id: receipts[0]!.id, outcome: "completed" });
    expect(receipts[2]!.unchangedFrom).toBeUndefined();
    expect(receipts[2]!.fingerprint).not.toBe(receipts[1]!.fingerprint);
    expect(warnings).toEqual([]);
  } finally {
    await runner.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

testIfDocker(
  "full constructed instructions survive checkpoint resume while ordinary views stay bounded",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "execution-instructions-"));
    const skill = join(cwd, "SKILL.md");
    const body = "Immutable expanded task instructions. ".repeat(100) + "END-OF-ORIGINAL-SKILL";
    await writeFile(skill, `---\nname: exact-task\ndescription: task fixture\n---\n${body}\n`);
    const runner = new ReceiptRunner(
      cwd,
      [
        {
          state: "work",
          override: { kind: "agent", state: { prompt: "/exact-task" } },
          persistOverride: false,
        },
        { state: "done" },
      ],
      [skill],
    );
    const snapshots: unknown[] = [];
    runner.subscribe((event) => {
      if (event.type === "state_machine") snapshots.push(event.stateMachine);
    });
    try {
      await runner.start({
        type: "start",
        mode: {
          name: "detail",
          prompt: "Work.",
          states: [
            { kind: "agent", name: "work", prompt: "Original definition." },
            { kind: "terminal", name: "done", status: "completed" },
          ],
        },
      });
      await runner.turn({ type: "prompt", message: "Do work.", behavior: "follow_up" });
      const prompt = runner.requests[0]!.messages.at(-1)!;
      const actual =
        typeof prompt.content === "string"
          ? prompt.content
          : prompt.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("");
      expect(actual).toContain(body);
      const raw = runner.getState()!;
      const decision = raw.stateMachine!.history.find(
        (event) => event.type === "runner_decided" && event.execution,
      );
      if (!decision) throw new Error("Missing accepted execution");
      expect(decision).toMatchObject({
        executionInstructions: actual,
        execution: { previewTruncated: true },
      });
      expect(JSON.stringify(snapshots)).not.toContain("END-OF-ORIGINAL-SKILL");
      const view = await runner.currentStateView();
      expect(JSON.stringify(view)).not.toContain("END-OF-ORIGINAL-SKILL");
      const expectedHistory = structuredClone(raw.stateMachine!.history.slice(-10));
      for (const event of expectedHistory) {
        if (event.type === "runner_decided") {
          delete event.executionInstructions;
          delete event.executionInstructionsUnavailable;
        }
      }
      expect(view.details).toMatchObject({ history: expectedHistory });
      const checkpoint = join(cwd, "state.json");
      await writeFile(checkpoint, JSON.stringify(raw));
      await writeFile(
        skill,
        "---\nname: exact-task\ndescription: changed\n---\nReplacement skill.",
      );
      const saved = JSON.parse(await readFile(checkpoint, "utf8"));
      saved.stateMachine.definition.states[0].prompt = "Replacement definition.";
      const resumed = new ReceiptRunner(cwd, [], [skill]);
      try {
        await resumed.start({ type: "start", state: saved });
        expect(resumed.getState()!.stateMachine!.history).toContainEqual(decision);
        expect(JSON.stringify(await resumed.currentStateView())).not.toContain(
          "END-OF-ORIGINAL-SKILL",
        );
      } finally {
        await resumed.dispose();
      }
    } finally {
      await runner.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

testIfDocker("instruction retention keeps complete newest text within its encoded budget", () => {
  const receipt: StateMachineExecutionReceipt = {
    id: "task",
    state: "work",
    kind: "script",
    fingerprint: "hash",
    cwd: "/tmp",
    forkContext: false,
    suppliedInputKeys: [],
    renderedInputKeys: [],
    persistOverride: false,
    preview: "preview",
    previewTruncated: true,
  };
  let session = createStateMachineSession(
    "Work.",
    { name: "quota", prompt: "Work.", states: [] },
    "work",
  );
  const add = (text: string) => {
    session.history.push({ type: "runner_decided", timestamp: 1, decision: { state: "work" } });
    session = recordAcceptedExecution(session, receipt, text);
  };
  // Quotes double in JSON; a character-count budget would admit both entries.
  const text = '"'.repeat(EXECUTION_INSTRUCTIONS_MAX_BYTES / 4);
  add(text);
  add(text);
  expect(session.history[1]).toMatchObject({
    execution: receipt,
    executionInstructionsUnavailable: "evicted",
  });
  expect(session.history[1]).not.toHaveProperty("executionInstructions");
  expect(session.history[2]).toMatchObject({ executionInstructions: text });
  add("x".repeat(EXECUTION_INSTRUCTIONS_MAX_BYTES));
  expect(session.history[3]).toMatchObject({
    execution: receipt,
    executionInstructionsUnavailable: "too_large",
  });
  expect(session.history[3]).not.toHaveProperty("executionInstructions");
  expect(session.history[2]).toMatchObject({ executionInstructions: text });
});
