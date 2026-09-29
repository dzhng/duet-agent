import { expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session/session.js";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";
import type { TurnState } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import baseline from "./fixtures/model-refresh/standalone-baseline.json" with { type: "json" };
import { modelRefreshCompletion } from "./helpers/model-refresh-upstream.js";
import { testIfDocker } from "./helpers/docker-only.js";

function selectState(model: string, state: string, call: number): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: `msg_${call}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: `call_${call}`,
        name: "select_state_machine_state",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ decision: { state } }) },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

testIfDocker(
  "saved workflow definitions recover child selections and retain virtual policy and history",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "saved-workflow-models-"));
    const previousBase = process.env.DUET_GATEWAY_BASE_URL;
    const previousKey = process.env.DUET_API_KEY;
    let parentCalls = 0;
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const payload = (await request.json()) as { model: string };
        requests.push(payload.model);
        if (["anthropic/claude-sonnet-5", "anthropic/claude-sonnet-5.5"].includes(payload.model)) {
          parentCalls++;
          if (parentCalls < 3)
            return selectState(payload.model, parentCalls === 1 ? "work" : "done", parentCalls);
        }
        return modelRefreshCompletion(payload.model);
      },
    });
    process.env.DUET_GATEWAY_BASE_URL = server.url.toString();
    process.env.DUET_API_KEY = "controlled-workflow-key";
    try {
      for (const [location, parentModel] of [
        ["mode", "sonnet-5"],
        ["active", "sonnet-5"],
        ["virtual", "sonnet-5"],
        ["active-5.5", "sonnet-5.5"],
      ]) {
        parentCalls = 0;
        requests.length = 0;
        const cwd = join(dir, location);
        await mkdir(cwd);
        const definition: StateMachineDefinition = {
          name: "saved-workflow",
          prompt: "Do the work, then finish.",
          states: [
            {
              kind: "agent",
              name: "work",
              prompt: "Reply with done.",
              model: "gpt-5.6-sol",
              thinkingLevel: "high",
            },
            { kind: "terminal", name: "done", status: "completed" },
          ],
        };
        const original = baseline.receipts.find((item) => item.input === "opus")!.envelope;
        const state: TurnState = {
          ...(structuredClone(original.state) as unknown as TurnState),
          options: { model: parentModel, memoryModel: "gpt-5.6-luna" },
          mode: location === "mode" ? definition : "auto",
        };
        if (location !== "mode")
          state.stateMachine = {
            definition,
            prompt: "Finish the saved work.",
            history: [
              {
                type: "state_definition_updated",
                timestamp: 1,
                state: "work",
                updatedState: structuredClone(definition.states[0]!),
              },
            ],
            createdAt: 1,
            updatedAt: 1,
          };
        const oldHistory = structuredClone(state.stateMachine?.history);
        if (location === "virtual") {
          const table = structuredClone(BUILT_IN_ROUTING_TABLE);
          table.tiers["gpt-5.6-sol"] = {
            routes: {
              general: {
                description: "Custom saved worker policy",
                target: { modelName: "haiku", thinkingLevel: "low" },
              },
            },
            advisor: {
              enabled: false,
              target: { modelName: "sol", thinkingLevel: "medium" },
              minStepsBetween: 5,
            },
          };
          await mkdir(join(cwd, ".duet"));
          await writeFile(join(cwd, ".duet", "models.json"), JSON.stringify(table));
        }
        await writeFile(join(cwd, "state.json"), JSON.stringify({ ...original, state }));
        const session = new Session(
          {
            cwd,
            memoryDbPath: false,
            memoryStores: false,
            skillDiscovery: { includeDefaults: false },
          },
          { id: location, sessionPath: cwd, resumeFromStorage: true },
        );
        try {
          await session.start();
          await session.prompt({ message: "Continue the saved workflow through work and done." });
          const terminal = await session.waitForTerminal();
          expect(terminal.type).toBe("complete");
          expect(requests).toContain(`anthropic/claude-${parentModel}`);
          expect(terminal.state.stateMachine?.terminal?.status).toBe("completed");
          expect(requests).toContain(
            location === "virtual" ? "anthropic/claude-haiku-4.5" : "openai/gpt-6.1-sol",
          );
          expect(requests).not.toContain("openai/gpt-5.6-sol");
          expect(
            terminal.state.agent.messages.slice(0, original.state.agent.messages.length) as unknown,
          ).toEqual(original.state.agent.messages);
          if (oldHistory)
            expect(terminal.state.stateMachine?.history.slice(0, oldHistory.length)).toEqual(
              oldHistory,
            );
        } finally {
          await session.dispose();
        }
        const stored = JSON.parse(await readFile(join(cwd, "state.json"), "utf8"));
        expect(
          stored.state.stateMachine.definition.states.find(
            (entry: { name: string }) => entry.name === "work",
          ).model,
        ).toBe(location === "virtual" ? "gpt-5.6-sol" : "sol");
      }
    } finally {
      server.stop(true);
      await rm(dir, { recursive: true, force: true });
      if (previousBase === undefined) delete process.env.DUET_GATEWAY_BASE_URL;
      else process.env.DUET_GATEWAY_BASE_URL = previousBase;
      if (previousKey === undefined) delete process.env.DUET_API_KEY;
      else process.env.DUET_API_KEY = previousKey;
    }
  },
  30_000,
);
