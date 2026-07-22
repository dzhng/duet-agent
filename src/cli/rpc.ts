import { createInterface } from "node:readline";
import {
  pinnedDefaultModel,
  pinnedMemoryModel,
  PROVIDER_SHORTHANDS,
  resolveProviderShorthand,
} from "../model-resolution/catalog.js";
import { TurnRunner } from "../turn-runner/turn-runner.js";
import {
  SystemRuntimeClock,
  type CancelScheduled,
  type RuntimeClock,
} from "../turn-runner/runtime-clock.js";
import type {
  RpcCommandAcceptedEvent,
  RpcEvent,
  RpcRunnerCommand,
  TurnCompactCommand,
  TurnEditFollowUpQueueCommand,
  TurnInterruptCommand,
  TurnRunnerCommand,
  TurnState,
  TurnSystemEvent,
  TaskId,
  TurnTerminalEvent,
} from "../types/protocol.js";
import type { PackageMetadata } from "./run.js";
import { buildProjectCliTurnConfig } from "./run.js";
import { expandHomeDir, fail, loadCliEnvFiles } from "./shared.js";
import { installShutdownHandlers } from "./shutdown.js";

const RPC_HEARTBEAT_INTERVAL_MS = 15_000;

/** Stdout operations needed by the RPC event writer. */
export interface RpcWritable {
  /** Queue one NDJSON line; false means subsequent writes must wait for `drain`. */
  write(chunk: string): boolean;
  /** Register the one-shot notification that stream backpressure has cleared. */
  once(event: "drain", listener: () => void): unknown;
}

/**
 * Ordered NDJSON writer for the RPC transport.
 *
 * Runner events are lossless and keep subscription order. Heartbeats are a
 * separate best-effort lane: at most one waits behind backpressure, newer
 * heartbeats replace it, and any real event is always written first.
 */
export class RpcEventWriter {
  private readonly losslessLines: string[] = [];
  private readonly activeTaskIds = new Set<TaskId>();
  private pendingHeartbeat?: string;
  private pumping = false;
  private heartbeatCancel?: CancelScheduled;
  private failure?: unknown;
  private readonly flushWaiters = new Set<() => void>();

  constructor(
    private readonly stream: RpcWritable,
    private readonly clock: RuntimeClock = new SystemRuntimeClock(),
  ) {
    // Heartbeats are unconditional process liveness: a host reads "heartbeat
    // arriving" as healthy and "silence past the interval" as wedged — no
    // task-set special case. They stop only at the terminal, when the process
    // is about to exit anyway.
    this.startHeartbeats();
  }

  /** Accept a runner event synchronously while its serialized value is stable. */
  emit(event: RpcEvent): void {
    this.losslessLines.push(serializeRpcEvent(event));

    if (event.type === "task_started" && event.task.status === "running") {
      this.activeTaskIds.add(event.task.id);
    } else if (event.type === "task_settled") {
      this.activeTaskIds.delete(event.settlement.id);
    } else if (isRpcTerminalEvent(event)) {
      this.stopHeartbeats();
    }

    this.pump();
  }

