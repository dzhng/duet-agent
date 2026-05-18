import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { BashOperations, Skill } from "@earendil-works/pi-coding-agent";
import dedent from "dedent";
import {
  createTurnRunnerTools as createTurnRunnerToolsWithStorage,
  DEFAULT_BASH_TIMEOUT_SECONDS,
  withDefaultBashTimeout,
  type TurnRunnerControlResult,
} from "../src/turn-runner/tools.js";
import type { TurnTodo } from "../src/types/protocol.js";

type TurnRunnerToolsInput = Parameters<typeof createTurnRunnerToolsWithStorage>[0];

function createTurnRunnerTools(input: Omit<TurnRunnerToolsInput, "todoStorage">) {
  let storedTodos: TurnTodo[] = [];
  return createTurnRunnerToolsWithStorage({
    ...input,
    todoStorage: {
      getTodos: () => storedTodos,
      setTodos: (todos) => {
        storedTodos = todos;
      },
    },
  });
}

describe("TurnRunner tools", () => {
  test("todo_write replaces and merges todo lists", async () => {
    let storedTodos: TurnTodo[] = [];
    const tools = createTurnRunnerToolsWithStorage({
      cwd: process.cwd(),
      mode: "agent",
      todoStorage: {
        getTodos: () => storedTodos,
        setTodos: (todos) => {
          storedTodos = todos;
        },
      },
    });
    const todoTool = tools.find((tool) => tool.name === "todo_write");

    expect(todoTool).toBeDefined();
    if (!todoTool) throw new Error("todo_write tool missing");

    const initial = await todoTool.execute("tool-1", {
      merge: false,
      todos: [
        { id: "plan", content: "Plan the work", status: "completed" },
        { id: "test", content: "Run tests", status: "pending" },
      ],
    });

    expect(initial.terminate).toBeUndefined();
    expect(storedTodos).toEqual([
      { id: "plan", content: "Plan the work", status: "completed" },
      { id: "test", content: "Run tests", status: "pending" },
    ]);
    expect(initial.details).toEqual(storedTodos);
    expect(initial.content).toEqual([
      {
        type: "text",
        text: dedent`
          Current task list:
          - [completed] plan: Plan the work
          - [pending] test: Run tests

          <system-reminder>
          The todo list still has unfinished items. As you complete each one, call todo_write again with merge=true to flip its status to completed (and advance the next item to in_progress). Keep calling todo_write until every item is in a terminal state.
          </system-reminder>
        `,
      },
    ]);

    const merged = await todoTool.execute("tool-2", {
      merge: true,
      todos: [
        { id: "test", content: "Run tests", status: "in_progress" },
        { id: "verify", content: "Verify behavior", status: "failed" },
      ],
    });

    expect(storedTodos).toEqual([
      { id: "plan", content: "Plan the work", status: "completed" },
      { id: "test", content: "Run tests", status: "in_progress" },
      { id: "verify", content: "Verify behavior", status: "failed" },
    ]);
    expect(merged.details).toEqual(storedTodos);

    const allDone = await todoTool.execute("tool-3", {
      merge: false,
      todos: [
        { id: "plan", content: "Plan the work", status: "completed" },
        { id: "test", content: "Run tests", status: "completed" },
      ],
    });
    expect(allDone.content).toEqual([
      {
        type: "text",
        text: [
          "Current task list:",
          "- [completed] plan: Plan the work",
          "- [completed] test: Run tests",
        ].join("\n"),
      },
    ]);
  });

  test("returns user questions in tool details and model-visible content", async () => {
    const tools = createTurnRunnerTools({ cwd: process.cwd(), mode: "agent" });
    const askUserQuestionTool = tools.find((tool) => tool.name === "ask_user_question");

    expect(askUserQuestionTool).toBeDefined();
    if (!askUserQuestionTool) throw new Error("ask_user_question tool missing");

    const result = await askUserQuestionTool.execute("tool-1", {
      questions: [
        {
          header: "Deployment",
          question: "Which environment should I deploy to?",
          options: [
            { label: "staging", description: "Internal validation" },
            { label: "production" },
          ],
        },
      ],
    });

    const details: TurnRunnerControlResult = result.details;
    expect(details).toEqual({
      type: "ask_user_question",
      questions: [
        {
          header: "Deployment",
          question: "Which environment should I deploy to?",
          options: [
            { label: "staging", description: "Internal validation" },
            { label: "production" },
          ],
        },
      ],
    });
    expect(result.terminate).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(details, null, 2) }]);
  });

  test("returns control decisions in tool details and model-visible content", async () => {
    const tools = createTurnRunnerTools({ cwd: process.cwd(), mode: "auto" });
    const createDefinitionTool = tools.find(
      (tool) => tool.name === "create_state_machine_definition",
    );

    expect(createDefinitionTool).toBeDefined();
    if (!createDefinitionTool) throw new Error("create_state_machine_definition tool missing");

    const result = await createDefinitionTool.execute("tool-1", {
      definition: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [{ kind: "terminal", name: "done", status: "completed" }],
      },
      firstState: "done",
    });

    const details: TurnRunnerControlResult = result.details;
    expect(details).toEqual({
      type: "create_state_machine_definition",
      definition: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [
          { kind: "terminal", name: "done", status: "completed" },
          { kind: "terminal", name: "failed", status: "failed" },
          { kind: "terminal", name: "cancelled", status: "cancelled" },
        ],
      },
      firstState: "done",
    });
    expect(result.terminate).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(details, null, 2) }]);
  });

  test("accepts dynamically created definitions with required and optional input fields", async () => {
    const tools = createTurnRunnerTools({ cwd: process.cwd(), mode: "auto" });
    const createDefinitionTool = tools.find(
      (tool) => tool.name === "create_state_machine_definition",
    );

    expect(createDefinitionTool).toBeDefined();
    if (!createDefinitionTool) throw new Error("create_state_machine_definition tool missing");

    const result = await createDefinitionTool.execute("tool-1", {
      definition: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [
          {
            kind: "script",
            name: "send_email",
            inputSchema: {
              type: "object",
              properties: {
                email: { type: "string" },
                followUpCount: { type: "integer", minimum: 0 },
              },
              required: ["email"],
              additionalProperties: false,
            },
            command: "send email",
          },
          { kind: "terminal", name: "done", status: "completed" },
        ],
      },
    });

    expect(result.details).toMatchObject({
      type: "create_state_machine_definition",
      definition: {
        states: [
          {
            name: "send_email",
            inputSchema: {
              required: ["email"],
              properties: {
                email: { type: "string" },
                followUpCount: { type: "integer", minimum: 0 },
              },
            },
          },
          { kind: "terminal", name: "done", status: "completed" },
          { kind: "terminal", name: "failed", status: "failed" },
          { kind: "terminal", name: "cancelled", status: "cancelled" },
        ],
      },
    });
  });

  test("rejects dynamically created definitions with invalid input schemas", async () => {
    const tools = createTurnRunnerTools({ cwd: process.cwd(), mode: "auto" });
    const createDefinitionTool = tools.find(
      (tool) => tool.name === "create_state_machine_definition",
    );

    expect(createDefinitionTool).toBeDefined();
    if (!createDefinitionTool) throw new Error("create_state_machine_definition tool missing");

    const result = createDefinitionTool.execute("tool-1", {
      definition: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [
          {
            kind: "script",
            name: "send_email",
            inputSchema: { type: "bogus" },
            command: "send email",
          },
        ],
      },
    });

    await expect(result).rejects.toThrow('Invalid inputSchema for state "send_email"');
  });

  test("rejects dynamically created definitions with invalid nested input schemas", async () => {
    const tools = createTurnRunnerTools({ cwd: process.cwd(), mode: "auto" });
    const createDefinitionTool = tools.find(
      (tool) => tool.name === "create_state_machine_definition",
    );

    expect(createDefinitionTool).toBeDefined();
    if (!createDefinitionTool) throw new Error("create_state_machine_definition tool missing");

    const result = createDefinitionTool.execute("tool-1", {
      definition: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [
          {
            kind: "script",
            name: "send_email",
            inputSchema: {
              type: "object",
              properties: { email: { type: "bogus" } },
              required: ["email"],
            },
            command: "send email",
          },
        ],
      },
    });

    await expect(result).rejects.toThrow('Invalid inputSchema for state "send_email"');
  });

  test("rejects poll states without a positive intervalMs", async () => {
    const tools = createTurnRunnerTools({ cwd: process.cwd(), mode: "auto" });
    const createDefinitionTool = tools.find(
      (tool) => tool.name === "create_state_machine_definition",
    );

    expect(createDefinitionTool).toBeDefined();
    if (!createDefinitionTool) throw new Error("create_state_machine_definition tool missing");

    const result = createDefinitionTool.execute("tool-1", {
      definition: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [
          {
            kind: "poll",
            name: "wait_for_reply",
            command: "check reply",
          },
        ],
      },
    });

    await expect(result).rejects.toThrow(
      'Invalid poll schedule for state "wait_for_reply": intervalMs must be positive.',
    );
  });

  test("auto-injects missing failed and cancelled terminal escape hatches", async () => {
    const tools = createTurnRunnerTools({ cwd: process.cwd(), mode: "auto" });
    const createDefinitionTool = tools.find(
      (tool) => tool.name === "create_state_machine_definition",
    );

    expect(createDefinitionTool).toBeDefined();
    if (!createDefinitionTool) throw new Error("create_state_machine_definition tool missing");

    const result = await createDefinitionTool.execute("tool-1", {
      definition: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [
          { kind: "agent", name: "research", prompt: "Research the prospect." },
          { kind: "terminal", name: "done", status: "completed" },
        ],
      },
    });

    const details = result.details as Extract<
      TurnRunnerControlResult,
      { type: "create_state_machine_definition" }
    >;
    expect(details.definition.states).toEqual([
      { kind: "agent", name: "research", prompt: "Research the prospect." },
      { kind: "terminal", name: "done", status: "completed" },
      { kind: "terminal", name: "failed", status: "failed" },
      { kind: "terminal", name: "cancelled", status: "cancelled" },
    ]);
  });

  test("preserves user-defined failed and cancelled states without overwriting", async () => {
    const tools = createTurnRunnerTools({ cwd: process.cwd(), mode: "auto" });
    const createDefinitionTool = tools.find(
      (tool) => tool.name === "create_state_machine_definition",
    );

    expect(createDefinitionTool).toBeDefined();
    if (!createDefinitionTool) throw new Error("create_state_machine_definition tool missing");

    const result = await createDefinitionTool.execute("tool-1", {
      definition: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [
          { kind: "terminal", name: "done", status: "completed" },
          { kind: "terminal", name: "failed", status: "failed", reason: "Custom failure note." },
        ],
      },
    });

    const details = result.details as Extract<
      TurnRunnerControlResult,
      { type: "create_state_machine_definition" }
    >;
    expect(details.definition.states).toEqual([
      { kind: "terminal", name: "done", status: "completed" },
      { kind: "terminal", name: "failed", status: "failed", reason: "Custom failure note." },
      { kind: "terminal", name: "cancelled", status: "cancelled" },
    ]);
  });

  test("rejects dynamically created definitions without a completed terminal", async () => {
    const tools = createTurnRunnerTools({ cwd: process.cwd(), mode: "auto" });
    const createDefinitionTool = tools.find(
      (tool) => tool.name === "create_state_machine_definition",
    );

    expect(createDefinitionTool).toBeDefined();
    if (!createDefinitionTool) throw new Error("create_state_machine_definition tool missing");

    const result = createDefinitionTool.execute("tool-1", {
      definition: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [{ kind: "agent", name: "research", prompt: "Research the prospect." }],
      },
    });

    await expect(result).rejects.toThrow(
      'must include at least one terminal state with status "completed"',
    );
  });

  test("rejects poll states with intervalMs shorter than 15 minutes", async () => {
    const tools = createTurnRunnerTools({ cwd: process.cwd(), mode: "auto" });
    const createDefinitionTool = tools.find(
      (tool) => tool.name === "create_state_machine_definition",
    );

    expect(createDefinitionTool).toBeDefined();
    if (!createDefinitionTool) throw new Error("create_state_machine_definition tool missing");

    const result = createDefinitionTool.execute("tool-1", {
      definition: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [
          {
            kind: "poll",
            name: "wait_for_reply",
            command: "check reply",
            intervalMs: 60_000,
          },
          { kind: "terminal", name: "done", status: "completed" },
        ],
      },
    });

    await expect(result).rejects.toThrow("intervalMs must be at least 15 minutes");
  });

  test("rejects timer states with wakeAt sooner than 15 minutes from now", async () => {
    const tools = createTurnRunnerTools({ cwd: process.cwd(), mode: "auto" });
    const createDefinitionTool = tools.find(
      (tool) => tool.name === "create_state_machine_definition",
    );

    expect(createDefinitionTool).toBeDefined();
    if (!createDefinitionTool) throw new Error("create_state_machine_definition tool missing");

    const result = createDefinitionTool.execute("tool-1", {
      definition: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [
          { kind: "timer", name: "wait_briefly", wakeAt: Date.now() + 60_000 },
          { kind: "terminal", name: "done", status: "completed" },
        ],
      },
    });

    await expect(result).rejects.toThrow("wakeAt must be at least 15 minutes in the future");
  });

  test("rejects timer states without a finite wakeAt", async () => {
    const tools = createTurnRunnerTools({
      cwd: process.cwd(),
      mode: "auto",
    });
    const createDefinitionTool = tools.find(
      (tool) => tool.name === "create_state_machine_definition",
    );

    expect(createDefinitionTool).toBeDefined();
    if (!createDefinitionTool) throw new Error("create_state_machine_definition tool missing");

    const result = createDefinitionTool.execute("tool-1", {
      definition: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [
          {
            kind: "timer",
            name: "wait_for_reply",
            wakeAt: Number.NaN,
          },
        ],
      },
    });

    await expect(result).rejects.toThrow(
      'Invalid timer schedule for state "wait_for_reply": wakeAt must be finite.',
    );
  });

  test("returns selected state decisions in tool details and model-visible content", async () => {
    const tools = createTurnRunnerTools({
      cwd: process.cwd(),
      mode: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [{ kind: "terminal", name: "done", status: "completed" }],
      },
    });
    const selectStateTool = tools.find((tool) => tool.name === "select_state_machine_state");

    expect(selectStateTool).toBeDefined();
    if (!selectStateTool) throw new Error("select_state_machine_state tool missing");

    const result = await selectStateTool.execute("tool-1", {
      decision: { kind: "terminal", state: "done" },
    });

    const details: TurnRunnerControlResult = result.details;
    expect(details).toEqual({
      type: "select_state_machine_state",
      decision: { kind: "terminal", state: "done" },
    });
    expect(result.terminate).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(details, null, 2) }]);
  });

  test("accepts state transition input that matches the selected state's schema", async () => {
    const tools = createTurnRunnerTools({
      cwd: process.cwd(),
      mode: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [
          {
            kind: "script",
            name: "send_email",
            inputSchema: {
              type: "object",
              properties: {
                email: { type: "string" },
                followUpCount: { type: "integer", minimum: 0 },
              },
              required: ["email"],
              additionalProperties: false,
            },
            command: "send '{{ input.email }}'",
          },
        ],
      },
    });
    const selectStateTool = tools.find((tool) => tool.name === "select_state_machine_state");

    expect(selectStateTool).toBeDefined();
    if (!selectStateTool) throw new Error("select_state_machine_state tool missing");

    const result = await selectStateTool.execute("tool-1", {
      decision: {
        kind: "run_state",
        state: "send_email",
        input: { email: "ada@example.com" },
      },
    });

    expect(result.details).toMatchObject({
      type: "select_state_machine_state",
      decision: {
        kind: "run_state",
        state: "send_email",
        input: { email: "ada@example.com" },
      },
    });

    const resultWithOptionalField = await selectStateTool.execute("tool-2", {
      decision: {
        kind: "run_state",
        state: "send_email",
        input: { email: "ada@example.com", followUpCount: 1 },
      },
    });

    expect(resultWithOptionalField.details).toMatchObject({
      type: "select_state_machine_state",
      decision: {
        kind: "run_state",
        state: "send_email",
        input: { email: "ada@example.com", followUpCount: 1 },
      },
    });
  });

  test("rejects state transition input that does not match the selected state's schema", async () => {
    const tools = createTurnRunnerTools({
      cwd: process.cwd(),
      mode: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [
          {
            kind: "script",
            name: "send_email",
            inputSchema: {
              type: "object",
              properties: { email: { type: "string" } },
              required: ["email"],
            },
            command: "send '{{ input.email }}'",
          },
        ],
      },
    });
    const selectStateTool = tools.find((tool) => tool.name === "select_state_machine_state");

    expect(selectStateTool).toBeDefined();
    if (!selectStateTool) throw new Error("select_state_machine_state tool missing");

    const result = selectStateTool.execute("tool-1", {
      decision: {
        kind: "run_state",
        state: "send_email",
        input: { email: 123 },
      },
    });

    await expect(result).rejects.toThrow('Invalid input for state "send_email"');
  });

  test("rejects state transition input that omits required fields", async () => {
    const tools = createTurnRunnerTools({
      cwd: process.cwd(),
      mode: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [
          {
            kind: "script",
            name: "send_email",
            inputSchema: {
              type: "object",
              properties: {
                email: { type: "string" },
                followUpCount: { type: "integer" },
              },
              required: ["email"],
            },
            command: "send '{{ input.email }}'",
          },
        ],
      },
    });
    const selectStateTool = tools.find((tool) => tool.name === "select_state_machine_state");

    expect(selectStateTool).toBeDefined();
    if (!selectStateTool) throw new Error("select_state_machine_state tool missing");

    const result = selectStateTool.execute("tool-1", {
      decision: {
        kind: "run_state",
        state: "send_email",
        input: { followUpCount: 1 },
      },
    });

    await expect(result).rejects.toThrow('Invalid input for state "send_email"');
  });

  test("rejects state transition input with unexpected optional fields when disallowed", async () => {
    const tools = createTurnRunnerTools({
      cwd: process.cwd(),
      mode: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [
          {
            kind: "script",
            name: "send_email",
            inputSchema: {
              type: "object",
              properties: {
                email: { type: "string" },
                followUpCount: { type: "integer" },
              },
              required: ["email"],
              additionalProperties: false,
            },
            command: "send '{{ input.email }}'",
          },
        ],
      },
    });
    const selectStateTool = tools.find((tool) => tool.name === "select_state_machine_state");

    expect(selectStateTool).toBeDefined();
    if (!selectStateTool) throw new Error("select_state_machine_state tool missing");

    const result = selectStateTool.execute("tool-1", {
      decision: {
        kind: "run_state",
        state: "send_email",
        input: { email: "ada@example.com", extra: true },
      },
    });

    await expect(result).rejects.toThrow('Invalid input for state "send_email"');
  });

  test("rejects state transition overrides with invalid input schemas", async () => {
    const tools = createTurnRunnerTools({
      cwd: process.cwd(),
      mode: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [{ kind: "script", name: "send_email", command: "send email" }],
      },
    });
    const selectStateTool = tools.find((tool) => tool.name === "select_state_machine_state");

    expect(selectStateTool).toBeDefined();
    if (!selectStateTool) throw new Error("select_state_machine_state tool missing");

    const result = selectStateTool.execute("tool-1", {
      decision: {
        kind: "run_state",
        state: "send_email",
        override: {
          kind: "script",
          state: { inputSchema: { type: "bogus" } },
        },
      },
    });

    await expect(result).rejects.toThrow('Invalid inputSchema for state "send_email"');
  });

  test("validates state transition input against override input schemas", async () => {
    const tools = createTurnRunnerTools({
      cwd: process.cwd(),
      mode: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [
          {
            kind: "script",
            name: "send_email",
            inputSchema: {
              type: "object",
              properties: { email: { type: "string" } },
              required: ["email"],
            },
            command: "send '{{ input.email }}'",
          },
        ],
      },
    });
    const selectStateTool = tools.find((tool) => tool.name === "select_state_machine_state");

    expect(selectStateTool).toBeDefined();
    if (!selectStateTool) throw new Error("select_state_machine_state tool missing");

    const accepted = await selectStateTool.execute("tool-1", {
      decision: {
        kind: "run_state",
        state: "send_email",
        override: {
          kind: "script",
          state: {
            inputSchema: {
              type: "object",
              properties: { prospectId: { type: "string" } },
              required: ["prospectId"],
              additionalProperties: false,
            },
          },
        },
        input: { prospectId: "prospect-1" },
      },
    });

    expect(accepted.details).toMatchObject({
      type: "select_state_machine_state",
      decision: {
        kind: "run_state",
        state: "send_email",
        input: { prospectId: "prospect-1" },
      },
    });

    const rejected = selectStateTool.execute("tool-2", {
      decision: {
        kind: "run_state",
        state: "send_email",
        override: {
          kind: "script",
          state: {
            inputSchema: {
              type: "object",
              properties: { prospectId: { type: "string" } },
              required: ["prospectId"],
              additionalProperties: false,
            },
          },
        },
        input: { email: "ada@example.com" },
      },
    });

    await expect(rejected).rejects.toThrow('Invalid input for state "send_email"');
  });

  test("returns trimmed current state-machine state for parent inspection", async () => {
    const stateMachine = {
      definition: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [
          {
            kind: "timer" as const,
            name: "waiting",
            wakeAt: 123,
          },
          { kind: "terminal" as const, name: "done", status: "completed" as const },
        ],
      },
      prompt: "Wait for reply.",
      currentState: "interrupted",
      progress: {
        states: {
          waiting: {
            kind: "poll" as const,
            runs: 1,
            sleeps: 6,
            nextWakeAt: 123,
          },
        },
      },
      history: Array.from({ length: 12 }, (_, index) => ({
        type: "state_started" as const,
        timestamp: index,
        state: `state-${index}`,
      })),
      createdAt: 1,
      updatedAt: 2,
    };
    const tools = createTurnRunnerTools({
      cwd: process.cwd(),
      mode: stateMachine.definition,
      getStateMachine: () => stateMachine,
    });
    const inspectTool = tools.find((tool) => tool.name === "get_current_state_machine_state");

    expect(inspectTool).toBeDefined();
    if (!inspectTool) throw new Error("get_current_state_machine_state tool missing");

    const result = await inspectTool.execute("tool-1", {});
    const details = result.details as { currentState?: string; history: unknown[] };
    expect(details.currentState).toBe("interrupted");
    expect(details.history).toContainEqual(expect.objectContaining({ state: "state-11" }));
    expect(details.history).toHaveLength(10);
    expect(result.details).toMatchObject({ historyCount: 12 });
    expect(result.details).toMatchObject({
      progress: {
        states: {
          waiting: {
            kind: "poll",
            runs: 1,
            sleeps: 6,
            nextWakeAt: 123,
          },
        },
      },
    });
  });

  test("rejects selected states outside the active definition", async () => {
    const tools = createTurnRunnerTools({
      cwd: process.cwd(),
      mode: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [
          { kind: "agent", name: "research", prompt: "Research the prospect." },
          { kind: "terminal", name: "done", status: "completed" },
        ],
      },
    });
    const selectStateTool = tools.find((tool) => tool.name === "select_state_machine_state");

    expect(selectStateTool).toBeDefined();
    if (!selectStateTool) throw new Error("select_state_machine_state tool missing");

    const result = selectStateTool.execute("tool-1", {
      decision: { kind: "run_state", state: "invented_state" },
    });

    await expect(result).rejects.toThrow(
      "Unknown state: invented_state. Valid states: research, done",
    );
  });

  test("rejects invalid states from dynamically created auto-mode definitions", async () => {
    const tools = createTurnRunnerTools({
      cwd: process.cwd(),
      mode: "auto",
      getDefinition: () => ({
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [
          { kind: "agent", name: "research", prompt: "Research the prospect." },
          { kind: "terminal", name: "done", status: "completed" },
        ],
      }),
    });
    const selectStateTool = tools.find((tool) => tool.name === "select_state_machine_state");

    expect(selectStateTool).toBeDefined();
    if (!selectStateTool) throw new Error("select_state_machine_state tool missing");

    const result = selectStateTool.execute("tool-1", {
      decision: { kind: "terminal", state: "invented_state" },
    });

    await expect(result).rejects.toThrow(
      "Unknown state: invented_state. Valid states: research, done",
    );
  });

  test("does not expose state-machine definition creation outside auto mode", () => {
    const agentTools = createTurnRunnerTools({ cwd: process.cwd(), mode: "agent" });
    const stateMachineTools = createTurnRunnerTools({
      cwd: process.cwd(),
      mode: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [{ kind: "terminal", name: "done", status: "completed" }],
      },
    });

    expect(agentTools.some((tool) => tool.name === "create_state_machine_definition")).toBe(false);
    expect(agentTools.some((tool) => tool.name === "ask_user_question")).toBe(true);
    expect(agentTools.some((tool) => tool.name === "select_state_machine_state")).toBe(false);
    expect(stateMachineTools.some((tool) => tool.name === "create_state_machine_definition")).toBe(
      false,
    );
    expect(stateMachineTools.some((tool) => tool.name === "select_state_machine_state")).toBe(true);
  });

  test("read_skill returns full SKILL.md instructions for a known skill", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "duet-skill-tool-"));
    try {
      const skillPath = join(tempDir, "SKILL.md");
      writeFileSync(
        skillPath,
        dedent`
          ---
          name: lazy-skill
          description: Lazy-loaded skill body.
          ---

          # Lazy Skill

          Full instructions live here.
        `,
      );
      const skill: Skill = {
        name: "lazy-skill",
        description: "Lazy-loaded skill body.",
        filePath: skillPath,
        baseDir: tempDir,
        sourceInfo: {} as Skill["sourceInfo"],
        disableModelInvocation: false,
      };

      const tools = createTurnRunnerTools({ cwd: process.cwd(), mode: "agent", skills: [skill] });
      const readSkillTool = tools.find((tool) => tool.name === "read_skill");

      expect(readSkillTool).toBeDefined();
      if (!readSkillTool) throw new Error("read_skill tool missing");

      const result = await readSkillTool.execute("tool-1", { name: "lazy-skill" });
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      expect(text).toContain("Full instructions live here.");
      expect(text).toContain(`Path: ${skillPath}`);
      expect(result.details).toEqual({
        type: "read_skill",
        name: "lazy-skill",
        filePath: skillPath,
      });

      const missing = readSkillTool.execute("tool-2", { name: "does-not-exist" });
      await expect(missing).rejects.toThrow(/Unknown skill: does-not-exist/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("describes tool schema properties for provider tool prompts", () => {
    const tools = createTurnRunnerTools({ cwd: process.cwd(), mode: "auto" });
    const createDefinitionTool = tools.find(
      (tool) => tool.name === "create_state_machine_definition",
    );
    const selectStateTool = tools.find((tool) => tool.name === "select_state_machine_state");

    expect(createDefinitionTool).toBeDefined();
    expect(selectStateTool).toBeDefined();
    if (!createDefinitionTool || !selectStateTool) throw new Error("Expected state-machine tools");

    // Smoke test: the trimmed description still surfaces the essentials
    // (call-shape example with the `definition` wrapper, the template syntax,
    // and the timer kind enum). Routing/policy guidance lives in the system
    // prompt, not this description.
    expect(createDefinitionTool.description).toContain("{{ input.foo }}");
    expect(createDefinitionTool.description).toContain('"kind": "agent"');
    expect(createDefinitionTool.description).toContain('"firstState"');
    expect(createDefinitionTool.description).toContain("`timer`");
    expect(selectStateTool.description).toContain("input object");
    expect(selectStateTool.description).toContain("timer overrides");
    expect(propertyDescription(createDefinitionTool.parameters, "definition")).toContain(
      "State-machine",
    );
    expect(propertyDescription(selectStateTool.parameters, "decision")).toContain(
      "State transition",
    );
  });

  describe("withDefaultBashTimeout", () => {
    function createRecordingOps(): {
      ops: BashOperations;
      calls: Array<{ command: string; timeout: number | undefined }>;
    } {
      const calls: Array<{ command: string; timeout: number | undefined }> = [];
      const ops: BashOperations = {
        exec: async (command, _cwd, options) => {
          calls.push({ command, timeout: options.timeout });
          return { exitCode: 0 };
        },
      };
      return { ops, calls };
    }

    test("fills in default timeout when caller did not specify one", async () => {
      const { ops, calls } = createRecordingOps();
      const wrapped = withDefaultBashTimeout(ops, 42);

      await wrapped.exec("echo hi", "/tmp", { onData: () => {} });

      expect(calls).toEqual([{ command: "echo hi", timeout: 42 }]);
    });

    test("respects an explicit timeout passed by the caller", async () => {
      const { ops, calls } = createRecordingOps();
      const wrapped = withDefaultBashTimeout(ops, 42);

      await wrapped.exec("sleep 1", "/tmp", { onData: () => {}, timeout: 7 });

      expect(calls).toEqual([{ command: "sleep 1", timeout: 7 }]);
    });

    test("treats timeout=0 as explicit (no override)", async () => {
      const { ops, calls } = createRecordingOps();
      const wrapped = withDefaultBashTimeout(ops, 42);

      await wrapped.exec("noop", "/tmp", { onData: () => {}, timeout: 0 });

      expect(calls).toEqual([{ command: "noop", timeout: 0 }]);
    });

    test("DEFAULT_BASH_TIMEOUT_SECONDS is a finite, positive duration", () => {
      expect(DEFAULT_BASH_TIMEOUT_SECONDS).toBeGreaterThan(0);
      expect(Number.isFinite(DEFAULT_BASH_TIMEOUT_SECONDS)).toBe(true);
    });
  });
});

function propertyDescription(schema: unknown, property: string): string {
  const record = schema as { properties?: Record<string, { description?: string }> };
  return record.properties?.[property]?.description ?? "";
}
