import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import dedent from "dedent";
import {
  createAskAdvisorTool,
  createTurnRunnerTools as createTurnRunnerToolsWithStorage,
  withoutBashKillTimeout,
  type AskAdvisorToolStorage,
  type TurnRunnerControlResult,
} from "../src/turn-runner/tools.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import { ModelRouter } from "../src/model-routing/router.js";
import { BUILT_IN_ROUTING_TABLE, type AdvisorPolicy } from "../src/model-routing/table.js";
import type { TurnTodo } from "../src/types/protocol.js";
import { testIfDocker } from "./helpers/docker-only.js";

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
  test("ask_advisor returns a graceful details-tagged refusal while gated", async () => {
    let advisorCalled = false;
    const tool = createAskAdvisorTool({
      getMessages: () => [],
      getSystemPrompt: () => "executor prompt",
      getObservations: async () => [],
      budgetTokens: 10_000,
      modelName: () => "anthropic/claude-fable-5",
      thinkingLevel: "high",
      advisorGate: () => ({ allowed: false, stepsUntilAllowed: 3 }),
      noteAdvisorConsult: () => {},
      callAdvisor: async () => {
        advisorCalled = true;
        return { advice: "unused" };
      },
    });

    const result = await tool.execute("advisor-1", {});

    expect(result.terminate).toBe(false);
    expect(result.details).toEqual({
      type: "ask_advisor",
      rateLimited: true,
      stepsUntilAllowed: 3,
    });
    expect(result.content[0]).toEqual(
      expect.objectContaining({ type: "text", text: expect.stringContaining("3 more") }),
    );
    expect(advisorCalled).toBe(false);
  });

  test("ask_advisor forwards cancellation and records only a successful consult", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let consults = 0;
    const tool = createAskAdvisorTool({
      getMessages: () => [
        { role: "user", content: "Build the router.", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "I inspected the implementation." }],
          api: "anthropic-messages",
          provider: "vercel-ai-gateway",
          model: "anthropic/claude-fable-5",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 2,
        },
      ],
      getSystemPrompt: () => "You are the executor.",
      getObservations: async () => ["The router API already owns the advisor gate."],
      budgetTokens: 10_000,
      modelName: () => "anthropic/claude-fable-5",
      thinkingLevel: "high",
      advisorGate: () => ({ allowed: true, stepsUntilAllowed: 0 }),
      noteAdvisorConsult: (success) => {
        if (success) consults += 1;
      },
      callAdvisor: async (input) => {
        receivedSignal = input.signal;
        expect(input.transcriptText).toContain("Build the router.");
        expect(input.transcriptText).toContain("> You are the executor.");
        expect(input.transcriptText).toContain("router API already owns");
        return { advice: "Verify the storage closure at the parent-agent boundary." };
      },
    });

    const result = await tool.execute("advisor-2", {}, controller.signal);

    expect(receivedSignal).toBe(controller.signal);
    expect(consults).toBe(1);
    expect(result.terminate).toBe(false);
    expect(result.content).toEqual([
      { type: "text", text: "Verify the storage closure at the parent-agent boundary." },
    ]);
    expect(result.details).toEqual({
      type: "ask_advisor",
      model: "anthropic/claude-fable-5",
      tokens: expect.any(Number),
    });
  });

  test("ask_advisor does not record a failed consult", async () => {
    let consults = 0;
    const tool = createAskAdvisorTool({
      getMessages: () => [{ role: "user", content: "Review this plan.", timestamp: 1 }],
      getSystemPrompt: () => "You are the executor.",
      getObservations: async () => [],
      budgetTokens: 10_000,
      modelName: () => "anthropic/claude-fable-5",
      thinkingLevel: "high",
      advisorGate: () => ({ allowed: true, stepsUntilAllowed: 0 }),
      noteAdvisorConsult: (success) => {
        if (success) consults += 1;
      },
      callAdvisor: async () => {
        throw new Error("advisor unavailable");
      },
    });

    await expect(tool.execute("advisor-failed", {})).rejects.toThrow("advisor unavailable");
    expect(consults).toBe(0);
  });

  test("overlapping ask_advisor executions reserve one router-owned consult slot", async () => {
    const router = new ModelRouter({
      table: BUILT_IN_ROUTING_TABLE,
      tier: "frontier",
      classify: async () => ({ route: "general", rationale: "General." }),
      resolveCatalog: { modelAcceptsImages: () => true },
    });
    let release!: () => void;
    let announceStarted!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const storage: AskAdvisorToolStorage = {
      getMessages: () => [{ role: "user", content: "Review this plan.", timestamp: 1 }],
      getSystemPrompt: () => "You are the executor.",
      getObservations: async () => [],
      budgetTokens: 10_000,
      modelName: () => "anthropic/claude-fable-5",
      thinkingLevel: "high",
      advisorGate: () => router.beginAdvisorConsult(),
      noteAdvisorConsult: (success = true) => router.endAdvisorConsult(success),
      callAdvisor: async () => {
        announceStarted();
        await blocked;
        return { advice: "Proceed." };
      },
    };
    const tool = createAskAdvisorTool(storage);

    const first = tool.execute("advisor-overlap-1", {});
    await started;
    const second = await tool.execute("advisor-overlap-2", {});
    expect(second.details).toEqual({
      type: "ask_advisor",
      rateLimited: true,
      stepsUntilAllowed: 0,
      inFlight: true,
    });
    release();
    await expect(first).resolves.toEqual(expect.objectContaining({ terminate: false }));
  });

  test("injects ask_advisor only for routed tiers that enable it", async () => {
    const priorKey = process.env.DUET_API_KEY;
    process.env.DUET_API_KEY = "advisor-tool-test-key";
    try {
      const frontier = new ToolListTurnRunner("frontier");
      await frontier.start({ type: "start", mode: "agent" });
      expect(frontier.toolNames()).toContain("ask_advisor");
      await frontier.dispose();

      const economy = new ToolListTurnRunner("economy");
      await economy.start({ type: "start", mode: "agent" });
      expect(economy.toolNames()).not.toContain("ask_advisor");
      await economy.dispose();

      const concrete = new ToolListTurnRunner("gpt-5.6-sol");
      await concrete.start({ type: "start", mode: "agent" });
      expect(concrete.toolNames()).not.toContain("ask_advisor");
      await concrete.dispose();
    } finally {
      if (priorKey === undefined) delete process.env.DUET_API_KEY;
      else process.env.DUET_API_KEY = priorKey;
    }
  });

  testIfDocker("lazy advisor resolution cannot crash session startup", async () => {
    const priorDuet = process.env.DUET_API_KEY;
    const priorVercel = process.env.AI_GATEWAY_API_KEY;
    const priorOpenRouter = process.env.OPENROUTER_API_KEY;
    const cwd = await mkdtemp(join(tmpdir(), "duet-advisor-lazy-"));
    delete process.env.DUET_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    process.env.OPENROUTER_API_KEY = "openrouter-test-key";
    try {
      const table = structuredClone(BUILT_IN_ROUTING_TABLE);
      table.tiers.frontier!.advisor.target.modelName = "gpt-5.6-luna";
      await mkdir(join(cwd, ".duet"));
      await writeFile(join(cwd, ".duet", "models.json"), JSON.stringify(table));
      const runner = new ToolListTurnRunner("frontier", cwd);

      await expect(runner.start({ type: "start", mode: "agent" })).resolves.toBeDefined();
      runner.parentMessages().push({ role: "user", content: "Review the plan.", timestamp: 1 });
      const advisor = runner.advisorTool();
      if (!advisor) throw new Error("ask_advisor tool missing");
      const result = await advisor.execute("advisor-unavailable", {});
      expect(result.details).toEqual({ type: "ask_advisor", unavailable: true });
      expect(result.content[0]).toEqual(
        expect.objectContaining({ text: expect.stringContaining("unavailable") }),
      );
      await runner.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
      if (priorDuet === undefined) delete process.env.DUET_API_KEY;
      else process.env.DUET_API_KEY = priorDuet;
      if (priorVercel === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = priorVercel;
      if (priorOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = priorOpenRouter;
    }
  });

  test("tier switches rebuild advisor injection and bind consults to the new router", async () => {
    // Routed boot resolves the tier's concrete target, which requires a
    // provider credential to be PRESENT (never called — the classifier and
    // advisor are faked). Fresh checkouts/worktrees carry no .env, so the
    // test supplies its own key like turn-runner-router.test.ts does.
    const priorKey = process.env.DUET_API_KEY;
    process.env.DUET_API_KEY = "tier-switch-test-key";
    try {
      await runTierSwitchScenario();
    } finally {
      if (priorKey === undefined) delete process.env.DUET_API_KEY;
      else process.env.DUET_API_KEY = priorKey;
    }
  });

  async function runTierSwitchScenario(): Promise<void> {
    const runner = new ToolListTurnRunner("economy");
    await runner.start({ type: "start", mode: "agent" });
    expect(runner.toolNames()).not.toContain("ask_advisor");

    runner.setModel("frontier");
    runner.refreshToolsForTest();
    expect(runner.toolNames()).toContain("ask_advisor");
    runner.parentMessages().push({ role: "user", content: "Review the plan.", timestamp: 1 });
    const advisor = runner.advisorTool();
    if (!advisor) throw new Error("ask_advisor tool missing");
    await advisor.execute("advisor-after-switch", {});
    expect(runner.consultedRouters.at(-1)).toBe(runner.currentRouter());
    expect(runner.completedConsultRouters.at(-1)).toBe(runner.currentRouter());

    runner.setModel("economy");
    runner.refreshToolsForTest();
    expect(runner.toolNames()).not.toContain("ask_advisor");
    await runner.dispose();
  }

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

  test("rejects ask_user_question calls with an empty options array", async () => {
    const tools = createTurnRunnerTools({ cwd: process.cwd(), mode: "agent" });
    const askUserQuestionTool = tools.find((tool) => tool.name === "ask_user_question");
    expect(askUserQuestionTool).toBeDefined();
    if (!askUserQuestionTool) throw new Error("ask_user_question tool missing");

    await expect(
      askUserQuestionTool.execute("tool-empty", {
        questions: [
          {
            question: "Pick one",
            options: [],
          },
          {
            question: "Pick two",
            options: [{ label: "only" }],
          },
        ],
      }),
    ).rejects.toThrow(
      "ask_user_question rejected: questions[0] has no options. Each question must include at least one option.",
    );
  });

  test("ask_user_question rejection message points at the offending question's index", async () => {
    const tools = createTurnRunnerTools({ cwd: process.cwd(), mode: "agent" });
    const askUserQuestionTool = tools.find((tool) => tool.name === "ask_user_question");
    if (!askUserQuestionTool) throw new Error("ask_user_question tool missing");

    await expect(
      askUserQuestionTool.execute("tool-empty-2", {
        questions: [
          { question: "Has options", options: [{ label: "yes" }] },
          { question: "No options", options: [] },
        ],
      }),
    ).rejects.toThrow(/questions\[1\] has no options/);
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

  test("accepts a park first state and appends the binding park nudge", async () => {
    const tools = createTurnRunnerTools({ cwd: process.cwd(), mode: "auto" });
    const createDefinitionTool = tools.find(
      (tool) => tool.name === "create_state_machine_definition",
    );
    if (!createDefinitionTool) throw new Error("create_state_machine_definition tool missing");

    const result = await createDefinitionTool.execute("tool-park", {
      definition: {
        name: "approval_gate",
        prompt: "Wait for approval.",
        states: [
          { kind: "park", name: "await_approval" },
          { kind: "terminal", name: "done", status: "completed" },
        ],
      },
      firstState: "await_approval",
    });
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
      'The state machine is parked at "await_approval".',
    );
  });

  test("rejects a definition whose state cwd does not exist", async () => {
    const tools = createTurnRunnerTools({ cwd: process.cwd(), mode: "auto" });
    const createDefinitionTool = tools.find(
      (tool) => tool.name === "create_state_machine_definition",
    );
    if (!createDefinitionTool) throw new Error("create_state_machine_definition tool missing");

    const result = createDefinitionTool.execute("tool-1", {
      definition: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [
          {
            kind: "agent",
            name: "implement",
            prompt: "Do the work.",
            cwd: "/nonexistent/worktree/path",
          },
          { kind: "terminal", name: "done", status: "completed" },
        ],
      },
      firstState: "implement",
    });

    await expect(result).rejects.toThrow(
      'cwd "/nonexistent/worktree/path" for state "implement" does not exist',
    );
    // The creation-time guidance points the model at the omit-now/set-later
    // pattern rather than the selection-time "already created" phrasing.
    await expect(result).rejects.toThrow("omit cwd here and set it via override.cwd");
  });

  test("rejects create-while-active without replaceActive, naming the active machine", async () => {
    const activeSession = {
      definition: {
        name: "conference_outreach",
        prompt: "Outreach flow.",
        states: [
          { kind: "poll" as const, name: "poll_email_reply", intervalMs: 300_000, command: "x" },
          { kind: "terminal" as const, name: "done", status: "completed" as const },
        ],
      },
      prompt: "Prospect Ada.",
      currentState: "poll_email_reply",
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const tools = createTurnRunnerTools({
      cwd: process.cwd(),
      mode: "auto",
      getStateMachine: () => activeSession,
    });
    const createDefinitionTool = tools.find(
      (tool) => tool.name === "create_state_machine_definition",
    );
    if (!createDefinitionTool) throw new Error("create_state_machine_definition tool missing");

    const result = createDefinitionTool.execute("tool-1", {
      definition: {
        name: "follow_up_flow",
        prompt: "New flow.",
        states: [{ kind: "terminal", name: "done", status: "completed" }],
      },
      firstState: "done",
    });

    // The error names the active machine and its current state so the agent can
    // decide whether to advance it or deliberately replace it.
    await expect(result).rejects.toThrow("conference_outreach");
    await expect(result).rejects.toThrow("poll_email_reply");
    await expect(result).rejects.toThrow("replaceActive: true");
  });

  test("allows create-while-active when replaceActive is set", async () => {
    const activeSession = {
      definition: {
        name: "conference_outreach",
        prompt: "Outreach flow.",
        states: [{ kind: "terminal" as const, name: "done", status: "completed" as const }],
      },
      prompt: "Prospect Ada.",
      currentState: "research_prospect",
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const tools = createTurnRunnerTools({
      cwd: process.cwd(),
      mode: "auto",
      getStateMachine: () => activeSession,
    });
    const createDefinitionTool = tools.find(
      (tool) => tool.name === "create_state_machine_definition",
    );
    if (!createDefinitionTool) throw new Error("create_state_machine_definition tool missing");

    const result = await createDefinitionTool.execute("tool-1", {
      definition: {
        name: "follow_up_flow",
        prompt: "New flow.",
        states: [{ kind: "terminal", name: "done", status: "completed" }],
      },
      firstState: "done",
      replaceActive: true,
    });

    const details: TurnRunnerControlResult = result.details;
    expect(details).toMatchObject({
      type: "create_state_machine_definition",
      definition: { name: "follow_up_flow" },
      firstState: "done",
    });
    expect(result.terminate).toBe(true);
  });

  test("allows create when the active session has already terminated", async () => {
    const terminalSession = {
      definition: {
        name: "conference_outreach",
        prompt: "Outreach flow.",
        states: [{ kind: "terminal" as const, name: "done", status: "completed" as const }],
      },
      prompt: "Prospect Ada.",
      currentState: "done",
      history: [],
      terminal: { state: "done", status: "completed" as const },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const tools = createTurnRunnerTools({
      cwd: process.cwd(),
      mode: "auto",
      getStateMachine: () => terminalSession,
    });
    const createDefinitionTool = tools.find(
      (tool) => tool.name === "create_state_machine_definition",
    );
    if (!createDefinitionTool) throw new Error("create_state_machine_definition tool missing");

    const result = await createDefinitionTool.execute("tool-1", {
      definition: {
        name: "follow_up_flow",
        prompt: "New flow.",
        states: [{ kind: "terminal", name: "done", status: "completed" }],
      },
      firstState: "done",
    });

    expect(result.terminate).toBe(true);
    expect(result.details).toMatchObject({ type: "create_state_machine_definition" });
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
      'Invalid poll schedule for state "wait_for_reply": intervalMs must be a duration string (e.g. "3h") or a positive number of milliseconds.',
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
      'Invalid timer schedule for state "wait_for_reply": wakeAt must be a finite Unix-epoch millisecond timestamp.',
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
      decision: { state: "done" },
    });

    const details: TurnRunnerControlResult = result.details;
    expect(details).toEqual({
      type: "select_state_machine_state",
      decision: { state: "done" },
    });
    expect(result.terminate).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(details, null, 2) }]);
  });

  test("selecting a park appends the binding park nudge", async () => {
    const tools = createTurnRunnerTools({
      cwd: process.cwd(),
      mode: {
        name: "approval_gate",
        prompt: "Wait for approval.",
        states: [{ kind: "park", name: "await_approval" }],
      },
    });
    const selectStateTool = tools.find((tool) => tool.name === "select_state_machine_state");
    if (!selectStateTool) throw new Error("select_state_machine_state tool missing");

    const result = await selectStateTool.execute("tool-park", {
      decision: { state: "await_approval", override: { kind: "park", state: {} } },
    });
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
      "you may end your turn and the machine stays parked.",
    );
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
        state: "send_email",
        input: { email: "ada@example.com" },
      },
    });

    expect(result.details).toMatchObject({
      type: "select_state_machine_state",
      decision: {
        state: "send_email",
        input: { email: "ada@example.com" },
      },
    });

    const resultWithOptionalField = await selectStateTool.execute("tool-2", {
      decision: {
        state: "send_email",
        input: { email: "ada@example.com", followUpCount: 1 },
      },
    });

    expect(resultWithOptionalField.details).toMatchObject({
      type: "select_state_machine_state",
      decision: {
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
        state: "send_email",
        input: { prospectId: "prospect-1" },
      },
    });

    const rejected = selectStateTool.execute("tool-2", {
      decision: {
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
      decision: { state: "invented_state" },
    });

    await expect(result).rejects.toThrow(
      "Unknown state: invented_state. Valid states: research, done",
    );
  });

  test("rejects an override whose kind does not match the selected state", async () => {
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
      decision: {
        state: "research",
        override: { kind: "script", state: { command: "echo nope" } },
      },
    });

    await expect(result).rejects.toThrow(
      'Override kind "script" does not match state "research", which is a "agent" state.',
    );
  });

  test("rejects a selected state whose cwd does not exist", async () => {
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
      decision: {
        state: "research",
        override: { kind: "agent", state: { cwd: "/nonexistent/worktree/path" } },
      },
    });

    await expect(result).rejects.toThrow(
      'cwd "/nonexistent/worktree/path" for state "research" does not exist',
    );
  });

  test("accepts a matching-kind override pointing at an existing cwd", async () => {
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

    const result = await selectStateTool.execute("tool-1", {
      decision: {
        state: "research",
        override: { kind: "agent", state: { prompt: "Tuned prompt.", cwd: process.cwd() } },
      },
    });

    expect(result.details).toMatchObject({
      type: "select_state_machine_state",
      decision: { state: "research" },
    });
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
      decision: { state: "invented_state" },
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
    expect(createDefinitionTool.description).toContain("`park`");
    expect(selectStateTool.description).toContain("input object");
    expect(selectStateTool.description).toContain("timer overrides");
    expect(propertyDescription(createDefinitionTool.parameters, "definition")).toContain(
      "State-machine",
    );
    expect(propertyDescription(selectStateTool.parameters, "decision")).toContain(
      "State transition",
    );
  });

  describe("withoutBashKillTimeout", () => {
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

    test("forwards no kill timeout when caller did not specify one", async () => {
      const { ops, calls } = createRecordingOps();
      const wrapped = withoutBashKillTimeout(ops);

      await wrapped.exec("echo hi", "/tmp", { onData: () => {} });

      expect(calls).toEqual([{ command: "echo hi", timeout: undefined }]);
    });

    test("strips an explicit timeout before the inner bash executor", async () => {
      const { ops, calls } = createRecordingOps();
      const wrapped = withoutBashKillTimeout(ops);

      await wrapped.exec("sleep 1", "/tmp", { onData: () => {}, timeout: 7 });

      expect(calls).toEqual([{ command: "sleep 1", timeout: undefined }]);
    });

    test("treats timeout=0 as explicit (no override)", async () => {
      const { ops, calls } = createRecordingOps();
      const wrapped = withoutBashKillTimeout(ops);

      await wrapped.exec("noop", "/tmp", { onData: () => {}, timeout: 0 });

      expect(calls).toEqual([{ command: "noop", timeout: undefined }]);
    });
  });
});