  /** Resolve after every accepted lossless event has crossed the stream boundary. */
  async flush(): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    if (!this.pumping && this.losslessLines.length === 0 && !this.pendingHeartbeat) return;
    await new Promise<void>((resolve) => this.flushWaiters.add(resolve));
    if (this.failure !== undefined) throw this.failure;
  }

  /** Stop transport-owned liveness work, then flush every accepted event. */
  async close(): Promise<void> {
    this.stopHeartbeats();
    await this.flush();
  }

  private startHeartbeats(): void {
    if (this.heartbeatCancel) return;
    this.heartbeatCancel = this.clock.repeat(() => this.emitHeartbeat(), RPC_HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeats(): void {
    this.heartbeatCancel?.();
    this.heartbeatCancel = undefined;
    this.pendingHeartbeat = undefined;
  }

  private emitHeartbeat(): void {
    this.pendingHeartbeat = serializeRpcEvent({
      type: "heartbeat",
      timestamp: this.clock.now(),
      activeTaskIds: [...this.activeTaskIds],
    });
    this.pump();
  }

  private pump(): void {
    if (this.pumping || this.failure !== undefined) return;
    this.pumping = true;
    void this.runPump();
  }

  private async runPump(): Promise<void> {
    try {
      while (true) {
        const line = this.losslessLines.shift() ?? this.takeHeartbeat();
        if (!line) break;
        if (!this.stream.write(line)) {
          await new Promise<void>((resolve) => this.stream.once("drain", resolve));
        }
      }
    } catch (error) {
      this.failure = error;
    } finally {
      this.pumping = false;
      if (this.failure !== undefined) {
        for (const resolve of this.flushWaiters) resolve();
        this.flushWaiters.clear();
      } else if (this.losslessLines.length > 0 || this.pendingHeartbeat) {
        this.pump();
      } else {
        for (const resolve of this.flushWaiters) resolve();
        this.flushWaiters.clear();
      }
    }
  }

  private takeHeartbeat(): string | undefined {
    const heartbeat = this.pendingHeartbeat;
    this.pendingHeartbeat = undefined;
    return heartbeat;
  }
}

function serializeRpcEvent(event: RpcEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function isRpcTerminalEvent(event: RpcEvent): event is TurnTerminalEvent {
  return (
    event.type === "complete" ||
    event.type === "ask" ||
    event.type === "sleep" ||
    event.type === "interrupted"
  );
}

/** Fatal errors may synthesize a terminal only when the captured state is quiescent. */
export function shouldEmitFatalTerminal(state: TurnState | undefined): state is TurnState {
  return Boolean(state && !state.tasks?.some((task) => task.status === "running"));
}

/**
 * Minimal contract the RPC loop expects from a turn runner. The full
 * {@link TurnRunner} satisfies it; tests pass a stub so the dispatch loop
 * can be exercised without spinning up real models or memory.
 */
export interface RpcRunner {
  start(command: Extract<TurnRunnerCommand, { type: "start" }>): Promise<unknown>;
  turn(
    command: Extract<TurnRunnerCommand, { type: "prompt" | "answer" | "wake" }>,
    onAccepted?: () => void,
  ): Promise<TurnTerminalEvent>;
  interrupt(command: TurnInterruptCommand): void;
  editFollowUpQueue(command: TurnEditFollowUpQueueCommand): void;
  compact(command: TurnCompactCommand): void | Promise<void>;
}

/**
 * `duet --rpc` — bare turn-runner control surface.
 *
 * Reads newline-delimited JSON {@link RpcRunnerCommand} values from stdin and
 * writes newline-delimited {@link RpcEvent} values to stdout. Prompt, answer,
 * and wake commands carry a caller-owned `requestId`; the RPC transport emits
 * `command_accepted` after the command enters the runner. The first command
 * must be `start`; the runner emits
 * `turn_started` and then waits for a turn-driving command (`prompt`,
 * `answer`, or `wake`). Additional turn-driving commands sent before the
 * terminal event are forwarded into the runner, which queues them onto the
 * same chain and still emits exactly one terminal. The process exits as
 * soon as that terminal lands.
 *
 * Soft protocol errors — malformed JSON lines, commands sent before
 * `start`, a second `start`, unknown command types — are surfaced as
 * `TurnSystemEvent`s on stdout and the loop keeps reading. The process
 * only ends on a terminal event or when stdin closes, so the host can
 * recover from a bad line without losing an in-flight turn.
 *
 * Unlike the TUI path, RPC mode bypasses {@link SessionManager} entirely:
 * no `state.json`, no resume hints. Persistence policy lives with the caller.
 * Memory still works regardless of session: `--incognito` disables durable
 * database and file sources, while normal mode persists observations to the
 * configured memory db and loads discovered curated files.
 *
 * Session attribution is opt-in via the `--session <id>` spawn flag. One RPC
 * process is one logical session (a second `start` is rejected), so the id is
 * a construction-time config value rather than a per-turn field: it lands on
 * `config.sessionId` before the runner is built and stamps every observation
 * written during the process. The `start` command and `turn_started` event
 * shape are unchanged — the caller already supplied the id, so it is not
 * echoed back.
 */
export async function runRpcCommand(args: string[], pkg: PackageMetadata): Promise<void> {
  const parsed = parseRpcArgs(args);
  const dotenvKeys = loadCliEnvFiles(parsed.workDir, parsed.envFilePath);

  // RPC mode never auto-upgrades: it is structurally non-interactive
  // (JSON-RPC over stdio) and is normally invoked by a host gateway that
  // owns its own upgrade policy out of band. A mid-upgrade SIGKILL from a
  // sandbox tearing down the exec process tree would leave the global
  // node_modules tree in a partial state; keeping RPC quiet here avoids
  // that risk entirely, matching the non-interactive gate in `run.ts`.

  const { config } = await buildProjectCliTurnConfig(
    {
      ...(parsed.modelName ? { modelName: parsed.modelName } : {}),
      ...(parsed.memoryModelName ? { memoryModelName: parsed.memoryModelName } : {}),
      incognito: parsed.incognito,
      ...(parsed.dbPath ? { dbPath: parsed.dbPath } : {}),
      ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
      workDir: parsed.workDir,
      ...(parsed.systemInstructions ? { systemInstructions: parsed.systemInstructions } : {}),
      ...(parsed.systemPromptFiles ? { systemPromptFiles: parsed.systemPromptFiles } : {}),
    },
    dotenvKeys,
  );

  // Identify ourselves so consumers can spot version skew between the RPC
  // protocol they encoded against and the binary they actually spawned.
  process.stderr.write(`${pkg.name} ${pkg.version} rpc\n`);

  const runner = new TurnRunner(config);
  const eventWriter = new RpcEventWriter(process.stdout);
  const writeEvent = (event: RpcEvent): void => eventWriter.emit(event);
  runner.subscribe(writeEvent);

  // Without these handlers, an unhandled rejection or uncaught exception
  // anywhere in start()/turn() setup (memory load, skill load, state
  // hydration, MCP connect) kills the process under Node's default policy
  // with no terminal event written and nothing on stderr. Hosts then see
  // `code=null stderr=` and have no way to surface a real error to the
  // user. Emit a system error event with the cause, then emit a `complete`
  // terminal only when the captured runner state has no in-process tasks.
  // Fabricating quiescence while work is open would let the RPC host reap a
  // live process tree; that path emits only the fatal diagnostic, then uses
  // runner.dispose() to stop and reap the work before exiting.
  let fatalExitStarted = false;
  const emitFatalAndExit = (reason: unknown): void => {
    if (fatalExitStarted) return;
    fatalExitStarted = true;
    const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    void (async () => {
      try {
        writeEvent({ type: "system", level: "error", message: `fatal: ${message}` });
        const state = runner.getState();
        if (shouldEmitFatalTerminal(state)) {
          writeEvent({ type: "complete", status: "failed", error: message, state });
        }
        await runner.dispose();
        await eventWriter.close();
      } catch {
        // stdout may be closed if the parent already gave up on us; nothing
        // useful remains after the best-effort task reaper and transport flush.
      } finally {
        process.exit(1);
      }
    })();
  };
  process.on("unhandledRejection", emitFatalAndExit);
  process.on("uncaughtException", emitFatalAndExit);

  const removeShutdownHandlers = installShutdownHandlers(async () => {
    await runner.dispose();
    await eventWriter.close();
  });

  try {
    await driveRpcLoop(runner, readStdinCommands(writeEvent), { emit: writeEvent });
  } finally {
    process.off("unhandledRejection", emitFatalAndExit);
    process.off("uncaughtException", emitFatalAndExit);
    removeShutdownHandlers();
    await runner.dispose();
    await eventWriter.close();
  }
}

export interface ParsedRpcArgs {
  modelName?: string;
  memoryModelName?: string;
  workDir: string;
  systemInstructions?: string;
  systemPromptFiles?: string[];
  envFilePath?: string;
  /**
   * Explicit memory database file path passed via `--db`. When omitted,
   * Project-aware config resolution falls back to the shared `~/.duet/memory.db`
   * default so RPC mode persists memory just like the TUI/run path.
   */
  dbPath?: string;
  /**
   * Caller-owned session id from the `--session <id>` spawn flag. Flows into
   * `config.sessionId` before the {@link TurnRunner} is constructed, so every
   * observation written during the process is attributed to this session. One
   * RPC process is one logical session; omitted when the host does not want
   * per-session attribution (writes then carry no session id).
   */
  sessionId?: string;
  incognito: boolean;
}

/**
 * Parse CLI args for `--rpc`. The accepted set mirrors the run command's
 * runtime-shaping flags; session-specific flags (`--resume`, prompt args,
 * `--resume-history-messages`) are intentionally omitted because RPC mode
 * bypasses SessionManager.
 */
export function parseRpcArgs(args: string[]): ParsedRpcArgs {
  let modelName: string | undefined;
  let memoryModelName: string | undefined;
  let providerFlag: string | undefined;
  let workDir = process.cwd();
  let systemInstructions: string | undefined;
  let systemPromptFiles: string[] | undefined;
  let envFilePath: string | undefined;
  let dbPath: string | undefined;
  let sessionId: string | undefined;
  let incognito = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--model":
      case "-m":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        modelName = args[++i];
        break;
      case "--memory-model":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        memoryModelName = args[++i];
        break;
      case "--provider":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        providerFlag = args[++i];
        break;
      case "--incognito":
      case "-i":
        incognito = true;
        break;
      case "--workdir":
      case "-w":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        workDir = expandHomeDir(args[++i]!);
        break;
      case "--system-prompt":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        systemInstructions = args[++i];
        break;
      case "--system-prompt-file":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        systemPromptFiles = [...(systemPromptFiles ?? []), args[++i]!];
        break;
      case "--no-system-prompt-files":
        systemPromptFiles = [];
        break;
      case "--env-file":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        envFilePath = args[++i];
        break;
      case "--db":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        dbPath = args[++i];
        break;
      case "--session":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        sessionId = args[++i];
        break;
      case "--no-skill-sync":
        // Deprecated no-op; tolerated so host scripts that pass it do not break.
        break;
      case "--no-auto-upgrade":
        // Accepted as a no-op: RPC mode never auto-upgrades, so the flag is
        // already true here. Tolerated so host scripts that forward run-mode
        // flags into `--rpc` invocations do not break.
        break;
      case "--rpc":
        // The dispatcher in cli.ts passes the full argv through; swallow the
        // routing flag here so it does not look like an unknown option.
        break;
      default:
        if (args[i]?.startsWith("-")) fail(`Unknown option: ${args[i]}`);
        fail(`Unexpected positional argument: ${args[i]}. RPC mode reads commands from stdin.`);
    }
  }

  if (providerFlag) {
    if (modelName || memoryModelName) {
      fail("--provider cannot be combined with --model or --memory-model");
    }
    const provider = resolveProviderShorthand(providerFlag);
    if (!provider) {
      fail(`Unknown provider: ${providerFlag}. Accepted values: ${PROVIDER_SHORTHANDS.join(", ")}`);
    }
    modelName = pinnedDefaultModel(provider);
    memoryModelName = pinnedMemoryModel(provider);
  }

  return {
    ...(modelName ? { modelName } : {}),
    ...(memoryModelName ? { memoryModelName } : {}),
    workDir,
    ...(systemInstructions ? { systemInstructions } : {}),
    ...(systemPromptFiles ? { systemPromptFiles } : {}),
    ...(envFilePath ? { envFilePath } : {}),
    ...(dbPath ? { dbPath } : {}),
    ...(sessionId ? { sessionId } : {}),
    incognito,
  };
}

