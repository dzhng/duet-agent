import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { TurnRunnerConfig } from "../types/config.js";
import type { McpHttpServerConfig, TurnEvent, TurnMode, TurnOptions } from "../types/protocol.js";
import { DEFAULT_MEMORY_DB_PATH, DEFAULT_SESSION_STORAGE_DIR } from "../memory/paths.js";
import { Session, type SessionTurnRunner } from "./session.js";

export {
  DEFAULT_DUET_DIR,
  DEFAULT_DUET_HOME,
  DEFAULT_MEMORY_DB_PATH,
  DEFAULT_SESSION_STORAGE_DIR,
} from "../memory/paths.js";

export interface SessionManagerCreateInput {
  /** Optional fixed id; the manager generates one when omitted. */
  sessionId?: string;
  /** Routing mode for the new session. */
  mode?: TurnMode;
  /**
   * When provided, the manager dispatches this prompt as the first turn after
   * setup completes. Omit to leave the session idle until the caller sends a
   * prompt directly.
   */
  prompt?: string;
  options?: TurnOptions;
  /** Remote MCP servers to connect for the new session. */
  mcpServers?: Record<string, McpHttpServerConfig>;
}

export interface SessionManagerOptions {
  sessionStoragePath?: string;
  createRunner?: (sessionId: string) => SessionTurnRunner;
}

export type SessionManagerEvent = {
  sessionId: string;
  event: TurnEvent;
};

export type SessionManagerEventHandler = (event: SessionManagerEvent) => void;

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly eventHandlers = new Set<SessionManagerEventHandler>();
  private readonly sessionStoragePath: string;
  readonly config: TurnRunnerConfig;

  constructor(
    config: TurnRunnerConfig,
    private readonly options: SessionManagerOptions = {},
  ) {
    this.config = withDefaultMemoryDbPath(config);
    this.sessionStoragePath = options.sessionStoragePath ?? DEFAULT_SESSION_STORAGE_DIR;
  }

  subscribe(handler: SessionManagerEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  create(input: SessionManagerCreateInput): Session {
    const session = this.createSession(input.sessionId, false);
    this.sessions.set(session.id, session);
    const setup = session.start({
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.options ? { options: input.options } : {}),
      ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
    });
    if (input.prompt) {
      const prompt = input.prompt;
      void setup.then(() =>
        session.prompt({
          message: prompt,
        }),
      );
    }
    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  resume(sessionId: string): Session {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const session = this.createSession(sessionId, true);
    this.sessions.set(sessionId, session);
    return session;
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.dispose();
    }
    this.sessions.clear();
  }

  private createSession(sessionId: string | undefined, resumeFromStorage: boolean): Session {
    const id = sessionId ?? createSessionId();
    const sessionPath = join(this.sessionStoragePath, sanitizeSessionId(id));
    mkdirSync(sessionPath, { recursive: true });
    const session = new Session(this.config, {
      id,
      runner: this.options.createRunner?.(id),
      resumeFromStorage,
      sessionPath,
    });
    session.subscribe((event) => {
      this.emit({ sessionId: session.id, event });
    });
    return session;
  }

  private emit(event: SessionManagerEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }
}

function withDefaultMemoryDbPath(config: TurnRunnerConfig): TurnRunnerConfig {
  if (config.memoryDbPath !== undefined) return config;
  return {
    ...config,
    memoryDbPath: DEFAULT_MEMORY_DB_PATH,
  };
}

function createSessionId(): string {
  return `session_${nanoid(12)}`;
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
}
