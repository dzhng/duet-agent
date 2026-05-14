import { createInterface } from "node:readline";
import { shimDuetApiKeyToAiGateway } from "../model-resolution/duet-gateway.js";
import {
  pinnedDefaultModel,
  pinnedMemoryModel,
  PROVIDER_SHORTHANDS,
  resolveProviderShorthand,
} from "../model-resolution/catalog.js";
import { maybeAutoSyncDefaultSkills } from "../lib/sync-skills.js";
import { TurnRunner } from "../turn-runner/turn-runner.js";
import type {
  TurnEditFollowUpQueueCommand,
  TurnInterruptCommand,
  TurnRunnerCommand,
  TurnTerminalEvent,
} from "../types/protocol.js";
import type { PackageMetadata } from "./run.js";
import { buildCliTurnConfig } from "./run.js";
import { fail, loadCliEnvFiles } from "./shared.js";
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
}

/**
 * `duet --rpc` — bare turn-runner control surface.
 *
 * Reads newline-delimited JSON {@link TurnRunnerCommand} values from stdin and
 * writes newline-delimited {@link import("../types/protocol.js").TurnEvent}
 * values to stdout. The first command must be `start`; the runner emits
 * `turn_started` and then waits for a turn-driving command (`prompt`,
 * `answer`, or `wake`). The process exits as soon as the runner emits the
 * terminal event for that single turn, so callers that want to drive more
 * turns reuse the returned `state` by launching a fresh `--rpc` process
 * with `start.state` set.
 *
 * Unlike the TUI path, RPC mode bypasses {@link SessionManager} entirely:
 * no session ids, no `state.json`, no resume hints. Persistence policy lives
 * with the caller. Memory still works regardless of session: `--incognito`
 * keeps it in-process, otherwise it persists to the configured memory db.
 */
export async function runRpcCommand(args: string[], pkg: PackageMetadata): Promise<void> {
  const parsed = parseRpcArgs(args);
  const dotenvKeys = loadCliEnvFiles(parsed.workDir, parsed.envFilePath);
  shimDuetApiKeyToAiGateway();

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
  runner.subscribe((event) => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  });

  const removeShutdownHandlers = installShutdownHandlers(() => runner.dispose());

  try {
    await driveRpcLoop(runner, readStdinCommands());
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
        workDir = args[++i]!;
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
    incognito,
    noSkillSync,
  };
}

/**
 * One-turn RPC lifecycle:
 *
 * 1. Wait for a `start` command, hand it to the runner.
 * 2. Pump remaining stdin commands concurrently with `runner.turn`. The
 *    turn-driving command (`prompt`, `answer`, `wake`) launches the turn;
 *    subsequent `interrupt` / `edit_follow_up_queue` commands flow into the
 *    runner while the turn is still in flight so callers can cancel or
 *    edit the follow-up queue without racing the stream.
 * 3. Resolve once the turn settles. Remaining stdin is drained but ignored;
 *    the lifecycle is one turn per process.
 *
 * Stdin closing before a turn-driving command arrives is a clean early exit:
 * the runner has nothing to do and the loop returns.
 */
export async function driveRpcLoop(
  runner: RpcRunner,
  commands: AsyncIterable<TurnRunnerCommand>,
): Promise<void> {
  const iterator = commands[Symbol.asyncIterator]();

  // Phase 1: start.
  const startResult = await iterator.next();
  if (startResult.done) return;
  const first = startResult.value;
  if (first.type !== "start") {
    fail(`First RPC command must be "start", received "${first.type}"`);
  }
  await runner.start(first);

  // Phase 2: read until a turn-driving command arrives, applying out-of-band
  // commands inline. `interrupt` and `edit_follow_up_queue` before a turn
  // command are surfaced to the runner immediately even though the runner
  // typically rejects them in that state; the runner is the source of truth
  // for that contract, not this loop.
  let turnPromise: Promise<TurnTerminalEvent> | undefined;
  while (!turnPromise) {
    const next = await iterator.next();
    if (next.done) return;
    const command = next.value;
    switch (command.type) {
      case "start":
        fail("RPC runner already started; only one start command is allowed");
        break;
      case "interrupt":
        runner.interrupt(command);
        break;
      case "edit_follow_up_queue":
        runner.editFollowUpQueue(command);
        break;
      case "prompt":
      case "answer":
      case "wake":
        turnPromise = runner.turn(command);
        break;
      default: {
        const exhaustive: never = command;
        fail(`Unknown RPC command type: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  // Phase 3: keep reading while the turn is in flight so the consumer can
  // interrupt or edit the follow-up queue mid-turn. Stop as soon as the
  // turn settles; further stdin is dropped because the lifecycle is one
  // turn per process.
  let turnDone = false;
  const settle = turnPromise.then(() => {
    turnDone = true;
  });
  while (!turnDone) {
    const next = await Promise.race([
      iterator.next(),
      settle.then(() => ({ done: true, value: undefined }) as IteratorResult<TurnRunnerCommand>),
    ]);
    if (next.done) break;
    const command = next.value;
    switch (command.type) {
      case "interrupt":
        runner.interrupt(command);
        break;
      case "edit_follow_up_queue":
        runner.editFollowUpQueue(command);
        break;
      case "start":
      case "prompt":
      case "answer":
      case "wake":
        fail(`RPC mode runs one turn per process; rejected extra "${command.type}" command`);
        break;
      default: {
        const exhaustive: never = command;
        fail(`Unknown RPC command type: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  await turnPromise;
}

/**
 * Async iterator over newline-delimited {@link TurnRunnerCommand} values
 * read from stdin. Blank lines are skipped; malformed JSON or commands
 * without a `type` field abort the process via {@link fail} so callers
 * see the error immediately instead of letting the runner reject them.
 */
async function* readStdinCommands(): AsyncGenerator<TurnRunnerCommand> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const rawLine of rl) {
      const command = parseRpcCommandLine(rawLine);
      if (command) yield command;
    }
  } finally {
    rl.close();
  }
}

/**
 * Parse one stdin line into a {@link TurnRunnerCommand}. Returns `undefined`
 * for blank lines so callers can skip them without a separate check. Exposed
 * so tests can feed the dispatch loop without going through stdin.
 */
export function parseRpcCommandLine(rawLine: string): TurnRunnerCommand | undefined {
  const line = rawLine.trim();
  if (!line) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    fail(`Invalid RPC command JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { type?: unknown }).type !== "string"
  ) {
    fail(`RPC command must be an object with a string "type"; received: ${line}`);
  }
  return parsed as TurnRunnerCommand;
}
