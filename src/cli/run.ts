import { maybeAutoSyncDefaultSkills } from "../lib/sync-skills.js";
import {
  pinnedDefaultModel,
  pinnedMemoryModel,
  PROVIDER_SHORTHANDS,
  resolveProviderShorthand,
} from "../model-resolution/catalog.js";
import {
  describeModelResolution,
  resolveCliMemoryModel,
  resolveCliModel,
  type ModelResolution,
} from "../model-resolution/resolver.js";
import { DEFAULT_MEMORY_DB_PATH, SessionManager } from "../session/session-manager.js";
import { runTui } from "../tui/app.js";
import { applyInlineSlashCommandsToCliConfig } from "./inline-slash.js";
import type { TurnRunnerConfig } from "../types/config.js";
import { DEFAULT_RESUME_HISTORY_MESSAGES, printRunHelp } from "./help.js";
import { resumeCommand } from "./resume-hint.js";
import {
  expandHomeDir,
  fail,
  isInteractive,
  loadCliEnvFiles,
  parseResumeHistoryMessages,
} from "./shared.js";
import { installShutdownHandlers } from "./shutdown.js";
import {
  createUpgradeStatusStream,
  describeUpgradeStatus,
  runAutoUpgrade,
} from "./auto-upgrade.js";

export interface CliTurnConfigInput {
  modelName?: string;
  memoryModelName?: string;
  incognito?: boolean;
  /**
   * Explicit memory database file path. When omitted, the config falls back
   * to {@link DEFAULT_MEMORY_DB_PATH} (`~/.duet/memory.db`). Ignored when
   * `incognito` is true, which forces `memoryDbPath: false`.
   */
  dbPath?: string;
  /**
   * Caller-owned session id used to attribute memory writes. The TUI path
   * sets it from the active `SessionManager` session; `duet --rpc` sets it
   * from the `--session <id>` spawn flag. When set, every observation written
   * during the process carries this id as its `session_id`, which is the axis
   * session-scoped recall filters on.
   */
  sessionId?: string;
  workDir: string;
  systemInstructions?: string;
  systemPromptFiles?: string[];
}

export interface CliTurnConfigResolution {
  config: TurnRunnerConfig;
  modelResolution: ModelResolution;
  memoryModelResolution: ModelResolution;
}

export interface PackageMetadata {
  name: string;
  version: string;
}

/**
 * Decide whether to render the interactive TUI vs the one-shot streaming
 * path. The TUI runs only when the terminal is interactive and the caller
 * did not supply a prompt argument; otherwise we run a single turn against
 * the SessionManager and exit when it settles.
 */
export function shouldUseTui(input: { interactive: boolean; prompt?: string }): boolean {
  return input.interactive && !input.prompt;
}

/**
 * Build the {@link TurnRunnerConfig} the CLI hands to the SessionManager,
 * along with the resolutions used to render model provenance lines.
 */
export function buildCliTurnConfig(
  input: CliTurnConfigInput,
  dotenvKeys: Set<string>,
): CliTurnConfigResolution {
  const modelResolution = resolveCliModel(input.modelName, dotenvKeys);
  const memoryModelResolution = resolveCliMemoryModel(input.memoryModelName, dotenvKeys);

  return {
    config: {
      model: modelResolution.modelName,
      memoryModel: memoryModelResolution.modelName,
      memoryDbPath: input.incognito ? false : (input.dbPath ?? DEFAULT_MEMORY_DB_PATH),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      cwd: input.workDir,
      ...(input.systemInstructions ? { systemInstructions: input.systemInstructions } : {}),
      ...(input.systemPromptFiles ? { systemPromptFiles: input.systemPromptFiles } : {}),
    },
    modelResolution,
    memoryModelResolution,
  };
}

/**
 * Default `duet` invocation: parse flags, load env files, build the config,
 * decide TUI vs JSON output, then drive the SessionManager through one
 * session. Prints a resume hint at the end whether the session terminated
 * cleanly or not.
 */
