import { describe, expect, test } from "bun:test";
import { connectMcpServers } from "../src/turn-runner/mcp.js";

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

  test("dispose is idempotent", async () => {
    const runtime = await connectMcpServers({}, { onWarn: () => {} });
    await runtime.dispose();
    await runtime.dispose();
  });
});
