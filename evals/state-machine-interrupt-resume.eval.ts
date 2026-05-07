import { describe, expect } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { waitFor } from "../test/helpers/async.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnQuestion, TurnState, TurnTerminalEvent } from "../src/types/protocol.js";
import type {
  StateMachineDefinition,
  StateMachineSessionEvent,
} from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "vercel-ai-gateway:anthropic/claude-sonnet-4.6";

describe("state machine interrupt and resume", () => {
  testIfDocker(
    "reruns an interrupted script state with the same transition input",
    async () => {
      const runner = createRunner(
        interruptDefinition,
        'On the initial prompt, select script_step with input {"value":"same-input"}.',
      );
      const started = await startTurn(runner, {
        mode: interruptDefinition,
        prompt: "Start the script interrupt eval.",
      });

      await waitFor(() => currentState(runner) === "script_step", 30_000);
      await delay(250);
      runner.interrupt({ type: "interrupt" });
      const interrupted = await started.turn;

      expect(interrupted.type).toBe("interrupted");
      expect(interrupted.state.stateMachine?.currentState).toBe("interrupted");
      expect(interruptedOutput(interrupted.state, "script_step")).toContain("script-start");

      const resumed = createRunner(
        interruptDefinition,
        [
          "The state machine may be interrupted. When the user says continue, call get_current_state_machine_state.",
          'Then select script_step again with input {"value":"same-input"} and override its command to exactly: printf \'{"rerun":true,"value":"same-input"}\'.',
          "After script_step completes, select done.",
        ].join("\n"),
      );
      await resumed.start({ type: "start", state: interrupted.state });
      const terminal = await resumed.turn({
        type: "prompt",
        message: "continue",
        behavior: "follow_up",
      });

      expectCompleted(terminal);
      expect(terminal.state.stateMachine?.terminal).toMatchObject({
        state: "done",
        status: "completed",
      });
      expect(completedOutput(terminal.state, "script_step")).toContain('"rerun":true');
      expect(selectedInput(terminal.state, "script_step")).toEqual({ value: "same-input" });
    },
    150_000,
  );

  testIfDocker(
    "reruns an interrupted poll script state and preserves partial output",
    async () => {
      const runner = createRunner(
        pollDefinition,
        'On the initial prompt, select poll_step with input {"value":"poll-input"}.',
      );
      const started = await startTurn(runner, {
        mode: pollDefinition,
        prompt: "Start the poll interrupt eval.",
      });

      await waitFor(() => currentState(runner) === "poll_step", 30_000);
      await delay(50);
      runner.interrupt({ type: "interrupt" });
      const interrupted = await started.turn;

      expect(interrupted.type).toBe("interrupted");
      expect(interrupted.state.stateMachine?.currentState).toBe("interrupted");
      expect(interruptedOutput(interrupted.state, "poll_step")).toContain("poll-start");

      const resumed = createRunner(
        pollDefinition,
        [
          "The state machine may be interrupted. When the user says continue, call get_current_state_machine_state.",
          'Then select poll_step again with input {"value":"poll-input"} and override its poll command to exactly: printf \'{"ready":true,"value":"poll-input"}\'.',
          'Use override kind "poll" with state {"poll":{"kind":"script","command":"printf \'{\\"ready\\":true,\\"value\\":\\"poll-input\\"}\'"},"intervalMs":1000,"timeoutMs":30000}.',
          "After poll_step completes, select done.",
        ].join("\n"),
      );
      await resumed.start({ type: "start", state: interrupted.state });
      const terminal = await resumed.turn({
        type: "prompt",
        message: "continue",
        behavior: "follow_up",
      });

      expectCompleted(terminal);
      expect(terminal.state.stateMachine?.terminal).toMatchObject({
        state: "done",
        status: "completed",
      });
      expect(completedOutput(terminal.state, "poll_step")).toContain('"ready":true');
      expect(selectedInput(terminal.state, "poll_step")).toEqual({ value: "poll-input" });
    },
    150_000,
  );

  testIfDocker(
    "routes a state-agent ask answer through a fresh parent-selected state",
    async () => {
      const runner = createRunner(
        askDefinition,
        "On the initial prompt, select ask_for_prospect without input.",
      );
      const first = await (
        await startTurn(runner, {
          mode: askDefinition,
          prompt: "Ask the state-agent question.",
        })
      ).turn;

      expect(first.type).toBe("ask");
      expect(first.state.stateMachine?.currentState).toBe("ask_for_prospect");

      const resumed = createRunner(
        askDefinition,
        [
          "The user is answering the state-agent question. Call get_current_state_machine_state.",
          'Select ask_for_prospect again with input {"prospect":"Ada Lovelace"}.',
          "After ask_for_prospect completes, select done.",
        ].join("\n"),
      );
      await resumed.start({ type: "start", state: first.state });
      const terminal = await resumed.turn({
        type: "answer",
        questions: questionsFrom(first),
        answers: { prospect: "Ada Lovelace" },
        behavior: "follow_up",
      });

      expectCompleted(terminal);
      expect(completedOutput(terminal.state, "ask_for_prospect")).toContain("Ada Lovelace");
      expect(
        terminal.state.stateMachine?.history.filter(
          (event) => event.type === "state_started" && event.state === "ask_for_prospect",
        ),
      ).toHaveLength(2);
    },
    150_000,
  );

  testIfDocker(
    "steer during active script work can replace the running state",
    async () => {
      const runner = createRunner(
        interruptDefinition,
        [
          'On the initial prompt, select script_step with input {"value":"original"}.',
          'If the user sends a steer message asking for replacement, select script_step with input {"value":"replacement"} and override its command to exactly: printf \'{"replacement":true}\'.',
          "After script_step completes, select done.",
        ].join("\n"),
      );
      const started = await startTurn(runner, {
        mode: interruptDefinition,
        prompt: "Start the active replacement eval.",
      });

      await waitFor(() => currentState(runner) === "script_step", 30_000);
      const terminal = await runner.turn({
        type: "prompt",
        message:
          "STEER: replace the running script now. Use the replacement input and replacement override command from your system instructions.",
        behavior: "steer",
      });
      await started.turn;

      expectCompleted(terminal);
      expect(completedOutput(terminal.state, "script_step")).toContain('"replacement":true');
      expect(selectedInput(terminal.state, "script_step")).toEqual({ value: "replacement" });
    },
    150_000,
  );

  testIfDocker(
    "second steer during active script work steers the running parent prompt",
    async () => {
      const runner = createRunner(
        interruptDefinition,
        [
          'On the initial prompt, select script_step with input {"value":"original"}.',
          "If the first steer says to wait for another steer, do not select a state yet.",
          'If a later steer says to replace the script, select script_step with input {"value":"second-steer"} and override its command to exactly: printf \'{"secondSteer":true}\'.',
          "After script_step completes, select done.",
        ].join("\n"),
      );
      const started = await startTurn(runner, {
        mode: interruptDefinition,
        prompt: "Start the active parent-prompt steer eval.",
      });

      await waitFor(() => currentState(runner) === "script_step", 30_000);
      const firstSteer = runner.turn({
        type: "prompt",
        message:
          "STEER: do not change the state yet. Wait for my next steer before selecting a state.",
        behavior: "steer",
      });
      const secondSteer = runner.turn({
        type: "prompt",
        message:
          "STEER: replace the running script now with the second-steer input and override command.",
        behavior: "steer",
      });

      const [terminal] = await Promise.all([started.turn, firstSteer, secondSteer]);

      expectCompleted(terminal);
      expect(completedOutput(terminal.state, "script_step")).toContain('"secondSteer":true');
      expect(selectedInput(terminal.state, "script_step")).toEqual({ value: "second-steer" });
    },
    150_000,
  );
});

