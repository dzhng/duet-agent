import type { RuntimeClock } from "../turn-runner/runtime-clock.js";
import { computePendingWork, type PendingWork } from "./quiescence.js";
import type {
  ScopeId,
  TaskDescriptor,
  TaskEvent,
  TaskId,
  TaskSettlement,
  TaskSnapshot,
  TaskStopReason,
} from "./types.js";

const MAX_SCOPE_DEPTH = 2;

/** Runtime hooks available to an in-process task executor. */
export interface TaskExecutionContext {
  /** Stable identity allocated before this executor starts. */
  taskId: TaskId;
  /** Aborted exactly once by task_stop, interrupt, or scope closure. */
  signal: AbortSignal;
  /** Append an ordered chunk to the task's retained output. */
  onOutput(chunk: string): void;
  /** Read the caller's reason when classifying an abort outcome. */
  stopReason(): TaskStopReason | undefined;
}

interface TaskOwnership {
  /** Scope that owns the task and is responsible for closing it. */
  ownerScopeId: ScopeId;
  /** Parent of a newly encountered scope; omitted only for a root scope. */
  parentScopeId?: ScopeId;
}

/** Specification for work that begins executing immediately. */
export interface InProcessTaskSpec<T = unknown> extends TaskOwnership {
  /** Selects the executor family for listings and downstream presentation. */
  kind: "tool" | "subagent";
  /** Stable machine-facing name for the operation. */
  name: string;
  /** Human-facing description of this invocation. */
  label: string;
  /** Run the task; rejection is observed and converted into a failed settlement. */
  execute(context: TaskExecutionContext): Promise<T>;
}

/** Specification for durable wall-clock work with no in-process executor. */
export interface ScheduledTaskSpec extends TaskOwnership {
  /** Marks the task as durable wall-clock work rather than an active process. */
  kind: "scheduled";
  /** Stable machine-facing name for the scheduled operation. */
  name: string;
  /** Human-facing description of what will resume. */
  label: string;
  /** Unix-epoch timestamp used by the quiescence decider. */
  wakeAt: number;
}

export type TaskSpec<T = unknown> = InProcessTaskSpec<T> | ScheduledTaskSpec;

/** Opaque start result used to race only the task selected for foreground delivery. */
export interface TaskHandle {
  readonly id: TaskId;
}

export type ForegroundRaceResult =
  | { kind: "settled"; settlement: TaskSettlement }
  | { kind: "still_running"; task: TaskSnapshot };

export type TaskReaper = (reason: TaskStopReason) => void | Promise<void>;

export interface TaskManagerOptions {
  /** Injected owner of time and timers, allowing lifecycle races without real sleeps. */
  clock: RuntimeClock;
  /** Receives ordered lifecycle changes without owning settlement delivery. */
  onEvent?: (event: TaskEvent) => void;
}

export interface RecoverResult {
  /** Previously running tasks that cannot exist in this process and were marked lost. */
  lost: readonly TaskDescriptor[];
}

export interface TaskManager {
  /** Register a child scope before work begins so depth is rejected at the executor boundary. */
  openScope(scopeId: ScopeId, parentScopeId?: ScopeId): void;
  /** Allocate an id and either spawn in-process work or record a schedule. */
  start<T>(spec: TaskSpec<T>): TaskHandle;
  /** Wait through a foreground budget without aborting on expiry. */
  raceForeground(handle: TaskHandle, budgetMs: number): Promise<ForegroundRaceResult>;
  /** Return descriptor copies, optionally restricted to their exact owner scope. */
  list(scopeId?: string): readonly TaskDescriptor[];
  /** Inspect retained output and terminal values without consuming settlement delivery. */
  output(id: TaskId): TaskSnapshot | undefined;
  /** Observe a task or the next task settling, optionally bounded by a clock-driven wait. */
  waitForSettlement(id?: TaskId, waitMs?: number): Promise<TaskSnapshot | undefined>;
  /** Pull the oldest undelivered settlement; this is the only consuming operation. */
  nextSettled(): TaskSettlement | undefined;
  /** Abort a task once and resolve only after its executor has fully unwound. */
  stop(id: TaskId, reason: TaskStopReason): Promise<TaskSnapshot | undefined>;
  /** Stop descendant scopes before directly owned tasks and await every unwind. */
  closeScope(scopeId: ScopeId, reason: TaskStopReason): Promise<void>;
  /** Abort all active and scheduled work, reap processes, and await full unwind. */
  interruptAll(reason: TaskStopReason): Promise<void>;
  /** Compute the current quiescence posture from task descriptors. */
  pendingWork(): PendingWork;
  /** Hydrate descriptors, converting process-bound running work to lost settlements. */
  recover(
    descriptors: readonly TaskDescriptor[],
    nextTaskId?: number,
    outputTails?: Readonly<Partial<Record<TaskId, readonly string[]>>>,
  ): RecoverResult;
  /** Return the numeric suffix that the next start() call will allocate. */
  nextTaskId(): number;
  /** Register process cleanup to run once at the next reap boundary. */
  registerReaper(reaper: TaskReaper): () => void;
  /** Invoke and drain all currently registered process cleanup callbacks. */
  reapAll(reason: TaskStopReason): Promise<void>;
}