export interface DriveRpcLoopOptions {
  /**
   * Sink for {@link TurnSystemEvent}s the loop emits when a command is
   * unusable (premature command before start, second start, unknown
   * command type). Defaults to a no-op so unit tests that do not care
   * about soft errors stay terse. The CLI wires this to stdout so hosts
   * see the same event stream they get from the runner.
   */
  emit?: (event: TurnSystemEvent | RpcCommandAcceptedEvent) => void;
}

/**
 * RPC dispatch loop. Drives one turn chain to completion and returns once
 * the chain's single terminal event has been emitted (or stdin closes).
 *
 * Soft protocol errors are emitted as `TurnSystemEvent`s via `options.emit`
 * and the loop keeps reading; the chain still ends on its terminal, so
 * `duet --rpc` remains the one place that decides when the process is safe
 * to tear down.
 *
 * Out-of-band commands (`interrupt`, `edit_follow_up_queue`, `compact`) and additional
 * turn-driving commands (`prompt`, `answer`, `wake`) are all forwarded to
 * the runner whether or not a chain is already in flight — the runner is
 * the source of truth for how repeated `turn()` calls compose.
 */
export async function driveRpcLoop(
  runner: RpcRunner,
  commands: AsyncIterable<RpcRunnerCommand>,
  options: DriveRpcLoopOptions = {},
): Promise<void> {
  const emit = options.emit ?? (() => {});
  const reportError = (message: string): void => {
    emit({ type: "system", level: "error", message });
  };
  const iterator = commands[Symbol.asyncIterator]();
  const CHAIN_SETTLED: IteratorResult<RpcRunnerCommand> = { done: true, value: undefined };

  let started = false;
  let chain: Promise<TurnTerminalEvent> | undefined;
  let chainSettled: Promise<IteratorResult<RpcRunnerCommand>> | undefined;
  let chainDone = false;

  while (true) {
    // Race stdin against the active chain so the loop wakes immediately
    // when the terminal lands. `chainSettled` resolves on both fulfillment
    // and rejection so a rejected chain never crashes the race; the
    // rejection still surfaces through the final `await chain` below.
    const next = chainSettled
      ? await Promise.race([iterator.next(), chainSettled])
      : await iterator.next();
    if (chainDone) break;
    if (next.done) break;

    const command = next.value;

    if (!started) {
      if (command.type !== "start") {
        // Out-of-band commands before start are not actionable: the
        // runner cannot accept them yet. Surface a soft error and keep
        // waiting for a real start command instead of killing the
        // process — the host may have buffered stale stdin from a
        // previous session.
        reportError(
          `RPC command "${command.type}" received before "start"; ignoring. The first command must be "start".`,
        );
        continue;
      }
      await runner.start(command);
      started = true;
      continue;
    }

    switch (command.type) {
      case "start":
        reportError("RPC runner already started; ignoring duplicate start command.");
        break;
      case "interrupt":
        runner.interrupt(command);
        break;
      case "edit_follow_up_queue":
        runner.editFollowUpQueue(command);
        break;
      case "compact":
        // Compact runs an async drain + horizon advance. Awaiting it
        // here serializes the RPC loop behind the drain so the next
        // prompt observes the freshly trimmed wire-tail.
        await runner.compact(command);
        break;
      case "prompt":
      case "answer":
      case "wake": {
        // The runner is the source of truth for command composition.
        // The first turn-driving command launches the chain; later ones
        // join it via the runner's own queueing. turn() returns the same
        // activeTurnPromise for the whole chain, so we only track the
        // first promise and let the runner serialize everything else.
        const { requestId, ...runnerCommand } = command;
        const promise = runner.turn(runnerCommand, () => {
          emit({ type: "command_accepted", requestId, commandType: command.type });
        });
        if (!chain) {
          chain = promise;
          const onSettle = (): IteratorResult<RpcRunnerCommand> => {
            chainDone = true;
            return CHAIN_SETTLED;
          };
          chainSettled = chain.then(onSettle, onSettle);
        }
        break;
      }
      default: {
        const unknown = command as { type?: unknown };
        reportError(`Unknown RPC command type: ${JSON.stringify(unknown.type)}. Ignoring command.`);
      }
    }
  }

  // Terminal means terminal: tear down the stdin reader so process exit never
  // depends on the host closing its end of the pipe (D2 — the sandbox reaps at
  // the first terminal). A pending iterator.next() parked on stdin would make
  // an awaited iterator.return() queue behind it forever, so destroy the
  // stream (settling the pending read) and let the generator finalize
  // asynchronously.
  process.stdin.destroy();
  void iterator.return?.(undefined);

  if (chain) await chain;
}

