import { describe, expect, test } from "bun:test";
import { createTurnRunnerTools, type TurnRunnerControlResult } from "../src/turn-runner/tools.js";

describe("TurnRunner tools", () => {
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
        states: [{ kind: "terminal", name: "done", status: "completed" }],
      },
      firstState: "done",
    });
    expect(result.terminate).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(details, null, 2) }]);
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

  test("returns state-machine agent prompts in tool details and model-visible content", async () => {
    const tools = createTurnRunnerTools({
      cwd: process.cwd(),
      mode: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [{ kind: "agent", name: "waiting", prompt: "Wait for a reply." }],
      },
    });
    const promptAgentTool = tools.find((tool) => tool.name === "prompt_state_machine_agent");

    expect(promptAgentTool).toBeDefined();
    if (!promptAgentTool) throw new Error("prompt_state_machine_agent tool missing");

    const result = await promptAgentTool.execute("tool-1", {
      prompt: "Use the user's reply to continue.",
    });

    const details: TurnRunnerControlResult = result.details;
    expect(details).toEqual({
      type: "prompt_state_machine_agent",
      prompt: "Use the user's reply to continue.",
    });
    expect(result.terminate).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(details, null, 2) }]);
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
      definition: {
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
    expect(stateMachineTools.some((tool) => tool.name === "prompt_state_machine_agent")).toBe(true);
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

    expect(createDefinitionTool.description).toContain("{{ input.email }}");
    expect(selectStateTool.description).toContain("input object");
    expect(propertyDescription(createDefinitionTool.parameters, "definition")).toContain(
      "State-machine",
    );
    expect(propertyDescription(selectStateTool.parameters, "decision")).toContain(
      "State transition",
    );
  });
});

function propertyDescription(schema: unknown, property: string): string {
  const record = schema as { properties?: Record<string, { description?: string }> };
  return record.properties?.[property]?.description ?? "";
}
