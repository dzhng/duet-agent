import { describe, expect } from "bun:test";
import { testIfDocker } from "../test/helpers/docker-only.js";
import { waitFor } from "../test/helpers/async.js";
import { createAssistantMessage } from "../test/helpers/messages.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import {
  TurnRunner,
  type AgentWorkerInput,
  type AgentWorkerResult,
} from "../src/turn-runner/turn-runner.js";
import type { StateAgentHandle } from "../src/turn-runner/state-machine-controller.js";
import type { TurnRunnerControlResult } from "../src/turn-runner/tools.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";

describe("state-machine interrupt resume", () => {
  testIfDocker(
    "reruns an interrupted agent state from a fresh state-agent transcript",
    async () => {
      const firstRunner = new EvalTurnRunner({
        parentControls: [
          {
            type: "select_state_machine_state",
            decision: { kind: "run_state", state: "agent_step" },
          },
        ],
        agentTerminals: ["pending"],
      });

      const { turn } = await startTurn(firstRunner, {
        mode: interruptDefinition,
        prompt: "Run the agent step.",
      });
      await waitFor(() => firstRunner.startedStateAgents === 1);
      firstRunner.interrupt({ type: "interrupt" });
      const interrupted = await turn;

      expect(interrupted.type).toBe("interrupted");
      expect(interrupted.state.stateMachine?.currentState).toBe("interrupted");
      expect(interrupted.state.stateMachine?.history).toContainEqual(
        expect.objectContaining({ type: "state_interrupted", state: "agent_step" }),
      );

      const secondRunner = new EvalTurnRunner({
        parentControls: [
          {
            type: "select_state_machine_state",
            decision: { kind: "run_state", state: "agent_step" },
          },
          { type: "select_state_machine_state", decision: { kind: "terminal", state: "done" } },
        ],
        agentTerminals: ["complete"],
      });
      await secondRunner.start({ type: "start", state: interrupted.state });
      const terminal = await secondRunner.turn({
        type: "prompt",
        message: "continue",
        behavior: "follow_up",
      });

      expect(terminal).toMatchObject({
        type: "complete",
        status: "completed",
        state: { stateMachine: { terminal: { state: "done", status: "completed" } } },
      });
      expect(secondRunner.startedStateAgents).toBe(1);
      expect(secondRunner.stateAgentPrompts).toEqual(["Do the agent work."]);
    },
  );

  testIfDocker(
    "records partial stdout and stderr when script and poll states are interrupted",
    async () => {
      for (const stateName of ["script_step", "poll_step"] as const) {
        const runner = new EvalTurnRunner({
          parentControls: [
            {
              type: "select_state_machine_state",
              decision: { kind: "run_state", state: stateName },
            },
          ],
          agentTerminals: [],
        });

        const { turn } = await startTurn(runner, {
          mode: interruptDefinition,
          prompt: `Run ${stateName}.`,
        });
        await waitFor(() => runner.events.some((event) => event === stateName));
        await new Promise((resolve) => setTimeout(resolve, 50));
        runner.interrupt({ type: "interrupt" });
        const interrupted = await turn;
        const event = interrupted.state.stateMachine?.history.find(
          (candidate) => candidate.type === "state_interrupted" && candidate.state === stateName,
        );

        expect(interrupted.type).toBe("interrupted");
        expect(event).toMatchObject({
          type: "state_interrupted",
          state: stateName,
          output: { stdout: expect.stringContaining(`${stateName}-out`) },
        });
      }
    },
  );

  testIfDocker("routes state-agent ask answers through a fresh parent-selected state", async () => {
    const runner = new EvalTurnRunner({
      parentControls: [
        {
          type: "select_state_machine_state",
          decision: { kind: "run_state", state: "answered_agent" },
        },
        {
          type: "select_state_machine_state",
          decision: {
            kind: "run_state",
            state: "answered_agent",
            input: { answer: "Ada" },
          },
        },
        { type: "select_state_machine_state", decision: { kind: "terminal", state: "done" } },
      ],
      agentTerminals: ["ask", "complete"],
    });

    const { turn } = await startTurn(runner, {
      mode: answerDefinition,
      prompt: "Run the agent question flow.",
    });
    const asked = await turn;
    expect(asked.type).toBe("ask");
    expect(asked.state.stateMachine?.history).toContainEqual(
      expect.objectContaining({ type: "state_asked_user", state: "answered_agent" }),
    );

    await runner.start({ type: "start", state: asked.state });
    const terminal = await runner.turn({
      type: "answer",
      questions: [{ question: "Which prospect?", options: [{ label: "Ada" }] }],
      answers: { prospect: "Ada" },
      behavior: "follow_up",
    });

    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      state: { stateMachine: { terminal: { state: "done", status: "completed" } } },
    });
    expect(runner.startedStateAgents).toBe(2);
    expect(runner.stateAgentPrompts.at(-1)).toContain("Ada");
  });

  testIfDocker("reruns an interrupted script state with the same transition input", async () => {
    const firstRunner = new EvalTurnRunner({
      parentControls: [
        {
          type: "select_state_machine_state",
          decision: { kind: "run_state", state: "script_step", input: { value: "same-input" } },
        },
      ],
      agentTerminals: [],
    });

    const { turn } = await startTurn(firstRunner, {
      mode: interruptDefinition,
      prompt: "Run the script step.",
    });
    await waitFor(() => firstRunner.events.includes("script_step"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    firstRunner.interrupt({ type: "interrupt" });
    const interrupted = await turn;

    const secondRunner = new EvalTurnRunner({
      parentControls: [
        {
          type: "select_state_machine_state",
          decision: {
            kind: "run_state",
            state: "script_step",
            input: { value: "same-input" },
            override: { kind: "script", state: { command: "printf '{\"rerun\":true}'" } },
          },
        },
        { type: "select_state_machine_state", decision: { kind: "terminal", state: "done" } },
      ],
      agentTerminals: [],
    });
    await secondRunner.start({ type: "start", state: interrupted.state });
    const terminal = await secondRunner.turn({
      type: "prompt",
      message: "continue",
      behavior: "follow_up",
    });

    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      state: { stateMachine: { terminal: { state: "done", status: "completed" } } },
    });
    const scriptStarts = terminal.state.stateMachine?.history.filter(
      (event) => event.type === "state_started" && event.state === "script_step",
    );
    expect(scriptStarts?.at(-1)).toMatchObject({ input: { value: "same-input" } });
  });

  testIfDocker("reruns an interrupted poll state with the same transition input", async () => {
    const firstRunner = new EvalTurnRunner({
      parentControls: [
        {
          type: "select_state_machine_state",
          decision: { kind: "run_state", state: "poll_step", input: { value: "same-input" } },
        },
      ],
      agentTerminals: [],
    });

    const { turn } = await startTurn(firstRunner, {
      mode: interruptDefinition,
      prompt: "Run the poll step.",
    });
    await waitFor(() => firstRunner.events.includes("poll_step"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    firstRunner.interrupt({ type: "interrupt" });
    const interrupted = await turn;

    const secondRunner = new EvalTurnRunner({
      parentControls: [
        {
          type: "select_state_machine_state",
          decision: {
            kind: "run_state",
            state: "poll_step",
            input: { value: "same-input" },
            override: {
              kind: "poll",
              state: {
                poll: { kind: "script", command: "printf '{\"rerun\":true}'" },
              },
            },
          },
        },
        { type: "select_state_machine_state", decision: { kind: "terminal", state: "done" } },
      ],
      agentTerminals: [],
    });
    await secondRunner.start({ type: "start", state: interrupted.state });
    const terminal = await secondRunner.turn({
      type: "prompt",
      message: "continue",
      behavior: "follow_up",
    });

    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      state: { stateMachine: { terminal: { state: "done", status: "completed" } } },
    });
    const pollStarts = terminal.state.stateMachine?.history.filter(
      (event) => event.type === "state_started" && event.state === "poll_step",
    );
    expect(pollStarts?.at(-1)).toMatchObject({ input: { value: "same-input" } });
  });

  testIfDocker("steer during active script work can replace the running state", async () => {
    const runner = new EvalTurnRunner({
      parentControls: [
        {
          type: "select_state_machine_state",
          decision: { kind: "run_state", state: "script_step" },
        },
        {
          type: "select_state_machine_state",
          decision: {
            kind: "run_state",
            state: "script_step",
            override: { kind: "script", state: { command: "printf '{\"replacement\":true}'" } },
          },
        },
        { type: "select_state_machine_state", decision: { kind: "terminal", state: "done" } },
      ],
      agentTerminals: [],
    });

    const { turn } = await startTurn(runner, {
      mode: interruptDefinition,
      prompt: "Run the script step.",
    });
    await waitFor(() => runner.events.includes("script_step"));
    const steer = runner.turn({
      type: "prompt",
      message: "replace the running script",
      behavior: "steer",
    });
    const terminal = await turn;
    const steerTerminal = await steer;

    expect(terminal).toBe(steerTerminal);
    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      state: { stateMachine: { terminal: { state: "done", status: "completed" } } },
    });
    expect(runner.parentPrompts).toContainEqual(
      expect.stringContaining("replace the running script"),
    );
    expect(terminal.state.stateMachine?.history).toContainEqual(
      expect.objectContaining({ type: "state_interrupted", state: "script_step" }),
    );
  });
});

