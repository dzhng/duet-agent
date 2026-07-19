import type { TaskDescriptor, TaskId, TaskSettlement, TaskStatus } from "../tasks/types.js";
import type { TurnEvent, TurnStep } from "../types/protocol.js";

const TASK_SCOPE_PREFIX = "task:";

export type TaskTreeEvent = Extract<
  TurnEvent,
  { type: "task_started" | "task_output" | "task_settled" | "step" | "usage" }
>;

export interface TaskTreeProjectionInput {
  /** Durable descriptors available when the TUI attaches, including after hydration. */
  tasks: readonly TaskDescriptor[];
  /** Ordered events observed after the snapshot was captured. */
  events?: readonly TaskTreeEvent[];
  /** Wall clock used for elapsed and wake labels. */
  now: number;
  /** Running aggregate already observed before late attach; prevents the next task tick being over-attributed. */
  initialTurnTokens?: number;
}

export interface TaskTreeRow {
  /** Stable key used by live renderers that update the projection in place. */
  key: "parent" | "held-awake" | TaskId;
  /** Complete printable row, including tree connectors and timing metadata. */
  text: string;
  /** Ownership nesting below the parent lane; the parent header is depth zero. */
  depth: number;
  /** Durable lifecycle status for task rows; absent on parent and held-awake rows. */
  status?: TaskStatus;
  /** Descriptor identity for task rows; absent on structural rows. */
  taskId?: TaskId;
  /** Tokens attributed from cumulative usage deltas carrying this task's origin. */
  tokenUsage?: number;
}

export interface TaskTreeProjection {
  /** Render-ready rows in stable task-id and ownership order. */
  rows: readonly TaskTreeRow[];
  /** In-process tasks that keep the turn open; scheduled work is deliberately excluded. */
  heldAwakeBy: readonly TaskId[];
  /** Latest parent-lane activity used by the accepted tree header. */
  parentActivity: string;
}

interface ProjectedTask {
  descriptor: TaskDescriptor;
  settledAt?: number;
  activity?: string;
  tokenUsage: number;
}

/**
 * Pure late-attach/live projection for the task surface. The durable snapshot is the
 * base truth; subsequent lifecycle events replace descriptors by id, task-origin
 * steps update only their lane, and cumulative usage events are differenced before
 * their delta is credited to the originating task.
 */
export function projectTaskTree(input: TaskTreeProjectionInput): TaskTreeProjection {
  const tasks = new Map<TaskId, ProjectedTask>();
  for (const descriptor of input.tasks) {
    tasks.set(descriptor.id, { descriptor: { ...descriptor }, tokenUsage: 0 });
  }

  let parentActivity = "working…";
  let previousTurnTokens = input.initialTurnTokens ?? 0;

  for (const event of input.events ?? []) {
    if (event.type === "task_started") {
      const existing = tasks.get(event.task.id);
      tasks.set(event.task.id, {
        descriptor: { ...event.task },
        tokenUsage: existing?.tokenUsage ?? 0,
        ...(existing?.activity ? { activity: existing.activity } : {}),
        ...(existing?.settledAt === undefined ? {} : { settledAt: existing.settledAt }),
      });
      continue;
    }
    if (event.type === "task_output") {
      const task = tasks.get(event.taskId);
      if (task) task.activity = summarizeActivity(event.chunk);
      continue;
    }
    if (event.type === "task_settled") {
      settleProjectedTask(tasks, event.settlement);
      continue;
    }
    if (event.type === "usage") {
      const current = event.turnUsage.totalTokens;
      const delta = Math.max(0, current - previousTurnTokens);
      previousTurnTokens = Math.max(previousTurnTokens, current);
      if (event.origin?.kind === "task") {
        const task = tasks.get(event.origin.taskId);
        if (task) task.tokenUsage += delta;
      }
      continue;
    }

    const activity = activityFromStep(event.step);
    if (!activity) continue;
    if (event.origin?.kind === "task") {
      const task = tasks.get(event.origin.taskId);
      if (task) task.activity = activity;
    } else if (!event.origin) {
      parentActivity = activity;
    }
  }

  const ordered = [...tasks.values()].sort(compareProjectedTasks);
  if (ordered.length === 0) return { rows: [], heldAwakeBy: [], parentActivity };

  const children = new Map<TaskId | undefined, ProjectedTask[]>();
  for (const task of ordered) {
    const parentId = parentTaskId(task.descriptor.ownerScopeId);
    const actualParent = parentId && tasks.has(parentId) ? parentId : undefined;
    const siblings = children.get(actualParent) ?? [];
    siblings.push(task);
    children.set(actualParent, siblings);
  }

  const rows: TaskTreeRow[] = [{ key: "parent", text: `● parent — ${parentActivity}`, depth: 0 }];
  appendTaskRows(rows, children, undefined, "", input.now);

  const heldAwakeBy = ordered
    .filter((task) => task.descriptor.status === "running")
    .map((task) => task.descriptor.id);
  if (heldAwakeBy.length > 0) {
    rows.push({
      key: "held-awake",
      text: `  turn open: held awake by ${heldAwakeBy.join(", ")}`,
      depth: 1,
    });
  }
  return { rows, heldAwakeBy, parentActivity };
}

