import { describe, expect } from "bun:test";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type {
  StateMachineDefinition,
  StateMachineSessionEvent,
} from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

describe("state template rendering", () => {
  testIfDocker(
    "renders prior state output into later agent and script states",
    async () => {
      const runner = new TurnRunner({
        model,
        mode: templateDefinition,
        skillDiscovery: { includeDefaults: false },
        systemInstructions: [
          "This is a live eval. Use the state-machine tools for every workflow step.",
          "Select states in this exact order: collect_release_data, write_release_note, render_payload, done.",
          'When selecting collect_release_data, use input {"release":"v1.2.3","owner":"Ada"}.',
          'When selecting write_release_note and render_payload, use input {"release":"v1.2.3","owner":"Ada","summary":"feature flags enabled"}.',
          "Do not ask the user questions.",
        ].join("\n"),
      });

      const terminal = await (
        await startTurn(runner, {
          mode: templateDefinition,
          prompt:
            "Run the template rendering workflow. The release includes feature flags and the release manager Ada.",
        })
      ).turn;

      expect(terminal.type).toBe("complete");
      expect(terminal.type === "complete" ? terminal.status : undefined).toBe("completed");

      const history = terminal.state.stateMachine?.history ?? [];
      expect(completedStateNames(history)).toEqual([
        "collect_release_data",
        "write_release_note",
        "render_payload",
      ]);

      const releaseNote = outputFor(history, "write_release_note");
      expect(releaseNote).toContain("v1.2.3");
      expect(releaseNote).toContain("Ada");
      expect(releaseNote.toLowerCase()).toContain("feature flags");

      const payload = outputFor(history, "render_payload");
      expect(payload).toContain("release=v1.2.3");
      expect(payload).toContain("owner=Ada");
      expect(payload).toContain("summary=feature flags enabled");
    },
    90_000,
  );
});

const templateDefinition: StateMachineDefinition = {
  name: "state_template_eval",
  prompt:
    "Use this workflow to validate that state outputs and transition inputs are rendered into later state prompts and scripts.",
  states: [
    {
      kind: "script",
      name: "collect_release_data",
      inputSchema: {
        type: "object",
        properties: {
          release: { type: "string" },
          owner: { type: "string" },
        },
        required: ["release", "owner"],
      },
      command:
        'printf \'{"release":"{{ input.release }}","owner":"{{ input.owner }}","summary":"feature flags enabled"}\'',
    },
    {
      kind: "agent",
      name: "write_release_note",
      inputSchema: {
        type: "object",
        properties: {
          release: { type: "string" },
          owner: { type: "string" },
          summary: { type: "string" },
        },
        required: ["release", "owner", "summary"],
      },
      prompt:
        "Do not call tools. Write one short release note that mentions release {{ input.release }}, owner {{ input.owner }}, and summary {{ input.summary }}.",
    },
    {
      kind: "script",
      name: "render_payload",
      inputSchema: {
        type: "object",
        properties: {
          release: { type: "string" },
          owner: { type: "string" },
          summary: { type: "string" },
        },
        required: ["release", "owner", "summary"],
      },
      command:
        "printf 'release={{ input.release }}\\nowner={{ input.owner }}\\nsummary={{ input.summary }}\\n'",
    },
    {
      kind: "terminal",
      name: "done",
      status: "completed",
      reason: "Template rendering succeeded.",
    },
  ],
};

function completedStateNames(history: StateMachineSessionEvent[]): string[] {
  return history.filter((event) => event.type === "state_completed").map((event) => event.state);
}

function outputFor(history: StateMachineSessionEvent[], state: string): string {
  const event = history.find(
    (candidate) => candidate.type === "state_completed" && candidate.state === state,
  );
  if (!event || event.type !== "state_completed") {
    throw new Error(`Expected completed state ${state}`);
  }
  return stringResult(event.output);
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