const interruptDefinition: StateMachineDefinition = {
  name: "interrupt_resume_eval",
  prompt: "Use this definition to test interrupted state-machine states.",
  states: [
    { kind: "agent", name: "agent_step", prompt: "Do the agent work." },
    {
      kind: "script",
      name: "script_step",
      command: "printf script_step-out; printf script_step-err >&2; sleep 2",
    },
    {
      kind: "poll",
      name: "poll_step",
      intervalMs: 60_000,
      poll: {
        kind: "script",
        command: "printf poll_step-out; printf poll_step-err >&2; sleep 2",
      },
    },
    { kind: "terminal", name: "done", status: "completed" },
  ],
};

const answerDefinition: StateMachineDefinition = {
  name: "answer_eval",
  prompt: "Use this definition to test state-agent answers through the parent.",
  states: [
    {
      kind: "agent",
      name: "answered_agent",
      prompt: "Continue with answer {{ input.answer }}.",
    },
    { kind: "terminal", name: "done", status: "completed" },
  ],
};

class EvalTurnRunner extends TurnRunner {
  readonly stateAgentPrompts: string[] = [];
  readonly parentPrompts: string[] = [];
  readonly events: string[] = [];
  startedStateAgents = 0;
  private readonly parentControls: TurnRunnerControlResult[];
  private readonly agentTerminals: Array<"pending" | "complete" | "ask">;