class ToolListTurnRunner extends TurnRunner {
  readonly consultedRouters: ModelRouter[] = [];
  readonly completedConsultRouters: ModelRouter[] = [];

  constructor(model: string, cwd?: string) {
    super({
      model,
      mode: "agent",
      ...(cwd ? { cwd } : {}),
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
    });
  }

  toolNames(): string[] {
    return this.requireParentAgent().state.tools.map((tool) => tool.name);
  }

  advisorTool() {
    return this.requireParentAgent().state.tools.find((tool) => tool.name === "ask_advisor");
  }

  parentMessages() {
    return this.requireParentAgent().state.messages;
  }

  refreshToolsForTest(): void {
    this.requireParentAgent().state.tools = this.createTools("agent").tools;
  }

  currentRouter(): ModelRouter | undefined {
    return this.modelRouter;
  }

  protected override createAskAdvisorStorage(
    router: ModelRouter,
    policy: AdvisorPolicy,
  ): AskAdvisorToolStorage {
    const storage = super.createAskAdvisorStorage(router, policy);
    const begin = storage.advisorGate;
    storage.advisorGate = () => {
      this.consultedRouters.push(router);
      return begin();
    };
    const note = storage.noteAdvisorConsult;
    storage.noteAdvisorConsult = (success) => {
      if (success) this.completedConsultRouters.push(router);
      note(success);
    };
    storage.callAdvisor = async () => ({ advice: "Proceed with the new tier." });
    return storage;
  }
}

function propertyDescription(schema: unknown, property: string): string {
  const record = schema as { properties?: Record<string, { description?: string }> };
  return record.properties?.[property]?.description ?? "";
}
