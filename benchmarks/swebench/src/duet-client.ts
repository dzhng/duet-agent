import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { SystemRuntimeClock, type RuntimeClock } from "../../../src/turn-runner/runtime-clock.js";
import type {
  RpcRunnerCommand,
  TurnEvent,
  TurnStartCommand,
  TurnTerminalEvent,
} from "../../../src/types/protocol.js";

/** Writable stdin half of a running duet RPC process. */
export interface ExecTransportStdin {
  /** Write one complete NDJSON command line, including its trailing newline. */
  write(line: string): void | Promise<void>;
}

/** Process boundary injected into {@link runDuetTurn}. */
export interface ExecTransport {
  /** Command stream consumed by `duet --rpc`. */
  stdin: ExecTransportStdin;
  /** Stdout split into lines; only valid JSON protocol events are retained. */
  stdoutLines: AsyncIterable<string>;
  /** Optional stderr stream. It is drained but never parsed as protocol. */
  stderrLines?: AsyncIterable<string>;
  /** Force-stop the process after the bounded interrupt grace expires. */
  kill(): void | Promise<void>;
  /** Process completion, exposed for container lifecycle owners and diagnostics. */
  exited: Promise<{ code: number | null; signal: string | null }>;
}

/** Client-side interruption thresholds for one model rollout. */
export interface RolloutLimits {
  /** Cumulative reported spend that triggers interruption after the current request completes. */
  costUsd: number;
  /** Maximum elapsed time before the client interrupts the turn. */
  wallClockMs: number;
  /** Time allowed for an interrupted terminal before the process is killed. */
  interruptGraceMs?: number;
}

/** RPC setup and resource policy for one unattended turn. */
export interface DuetTurnSpec {
  /** Start payload sent before the prompt; defaults to explicit agent mode. */
  start?: Omit<TurnStartCommand, "type">;
  limits: RolloutLimits;
}

/** Complete client-side record of one RPC turn. */
export interface RolloutOutcome {
  /** First protocol terminal, or `"killed"` when no terminal arrived safely. */
  terminal: TurnTerminalEvent | "killed";
  /** Every valid protocol event observed before the outcome was decided. */
  events: TurnEvent[];
  /** True only when the wall-clock ceiling fired, not when spend caused interruption. */
  timedOut: boolean;
  /** Why no protocol terminal arrived; absent when `terminal` is a real event. */
  killedReason?: "process_exit" | "wall_clock" | "cost";
  /** Elapsed time measured by the injected monotonic runtime clock. */
  wallClockMs: number;
}

const DEFAULT_INTERRUPT_GRACE_MS = 90_000;

/**
 * Drive one unattended duet RPC turn over an injected process transport.
 *
 * Thresholds are evaluated from cumulative wire events. On a breach the client
 * requests a graceful interrupt, retains every subsequent event, and
 * force-kills only if no terminal arrives within the grace period. A provider
 * request can overshoot the dollar threshold before its usage event is visible.
 */
