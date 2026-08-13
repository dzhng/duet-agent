import { describe, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";
import { startMcpHttpServer } from "../test/helpers/mcp-http-server.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

// Deterministic, model-can't-guess values returned by the live MCP server.
// Picking nonsense tokens forces the model to actually call the tool to learn them.
const MAGIC_WORD = "PLATYPUS_47_QUARTZ";
const SQUAWK_VALUE = "SQUAWK_NINETEEN_TEAL";

function buildEvalMcpServer(): McpServer {
  const mcp = new McpServer({ name: "duet-eval-mcp", version: "0.0.0" });
  mcp.registerTool(
    "magic_word",
    {
      title: "Magic word",
      description: "Returns the secret magic word for this MCP server.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: MAGIC_WORD }] }),
  );
  mcp.registerTool(
    "echo_squawk",
    {
      title: "Echo squawk",
      description: "Echoes the provided phrase back, prefixed with the server's squawk value.",
      inputSchema: { phrase: z.string() },
    },
    async ({ phrase }) => ({
      content: [{ type: "text", text: `${SQUAWK_VALUE}:${phrase}` }],
    }),
  );
  return mcp;
}

describe("mcp http tools", () => {
  testIfDocker(
    "exposes a live remote MCP server's tools and routes calls through the agent",
    async () => {
      const server = await startMcpHttpServer(buildEvalMcpServer);
      const runner = new TurnRunner({
        model,
        mode: "agent",
        skillDiscovery: { includeDefaults: false },
      });

      const mcpToolCalls: Array<{ name: string; output?: string }> = [];
      runner.subscribe((event: TurnEvent) => {
        if (event.type !== "step") return;
        const step = event.step;
        if (step.type !== "tool_call" || step.isError) return;
        if (!step.toolName.startsWith("eval_mcp__")) return;
        const text = step.output?.find((part) => part.type === "text");
        mcpToolCalls.push({
          name: step.toolName,
          output: text && "text" in text ? text.text : undefined,
        });
      });

      try {
        await runner.start({
          type: "start",
          mode: "agent",
          mcpServers: {
            eval_mcp: { type: "http", url: server.url },
          },
        });

        const terminal = await runner.turn({
          type: "prompt",
          message:
            "Call the magic_word tool, then call echo_squawk with phrase=hello. " +
            "Reply with exactly two lines: the magic word on the first line, " +
            "and the echoed squawk on the second. No other text.",
          behavior: "follow_up",
        });

        expect(terminal.type).toBe("complete");

        // The agent must have actually invoked both MCP-backed tools, and the
        // tool-result content must be the literal values the live server returned.
        const calledNames = mcpToolCalls.map((call) => call.name);
        expect(calledNames).toContain("eval_mcp__magic_word");
        expect(calledNames).toContain("eval_mcp__echo_squawk");
        expect(mcpToolCalls.find((call) => call.name === "eval_mcp__magic_word")?.output).toBe(
          MAGIC_WORD,
        );
        expect(mcpToolCalls.find((call) => call.name === "eval_mcp__echo_squawk")?.output).toBe(
          `${SQUAWK_VALUE}:hello`,
        );

        const reply = terminal.type === "complete" ? (terminal.result ?? "") : "";
        expect(reply).toContain(MAGIC_WORD);
        expect(reply).toContain(`${SQUAWK_VALUE}:hello`);
      } finally {
        await runner.dispose();
        await server.close();
      }
    },
    60_000,
  );
});
