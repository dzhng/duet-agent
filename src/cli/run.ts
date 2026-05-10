import { createInterface } from "node:readline/promises";
import { shimDuetApiKeyToAiGateway } from "../model-resolution/duet-gateway.js";
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
import { SessionManager } from "../session/session-manager.js";
import { runTui } from "../tui/app.js";
import type { TurnRunnerConfig } from "../types/config.js";
import { DEFAULT_RESUME_HISTORY_LINES, printRunHelp } from "./help.js";
import { resumeCommand } from "./resume-hint.js";
import { fail, isInteractive, loadCliEnvFiles, parseResumeHistoryLines } from "./shared.js";
import { installShutdownHandlers } from "./shutdown.js";
import { getNewVersionNotice } from "./version-check.js";

export interface CliTurnConfigInput {
  modelName?: string;
  memoryModelName?: string;
  incognito?: boolean;
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
 * Decide whether to render the interactive TUI vs JSONL events.
 *
 * Supplying a prompt argument selects JSONL so one-shot runs have a stable
 * machine-readable contract by default; an explicit `--json` always wins.
 */
export function shouldUseTui(input: {
  interactive: boolean;
  jsonOutput: boolean;
  prompt?: string;
}): boolean {
  return input.interactive && !input.jsonOutput && !input.prompt;
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
      ...(input.incognito ? { memoryDbPath: false } : {}),
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
  let resumeHistoryLines = DEFAULT_RESUME_HISTORY_LINES;
  let resumeHistoryLinesExplicit = false;
  let jsonOutput = false;
  let envFilePath: string | undefined;
  let incognito = false;
  const promptParts: string[] = [];
  const interactive = isInteractive();

  // Kick off the npm registry probe immediately so it overlaps with env
  // loading, model resolution, skill discovery, and session bootstrap. JSON
  // callers await the result; the TUI path only consumes it if it has already
  // settled by the time we render, so a slow registry never delays first paint.
  const versionNoticePromise = getNewVersionNotice(pkg.name, pkg.version).catch(() => undefined);

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
      case "--resume":
      case "-r":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        resumeSessionId = args[++i];
        break;
      case "--resume-history-lines":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        try {
          resumeHistoryLines = parseResumeHistoryLines(args[++i]!, args[i - 1]!);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
        resumeHistoryLinesExplicit = true;
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
      case "--json":
        jsonOutput = true;
        break;
      case "--env-file":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        envFilePath = args[++i];
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

  let prompt = promptParts.join(" ");

  // Read from stdin if no prompt is provided
  if (!prompt && !interactive) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    prompt = Buffer.concat(chunks).toString("utf-8").trim();
  }

  if (!prompt && jsonOutput && interactive) {
    prompt = await readInteractivePrompt();
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
  shimDuetApiKeyToAiGateway();

  // Refresh the gateway-managed default skills when the user has previously
  // opted in via `duet login` (i.e. `~/.duet/.skills-hash` exists). Logging
  // in with --skip-skill-sync leaves no hash, so this stays a no-op until
  // the user explicitly syncs at least once. The conditional GET hits 304
  // in steady state, so the cost is one cheap round-trip.
  if (process.env.DUET_API_KEY) {
    await maybeAutoSyncDefaultSkills({ apiKey: process.env.DUET_API_KEY });
  }

  const { config, modelResolution, memoryModelResolution } = buildCliTurnConfig(
    {
      ...(modelName ? { modelName } : {}),
      ...(memoryModelName ? { memoryModelName } : {}),
      incognito,
      workDir,
      ...(systemInstructions ? { systemInstructions } : {}),
      ...(systemPromptFiles ? { systemPromptFiles } : {}),
    },
    dotenvKeys,
  );
  modelName = modelResolution.modelName;
  memoryModelName = memoryModelResolution.modelName;

  const useTui = shouldUseTui({ interactive, jsonOutput, prompt });
  const useJson = !useTui;

  // JSON consumers are already waiting for stderr output, so blocking on the
  // probe is fine. The TUI never blocks here — it consumes the promise
  // directly and swaps in the notice once the probe settles.
  if (useJson) {
    const newVersionNotice = await versionNoticePromise;
    if (newVersionNotice) process.stderr.write(`${newVersionNotice}\n`);
    process.stderr.write(`Model: ${modelName}\n`);
    process.stderr.write(`Source: ${describeModelResolution(modelResolution)}\n`);
    process.stderr.write(`Memory model: ${memoryModelName}\n`);
    process.stderr.write(`Memory source: ${describeModelResolution(memoryModelResolution)}\n`);
  }

  const manager = new SessionManager(config);
  manager.subscribe(({ event }) => {
    if (useJson) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
  });

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

    if (useTui) {
      await runTui({
        session,
        ...(resumedHistory ? { history: resumedHistory } : {}),
        resumeHistoryLines,
        modelName,
        modelSource: describeModelResolution(modelResolution),
        memoryModelName,
        memoryModelSource: describeModelResolution(memoryModelResolution),
        workDir,
        sessionId: session.id,
        packageVersion: pkg.version,
        versionNoticePromise,
      });
    }

    process.stderr.write(
      `To resume this session:\n${resumeCommand(session.id, {
        ...(modelName ? { modelName } : {}),
        ...(memoryModelName ? { memoryModelName } : {}),
        workDir,
        incognito,
        ...(systemInstructions ? { systemInstructions } : {}),
        ...(systemPromptFiles ? { systemPromptFiles } : {}),
        ...(envFilePath ? { envFilePath } : {}),
        ...(resumeHistoryLinesExplicit ? { resumeHistoryLines } : {}),
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

/**
 * Read a single prompt from stdin when --json is set in an interactive
 * terminal and no prompt was supplied via argv. Loops until the user
 * provides non-empty input.
 */
async function readInteractivePrompt(): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    let prompt = "";
    while (!prompt) {
      prompt = (await rl.question("> ")).trim();
    }
    return prompt;
  } finally {
    rl.close();
  }
}
