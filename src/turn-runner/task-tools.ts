import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "typebox";
import type { RuntimeClock } from "./runtime-clock.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { TaskId, TaskSnapshot } from "../tasks/types.js";

const MAX_INLINE_SETTLEMENT_CHARS = 2_000;

const taskOutputSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Task id, such as t3. Omit to list all tasks." })),
  wait: Type.Optional(
    Type.Number({
      minimum: 0,
      description: "Seconds to wait for this task to settle before returning its current output.",
    }),
  ),
});

const taskStopSchema = Type.Object({
  id: Type.String({ description: "Task id to stop, such as t3." }),
});

type TaskOutputParams = Static<typeof taskOutputSchema>;
type TaskStopParams = Static<typeof taskStopSchema>;

export interface BackgroundableDependencies {
  /** Single lifecycle owner used for starting, racing, inspecting, and stopping work. */
  taskManager: TaskManager;
  /** Default foreground wait budget; individual calls may override it in seconds. */
  defaultWaitBudgetMs: number;
  /** Runtime time source used for stable elapsed wording. */
  clock: RuntimeClock;
  /** Scope whose closure must stop the task. */
  ownerScopeId: () => string;
  /** Convert validated tool arguments into the human-facing task label. */
  label: (params: Record<string, unknown>) => string;
  /** Register whether a new task is immediately deliverable or still racing foreground. */
  onTaskStarted?: (id: TaskId, foregroundPending: boolean) => void;
  /** Resolve foreground delivery: true converts to background; false suppresses its FIFO notice. */
  onForegroundResult?: (id: TaskId, converted: boolean) => void;
}

/**
 * Turn a normal pi tool into task-backed work. The wrapped tool always executes under the
 * task's AbortSignal; a foreground budget expiry changes only its delivery mode, never its
 * lifetime.
 */
export function wrapBackgroundable<TParameters extends TSchema, TDetails>(
  tool: AgentTool<TParameters, TDetails>,
  deps: BackgroundableDependencies,
): AgentTool {
  const baseProperties =
    "properties" in tool.parameters
      ? (tool.parameters.properties as Record<string, TSchema>)
      : ({} as Record<string, TSchema>);
  const parameters = Type.Object({
    ...baseProperties,
    timeout: Type.Optional(
      Type.Number({
        minimum: 0,
        description:
          "Foreground wait budget in seconds. Expiry moves the command to the background; it does not kill it.",
      }),
    ),
    run_in_background: Type.Optional(
      Type.Boolean({
        description: "Start the command in the background and return immediately.",
      }),
    ),
  });

  return {
    ...tool,
    parameters,
    description: `${tool.description} The timeout is a foreground wait budget, not a kill timeout. Use run_in_background to return immediately.`,
    async execute(toolCallId, rawParams, outerSignal, onUpdate) {
      if (outerSignal?.aborted) throw new Error("Tool call aborted before task start.");
      const params = rawParams as Record<string, unknown> & {
        timeout?: number;
        run_in_background?: boolean;
      };
      const { timeout, run_in_background: runInBackground, ...innerParams } = params;
      let lastOutput = "";
      const handle = deps.taskManager.start({
        kind: "tool",
        name: tool.name,
        label: deps.label(params),
        ownerScopeId: deps.ownerScopeId(),
        execute: async ({ signal, onOutput }) => {
          const unregisterReaper = deps.taskManager.registerReaper(async (reason) => {
            if (!signal.aborted) {
              // stop() owns the AbortController and resolves only after the child process group
              // has unwound, so reapAll is a real shutdown barrier rather than a fire-and-forget.
              await deps.taskManager.stop(handle.id, reason);
            }
          });
          try {
            const result = await tool.execute(
              toolCallId,
              innerParams as Static<TParameters>,
              signal,
              (partial) => {
                const text = resultText(partial);
                const delta = text.startsWith(lastOutput) ? text.slice(lastOutput.length) : text;
                lastOutput = text;
                if (delta) onOutput(delta);
                onUpdate?.(partial);
              },
            );
            const text = resultText(result);
            const delta = text.startsWith(lastOutput) ? text.slice(lastOutput.length) : text;
            if (delta) onOutput(delta);
            return result;
          } finally {
            unregisterReaper();
          }
        },
      });
      deps.onTaskStarted?.(handle.id, !runInBackground);

      if (runInBackground) {
        const snapshot = deps.taskManager.output(handle.id);
        if (!snapshot) throw new Error(`Task ${handle.id} disappeared after start.`);
        return textResult(startedInBackgroundNotice(snapshot));
      }

      const budgetMs = timeout === undefined ? deps.defaultWaitBudgetMs : timeout * 1_000;
      const foreground = await deps.taskManager.raceForeground(handle, budgetMs);
      if (foreground.kind === "settled") {
        deps.onForegroundResult?.(handle.id, false);
        if (foreground.settlement.status === "completed") {
          return foreground.settlement.result as AgentToolResult<TDetails>;
        }
        if (foreground.settlement.status === "stopped") {
          throw new Error(`Task ${handle.id} stopped: ${foreground.settlement.reason}`);
        }
        if (foreground.settlement.status === "failed") {
          throw foreground.settlement.error;
        }
        throw new Error(`Task ${handle.id} was lost.`);
      }
      deps.onForegroundResult?.(handle.id, true);
      return textResult(stillRunningNotice(foreground.task, deps.clock.now()));
    },
  };
}

