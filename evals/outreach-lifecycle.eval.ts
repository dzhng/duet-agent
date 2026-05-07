import { describe, expect } from "bun:test";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { setTimeout as delay } from "node:timers/promises";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnTerminalEvent } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "vercel-ai-gateway:anthropic/claude-sonnet-4.6";

describe("outreach lifecycle state machine", () => {
  testIfDocker(
    "runs research, outreach, wait, reply classification, and terminal completion",
    async () => {
      const runner = new TurnRunner({
        model,
        mode: outreachDefinition,
        skillDiscovery: { includeDefaults: false },
        systemInstructions: [
          "This is an eval. Use the state-machine tools for the durable outreach workflow.",
          "Select states in this order: research_prospect, send_outreach, wait_for_reply, fetch_reply, classify_reply, meeting_scheduled.",
          "When selecting a state with inputSchema, provide the required input object.",
          "Do not ask the user questions.",
        ].join("\n"),
      });

      const first = await (
        await startTurn(runner, {
          mode: outreachDefinition,
          prompt:
            "Run the outreach lifecycle for Ada Lovelace at ada@example.com. The fake reply says she is interested in a meeting.",
        })
      ).turn;

      expect(first.type).toBe("sleep");
      expect(first.state.stateMachine?.currentState).toBe("wait_for_reply");

      await delay(10_100);

      const terminal = await runner.turn({ type: "wake" });

      expect(terminal.type).toBe("complete");
      expect(terminal.type === "complete" ? terminal.status : undefined).toBe("completed");
      expect(terminal.state.stateMachine?.terminal).toMatchObject({
        state: "meeting_scheduled",
        status: "completed",
      });
      expect(completedStates(terminal)).toEqual([
        "research_prospect",
        "send_outreach",
        "wait_for_reply",
        "fetch_reply",
        "classify_reply",
      ]);
    },
    120_000,
  );
});

const outreachDefinition: StateMachineDefinition = {
  name: "outreach_eval",
  prompt:
    "Use this state machine for the eval outreach lifecycle: research a prospect, send outreach, wait briefly, fetch a fake reply, classify it, and finish when a meeting should be scheduled.",
  states: [
    {
      kind: "agent",
      name: "research_prospect",
      inputSchema: {
        type: "object",
        properties: {
          prospectName: { type: "string" },
          company: { type: "string" },
        },
        required: ["prospectName", "company"],
      },
      prompt:
        "Do not call tools. Write one concise research note for {{ input.prospectName }} from {{ input.company }}.",
    },
    {
      kind: "script",
      name: "send_outreach",
      inputSchema: {
        type: "object",
        properties: {
          email: { type: "string" },
          prospectName: { type: "string" },
        },
        required: ["email", "prospectName"],
      },
      command:
        'printf \'{"sent":true,"email":"{{ input.email }}","messageId":"eval-message-1","prospectName":"{{ input.prospectName }}"}\'',
    },
    {
      kind: "poll",
      name: "wait_for_reply",
      intervalMs: 10_000,
      timeoutMs: 30_000,
      poll: { kind: "timer" },
    },
    {
      kind: "script",
      name: "fetch_reply",
      inputSchema: {
        type: "object",
        properties: {
          messageId: { type: "string" },
        },
        required: ["messageId"],
      },
      command:
        'printf \'{"reply":"Thanks for reaching out. I am interested in scheduling a meeting next week.","messageId":"{{ input.messageId }}"}\'',
    },
    {
      kind: "agent",
      name: "classify_reply",
      inputSchema: {
        type: "object",
        properties: {
          reply: { type: "string" },
        },
        required: ["reply"],
      },
      prompt:
        "Do not call tools. Classify this outreach reply as interested, negative, question, neutral, or unclear. Reply with one sentence. Reply: {{ input.reply }}",
    },
    {
      kind: "terminal",
      name: "meeting_scheduled",
      status: "completed",
      reason: "The fake reply was classified as interested.",
    },
  ],
};

function completedStates(terminal: TurnTerminalEvent): string[] {
  return (
    terminal.state.stateMachine?.history
      .filter((event) => event.type === "state_completed")
      .map((event) => event.state) ?? []
  );
}