function settleProjectedTask(tasks: Map<TaskId, ProjectedTask>, settlement: TaskSettlement): void {
  const task = tasks.get(settlement.id);
  if (!task) return;
  task.descriptor = { ...task.descriptor, status: settlement.status };
  task.settledAt = settlement.settledAt;
}

function appendTaskRows(
  rows: TaskTreeRow[],
  children: ReadonlyMap<TaskId | undefined, readonly ProjectedTask[]>,
  parentId: TaskId | undefined,
  prefix: string,
  now: number,
): void {
  const siblings = children.get(parentId) ?? [];
  siblings.forEach((task, index) => {
    const last = index === siblings.length - 1;
    const connector = last ? "└─" : "├─";
    rows.push({
      key: task.descriptor.id,
      taskId: task.descriptor.id,
      status: task.descriptor.status,
      tokenUsage: task.tokenUsage,
      depth: prefix.length / 3 + 1,
      text: `${prefix}  ${connector} ${formatTask(task, now)}`,
    });
    appendTaskRows(rows, children, task.descriptor.id, `${prefix}${last ? "   " : "  │"}`, now);
  });
}

function formatTask(task: ProjectedTask, now: number): string {
  const { descriptor } = task;
  const marker = taskMarker(descriptor.status);
  const label = formatTaskLabel(descriptor);
  const activity = task.activity ? ` — ${task.activity}` : "";
  const timing =
    descriptor.status === "scheduled" && descriptor.wakeAt !== undefined
      ? ` — wakes ${formatWakeTime(descriptor.wakeAt)}`
      : descriptor.status === "running"
        ? formatTaskElapsed(descriptor.startedAt, now)
        : task.settledAt === undefined
          ? ""
          : formatTaskElapsed(descriptor.startedAt, task.settledAt);
  const usage = task.tokenUsage > 0 ? `   [${formatTokenCount(task.tokenUsage)} tok]` : "";
  return `${marker} ${descriptor.id} ${descriptor.name} ${label}${activity}${timing}${usage}`.trimEnd();
}

function formatTaskLabel(task: TaskDescriptor): string {
  const label = truncate(task.label.trim(), 46);
  return task.name === "bash" ? `\`${label}\`` : label;
}

function taskMarker(status: TaskStatus): string {
  if (status === "running") return "⠙";
  if (status === "scheduled") return "◷";
  if (status === "completed") return "✔";
  if (status === "failed") return "✘";
  if (status === "stopped") return "■";
  return "?";
}

function formatTaskElapsed(startedAt: number, endedAt: number): string {
  const totalSeconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  if (totalSeconds < 60) return ` ${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  return ` ${minutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
}

function formatWakeTime(wakeAt: number): string {
  return new Date(wakeAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
}

function activityFromStep(step: TurnStep): string | undefined {
  if (step.type === "text" || step.type === "reasoning") return summarizeActivity(step.text);
  if (step.type === "text_delta" || step.type === "reasoning_delta") {
    return summarizeActivity(step.delta);
  }
  if (step.type === "tool_call_start") return `running ${step.toolName}`;
  if (step.type === "tool_call") return `${step.toolName} ${step.isError ? "failed" : "finished"}`;
  return summarizeActivity(step.message);
}

function summarizeActivity(value: string): string | undefined {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine ? truncate(oneLine, 54) : undefined;
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1)).trimEnd()}…`;
}

function parentTaskId(ownerScopeId: string): TaskId | undefined {
  if (!ownerScopeId.startsWith(TASK_SCOPE_PREFIX)) return undefined;
  const candidate = ownerScopeId.slice(TASK_SCOPE_PREFIX.length);
  return /^t\d+$/.test(candidate) ? (candidate as TaskId) : undefined;
}

function compareProjectedTasks(a: ProjectedTask, b: ProjectedTask): number {
  return Number(a.descriptor.id.slice(1)) - Number(b.descriptor.id.slice(1));
}

/** Narrowed event predicate shared by the session router and pure tests. */
export function isTaskTreeEvent(event: TurnEvent): event is TaskTreeEvent {
  return (
    event.type === "task_started" ||
    event.type === "task_output" ||
    event.type === "task_settled" ||
    event.type === "step" ||
    event.type === "usage"
  );
}
