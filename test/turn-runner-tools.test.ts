import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { Skill } from "@mariozechner/pi-coding-agent";
import dedent from "dedent";
import { createTurnRunnerTools, type TurnRunnerControlResult } from "../src/turn-runner/tools.js";

describe("TurnRunner tools", () => {
  test("todo_write replaces and merges todo lists", async () => {
    const tools = createTurnRunnerTools({ cwd: process.cwd(), mode: "agent" });
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
    expect(initial.details).toEqual({
      type: "todo_write",
      todos: [
        { id: "plan", content: "Plan the work", status: "completed" },
        { id: "test", content: "Run tests", status: "pending" },
      ],
    });
    expect(initial.content).toEqual([
      {
        type: "text",
        text: [
          "Current task list:",
          "- [completed] plan: Plan the work",
          "- [pending] test: Run tests",
        ].join("\n"),
      },
    ]);

    const merged = await todoTool.execute("tool-2", {
      merge: true,
      todos: [
        { id: "test", content: "Run tests", status: "in_progress" },
        { id: "verify", content: "Verify behavior", status: "failed" },
      ],
    });

    expect(merged.details).toEqual({
      type: "todo_write",
      todos: [
        { id: "plan", content: "Plan the work", status: "completed" },
        { id: "test", content: "Run tests", status: "in_progress" },
        { id: "verify", content: "Verify behavior", status: "failed" },
      ],
    });
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
        states: [{ kind: "terminal", name: "done", status: "completed" }],
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
      expect(text).toContain(`Base directory: ${tempDir}`);
      expect(result.details).toEqual({
        type: "read_skill",
        name: "lazy-skill",
        filePath: skillPath,
        baseDir: tempDir,
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