const interruptDefinition: StateMachineDefinition = {
  name: "interrupt_eval",
  prompt:
    "Use this workflow to validate interruption, resume, and steer replacement for a long script state.",
  states: [
    {
      kind: "script",
      name: "script_step",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "string" },
        },
        required: ["value"],
      },
      command:
        "printf 'script-start {{ input.value }}\\n'; sleep 60; printf 'script-finished {{ input.value }}\\n'",
    },
    {
      kind: "terminal",
      name: "done",
      status: "completed",
      reason: "The interrupt eval completed.",
    },
  ],
};

const pollDefinition: StateMachineDefinition = {
  name: "poll_interrupt_eval",
  prompt: "Use this workflow to validate interruption and resume for a long poll script state.",
  states: [
    {
      kind: "poll",
      name: "poll_step",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "string" },
        },
        required: ["value"],
      },
      intervalMs: 60_000,
      timeoutMs: 120_000,
      poll: {
        kind: "script",
        command:
          'printf \'poll-start {{ input.value }}\\n\'; sleep 60; printf \'{"ready":true,"value":"{{ input.value }}"}\'',
      },
    },
    {
      kind: "terminal",
      name: "done",
      status: "completed",
      reason: "The poll interrupt eval completed.",
    },
  ],
};

const askDefinition: StateMachineDefinition = {
  name: "state_agent_ask_eval",
  prompt: "Use this workflow to validate state-agent ask and answer resume behavior.",
  states: [
    {
      kind: "agent",
      name: "ask_for_prospect",
      prompt: [
        "If the prospect value below is blank, call ask_user_question with one question asking exactly: Which prospect?",
        "Use one option labelled Ada Lovelace.",
        "If the prospect value below is not blank, do not call tools and reply exactly: ANSWERED {{ input.prospect }}",
        "Prospect value: {{ input.prospect }}",
      ].join("\n"),
    },
    {
      kind: "terminal",
      name: "done",
      status: "completed",
      reason: "The ask eval completed.",
    },
  ],
};

