import { createInterface } from "node:readline";
import {
  pinnedDefaultModel,
  pinnedMemoryModel,
  PROVIDER_SHORTHANDS,
  resolveProviderShorthand,
} from "../model-resolution/catalog.js";
import { maybeAutoSyncDefaultSkills } from "../lib/sync-skills.js";
import { TurnRunner } from "../turn-runner/turn-runner.js";
import type {
  TurnCompactCommand,
  TurnEditFollowUpQueueCommand,
  TurnEvent,
  TurnInterruptCommand,
  TurnRunnerCommand,
  TurnSystemEvent,
  TurnTerminalEvent,
} from "../types/protocol.js";
import type { PackageMetadata } from "./run.js";
import { buildCliTurnConfig } from "./run.js";
import { expandHomeDir, fail, loadCliEnvFiles } from "./shared.js";
import { installShutdownHandlers } from "./shutdown.js";

/**
 * Minimal contract the RPC loop expects from a turn runner. The full
 * {@link TurnRunner} satisfies it; tests pass a stub so the dispatch loop
 * can be exercised without spinning up real models or memory.
 */
export interface RpcRunner {
  start(command: Extract<TurnRunnerCommand, { type: "start" }>): Promise<unknown>;
  turn(
    command: Extract<TurnRunnerCommand, { type: "prompt" | "answer" | "wake" }>,
  ): Promise<TurnTerminalEvent>;
  interrupt(command: TurnInterruptCommand): void;
  editFollowUpQueue(command: TurnEditFollowUpQueueCommand): void;
  compact(command: TurnCompactCommand): void | Promise<void>;
}

/**
 * `duet --rpc` — bare turn-runner control surface.
 *
 * Reads newline-delimited JSON {@link TurnRunnerCommand} values from stdin and
 * writes newline-delimited {@link import("../types/protocol.js").TurnEvent}
 * values to stdout. The first command must be `start`; the runner emits
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
 * no session ids, no `state.json`, no resume hints. Persistence policy lives
 * with the caller. Memory still works regardless of session: `--incognito`
 * keeps it in-process, otherwise it persists to the configured memory db.
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

  // Refresh gateway-managed default skills when the user has previously
  // opted in via `duet login`. Skipped when the caller passes
  // --no-skill-sync (e.g. a sandbox host that already manages its own skill
  // bundle). Conditional GET keeps the steady-state cost to a single 304
  // round-trip.
  if (process.env.DUET_API_KEY && !parsed.noSkillSync) {
    await maybeAutoSyncDefaultSkills({ apiKey: process.env.DUET_API_KEY });
  }

  const { config } = buildCliTurnConfig(
    {
      ...(parsed.modelName ? { modelName: parsed.modelName } : {}),
      ...(parsed.memoryModelName ? { memoryModelName: parsed.memoryModelName } : {}),
      incognito: parsed.incognito,
      ...(parsed.dbPath ? { dbPath: parsed.dbPath } : {}),
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
  const writeEvent = (event: TurnEvent): void => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };
  runner.subscribe(writeEvent);

  // Without these handlers, an unhandled rejection or uncaught exception
  // anywhere in start()/turn() setup (memory load, skill load, state
  // hydration, MCP connect) kills the process under Node's default policy
  // with no terminal event written and nothing on stderr. Hosts then see
  // `code=null stderr=` and have no way to surface a real error to the
  // user. Emit a system error event with the cause, then — if the runner
  // already has a hydrated state — also emit a `complete` terminal so the
  // host can settle the in-flight turn cleanly. The system event alone is
  // the floor; the terminal is best-effort because TurnCompletedEvent
  // requires `state`, which doesn't exist if we died before `start()`
  // finished hydrating.
  const emitFatalAndExit = (reason: unknown): void => {
    const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    try {
      writeEvent({ type: "system", level: "error", message: `fatal: ${message}` });
      const state = runner.getState();
      if (state) {
        writeEvent({ type: "complete", status: "failed", error: message, state });
      }
    } catch {
      // stdout may be closed if the parent already gave up on us; nothing
      // useful to do at this point besides exiting.
    }
    process.exit(1);
  };
  process.on("unhandledRejection", emitFatalAndExit);
  process.on("uncaughtException", emitFatalAndExit);

  const removeShutdownHandlers = installShutdownHandlers(() => runner.dispose());

  try {
    await driveRpcLoop(runner, readStdinCommands(writeEvent), { emit: writeEvent });
  } finally {
    removeShutdownHandlers();
    await runner.dispose();
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
   * `buildCliTurnConfig` falls back to the shared `~/.duet/memory.db`
   * default so RPC mode persists memory just like the TUI/run path.
   */
  dbPath?: string;
  incognito: boolean;
  /** When true, skip the on-load default-skill sync. */
  noSkillSync: boolean;
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
  let incognito = false;
  let noSkillSync = false;

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
      case "--no-skill-sync":
        noSkillSync = true;
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
    incognito,
    noSkillSync,
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
  emit?: (event: TurnSystemEvent) => void;
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
  commands: AsyncIterable<TurnRunnerCommand>,
  options: DriveRpcLoopOptions = {},
): Promise<void> {
  const emit = options.emit ?? (() => {});
  const reportError = (message: string): void => {
    emit({ type: "system", level: "error", message });
  };
  const iterator = commands[Symbol.asyncIterator]();
  const CHAIN_SETTLED: IteratorResult<TurnRunnerCommand> = { done: true, value: undefined };

  let started = false;
  let chain: Promise<TurnTerminalEvent> | undefined;
  let chainSettled: Promise<IteratorResult<TurnRunnerCommand>> | undefined;
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
        const promise = runner.turn(command);
        if (!chain) {
          chain = promise;
          const onSettle = (): IteratorResult<TurnRunnerCommand> => {
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

  if (chain) await chain;
}

/**
 * Async iterator over newline-delimited {@link TurnRunnerCommand} values
 * read from stdin. Blank lines are skipped. Malformed JSON or commands
 * without a `type` field are surfaced through {@link emit} as a soft
 * {@link TurnSystemEvent} and skipped; the iterator never aborts the
 * process, so a bad line cannot kill an in-flight turn.
 */
async function* readStdinCommands(
  emit: (event: TurnSystemEvent) => void,
): AsyncGenerator<TurnRunnerCommand> {
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
  | { kind: "command"; command: TurnRunnerCommand }
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
  return { kind: "command", command: parsed as TurnRunnerCommand };
}
