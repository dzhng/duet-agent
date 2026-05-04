import { describe, expect, test } from "bun:test";
import { createHarnessTools, type HarnessControlResult } from "../src/harness/tools.js";

describe("Harness tools", () => {
  test("returns control decisions in tool details and model-visible content", async () => {
    const tools = createHarnessTools({ cwd: process.cwd(), mode: "auto" });
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

    const details: HarnessControlResult = result.details;
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
    const tools = createHarnessTools({
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

    const details: HarnessControlResult = result.details;
    expect(details).toEqual({
      type: "select_state_machine_state",
      decision: { kind: "terminal", state: "done" },
    });
    expect(result.terminate).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(details, null, 2) }]);
  });

  test("does not expose state-machine definition creation outside auto mode", () => {
    const agentTools = createHarnessTools({ cwd: process.cwd(), mode: "agent" });
    const stateMachineTools = createHarnessTools({
      cwd: process.cwd(),
      mode: {
        name: "outreach",
        prompt: "Use for outreach work.",
        states: [{ kind: "terminal", name: "done", status: "completed" }],
      },
    });

    expect(agentTools.some((tool) => tool.name === "create_state_machine_definition")).toBe(false);
    expect(agentTools.some((tool) => tool.name === "select_state_machine_state")).toBe(false);
    expect(stateMachineTools.some((tool) => tool.name === "create_state_machine_definition")).toBe(
      false,
    );
    expect(stateMachineTools.some((tool) => tool.name === "select_state_machine_state")).toBe(true);
  });
});
