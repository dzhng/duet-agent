import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { connectMcpServers } from "../src/turn-runner/mcp.js";
import { startMcpHttpServer } from "./helpers/mcp-http-server.js";

/**
 * MCP server whose only tool never responds, standing in for long-poll
 * integration tools (e.g. Composio's wait-for-connection).
 */
function buildHangingMcpServer(): McpServer {
  const mcp = new McpServer({ name: "hang-test-mcp", version: "0.0.0" });
  mcp.registerTool(
    "wait_forever",
    { description: "Never responds.", inputSchema: {} },
    () => new Promise(() => {}),
  );
  return mcp;
}

describe("connectMcpServers", () => {
  test("returns an empty runtime when no servers are configured", async () => {
    const runtime = await connectMcpServers({}, { onWarn: () => {} });
    expect(runtime.tools).toEqual([]);
    await runtime.dispose();
  });

  test("warns and skips servers with invalid urls", async () => {
    const warnings: string[] = [];
    const runtime = await connectMcpServers(
      { broken: { type: "http", url: "not a url" } },
      { onWarn: (m) => warnings.push(m) },
    );
    expect(runtime.tools).toEqual([]);
    expect(warnings.some((m) => m.includes("invalid url"))).toBe(true);
    await runtime.dispose();
  });

  test("warns and skips servers with non-http protocols", async () => {
    const warnings: string[] = [];
    const runtime = await connectMcpServers(
      { weird: { type: "http", url: "ftp://example.com/mcp" } },
      { onWarn: (m) => warnings.push(m) },
    );
    expect(runtime.tools).toEqual([]);
    expect(warnings.some((m) => m.includes("unsupported protocol"))).toBe(true);
    await runtime.dispose();
  });

  test("warns and skips servers that fail to connect", async () => {
    const warnings: string[] = [];
    // 127.0.0.1:1 is reserved and should fail fast.
    const runtime = await connectMcpServers(
      { offline: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      { onWarn: (m) => warnings.push(m) },
    );
    expect(runtime.tools).toEqual([]);
    expect(warnings.some((m) => m.includes("failed to connect"))).toBe(true);
    await runtime.dispose();
  });

  test("aborting the signal cancels an in-flight tool call promptly", async () => {
    const server = await startMcpHttpServer(buildHangingMcpServer);
    const runtime = await connectMcpServers(
      { hang: { type: "http", url: server.url } },
      { onWarn: () => {} },
    );
    try {
      const tool = runtime.tools.find((t) => t.name === "hang__wait_forever");
      if (!tool) throw new Error("hang__wait_forever tool not exposed");

      const controller = new AbortController();
      const pending = tool.execute("call-1", {}, controller.signal);
      setTimeout(() => controller.abort(new Error("Interrupted")), 50);

      // Without abort support the call only ends at the MCP SDK's 60s request
      // timeout; the race distinguishes "cancelled promptly" from that hang.
      const outcome = await Promise.race([
        pending.then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        ),
        new Promise<{ kind: "hung" }>((resolve) =>
          setTimeout(() => resolve({ kind: "hung" }), 3_000),
        ),
      ]);
      // The rejection must be OUR abort, not some other failure that would
      // also end the call early (connect error, server 500).
      expect(outcome.kind).toBe("rejected");
      if (outcome.kind === "rejected") {
        expect(String(outcome.error)).toContain("Interrupted");
      }
    } finally {
      await runtime.dispose();
      await server.close();
    }
  }, 10_000);

  test("dispose is idempotent", async () => {
    const runtime = await connectMcpServers({}, { onWarn: () => {} });
    await runtime.dispose();
    await runtime.dispose();
  });
});