function createRunner(definition: StateMachineDefinition, instruction: string): TurnRunner {
  return new TurnRunner({
    model,
    mode: definition,
    skillDiscovery: { includeDefaults: false },
    systemInstructions: [
      "This is a live eval. You must use the state-machine tools rather than answering normally.",
      "When state-machine state is interrupted or when answering a state-agent question, inspect current state with get_current_state_machine_state before choosing a state.",
      "Use select_state_machine_state for every state transition. Do not ask the user questions from the parent agent.",
      instruction,
    ].join("\n"),
  });
}

function currentState(runner: TurnRunner): string | undefined {
  return runner.getState()?.stateMachine?.currentState;
}

function questionsFrom(event: TurnTerminalEvent): TurnQuestion[] {
  if (event.type !== "ask") {
    throw new Error("Expected ask terminal event");
  }
  return event.questions;
}

function expectCompleted(event: TurnTerminalEvent): void {
  expect(event.type).toBe("complete");
  expect(event.type === "complete" ? event.status : undefined).toBe("completed");
}

function selectedInput(
  state: TurnState,
  selectedState: string,
): Record<string, unknown> | undefined {
  const event = findLastEvent(
    state,
    (candidate) => candidate.type === "state_started" && candidate.state === selectedState,
  );
  if (!event || event.type !== "state_started") {
    throw new Error(`Expected state_started for ${selectedState}`);
  }
  return event.input;
}

function completedOutput(state: TurnState, selectedState: string): string {
  const event = completedEvent(state, selectedState);
  return stringResult(event.output);
}

function interruptedOutput(state: TurnState, selectedState: string): string {
  const event = findLastEvent(
    state,
    (candidate) => candidate.type === "state_interrupted" && candidate.state === selectedState,
  );
  if (!event || event.type !== "state_interrupted") {
    throw new Error(`Expected state_interrupted for ${selectedState}`);
  }
  if (!event.output) return "";
  if ("stdout" in event.output) return `${event.output.stdout}${event.output.stderr}`;
  return event.output.assistantText ?? "";
}

function completedEvent(
  state: TurnState,
  selectedState: string,
): StateMachineSessionEvent & {
  type: "state_completed";
} {
  const event = findLastEvent(
    state,
    (candidate) => candidate.type === "state_completed" && candidate.state === selectedState,
  );
  if (!event || event.type !== "state_completed") {
    throw new Error(`Expected state_completed for ${selectedState}`);
  }
  return event;
}

function findLastEvent(
  state: TurnState,
  predicate: (event: StateMachineSessionEvent) => boolean,
): StateMachineSessionEvent | undefined {
  const history = state.stateMachine?.history ?? [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index];
    if (predicate(event)) return event;
  }
  return undefined;
}

function stringResult(output: unknown): string {
  if (
    output &&
    typeof output === "object" &&
    "result" in output &&
    typeof output.result === "string"
  ) {
    return output.result;
  }
  if (output !== undefined) return JSON.stringify(output);
  throw new Error("Expected state output with a string result");
}
