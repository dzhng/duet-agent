/**
 * TUI playground.
 *
 * Renders the real TUI on top of a stub `SessionTurnRunner` so layout, colors,
 * and status-line composition can be verified without a live model. Each user
 * prompt drives a scripted scenario instead of hitting a provider:
 *
 *   /working <secs>            stream a fake working turn that lasts ~secs
 *   /observe <secs>            same, but as an observational memory phase
 *   /queue <a,b,c>             emit a follow-up queue with the given prompts
 *   /queue+observe <secs>      run an observation phase with a non-empty queue
 *   /tools <secs>              emit a fake tool-call running → completed
 *   /ask                       emit an `ask` terminal with two questions
 *   /sleep <secs>              emit a `sleep` terminal that wakes in N seconds
 *   /error <message>           emit a system error and end the turn
 *   anything else              stream a short text reply and complete
 *
 * Run with:
 *   bun run examples/tui-playground.ts
 *
 * The optional first CLI arg is auto-submitted as the initial prompt, so:
 *   bun run examples/tui-playground.ts "/queue+observe 30"
 * lets you eyeball the combined status line right away.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { Session, type SessionTurnRunner } from "../src/session/session.js";
import { runTui } from "../src/tui/app.js";
import type { SkillCollision } from "../src/turn-runner/skills.js";
import type {
  TurnAgentFile,
  TurnCommand,
  TurnEditFollowUpQueueCommand,
  TurnEvent,
  TurnInterruptCommand,
  TurnStartCommand,
  TurnState,
  TurnTerminalEvent,
} from "../src/types/protocol.js";

const INITIAL_STATE: TurnState = {
  status: "running",
  mode: "agent",
  agent: { status: "running", messages: [] },
};

class FakePlaygroundRunner implements SessionTurnRunner {
  private readonly handlers = new Set<(event: TurnEvent) => void>();
  private state: TurnState = INITIAL_STATE;
  private interrupted = false;
  private currentTurn?: { resolve: () => void; cancelled: boolean };

  async start(_command: TurnStartCommand): Promise<TurnState> {
    this.emit({ type: "turn_started", state: this.state });
    return this.state;
  }

  async turn(command: TurnCommand): Promise<TurnTerminalEvent> {
    if (command.type !== "prompt") {
      return this.complete("Only prompts are scripted in the playground.");
    }
    this.interrupted = false;
    const terminal = await this.runScenario(command.message.trim());
    this.state = terminal.state;
    this.emit(terminal);
    return terminal;
  }

  interrupt(_command: TurnInterruptCommand): void {
    if (this.currentTurn) {
      this.interrupted = true;
      this.currentTurn.cancelled = true;
      this.currentTurn.resolve();
    }
  }

  editFollowUpQueue(command: TurnEditFollowUpQueueCommand): void {
    this.emit({ type: "follow_up_queue", prompts: command.prompts });
  }

  getState(): TurnState | undefined {
    return this.state;
  }

  subscribe(handler: (event: TurnEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async getSkills(): Promise<readonly Skill[]> {
    return [];
  }

  async getResolvedAgentFiles(): Promise<readonly TurnAgentFile[]> {
    return [];
  }

  async getSkillCollisions(): Promise<readonly SkillCollision[]> {
    return [];
  }

  async dispose(): Promise<void> {}

  // ---- scenario plumbing ---------------------------------------------------

  private emit(event: TurnEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  private async runScenario(message: string): Promise<TurnTerminalEvent> {
    if (message.startsWith("/working")) {
      const secs = parseSeconds(message, 8);
      await this.sleep(secs * 1000);
      if (this.interrupted) return this.interruptedTerminal();
      this.emit({ type: "step", step: { type: "text", text: `Worked for ${secs}s.` } });
      return this.complete(`Worked for ${secs}s.`);
    }

    if (message.startsWith("/tools")) {
      const secs = parseSeconds(message, 4);
      this.emit({
        type: "step",
        step: {
          type: "tool_call",
          toolName: "fake_search",
          toolCallId: "tool_1",
          status: "running",
          input: { query: "playground" },
        },
      });
      await this.sleep(secs * 1000);
      if (this.interrupted) return this.interruptedTerminal();
      this.emit({
        type: "step",
        step: {
          type: "tool_call",
          toolName: "fake_search",
          toolCallId: "tool_1",
          status: "completed",
          input: { query: "playground" },
          output: [{ type: "text", text: "Found 3 results." }],
        },
      });
      return this.complete("Tool call finished.");
    }

    if (message.startsWith("/observe")) {
      const secs = parseSeconds(message, 20);
      return this.runMemoryPhase("observation", secs);
    }

    if (message.startsWith("/reflect")) {
      const secs = parseSeconds(message, 20);
      return this.runMemoryPhase("reflection", secs);
    }

    if (message.startsWith("/queue+observe")) {
      const secs = parseSeconds(message, 30);
      this.emit({
        type: "follow_up_queue",
        prompts: ["draft release notes", "ping reviewers", "merge once green"],
      });
      const terminal = await this.runMemoryPhase("observation", secs);
      this.emit({ type: "follow_up_queue", prompts: [] });
      return terminal;
    }

    if (message.startsWith("/queue")) {
      const arg = message.slice("/queue".length).trim();
      const prompts =
        arg.length > 0
          ? arg
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean)
          : ["follow-up one", "follow-up two", "follow-up three"];
      this.emit({ type: "follow_up_queue", prompts });
      await this.sleep(2000);
      if (this.interrupted) return this.interruptedTerminal();
      this.emit({ type: "follow_up_queue", prompts: [] });
      return this.complete(`Queued ${prompts.length} follow-ups.`);
    }

    if (message.startsWith("/ask")) {
      const terminal: TurnTerminalEvent = {
        type: "ask",
        state: { ...this.state, status: "waiting_for_human" },
        questions: [
          {
            question: "Pick a deployment target",
            options: [
              { label: "staging" },
              { label: "production", description: "requires approval" },
            ],
          },
        ],
      };
      return terminal;
    }

    if (message.startsWith("/sleep")) {
      const secs = parseSeconds(message, 10);
      return {
        type: "sleep",
        state: { ...this.state, status: "sleeping" },
        wakeAt: Date.now() + secs * 1000,
      };
    }

    if (message.startsWith("/error")) {
      const detail = message.slice("/error".length).trim() || "synthetic failure";
      this.emit({ type: "system", level: "error", message: detail });
      return {
        type: "complete",
        status: "failed",
        error: detail,
        state: { ...this.state, status: "failed" },
      };
    }

    // Default: stream a short reply.
    const reply = `playground reply for: ${message}`;
    for (const chunk of reply.match(/.{1,12}/g) ?? []) {
      this.emit({ type: "step", step: { type: "text_delta", delta: chunk } });
      await this.sleep(120);
      if (this.interrupted) return this.interruptedTerminal();
    }
    this.emit({ type: "step", step: { type: "text", text: reply } });
    return this.complete(reply);
  }

  private async runMemoryPhase(
    phase: "observation" | "reflection",
    seconds: number,
  ): Promise<TurnTerminalEvent> {
    this.emit({
      type: "memory",
      phase,
      status: "running",
      message:
        phase === "observation"
          ? "Observing conversation into memory…"
          : "Reflecting on observations…",
    });
    await this.sleep(seconds * 1000);
    if (this.interrupted) return this.interruptedTerminal();
    this.emit({
      type: "memory",
      phase,
      status: "completed",
      message: `${phase} complete`,
    });
    return this.complete(`${phase} finished after ${seconds}s.`);
  }

  private complete(result: string): TurnTerminalEvent {
    return {
      type: "complete",
      status: "completed",
      result,
      state: { ...this.state, status: "completed" },
    };
  }

  private interruptedTerminal(): TurnTerminalEvent {
    return {
      type: "interrupted",
      state: {
        ...this.state,
        status: "interrupted",
        agent: { ...this.state.agent, status: "cancelled" },
      },
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const handle = setTimeout(() => {
        this.currentTurn = undefined;
        resolve();
      }, ms);
      this.currentTurn = {
        cancelled: false,
        resolve: () => {
          clearTimeout(handle);
          this.currentTurn = undefined;
          resolve();
        },
      };
    });
  }
}

function parseSeconds(message: string, fallback: number): number {
  const match = message.match(/(\d+)/);
  if (!match) return fallback;
  const value = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function main(): Promise<void> {
  const initialPrompt = process.argv[2];
  const sessionPath = await mkdtemp(join(tmpdir(), "duet-tui-playground-"));
  const runner = new FakePlaygroundRunner();
  const session = new Session(
    { model: "playground", cwd: process.cwd() },
    { id: "playground", sessionPath, runner, resumeFromStorage: false },
  );

  await runTui({
    session,
    workDir: process.cwd(),
    sessionId: "playground",
    packageVersion: "playground",
    modelName: "playground",
    memoryModelName: "playground",
    ...(initialPrompt ? { initialPrompt } : {}),
  });

  await session.dispose();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
