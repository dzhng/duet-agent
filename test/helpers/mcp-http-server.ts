import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return undefined;
  return JSON.parse(text);
}

/**
 * In-process streamable-HTTP MCP server for tests and evals.
 *
 * Stateless mode: `buildServer` produces a fresh `McpServer` per request, so
 * callers stay free of session bookkeeping (mirrors the SDK's reference
 * example). `close` force-closes open connections so a test whose tool call is
 * still in flight can shut down without waiting on it.
 */
export async function startMcpHttpServer(
  buildServer: () => McpServer,
): Promise<{ url: string; close: () => Promise<void> }> {
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
        const server = buildServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await transport.handleRequest(req, res, body);
      } catch (error) {
        console.error("mcp test server error:", error);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        }
      }
    })();
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
