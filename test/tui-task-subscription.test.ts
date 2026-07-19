import { describe, expect, test } from "bun:test";
import type { BoxRenderable, TextRenderable } from "@opentui/core";
import type { Session } from "../src/session/session.js";
import { bindSessionToUi } from "../src/tui/session-subscription.js";
import type { QuestionPicker } from "../src/tui/question-picker.js";
import type { Sidebar } from "../src/tui/sidebar.js";
import type { StatusController } from "../src/tui/status-controller.js";
import type { StepRenderer } from "../src/tui/step-renderer.js";
import type { TaskLaneRenderer } from "../src/tui/task-lane-renderer.js";
import type { TurnEvent } from "../src/types/protocol.js";

const INITIAL_STATE = {
  status: "running" as const,
  mode: "agent" as const,
  agent: { status: "running" as const, messages: [] },
};

describe("TUI task subscription", () => {
  test("seeds hydrated tasks, routes task origins into their sibling lane, and idles only at a terminal", () => {
    const task = {
      id: "t4" as const,
      kind: "subagent" as const,
      name: "spawn_agent",
      label: "audit auth flows",
      ownerScopeId: "root",
      status: "running" as const,
      startedAt: 1000,
    };
    let handler: ((event: TurnEvent) => void) | undefined;
    const session = {
      getState: () => ({ ...INITIAL_STATE, tasks: [task] }),
      getLastUsage: () => undefined,
      getSessionCostUsd: () => 0,
      routeStatus: () => undefined,
      subscribe: (next: (event: TurnEvent) => void) => {
        handler = next;
        return () => undefined;
      },
    } as unknown as Session;
    const laneEvents: TurnEvent[] = [];
    const seeds: unknown[] = [];
    const taskLaneRenderer = {
      seed: (...args: unknown[]) => seeds.push(args),
      renderEvent: (event: TurnEvent) => laneEvents.push(event),
    } as unknown as TaskLaneRenderer;
    const parentSteps: unknown[] = [];
    const stepRenderer = {
      renderStep: (step: unknown) => parentSteps.push(step),
      renderUsage: () => undefined,
      renderTurnElapsed: () => undefined,
      renderSleeping: () => undefined,
      renderMemoryStatus: () => undefined,
    } as unknown as StepRenderer;
    let idleCalls = 0;
    const statusController = {
      markIdle: () => {
        idleCalls += 1;
      },
      setQueuedFollowUps: () => undefined,
    } as unknown as StatusController;
    const sidebar = {
      setTodos: () => undefined,
      setStateMachine: () => undefined,
      setRouteStatus: () => undefined,
      setUsage: () => undefined,
      setSessionCost: () => undefined,
    } as unknown as Sidebar;
    const followUpPanel = { visible: false } as unknown as BoxRenderable;
    const followUpPanelBody = { content: "" } as unknown as TextRenderable;

    bindSessionToUi({
      session,
      sidebar,
      followUpPanel,
      followUpPanelBody,
      taskLaneRenderer,
      stepRenderer,
      statusController,
      questionPicker: { show: () => undefined } as unknown as QuestionPicker,
      appendLine: () => undefined,
      appendBlock: () => undefined,
      appendUserBlock: () => undefined,
    });

    expect(seeds).toEqual([[[task], undefined]]);
    if (!handler) throw new Error("subscription handler was not installed");

    handler({
      type: "step",
      origin: { kind: "task", taskId: "t4", ownerScopeId: "root" },
      step: { type: "text", text: "child output" },
    });
    expect(laneEvents).toHaveLength(1);
    expect(parentSteps).toEqual([]);

    handler({ type: "step", step: { type: "text", text: "parent output" } });
    expect(laneEvents).toHaveLength(2);
    expect(parentSteps).toEqual([{ type: "text", text: "parent output" }]);

    handler({ type: "heartbeat", timestamp: 2000, activeTaskIds: ["t4"] });
    handler({ type: "system", level: "error", message: "diagnostic" });
    expect(laneEvents).toHaveLength(2);
    expect(idleCalls).toBe(0);

    handler({
      type: "complete",
      status: "completed",
      result: "done",
      state: { ...INITIAL_STATE, status: "completed" },
    });
    expect(idleCalls).toBe(1);
  });
});