export async function runDuetTurn(
  transport: ExecTransport,
  spec: DuetTurnSpec,
  prompt: string,
  clock: RuntimeClock = new SystemRuntimeClock(),
): Promise<RolloutOutcome> {
  validateLimits(spec.limits);
  const startedAt = clock.now();
  const events: TurnEvent[] = [];
  const iterator = transport.stdoutLines[Symbol.asyncIterator]();

  // Stderr carries the CLI version banner and diagnostics, never protocol.
  // Drain it so a verbose child cannot block on a full pipe.
  if (transport.stderrLines) void drainLines(transport.stderrLines);

  await writeCommand(transport, {
    ...spec.start,
    type: "start",
    mode: spec.start?.mode ?? "agent",
  });
  await writeCommand(transport, {
    type: "prompt",
    requestId: "swebench-rollout-prompt",
    message: prompt,
    behavior: "follow_up",
  });

  let pendingRead: Promise<IteratorResult<string>> | undefined;
  const nextLine = (): Promise<IteratorResult<string>> => {
    pendingRead ??= iterator.next();
    return pendingRead;
  };
  const consumeRead = (): void => {
    pendingRead = undefined;
  };

  while (true) {
    const remainingMs = spec.limits.wallClockMs - (clock.now() - startedAt);
    if (remainingMs <= 0) {
      return interruptAndAwaitTerminal(true);
    }

    const raced = await raceReadWithTimeout(nextLine(), remainingMs, clock);
    if (raced.type === "timeout") return interruptAndAwaitTerminal(true);
    consumeRead();

    if (raced.result.done) {
      await transport.kill();
      return outcome("killed", false, "process_exit");
    }

    const event = parseRpcEvent(raced.result.value);
    if (!event) continue;
    events.push(event);

    if (isTerminal(event)) return outcome(event, false);
    if (event.type === "usage" && event.turnUsage.cost.total >= spec.limits.costUsd) {
      return interruptAndAwaitTerminal(false);
    }
  }

  async function interruptAndAwaitTerminal(timedOut: boolean): Promise<RolloutOutcome> {
    await writeCommand(transport, { type: "interrupt" });
    const graceMs = spec.limits.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
    const graceStartedAt = clock.now();

    while (true) {
      const remainingGraceMs = graceMs - (clock.now() - graceStartedAt);
      if (remainingGraceMs <= 0) break;

      const raced = await raceReadWithTimeout(nextLine(), remainingGraceMs, clock);
      if (raced.type === "timeout") break;
      consumeRead();
      if (raced.result.done) break;

      const event = parseRpcEvent(raced.result.value);
      if (!event) continue;
      events.push(event);
      if (isTerminal(event)) return outcome(event, timedOut);
    }

    await transport.kill();
    return outcome("killed", timedOut, timedOut ? "wall_clock" : "cost");
  }

  function outcome(
    terminal: TurnTerminalEvent | "killed",
    timedOut: boolean,
    killedReason?: RolloutOutcome["killedReason"],
  ): RolloutOutcome {
    return {
      terminal,
      events,
      timedOut,
      ...(killedReason ? { killedReason } : {}),
      wallClockMs: clock.now() - startedAt,
    };
  }
}

/** Spawn the repository CLI as a local RPC process for the playable checkpoint. */
export function spawnLocalDuetRpc(args: readonly string[]): ExecTransport {
  const child = spawn(process.execPath, ["src/cli.ts", "--rpc", ...args], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  return {
    stdin: {
      write: (line) =>
        new Promise<void>((resolve, reject) => {
          child.stdin.write(line, (error) => (error ? reject(error) : resolve()));
        }),
    },
    stdoutLines: readLines(child.stdout),
    stderrLines: readLines(child.stderr),
    kill: () => {
      child.kill("SIGKILL");
    },
    exited: new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
  };
}

async function writeCommand(transport: ExecTransport, command: RpcRunnerCommand): Promise<void> {
  await transport.stdin.write(`${JSON.stringify(command)}\n`);
}

async function raceReadWithTimeout(
  read: Promise<IteratorResult<string>>,
  timeoutMs: number,
  clock: RuntimeClock,
): Promise<{ type: "read"; result: IteratorResult<string> } | { type: "timeout" }> {
  const controller = new AbortController();
  const timeout = clock.sleep(timeoutMs, controller.signal).then(
    () => ({ type: "timeout" }) as const,
    () => new Promise<never>(() => {}),
  );
  const result = await Promise.race([
    read.then((value) => ({ type: "read", result: value }) as const),
    timeout,
  ]);
  if (result.type === "read") controller.abort();
  return result;
}

function parseRpcEvent(line: string): TurnEvent | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as { type?: unknown }).type !== "string"
    ) {
      return undefined;
    }
    return value as TurnEvent;
  } catch {
    return undefined;
  }
}

function isTerminal(event: TurnEvent): event is TurnTerminalEvent {
  return (
    event.type === "complete" ||
    event.type === "ask" ||
    event.type === "interrupted" ||
    event.type === "sleep"
  );
}

function validateLimits(limits: RolloutLimits): void {
  if (!Number.isFinite(limits.costUsd) || limits.costUsd <= 0) {
    throw new RangeError("limits.costUsd must be a finite positive number");
  }
  if (!Number.isFinite(limits.wallClockMs) || limits.wallClockMs <= 0) {
    throw new RangeError("limits.wallClockMs must be a finite positive number");
  }
  if (
    limits.interruptGraceMs !== undefined &&
    (!Number.isFinite(limits.interruptGraceMs) || limits.interruptGraceMs < 0)
  ) {
    throw new RangeError("limits.interruptGraceMs must be a finite non-negative number");
  }
}

async function* readLines(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
  } finally {
    lines.close();
  }
}

async function drainLines(lines: AsyncIterable<string>): Promise<void> {
  const iterator = lines[Symbol.asyncIterator]();
  while (!(await iterator.next()).done) {
    // Intentionally ignored: stderr is diagnostic-only and must not enter the
    // protocol event ledger.
  }
}