  constructor(input: {
    parentControls: TurnRunnerControlResult[];
    agentTerminals: Array<"pending" | "complete" | "ask">;
  }) {
    super({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
    this.parentControls = [...input.parentControls];
    this.agentTerminals = [...input.agentTerminals];
    this.subscribe((event) => {
      if (event.type === "state_machine") this.events.push(event.currentState);
    });
  }

  protected override async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    this.parentPrompts.push(input.prompt);
    const control = this.parentControls.shift() ?? { type: "none" };
    return {
      control,
      terminal: {
        type: "complete",
        status: "completed",
        result: "Parent decision.",
        state: {
          ...input.state,
          status: "completed",
          agent: {
            ...input.state.agent,
            status: "completed",
            messages: [
              ...input.state.agent.messages,
              createAssistantMessage({ text: "Parent decision." }),
            ],
          },
        },
      },
    };
  }

  protected override createStateAgentHandle(input: { prompt: string }): StateAgentHandle {
    this.startedStateAgents += 1;
    this.stateAgentPrompts.push(input.prompt);
    let interrupted = false;
    return {
      prompt: async () => {
        const terminal = this.agentTerminals.shift() ?? "complete";
        if (terminal === "pending") {
          await waitFor(() => interrupted, 5_000);
          return { type: "interrupted" };
        }
        if (terminal === "ask") {
          return {
            type: "ask",
            questions: [{ question: "Which prospect?", options: [{ label: "Ada" }] }],
          };
        }
        return { type: "complete", result: "Agent complete." };
      },
      interrupt: () => {
        interrupted = true;
      },
      partialAssistantText: () => "partial agent text",
    };
  }
}