interface TaskRecord {
  descriptor: TaskDescriptor;
  readonly output: string[];
  readonly abortController?: AbortController;
  stopReason?: TaskStopReason;
  settlement?: TaskSettlement;
  readonly finished: Promise<TaskSettlement>;
  resolveFinished(settlement: TaskSettlement): void;
}

interface ScopeRecord {
  readonly id: string;
  readonly parentScopeId?: ScopeId;
  readonly depth: number;
  closed: boolean;
}

/** Create the single owner of task lifecycle and settlement delivery. */
export function createTaskManager(options: TaskManagerOptions): TaskManager {
  const records = new Map<TaskId, TaskRecord>();
  const scopes = new Map<string, ScopeRecord>();
  const settlements: TaskSettlement[] = [];
  const settlementWaiters = new Set<(settlement: TaskSettlement) => void>();
  const reapers = new Set<TaskReaper>();
  let nextTaskNumber = 1;

  const copyDescriptor = (descriptor: TaskDescriptor): TaskDescriptor => ({ ...descriptor });
  const snapshot = (record: TaskRecord): TaskSnapshot => ({
    descriptor: copyDescriptor(record.descriptor),
    output: [...record.output],
    ...(record.settlement ? { settlement: record.settlement } : {}),
  });

  const emit = (event: TaskEvent): void => options.onEvent?.(event);

  const registerScope = (ownerScopeId: ScopeId, parentScopeId?: ScopeId): ScopeRecord => {
    const existing = scopes.get(ownerScopeId);
    if (existing) {
      if (existing.parentScopeId !== parentScopeId && parentScopeId !== undefined) {
        throw new Error(`Scope ${ownerScopeId} already has a different parent`);
      }
      if (existing.closed) throw new Error(`Scope ${ownerScopeId} is closed`);
      return existing;
    }

    let depth = 0;
    if (parentScopeId !== undefined) {
      const parent = scopes.get(parentScopeId);
      if (!parent) throw new Error(`Parent scope ${parentScopeId} must be registered first`);
      if (parent.closed) throw new Error(`Parent scope ${parentScopeId} is closed`);
      depth = parent.depth + 1;
    }
    if (depth > MAX_SCOPE_DEPTH) {
      throw new RangeError(`Task scope depth ${depth} exceeds maximum ${MAX_SCOPE_DEPTH}`);
    }

    const scope: ScopeRecord = {
      id: ownerScopeId,
      ...(parentScopeId === undefined ? {} : { parentScopeId }),
      depth,
      closed: false,
    };
    scopes.set(ownerScopeId, scope);
    return scope;
  };

  const createRecord = (
    descriptor: TaskDescriptor,
    abortController?: AbortController,
  ): TaskRecord => {
    let resolveFinished!: (settlement: TaskSettlement) => void;
    const finished = new Promise<TaskSettlement>((resolve) => {
      resolveFinished = resolve;
    });
    return {
      descriptor,
      output: [],
      ...(abortController ? { abortController } : {}),
      finished,
      resolveFinished,
    };
  };

  const settle = (record: TaskRecord, settlement: TaskSettlement): TaskSettlement => {
    if (record.settlement) return record.settlement;
    record.settlement = settlement;
    record.descriptor = { ...record.descriptor, status: settlement.status };
    settlements.push(settlement);
    record.resolveFinished(settlement);
    emit({ type: "settled", settlement });
    for (const notify of settlementWaiters) notify(settlement);
    return settlement;
  };

  const manager: TaskManager = {
    openScope(scopeId, parentScopeId) {
      registerScope(scopeId, parentScopeId);
    },

    start<T>(spec: TaskSpec<T>): TaskHandle {
      if (spec.kind === "scheduled" && !Number.isFinite(spec.wakeAt)) {
        throw new RangeError("wakeAt must be a finite Unix-epoch timestamp");
      }
      registerScope(spec.ownerScopeId, spec.parentScopeId);
      const id = `t${nextTaskNumber++}` as TaskId;
      const descriptor: TaskDescriptor = {
        id,
        kind: spec.kind,
        name: spec.name,
        label: spec.label,
        ownerScopeId: spec.ownerScopeId,
        status: spec.kind === "scheduled" ? "scheduled" : "running",
        startedAt: options.clock.now(),
        ...(spec.kind === "scheduled" ? { wakeAt: spec.wakeAt } : {}),
      };

      if (spec.kind === "scheduled") {
        const record = createRecord(descriptor);
        records.set(id, record);
        emit({ type: "started", descriptor: copyDescriptor(descriptor) });
        return { id };
      }

      const abortController = new AbortController();
      const record = createRecord(descriptor, abortController);
      records.set(id, record);
      emit({ type: "started", descriptor: copyDescriptor(descriptor) });

      const execution = Promise.resolve().then(() =>
        spec.execute({
          taskId: id,
          signal: abortController.signal,
          onOutput(chunk) {
            if (record.settlement) return;
            record.output.push(chunk);
            emit({ type: "output", id, chunk });
          },
          stopReason: () => record.stopReason,
        }),
      );

      // Attach both branches synchronously: executor rejection is always observed at spawn.
      void execution.then(
        (result) => {
          if (record.stopReason !== undefined) {
            settle(record, {
              id,
              status: "stopped",
              settledAt: options.clock.now(),
              reason: record.stopReason,
            });
            return;
          }
          settle(record, { id, status: "completed", settledAt: options.clock.now(), result });
        },
        (error: unknown) => {
          if (record.stopReason !== undefined) {
            settle(record, {
              id,
              status: "stopped",
              settledAt: options.clock.now(),
              reason: record.stopReason,
            });
            return;
          }
          settle(record, { id, status: "failed", settledAt: options.clock.now(), error });
        },
      );
      return { id };
    },

    async raceForeground(handle, budgetMs) {
      if (!Number.isFinite(budgetMs) || budgetMs < 0) {
        throw new RangeError("budgetMs must be a finite non-negative number");
      }
      const record = records.get(handle.id);
      if (!record) throw new Error(`Unknown task ${handle.id}`);
      if (record.settlement) return { kind: "settled", settlement: record.settlement };

      let cancelBudget = (): void => undefined;
      const budgetElapsed = new Promise<void>((resolve) => {
        cancelBudget = options.clock.schedule(resolve, budgetMs);
      });
      await Promise.race([record.finished, budgetElapsed]);
      cancelBudget();

      // A completion queued at the exact deadline wins the photo finish.
      await Promise.resolve();
      if (record.settlement) return { kind: "settled", settlement: record.settlement };
      return { kind: "still_running", task: snapshot(record) };
    },

    list(scopeId) {
      return [...records.values()]
        .filter((record) => scopeId === undefined || record.descriptor.ownerScopeId === scopeId)
        .map((record) => copyDescriptor(record.descriptor));
    },

    output(id) {
      const record = records.get(id);
      return record ? snapshot(record) : undefined;
    },

    async waitForSettlement(id, waitMs) {
      if (waitMs !== undefined && (!Number.isFinite(waitMs) || waitMs < 0)) {
        throw new RangeError("waitMs must be a finite non-negative number");
      }
      const record = id === undefined ? undefined : records.get(id);
      if (id !== undefined && !record) return undefined;
      if (record?.settlement) return snapshot(record);
      if (id === undefined && settlements.length > 0) {
        return snapshot(records.get(settlements[0]!.id)!);
      }

      const notify = (settlement: TaskSettlement): void => {
        if (id === undefined || settlement.id === id) {
          settlementWaiters.delete(notify);
          resolveObserved(settlement);
        }
      };
      let resolveObserved!: (settlement: TaskSettlement) => void;
      const observed = new Promise<TaskSettlement>((resolve) => {
        resolveObserved = resolve;
        settlementWaiters.add(notify);
      });
      if (waitMs === undefined) {
        const settlement = await observed;
        return snapshot(records.get(settlement.id)!);
      }

      let cancelWait = (): void => undefined;
      const elapsed = new Promise<undefined>((resolve) => {
        cancelWait = options.clock.schedule(() => resolve(undefined), waitMs);
      });
      const settlement = await Promise.race([observed, elapsed]);
      cancelWait();
      settlementWaiters.delete(notify);
      return settlement ? snapshot(records.get(settlement.id)!) : undefined;
    },

    nextSettled() {
      return settlements.shift();
    },

    async stop(id, reason) {
      const record = records.get(id);
      if (!record) return undefined;
      if (record.settlement || isTerminal(record.descriptor)) return snapshot(record);
      record.stopReason ??= reason;
      if (record.abortController) {
        record.abortController.abort(reason);
        await record.finished;
      } else {
        settle(record, { id, status: "stopped", settledAt: options.clock.now(), reason });
      }
      return snapshot(record);
    },

    async closeScope(scopeId, reason) {
      const scope = scopes.get(scopeId);
      if (!scope || scope.closed) return;
      const descendants = [...scopes.values()]
        .filter((candidate) => isDescendantOf(candidate, scopeId, scopes))
        .sort((left, right) => right.depth - left.depth);

      for (const descendant of descendants) {
        const owned = [...records.values()].filter(
          (record) =>
            record.descriptor.ownerScopeId === descendant.id && !isTerminal(record.descriptor),
        );
        await Promise.all(owned.map((record) => manager.stop(record.descriptor.id, reason)));
        descendant.closed = true;
      }
      const directlyOwned = [...records.values()].filter(
        (record) => record.descriptor.ownerScopeId === scopeId && !isTerminal(record.descriptor),
      );
      await Promise.all(directlyOwned.map((record) => manager.stop(record.descriptor.id, reason)));
      scope.closed = true;
    },

    async interruptAll(reason) {
      const pending = [...records.values()].filter((record) => !isTerminal(record.descriptor));
      const barriers = pending.map((record) => manager.stop(record.descriptor.id, reason));
      await manager.reapAll(reason);
      await Promise.all(barriers);
    },

    pendingWork() {
      return computePendingWork(manager.list());
    },

    recover(descriptors, persistedNextTaskId, outputTails) {
      const lost: TaskDescriptor[] = [];
      for (const source of descriptors) {
        if (records.has(source.id)) throw new Error(`Duplicate recovered task ${source.id}`);
        const match = /^t(\d+)$/.exec(source.id);
        if (!match) throw new Error(`Invalid task id ${source.id}`);
        nextTaskNumber = Math.max(nextTaskNumber, Number(match[1]) + 1);
        registerScope(source.ownerScopeId);

        const descriptor = copyDescriptor(source);
        const record = createRecord(descriptor);
        record.output.push(...(outputTails?.[descriptor.id] ?? []));
        records.set(descriptor.id, record);
        if (
          descriptor.status === "running" ||
          (descriptor.status === "scheduled" && !Number.isFinite(descriptor.wakeAt))
        ) {
          descriptor.status = "lost";
          lost.push(copyDescriptor(descriptor));
          settle(record, {
            id: descriptor.id,
            status: "lost",
            settledAt: options.clock.now(),
          });
        }
      }
      if (persistedNextTaskId !== undefined) {
        if (!Number.isInteger(persistedNextTaskId) || persistedNextTaskId < 1) {
          throw new RangeError("nextTaskId must be a positive integer");
        }
        nextTaskNumber = Math.max(nextTaskNumber, persistedNextTaskId);
      }
      return { lost };
    },

    nextTaskId() {
      return nextTaskNumber;
    },

    registerReaper(reaper) {
      reapers.add(reaper);
      return () => reapers.delete(reaper);
    },

    async reapAll(reason) {
      const active = [...reapers];
      reapers.clear();
      await Promise.all(active.map((reaper) => reaper(reason)));
    },
  };

  return manager;
}

function isDescendantOf(
  candidate: ScopeRecord,
  ancestorId: string,
  scopes: ReadonlyMap<string, ScopeRecord>,
): boolean {
  let parentScopeId = candidate.parentScopeId;
  while (parentScopeId !== undefined) {
    if (parentScopeId === ancestorId) return true;
    parentScopeId = scopes.get(parentScopeId)?.parentScopeId;
  }
  return false;
}

function isTerminal(descriptor: TaskDescriptor): boolean {
  return !["running", "scheduled"].includes(descriptor.status);
}