/**
 * Async iterator over newline-delimited {@link RpcRunnerCommand} values
 * read from stdin. Blank lines are skipped. Malformed JSON or commands
 * without a `type` field are surfaced through {@link emit} as a soft
 * {@link TurnSystemEvent} and skipped; the iterator never aborts the
 * process, so a bad line cannot kill an in-flight turn.
 */
async function* readStdinCommands(
  emit: (event: TurnSystemEvent) => void,
): AsyncGenerator<RpcRunnerCommand> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const rawLine of rl) {
      const result = parseRpcCommandLine(rawLine);
      if (result.kind === "command") yield result.command;
      else if (result.kind === "error") {
        emit({ type: "system", level: "error", message: result.message });
      }
    }
  } finally {
    rl.close();
  }
}

/**
 * Discriminated outcome of parsing one stdin line. The dispatch loop
 * forwards `error` results to its emit sink and skips `skip` results so a
 * single bad line never propagates a thrown exception across the loop
 * boundary or terminates the process.
 */
export type ParseRpcCommandLineResult =
  | { kind: "command"; command: RpcRunnerCommand }
  | { kind: "error"; message: string }
  | { kind: "skip" };

/**
 * Parse one stdin line. Blank/whitespace-only lines return `{ kind: "skip" }`
 * so the iterator can drop them silently; malformed JSON or commands without
 * a string `type` field return `{ kind: "error" }` so the caller can surface
 * a `TurnSystemEvent` to the host and keep reading.
 */
export function parseRpcCommandLine(rawLine: string): ParseRpcCommandLineResult {
  const line = rawLine.trim();
  if (!line) return { kind: "skip" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return {
      kind: "error",
      message: `Invalid RPC command JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { type?: unknown }).type !== "string"
  ) {
    return {
      kind: "error",
      message: `RPC command must be an object with a string "type"; received: ${line}`,
    };
  }
  const commandType = (parsed as { type: string }).type;
  if (
    (commandType === "prompt" || commandType === "answer" || commandType === "wake") &&
    (typeof (parsed as { requestId?: unknown }).requestId !== "string" ||
      (parsed as { requestId: string }).requestId.trim().length === 0)
  ) {
    return {
      kind: "error",
      message: `RPC command "${commandType}" requires a non-empty string "requestId".`,
    };
  }
  return { kind: "command", command: parsed as RpcRunnerCommand };
}
