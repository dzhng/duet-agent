import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { TurnRunnerConfig } from "../types/config.js";
import type { TurnEvent } from "../types/protocol.js";
import { Session, type SessionStartInput, type SessionTurnRunner } from "./session.js";

export interface SessionManagerCreateInput extends Partial<SessionStartInput> {
  sessionId?: string;
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

  constructor(
    readonly config: TurnRunnerConfig,
    private readonly options: SessionManagerOptions = {},
  ) {
    this.sessionStoragePath =
      options.sessionStoragePath ?? join(config.cwd ?? process.cwd(), ".agents", "sessions");
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
    if (input.prompt) {
      void session.start({ prompt: input.prompt, mode: input.mode, options: input.options });
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

function createSessionId(): string {
  return `session_${nanoid(12)}`;
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
}