export async function runRunCommand(args: string[], pkg: PackageMetadata): Promise<void> {
  let modelName: string | undefined;
  let memoryModelName: string | undefined;
  // Raw value of --provider so we can both pin the default model below and
  // surface a clearer error if --model was also passed.
  let providerFlag: string | undefined;
  let workDir = process.cwd();
  let resumeSessionId: string | undefined;
  let systemInstructions: string | undefined;
  let systemPromptFiles: string[] | undefined;
  let resumeHistoryMessages = DEFAULT_RESUME_HISTORY_MESSAGES;
  let resumeHistoryMessagesExplicit = false;
  let envFilePath: string | undefined;
  let dbPath: string | undefined;
  let incognito = false;
  let noAutoUpgrade = false;
  let noSkillSync = false;
  const promptParts: string[] = [];
  const interactive = isInteractive();

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
      case "--resume":
      case "-r":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        resumeSessionId = args[++i];
        break;
      case "--resume-history-messages":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        try {
          resumeHistoryMessages = parseResumeHistoryMessages(args[++i]!, args[i - 1]!);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
        resumeHistoryMessagesExplicit = true;
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
      case "--no-auto-upgrade":
        noAutoUpgrade = true;
        break;
      case "--no-skill-sync":
        noSkillSync = true;
        break;
      case "--version":
      case "-v":
        console.log(pkg.version);
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      case "--help":
      case "-h":
        printRunHelp(pkg.name);
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        if (args[i]?.startsWith("-")) {
          fail(`Unknown option: ${args[i]}`);
        }
        promptParts.push(args[i]!);
    }
  }

  // `let prompt: string | undefined` so the inline-slash applier can
  // unset it when the whole prompt was just slash commands (e.g.
  // `duet "/model X"`) — mirrors the TUI's whole-message dispatcher
  // skipping the agent turn entirely.
  let prompt: string | undefined = promptParts.join(" ");

  // Read from stdin if no prompt is provided
  if (!prompt && !interactive) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    prompt = Buffer.concat(chunks).toString("utf-8").trim();
  }

  if (!prompt && !resumeSessionId && !interactive) {
    console.error("Usage: duet <prompt>");
    console.error('  e.g., duet "build a todo app"');
    process.exit(1);
  }

  if (providerFlag) {
    if (modelName || memoryModelName) {
      fail("--provider cannot be combined with --model or --memory-model");
    }
    const provider = resolveProviderShorthand(providerFlag);
    if (!provider) {
      fail(`Unknown provider: ${providerFlag}. Accepted values: ${PROVIDER_SHORTHANDS.join(", ")}`);
    }
    // Pin both the chat and memory models to this provider's catalog entry
    // so resolution skips the env-var inference that would otherwise pick
    // a different provider when multiple keys are present.
    modelName = pinnedDefaultModel(provider);
    memoryModelName = pinnedMemoryModel(provider);
  }

  const dotenvKeys = loadCliEnvFiles(workDir, envFilePath);

  // Probe the registry and (if newer) run the package manager in-process
  // while the TUI is already mounted. The TUI subscribes to upgradeStatus$
  // to render a live header line; the JSON path awaits the final status
  // and prints one summary line to stderr.
  //
  // Auto-upgrade is gated on having a TTY: non-interactive invocations
  // (e.g. `duet <prompt>` exec'd by a sandbox terminal channel) often get
  // their whole process tree torn down as soon as the command "finishes",
  // which kills the detached npm child mid-rename and leaves the global
  // node_modules tree in a partial state (`@duetso/.agent-<random>`
  // staging dirs with no `agent` symlink).
  const nonInteractive = !process.stdin.isTTY && !process.stdout.isTTY;
  const upgradeStatus$ = createUpgradeStatusStream();
  const upgradePromise = runAutoUpgrade({
    packageName: pkg.name,
    currentVersion: pkg.version,
    disabled: noAutoUpgrade || nonInteractive,
    onStatus: (status) => upgradeStatus$.publish(status),
  }).then((status) => {
    upgradeStatus$.complete(status);
    return status;
  });

  // Refresh the gateway-managed default skills when the user has previously
  // opted in via `duet login` (i.e. `~/.duet/.skills-hash` exists). Logging
  // in with --skip-skill-sync leaves no hash, so this stays a no-op until
  // the user explicitly syncs at least once. The conditional GET hits 304
  // in steady state, so the cost is one cheap round-trip.
  //
  // Awaited (not backgrounded): the parent agent's system prompt captures the
  // skill set at session start, so the sync must finish before the session
  // starts or the agent runs the whole session unaware of the synced skills.
  if (process.env.DUET_API_KEY && !noSkillSync) {
    await maybeAutoSyncDefaultSkills({ apiKey: process.env.DUET_API_KEY });
  }

  const { config, modelResolution, memoryModelResolution } = buildCliTurnConfig(
    {
      ...(modelName ? { modelName } : {}),
      ...(memoryModelName ? { memoryModelName } : {}),
      incognito,
      ...(dbPath ? { dbPath } : {}),
      workDir,
      ...(systemInstructions ? { systemInstructions } : {}),
      ...(systemPromptFiles ? { systemPromptFiles } : {}),
    },
    dotenvKeys,
  );
  modelName = modelResolution.modelName;
  memoryModelName = memoryModelResolution.modelName;

  const useTui = shouldUseTui({ interactive, prompt });

  // Apply inline `/model` and `/thinking` commands embedded in the
  // non-TUI one-shot prompt before we hand the prompt to the session.
  // The prompt text itself is passed through to the agent verbatim,
  // mirroring how the TUI keeps the slash form in the message and how
  // `/skill-name` references survive the dispatch.
  if (!useTui && prompt) {
    const { residue } = applyInlineSlashCommandsToCliConfig(prompt, config, (line) =>
      process.stderr.write(line),
    );
    // Sync the cached display name so the boot summary lines reflect any
    // inline override; the resolver source is unchanged because the
    // inline form is logically equivalent to `--model`.
    modelName = config.model ?? modelName;
    // Dispatch the prompt with the slash forms stripped out. When the
    // whole prompt was just slash commands (e.g. `duet "/model X"`),
    // the residue is empty and we skip the agent turn entirely —
    // mirrors the TUI's whole-message dispatcher returning before
    // reaching dispatchTurn.
    prompt = residue.length > 0 ? residue : undefined;
  }

  // One-shot consumers want a single summary line, not a streaming status.
  // Await the final upgrade status and print the human-readable form (if any)
  // before the regular boot lines. The TUI subscribes to the live stream
  // instead and renders intermediate "Checking…/Updating…" states inline.
  if (!useTui) {
    const finalStatus = await upgradePromise;
    const notice = describeUpgradeStatus(pkg.name, finalStatus);
    if (notice) process.stderr.write(`${notice}\n`);
    process.stderr.write(`Model: ${modelName}\n`);
    process.stderr.write(`Source: ${describeModelResolution(modelResolution)}\n`);
    process.stderr.write(`Memory model: ${memoryModelName}\n`);
    process.stderr.write(`Memory source: ${describeModelResolution(memoryModelResolution)}\n`);
  }

  const manager = new SessionManager(config);
  if (!useTui) {
    // Non-TUI runs (one-shot prompt, piped stdin) stream events as JSONL so
    // CI scripts can parse them. The TUI subscribes to its own rendering
    // pipeline and has no use for stdout JSONL.
    manager.subscribe(({ event }) => {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    });
  }

  // Ensure PGlite gets a chance to flush its WAL on Ctrl+C / SIGTERM. The
  // `finally` block below handles normal returns and thrown errors, but
  // signals bypass it and would otherwise leave the memory database dirty.
  const removeShutdownHandlers = installShutdownHandlers(() => manager.dispose());

  try {
    const session = resumeSessionId
      ? manager.resume(resumeSessionId)
      : manager.create({
          ...(config.mode ? { mode: config.mode } : {}),
          ...(useTui || !prompt ? {} : { prompt }),
        });
    let resumedHistory: import("@earendil-works/pi-agent-core").AgentMessage[] | undefined;

    if (resumeSessionId) {
      // Force-load the persisted state.json so setup hands the resumed
      // state to the runner and any TUI history replays before new turns.
      await session.hydrate();
      if (!session.getState()) {
        throw new Error(`Unknown session: ${resumeSessionId}`);
      }
      // Setup runs against the hydrated state; manager.create() already
      // dispatched setup for fresh sessions.
      await session.start();
      resumedHistory = session.getState()?.agent.messages;
    }

    if (prompt && resumeSessionId) {
      await session.prompt({ message: prompt });
      await session.waitForTerminal();
    } else if (prompt && !resumeSessionId) {
      await session.waitForTerminal();
    }

    // Live session pointer for the TUI loop below. Starts as the boot-time
    // session (fresh or `--resume <id>`-hydrated) and gets re-pointed each
    // time the user picks a "pick up the thread" row in the starter menu.
    // Same code path as `--resume <id>` from the command line: dispose the
    // current session, `manager.resume(newId)` + `hydrate()` + `start()`,
    // re-enter `runTui` with the hydrated session and its message history.
    let activeSession = session;
    let activeHistory = resumedHistory;
    let activeIsResume = Boolean(resumeSessionId);

    if (useTui) {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let pendingResumeSessionId: string | undefined;
        let pendingClear = false;
        await runTui({
          session: activeSession,
          ...(activeHistory ? { history: activeHistory } : {}),
          ...(activeIsResume ? { isResume: true } : {}),
          onResumeRequest: (id: string) => {
            pendingResumeSessionId = id;
          },
          onClearRequest: () => {
            pendingClear = true;
          },
          resumeHistoryMessages,
          modelName,
          modelSource: describeModelResolution(modelResolution),
          memoryModelName,
          memoryModelSource: describeModelResolution(memoryModelResolution),
          workDir,
          sessionId: activeSession.id,
          packageName: pkg.name,
          packageVersion: pkg.version,
          upgradeStatus$,
        });

        if (pendingClear) {
          // `/clear` from the slash dispatcher: drop the current session
          // (flushing state.json) and start a fresh one. The new session
          // boots with starters visible — same as launching `duet`
          // without `--resume`.
          await activeSession.dispose();
          activeSession = manager.create(config.mode ? { mode: config.mode } : {});
          activeHistory = undefined;
          activeIsResume = false;
          continue;
        }

        if (!pendingResumeSessionId) break;

        // User picked a recent session from the starter menu. Swap the
        // placeholder for the requested session: dispose first so its
        // state.json gets flushed, then hydrate the resume target so
        // `agent.messages` is available for transcript replay.
        await activeSession.dispose();
        activeSession = manager.resume(pendingResumeSessionId);
        await activeSession.hydrate();
        if (!activeSession.getState()) {
          throw new Error(`Unknown session: ${pendingResumeSessionId}`);
        }
        await activeSession.start();
        activeHistory = activeSession.getState()?.agent.messages;
        activeIsResume = true;
      }
    }

    process.stderr.write(
      `To resume this session:\n${resumeCommand(activeSession.id, {
        ...(modelName ? { modelName } : {}),
        ...(memoryModelName ? { memoryModelName } : {}),
        workDir,
        incognito,
        ...(dbPath ? { dbPath } : {}),
        ...(systemInstructions ? { systemInstructions } : {}),
        ...(systemPromptFiles ? { systemPromptFiles } : {}),
        ...(envFilePath ? { envFilePath } : {}),
        ...(resumeHistoryMessagesExplicit ? { resumeHistoryMessages } : {}),
      })}\n`,
    );
  } catch (err: any) {
    console.error(`Fatal: ${err.message}`);
    process.exitCode = 1;
  } finally {
    removeShutdownHandlers();
    await manager.dispose();
  }
}
