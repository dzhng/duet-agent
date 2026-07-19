import { type CliRenderer, TextRenderable } from "@opentui/core";
import type { TaskDescriptor, TaskId } from "../tasks/types.js";
import type { TurnEvent } from "../types/protocol.js";
import {
  isTaskTreeEvent,
  projectTaskTree,
  type TaskTreeEvent,
  type TaskTreeProjection,
} from "./task-tree.js";
import { COLORS } from "./theme.js";
import type { StatusController } from "./status-controller.js";
import type { TranscriptWriter } from "./transcript-writer.js";

export interface TaskLaneRendererOptions {
  renderer: CliRenderer;
  transcriptWriter: TranscriptWriter;
  statusController: StatusController;
}

/**
 * Live owner of the task tree renderable. It is deliberately a sibling of
 * StepRenderer: task-origin steps never enter the single-lane transcript tool map,
 * while parent steps can still update both the ordinary transcript and tree header.
 */
export class TaskLaneRenderer {
  private readonly events: TaskTreeEvent[] = [];
  private tasks: readonly TaskDescriptor[] = [];
  private initialTurnTokens: number | undefined;
  private line: TextRenderable | undefined;
  private projection: TaskTreeProjection = {
    rows: [],
    heldAwakeBy: [],
    parentActivity: "working…",
  };

  constructor(private readonly opts: TaskLaneRendererOptions) {}

  /** Seed the lane before subscribing so late attach never waits for a terminal or replay. */
  seed(tasks: readonly TaskDescriptor[], initialTurnTokens?: number): void {
    this.tasks = tasks.map((task) => ({ ...task }));
    this.initialTurnTokens = initialTurnTokens;
    this.refresh();
  }

  renderEvent(event: TurnEvent): void {
    if (!isTaskTreeEvent(event)) return;
    const superseded = supersededEventIndex(this.events, event);
    if (superseded !== -1) this.events.splice(superseded, 1);
    this.events.push(event);
    this.refresh();
  }

  /** Advance elapsed counters from the shared status ticker. */
  refresh(): void {
    this.projection = projectTaskTree({
      tasks: this.tasks,
      events: this.events,
      now: Date.now(),
      ...(this.initialTurnTokens === undefined
        ? {}
        : { initialTurnTokens: this.initialTurnTokens }),
    });
    this.opts.statusController.setHeldAwakeTasks(
      this.projection.heldAwakeBy,
      earliestRunningStart(this.tasks, this.events, this.projection.heldAwakeBy),
    );
    if (this.projection.rows.length === 0) return;
    // The persistent status row owns the held-awake sentence so it sits
    // immediately below this block exactly once, matching the accepted tree.
    const content = this.projection.rows
      .filter((row) => row.key !== "held-awake")
      .map((row) => row.text)
      .join("\n");
    if (!this.line) {
      this.opts.transcriptWriter.beginBlock();
      this.line = new TextRenderable(this.opts.renderer, { content, fg: COLORS.status });
      this.opts.transcriptWriter.mount(this.line);
      return;
    }
    this.line.content = content;
  }
}

function earliestRunningStart(
  snapshot: readonly TaskDescriptor[],
  events: readonly TaskTreeEvent[],
  runningIds: readonly TaskId[],
): number | undefined {
  const starts = new Map(snapshot.map((task) => [task.id, task.startedAt]));
  for (const event of events) {
    if (event.type === "task_started") starts.set(event.task.id, event.task.startedAt);
  }
  const values = runningIds.flatMap((id) => {
    const startedAt = starts.get(id);
    return startedAt === undefined ? [] : [startedAt];
  });
  return values.length === 0 ? undefined : Math.min(...values);
}

/** Streaming/output activity is latest-value UI state, so replace it instead of retaining every delta. */
function supersededEventIndex(events: readonly TaskTreeEvent[], next: TaskTreeEvent): number {
  if (next.type === "task_output") {
    return events.findIndex(
      (event) => event.type === "task_output" && event.taskId === next.taskId,
    );
  }
  if (next.type !== "step") return -1;
  const nextLane = next.origin?.taskId ?? "parent";
  return events.findIndex((event) => {
    if (event.type !== "step") return false;
    const lane = event.origin?.taskId ?? "parent";
    return lane === nextLane;
  });
}
