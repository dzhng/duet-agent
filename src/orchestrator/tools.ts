import { tool } from "ai";
import { z } from "zod";
import type {
  MemoryStore,
  Sandbox,
  InterruptBus,
  Guardrail,
  GuardrailContext,
  AgentId,
  SessionState,
} from "../core/types.js";

interface ToolDeps {
  agentId: AgentId;
  memory: MemoryStore;
  sandbox: Sandbox;
  interrupts: InterruptBus;
  guardrail?: Guardrail;
  sessionState: SessionState;
  allowedActions: string[];
}

/**
 * Create the tool set for a sub-agent. Every agent gets the same
 * primitives — bash, files, memory — but scoped by their allowedActions.
 *
 * No MCP. Everything is files and CLI.
 */
export function createTools(deps: ToolDeps) {
  const { agentId, memory, sandbox, interrupts, guardrail, sessionState, allowedActions } = deps;

  async function checkGuardrail(action: string, content: string): Promise<void> {
    if (!guardrail) return;
    const ctx: GuardrailContext = {
      agentId,
      action,
      content,
      memories: await memory.recall({ limit: 5, scope: "session" }),
      sessionState,
    };
    const result = await guardrail.evaluate(ctx);
    if (!result.allowed) {
      interrupts.emit({
        source: { kind: "guardrail", rule: guardrail.name, message: result.reason ?? "Blocked" },
        priority: "pause",
      });
      throw new Error(`Guardrail blocked: ${result.reason}${result.suggestion ? ` — suggestion: ${result.suggestion}` : ""}`);
    }
  }

  const bashSchema = z.object({
    command: z.string().describe("The bash command to execute"),
    timeoutMs: z.number().optional().describe("Timeout in milliseconds"),
  });

  const readFileSchema = z.object({
    path: z.string().describe("Path to the file"),
  });

  const writeFileSchema = z.object({
    path: z.string().describe("Path to the file"),
    content: z.string().describe("Content to write"),
  });

  const globSchema = z.object({
    pattern: z.string().describe("Glob pattern"),
    cwd: z.string().optional().describe("Working directory"),
  });

  const memoryWriteSchema = z.object({
    content: z.string().describe("What to remember"),
    tags: z.array(z.string()).describe("Tags for filtering"),
    importance: z.number().min(0).max(1).describe("Importance 0-1"),
    scope: z.enum(["session", "persistent"]).describe("Scope of the memory"),
  });

  const memoryRecallSchema = z.object({
    query: z.string().optional().describe("Natural language search query"),
    tags: z.array(z.string()).optional().describe("Filter by tags"),
    limit: z.number().optional().describe("Max results"),
  });

  const memoryForgetSchema = z.object({
    memoryId: z.string().describe("Memory ID to forget"),
  });

  const interruptSchema = z.object({
    message: z.string().describe("The interrupt message"),
    priority: z.enum(["pause", "queue", "info"]).describe("Interrupt priority"),
  });

  const allTools = {
    bash: tool({
      description: "Execute a bash command in the sandbox. This is the primary way to interact with the world.",
      inputSchema: bashSchema,
      execute: async (input: z.infer<typeof bashSchema>) => {
        await checkGuardrail("bash", input.command);
        const result = await sandbox.exec(input.command, { timeoutMs: input.timeoutMs });
        return {
          exitCode: result.exitCode,
          stdout: result.stdout.slice(0, 50_000),
          stderr: result.stderr.slice(0, 10_000),
          durationMs: result.durationMs,
        };
      },
    }),

    readFile: tool({
      description: "Read a file from the sandbox filesystem",
      inputSchema: readFileSchema,
      execute: async (input: z.infer<typeof readFileSchema>) => {
        const content = await sandbox.readFile(input.path);
        return { content: content.slice(0, 100_000) };
      },
    }),

    writeFile: tool({
      description: "Write content to a file in the sandbox filesystem",
      inputSchema: writeFileSchema,
      execute: async (input: z.infer<typeof writeFileSchema>) => {
        await checkGuardrail("writeFile", `${input.path}: ${input.content.slice(0, 200)}`);
        await sandbox.writeFile(input.path, input.content);
        return { success: true, path: input.path };
      },
    }),

    glob: tool({
      description: "Find files matching a glob pattern",
      inputSchema: globSchema,
      execute: async (input: z.infer<typeof globSchema>) => {
        const files = await sandbox.glob(input.pattern, input.cwd);
        return { files };
      },
    }),

    memoryWrite: tool({
      description: "Write a memory. Memories persist across sessions and are searchable.",
      inputSchema: memoryWriteSchema,
      execute: async (input: z.infer<typeof memoryWriteSchema>) => {
        const mem = await memory.write({
          author: agentId,
          createdAt: Date.now(),
          content: input.content,
          tags: input.tags,
          importance: input.importance,
          scope: input.scope,
        });
        return { memoryId: mem.id };
      },
    }),

    memoryRecall: tool({
      description: "Search memories. Returns the most relevant memories matching the query.",
      inputSchema: memoryRecallSchema,
      execute: async (input: z.infer<typeof memoryRecallSchema>) => {
        const memories = await memory.recall({ query: input.query, tags: input.tags, limit: input.limit });
        return {
          memories: memories.map((m) => ({
            id: m.id,
            content: m.content,
            tags: m.tags,
            importance: m.importance,
            createdAt: m.createdAt,
          })),
        };
      },
    }),

    memoryForget: tool({
      description: "Forget a specific memory by ID",
      inputSchema: memoryForgetSchema,
      execute: async (input: z.infer<typeof memoryForgetSchema>) => {
        await memory.forget(input.memoryId as any);
        return { success: true };
      },
    }),

    interrupt: tool({
      description: "Send an interrupt to another agent or the orchestrator",
      inputSchema: interruptSchema,
      execute: async (input: z.infer<typeof interruptSchema>) => {
        interrupts.emit({
          source: { kind: "agent", agentId, message: input.message },
          priority: input.priority,
        });
        return { sent: true };
      },
    }),
  };

  // Filter to allowed actions only
  if (allowedActions.length > 0 && !allowedActions.includes("*")) {
    const filtered: Record<string, (typeof allTools)[keyof typeof allTools]> = {};
    for (const action of allowedActions) {
      if (action in allTools) {
        filtered[action] = allTools[action as keyof typeof allTools];
      }
    }
    return filtered;
  }

  return allTools;
}