/** B1: the only source for foreground wait-budget conversion wording. */
export function stillRunningNotice(snapshot: TaskSnapshot, now = Date.now()): string {
  const recent = recentOutput(snapshot);
  return [
    `Task ${snapshot.descriptor.id} is still running (${taskDescription(snapshot)}, ${formatElapsed(snapshot, now)} elapsed).`,
    "Recent output:",
    recent ? indent(recent) : "  (no output yet)",
    `It continues in the background. Check it with task_output("${snapshot.descriptor.id}", {wait: 60}),`,
    `stop it with task_stop("${snapshot.descriptor.id}"), or keep working and you'll be nudged when it settles.`,
  ].join("\n");
}

/** B2: the only source for explicit background-start wording. */
export function startedInBackgroundNotice(snapshot: TaskSnapshot): string {
  return [
    `Started background task ${snapshot.descriptor.id} (${taskDescription(snapshot)}).`,
    `You'll be nudged when it settles; task_output("${snapshot.descriptor.id}") shows live progress.`,
  ].join("\n");
}

/** B3: the only source for batched settlement nudges and idle re-prompts. */
export function settlementNotice(settlements: readonly TaskSnapshot[]): string {
  const lines = settlements.map((snapshot) => {
    const settlement = snapshot.settlement;
    if (!settlement)
      return `- ${snapshot.descriptor.id} (${taskDescription(snapshot)}) is running.`;
    const status = settlement.status === "failed" ? "failed" : settlement.status;
    const inline = settlementInline(snapshot);
    return `- ${snapshot.descriptor.id} (${taskDescription(snapshot)}) ${status}${inline ? ` — ${inline}` : ""}. Full output: task_output("${snapshot.descriptor.id}")`;
  });
  return [
    "<system-reminder>",
    `${settlements.length} ${settlements.length === 1 ? "task" : "tasks"} settled while you were working:`,
    ...lines,
    "Act on these or continue; your turn stays open while tasks run.",
    "</system-reminder>",
  ].join("\n");
}

/** Create the sequential admin lane. These tools only inspect existing tasks. */
export function createTaskAdminTools(input: {
  taskManager: TaskManager;
  clock: RuntimeClock;
}): AgentTool[] {
  return [createTaskOutputTool(input), createTaskStopTool(input.taskManager)];
}

function createTaskOutputTool(input: {
  taskManager: TaskManager;
  clock: RuntimeClock;
}): AgentTool<typeof taskOutputSchema> {
  return {
    name: "task_output",
    label: "Task output",
    executionMode: "sequential",
    description:
      "List all tasks, or inspect one task's retained output. Optionally wait for that task to settle.",
    parameters: taskOutputSchema,
    async execute(...args) {
      const params = args[1] as TaskOutputParams;
      if (!params.id) {
        const tasks = input.taskManager.list();
        const text = tasks.length
          ? tasks
              .map(
                (task) =>
                  `${task.id}\t${task.kind}\t${task.label}\t${task.status}\t${formatDuration(Math.max(0, input.clock.now() - task.startedAt))}`,
              )
              .join("\n")
          : "No tasks.";
        return textResult(text);
      }
      const id = params.id as TaskId;
      if (params.wait !== undefined) {
        await input.taskManager.waitForSettlement(id, params.wait * 1_000);
      }
      const snapshot = input.taskManager.output(id);
      if (!snapshot) throw new Error(`Unknown task ${params.id}`);
      return textResult(formatTaskOutput(snapshot));
    },
  };
}

function createTaskStopTool(taskManager: TaskManager): AgentTool<typeof taskStopSchema> {
  return {
    name: "task_stop",
    label: "Stop task",
    executionMode: "sequential",
    description: "Stop one running or scheduled task and return its final retained output.",
    parameters: taskStopSchema,
    async execute(...args) {
      const params = args[1] as TaskStopParams;
      const snapshot = await taskManager.stop(params.id as TaskId, "Stopped by task_stop.");
      if (!snapshot) throw new Error(`Unknown task ${params.id}`);
      return textResult(formatTaskOutput(snapshot));
    },
  };
}

function formatTaskOutput(snapshot: TaskSnapshot): string {
  const output = snapshot.output.join("");
  const settlement = snapshot.settlement
    ? `\nStatus: ${snapshot.settlement.status}`
    : `\nStatus: ${snapshot.descriptor.status}`;
  return `${output || "(no output)"}${settlement}`;
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter(
      (item): item is Extract<(typeof result.content)[number], { type: "text" }> =>
        item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function taskDescription(snapshot: TaskSnapshot): string {
  return `${snapshot.descriptor.name}: \`${snapshot.descriptor.label}\``;
}

function formatElapsed(snapshot: TaskSnapshot, now: number): string {
  const end = snapshot.settlement?.settledAt ?? now;
  return formatDuration(Math.max(0, end - snapshot.descriptor.startedAt));
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m${seconds % 60}s` : `${seconds}s`;
}

function recentOutput(snapshot: TaskSnapshot): string {
  return snapshot.output.join("").trim().slice(-1_500);
}

function settlementInline(snapshot: TaskSnapshot): string {
  if (!snapshot.settlement) return "";
  if (snapshot.settlement.status === "completed") {
    const result = snapshot.settlement.result;
    const text = isAgentToolResult(result) ? resultText(result) : String(result ?? "completed");
    return text.trim().slice(0, MAX_INLINE_SETTLEMENT_CHARS);
  }
  if (snapshot.settlement.status === "failed") return String(snapshot.settlement.error);
  if (snapshot.settlement.status === "stopped") return snapshot.settlement.reason;
  return "task was lost";
}

function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    "content" in value &&
    Array.isArray((value as { content?: unknown }).content),
  );
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
