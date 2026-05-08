import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TSchema } from "typebox";
import type { McpHttpServerConfig } from "../types/protocol.js";

const MCP_TOOL_NAME_SEPARATOR = "__";

/**
 * Connected MCP server runtime.
 *
 * Owns one MCP client + transport per configured server, exposes the union of
 * their tools as `AgentTool[]` ready to drop into the parent or state agents,
 * and disposes connections when the turn runner shuts down.
 *
 * Tool names are namespaced as `{server}__{tool}` so multiple servers with
 * overlapping tool names can coexist without collisions inside a single agent
 * turn.
 */
export interface McpRuntime {
  /** Tools backed by every connected MCP server, in deterministic order. */
  tools: AgentTool[];
  /** Close every transport and client. Idempotent. */
  dispose: () => Promise<void>;
}

interface McpSession {
  serverName: string;
  client: Client;
  transport: Transport;
}

/**
 * Connect to every configured HTTP MCP server and build a flat list of
 * `AgentTool`s. Servers that fail to connect are dropped with a warning so a
 * single broken server cannot block the rest of the turn runner from starting.
 */
export async function connectMcpServers(
  servers: Record<string, McpHttpServerConfig>,
  options?: {
    /** Optional sink for connection diagnostics. Defaults to `console.warn`. */
    onWarn?: (message: string) => void;
  },
): Promise<McpRuntime> {
  const warn = options?.onWarn ?? ((message: string) => console.warn(message));
  const sessions: McpSession[] = [];
  const tools: AgentTool[] = [];

  for (const [serverName, config] of Object.entries(servers)) {
    if (config.type !== "http") {
      warn(`mcp: unsupported transport "${config.type}" for server "${serverName}"; skipping.`);
      continue;
    }
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      warn(`mcp: invalid url for server "${serverName}": ${config.url}; skipping.`);
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      warn(`mcp: unsupported protocol "${url.protocol}" for server "${serverName}"; skipping.`);
      continue;
    }

    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });
    const client = new Client({ name: "duet-agent", version: "0.0.0" });

    try {
      await client.connect(transport);
    } catch (error) {
      warn(`mcp: failed to connect server "${serverName}": ${describeError(error)}`);
      await transport.close().catch(() => {});
      await client.close().catch(() => {});
      continue;
    }

    let listed: Awaited<ReturnType<Client["listTools"]>>;
    try {
      listed = await client.listTools();
    } catch (error) {
      warn(`mcp: failed to list tools for server "${serverName}": ${describeError(error)}`);
      await disposeSession({ serverName, client, transport });
      continue;
    }

    sessions.push({ serverName, client, transport });
    for (const tool of listed.tools) {
      tools.push(buildAgentTool(serverName, client, tool));
    }
  }

  // Sort once so the tools block is stable across turns for prompt caching.
  tools.sort((a, b) => a.name.localeCompare(b.name));

  let disposed = false;
  return {
    tools,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await Promise.allSettled(sessions.map(disposeSession));
    },
  };
}

interface ListedMcpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
}

function buildAgentTool(serverName: string, client: Client, tool: ListedMcpTool): AgentTool {
  const namespacedName = `${serverName}${MCP_TOOL_NAME_SEPARATOR}${tool.name}`;
  // MCP tool inputSchema is JSON Schema; pi-agent's Ajv validator runs with
  // strictSchema:false so a plain JSON Schema object is accepted in the
  // `parameters` slot that is typed as TSchema.
  const parameters = (tool.inputSchema ?? { type: "object" }) as TSchema;
  return {
    name: namespacedName,
    label: tool.title ?? tool.name,
    description: tool.description ?? `MCP tool "${tool.name}" provided by server "${serverName}".`,
    parameters,
    execute: async (_toolCallId, params) => {
      const result = (await client.callTool({
        name: tool.name,
        arguments: isPlainObject(params) ? (params as Record<string, unknown>) : {},
      })) as CallToolResult;
      return toAgentToolResult(serverName, tool.name, result);
    },
  };
}

function toAgentToolResult(
  serverName: string,
  toolName: string,
  result: CallToolResult,
): AgentToolResult<{ mcpServer: string; mcpTool: string; structuredContent?: unknown }> {
  const rawContent = Array.isArray(result.content) ? result.content : [];
  const content =
    rawContent.length > 0
      ? (rawContent as AgentToolResult<unknown>["content"])
      : ([
          {
            type: "text",
            text:
              result.structuredContent !== undefined
                ? JSON.stringify(result.structuredContent, null, 2)
                : JSON.stringify(
                    { status: result.isError ? "error" : "ok", server: serverName, tool: toolName },
                    null,
                    2,
                  ),
          },
        ] as AgentToolResult<unknown>["content"]);
  return {
    content,
    details: {
      mcpServer: serverName,
      mcpTool: toolName,
      structuredContent: result.structuredContent,
    },
  };
}

async function disposeSession(session: McpSession): Promise<void> {
  await session.transport.close().catch(() => {});
  await session.client.close().catch(() => {});
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
