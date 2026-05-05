import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { Harness, type HarnessEventHandler } from "../harness/harness.js";
import type { HarnessConfig } from "../types/config.js";
import type {
  HarnessEvent,
  HarnessMode,
  HarnessSession,
  HarnessTerminalTurnEvent,
  HarnessTurnOptions,
} from "../types/protocol.js";

export interface OrchestratorRunInput {
  sessionId?: string;
  prompt: string;
  mode?: HarnessMode;
  options?: HarnessTurnOptions;
}

export interface OrchestratorRunResult {
  sessionId: string;
  terminal: HarnessTerminalTurnEvent;
}

export interface OrchestratorHarness {
  turn(command: Parameters<Harness["turn"]>[0]): Promise<HarnessTerminalTurnEvent>;
  subscribe(handler: HarnessEventHandler): () => void;
  dispose(): Promise<void>;
}

export interface OrchestratorOptions {
  harness?: OrchestratorHarness;
  sleep?: (ms: number) => Promise<void>;
  sessionStoragePath?: string;
}

export class Orchestrator {
  private readonly harness: OrchestratorHarness;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly sessionStoragePath: string;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private activeSessionId?: string;

  constructor(
    readonly config: HarnessConfig,
    options: OrchestratorOptions = {},
  ) {
    this.harness = options.harness ?? new Harness(config);
    this.sleep = options.sleep ?? ((ms) => this.defaultSleep(ms));
    this.sessionStoragePath =
      options.sessionStoragePath ?? join(config.cwd ?? process.cwd(), ".agents", "sessions");
  }

  subscribe(handler: (event: HarnessEvent) => void): () => void {
    return this.harness.subscribe(handler);
  }

  async run(input: OrchestratorRunInput): Promise<OrchestratorRunResult> {
    const sessionId = input.sessionId ?? this.activeSessionId ?? createSessionId();
    const stored = await this.readStoredSession(sessionId);
    let terminal = await this.harness.turn(
      stored
        ? {
            type: "prompt",
            session: stored,
            message: input.prompt,
            behavior: "steer",
            ...(input.options ? { options: input.options } : {}),
          }
        : {
            type: "start",
            mode: input.mode ?? this.config.mode,
            prompt: input.prompt,
            ...(input.options ? { options: input.options } : {}),
          },
    );
    this.activeSessionId = sessionId;
    await this.writeStoredSession(sessionId, terminal.session);

    while (terminal.type === "sleep") {
      await this.sleep(Math.max(0, terminal.wakeAt - Date.now()));
      terminal = await this.harness.turn({
        type: "wake",
        session: terminal.session,
        ...(input.options ? { options: input.options } : {}),
      });
      await this.writeStoredSession(sessionId, terminal.session);
    }

    return { sessionId, terminal };
  }

  async dispose(): Promise<void> {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    await this.harness.dispose();
  }

  private defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      this.timers.add(timer);
    });
  }

  private async readStoredSession(sessionId: string): Promise<HarnessSession | undefined> {
    try {
      const content = await readFile(this.sessionFilePath(sessionId), "utf-8");
      const stored = JSON.parse(content) as { session: HarnessSession };
      return stored.session;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  private async writeStoredSession(sessionId: string, session: HarnessSession): Promise<void> {
    await mkdir(this.sessionStoragePath, { recursive: true });
    await writeFile(
      this.sessionFilePath(sessionId),
      `${JSON.stringify({ sessionId, updatedAt: Date.now(), session }, null, 2)}\n`,
      "utf-8",
    );
  }

  private sessionFilePath(sessionId: string): string {
    return join(this.sessionStoragePath, `${sanitizeSessionId(sessionId)}.json`);
  }
}

function createSessionId(): string {
  return `session_${nanoid(12)}`;
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
}
