import { describe, expect } from "bun:test";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

// Deterministic, model-can't-guess values returned by the live MCP server.
// Picking nonsense tokens forces the model to actually call the tool to learn them.
const MAGIC_WORD = "PLATYPUS_47_QUARTZ";
const SQUAWK_VALUE = "SQUAWK_NINETEEN_TEAL";

interface LiveMcpServer {
  url: string;
  close: () => Promise<void>;
}

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

async function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return undefined;
  return JSON.parse(text);
}

async function startLiveMcpServer(): Promise<LiveMcpServer> {
  // Stateless mode: spin up a fresh server+transport per request. This mirrors
  // the SDK's reference example and keeps the eval free of session bookkeeping.
  const httpServer: Server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method !== "POST") {
          res.writeHead(405, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Method not allowed." },
              id: null,
            }),
          );
          return;
        }
        const body = await readJsonBody(req);
        const server = buildEvalMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await transport.handleRequest(req, res, body);
      } catch (error) {
        console.error("mcp eval server error:", error);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        }
      }
    })();
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/mcp`;

  return {
    url,
    close: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

describe("mcp http tools", () => {
  testIfDocker(
    "exposes a live remote MCP server's tools and routes calls through the agent",
    async () => {
      const server = await startLiveMcpServer();
      const runner = new TurnRunner({
        model,
        mode: "agent",
        skillDiscovery: { includeDefaults: false },
      });

      const mcpToolCalls: Array<{ name: string; output?: string }> = [];
      runner.subscribe((event: TurnEvent) => {
        if (event.type !== "step") return;
        const step = event.step;
        if (step.type !== "tool_call") return;
        if (!step.toolName.startsWith("eval_mcp__")) return;
        if (step.status === "completed") {
          const text = step.output?.find((part) => part.type === "text");
          mcpToolCalls.push({
            name: step.toolName,
            output: text && "text" in text ? text.text : undefined,
          });
        }
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
