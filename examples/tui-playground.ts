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
 *   /tools <secs>              emit one fake tool-call running → completed
 *   /tools-demo                run a batch of formatters with verbose data
 *   /ask                       emit an `ask` terminal with three questions
 *                              (single-select, multi-select, single-select).
 *                              Up/Down moves the highlight (and live-records
 *                              the answer for single-select). Space/Enter
 *                              advances on single-select, toggles a row on
 *                              multi-select, and advances when the synthetic
 *                              "Done" row is highlighted. ←/→ revisit prior
 *                              or upcoming questions. Typing a prompt
 *                              mid-flow flushes the latest answers via
 *                              `session.answer({ ..., message })`.
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
  TurnUsageEvent,
  TurnEditFollowUpQueueCommand,
  TurnEvent,
  TurnInterruptCommand,
  TurnQuestion,
  TurnStartCommand,
  TurnState,
  TurnTerminalEvent,
} from "../src/types/protocol.js";

export const INITIAL_STATE: TurnState = {
  status: "running",
  mode: "agent",
  agent: { status: "running", messages: [] },
};

// Keep this list in sync with the runScenario branches below; rendered as the
// first transcript block so users hitting `bun run examples/tui-playground.ts`
// can discover scenarios without scrolling back to the file header.
export const PLAYGROUND_MENU = [
  "Playground scenarios (type any of these and press Enter):",
  "  /working <secs>            stream a fake working turn for ~secs",
  "  /observe <secs>            same, but as an observational memory phase",
  "  /reflect <secs>            same, but as a reflection memory phase",
  "  /queue <a,b,c>             emit a follow-up queue with the given prompts",
  "  /queue+observe <secs>      observation phase with a non-empty queue",
  "  /tools <secs>              one fake tool-call running -> completed",
  "  /tools-demo                run a batch of formatters with verbose data",
  "  /ask                       ask three questions (single, multi, single).",
  "                             ↑/↓ move highlight (single-select live-records);",
  "                             Space/Enter advance, or toggle on multi-select;",
  "                             a 'Done' row is the multi-select advance key;",
  "                             ←/→ revisit prior or upcoming questions;",
  "                             typing mid-flow flushes the latest answers.",
  "  /context [pct]             emit a usage event filling the bar to ~pct (default 60)",
  "  /sleep <secs>              emit a sleep terminal that wakes in N seconds",
  "  /error <message>           emit a system error and end the turn",
  "  /echo <text>               stream <text> back verbatim and complete (used by tests)",
  "  anything else              stream a short text reply and complete",
].join("\n");

export class FakePlaygroundRunner implements SessionTurnRunner {
  private readonly handlers = new Set<(event: TurnEvent) => void>();
  private state: TurnState = INITIAL_STATE;
  private interrupted = false;
  private currentTurn?: { resolve: () => void; cancelled: boolean };

  async start(_command: TurnStartCommand): Promise<TurnState> {
    this.emit({ type: "turn_started", state: this.state });
    this.emit({ type: "system", level: "info", message: PLAYGROUND_MENU });
    return this.state;
  }

  async turn(command: TurnCommand): Promise<TurnTerminalEvent> {
    if (command.type === "wake") {
      return this.complete("Woke up.");
    }
    this.interrupted = false;
    const terminal =
      command.type === "answer"
        ? await this.runAnswerScenario(command)
        : await this.runScenario(command.message.trim());
    this.state = terminal.state;
    this.emit(terminal);
    return terminal;
  }

  /**
   * Stream a summary of the answers (and any flushed prompt) the TUI picker
   * dispatched via `session.answer(...)`. Lets the playground exercise the
   * picker handoff end-to-end without a real model.
   */
  private async runAnswerScenario(
    command: Extract<TurnCommand, { type: "answer" }>,
  ): Promise<TurnTerminalEvent> {
    const lines: string[] = ["Answers received:"];
    for (const question of command.questions) {
      const labels = command.answers[question.question] ?? [];
      const rendered = labels.length === 0 ? "(no selection)" : labels.join(", ");
      lines.push(`- ${question.question} -> ${rendered}`);
    }
    const trailing = command.message?.trim();
    if (trailing) lines.push(`Trailing prompt: ${trailing}`);
    const summary = lines.join("\n");

    for (const chunk of summary.match(/.{1,32}/g) ?? []) {
      this.emit({ type: "step", step: { type: "text_delta", delta: chunk } });
      await this.sleep(60);
      if (this.interrupted) return this.interruptedTerminal();
    }
    this.emit({ type: "step", step: { type: "text", text: summary } });
    return this.complete(summary);
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

  /**
   * Emit a synthetic `ask` terminal so tests / playground extensions can
   * push the picker into a known state without routing through the slash
   * scenario layer. Mirrors what the `/ask` scenario produces, but lets
   * the caller hand-craft the questions list.
   */
  emitAskTerminal(questions: TurnQuestion[]): void {
    const terminal: TurnTerminalEvent = {
      type: "ask",
      state: { ...this.state, status: "waiting_for_human" },
      questions,
    };
    this.state = terminal.state;
    this.emit(terminal);
  }

  /** Emit `usage` for tests that need explicit segment totals. */
  emitUsage(event: Omit<TurnUsageEvent, "type">): void {
    this.emit({ type: "usage", ...event });
  }

  /**
   * Push a hand-crafted event through the same fan-out the scenario engine
   * uses. Tests rely on this to drive isolated step / memory / usage flows
   * without paying the latency of a full scripted scenario.
   */
  emitEvent(event: TurnEvent): void {
    this.emit(event);
  }

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

    if (message.startsWith("/tools-demo")) {
      const askTerminal = await this.runToolsDemo();
      return askTerminal ?? this.complete("Tools demo finished.");
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
        prompts: [
          { message: "draft release notes" },
          { message: "ping reviewers" },
          { message: "merge once green" },
        ],
      });
      const terminal = await this.runMemoryPhase("observation", secs);
      this.emit({ type: "follow_up_queue", prompts: [] });
      return terminal;
    }

    if (message.startsWith("/queue")) {
      const arg = message.slice("/queue".length).trim();
      const messages =
        arg.length > 0
          ? arg
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean)
          : ["follow-up one", "follow-up two", "follow-up three"];
      this.emit({
        type: "follow_up_queue",
        prompts: messages.map((m) => ({ message: m })),
      });
      await this.sleep(2000);
      if (this.interrupted) return this.interruptedTerminal();
      this.emit({ type: "follow_up_queue", prompts: [] });
      return this.complete(`Queued ${messages.length} follow-ups.`);
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
          {
            question: "Which test suites should run before promotion?",
            multiSelect: true,
            options: [
              { label: "unit", description: "fast, runs on every push" },
              { label: "integration", description: "hits live services" },
              { label: "e2e", description: "drives the browser" },
              { label: "load", description: "long-running soak" },
            ],
          },
          {
            question: "Confirm rollout window",
            options: [
              { label: "now" },
              { label: "tonight", description: "after 22:00 local" },
              { label: "next morning" },
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

    if (message.startsWith("/context")) {
      // Synthetic `usage` for the sidebar bar. Optional arg: target
      // fill percent (default 60). Breakdown uses fixed-ish system + memory
      // caps, ~7% untracked overhead, remainder as messages; usage fields
      // are shaped so the title-row cost readout is non-zero (Opus 4 $/M).
      const arg = message.slice("/context".length).trim();
      const target = Math.max(1, Math.min(120, Number.parseInt(arg, 10) || 60));
      const cap = 200_000;
      const total = Math.round((target / 100) * cap);

      const systemPrompt = Math.min(total, 6_400);
      const localMemory = Math.min(Math.round(total * 0.06), Math.round(cap * 0.05));
      const globalMemory = Math.min(Math.round(total * 0.025), Math.round(cap * 0.03));
      const overhead = Math.round(total * 0.07);
      const messages = Math.max(0, total - systemPrompt - localMemory - globalMemory - overhead);

      const output = Math.round(total * 0.04);
      const cacheRead = Math.round(total * 0.7);
      const cacheWrite = Math.round(total * 0.05);
      const input = Math.max(0, total - cacheRead - cacheWrite);
      const cost = {
        input: (input / 1_000_000) * 15,
        output: (output / 1_000_000) * 75,
        cacheRead: (cacheRead / 1_000_000) * 1.5,
        cacheWrite: (cacheWrite / 1_000_000) * 18.75,
        total: 0,
      };
      cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;

      const usage = { input, output, cacheRead, cacheWrite, totalTokens: total, cost };
      this.emitUsage({
        turnUsage: usage,
        lastMessageUsage: usage,
        effectiveContextWindow: cap,
        contextWindowUsage: { systemPrompt, messages, localMemory, globalMemory },
      });
      return this.complete(`Emitted usage at ~${target}% of ${cap} tokens.`);
    }

    if (message.startsWith("/echo")) {
      // Streams the trailing text back verbatim. Deterministic and free of
      // incidental tokens (no timing strings or queue counts) so callers
      // can assert on an exact substring of the rendered transcript.
      const reply = message.slice("/echo".length).trim() || "echo";
      for (const chunk of reply.match(/.{1,8}/g) ?? []) {
        this.emit({ type: "step", step: { type: "text_delta", delta: chunk } });
        await this.sleep(10);
        if (this.interrupted) return this.interruptedTerminal();
      }
      this.emit({ type: "step", step: { type: "text", text: reply } });
      return this.complete(reply);
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

  /**
   * Walks through the per-tool formatters with intentionally chunky inputs
   * and outputs so the per-tool result clamp (`assembleToolBlock`) can be eyeballed
   * without standing up a real model. Each call runs briefly with a spinner
   * before completing so live-finalize logic also exercises.
   */
  private async runToolsDemo(): Promise<TurnTerminalEvent | undefined> {
    const longJson = `interface AgentMessage { role: "user" | "assistant" | "tool"; content: ContentBlock[]; metadata: { traceId: string; createdAt: number; tags: string[]; }; }`;
    const grepHits = Array.from(
      { length: 42 },
      (_, i) =>
        `src/tui/app.ts:${100 + i}: const handler${i} = (event: TurnEvent) => sidebar.refresh();`,
    ).join("\n");
    const bashOutput = Array.from(
      { length: 18 },
      (_, i) =>
        `[2026-05-09T17:${String(i).padStart(2, "0")}:00] worker-${i}: built target ${i} in ${(Math.random() * 4 + 1).toFixed(2)}s with cache hit ratio 0.${(Math.random() * 100) | 0}`,
    ).join("\n");

    const fixtures: Array<{
      toolName: string;
      input: Record<string, unknown>;
      output?: string;
      isError?: boolean;
    }> = [
      {
        toolName: "bash",
        input: { command: "rg --json 'AgentMessage' node_modules/@earendil-works/" },
        output: bashOutput,
      },
      {
        toolName: "bash",
        input: {
          command: "set -euo pipefail\nfor i in $(seq 1 5); do echo run $i; done\necho done",
          timeout: 600,
        },
        output: "run 1\nrun 2\nrun 3\nrun 4\nrun 5\ndone",
      },
      {
        toolName: "read",
        input: { path: "src/tui/app.ts", offset: 100, limit: 40 },
        output: longJson,
      },
      {
        toolName: "grep",
        input: { pattern: "TurnEvent", path: "src/", glob: "*.ts", ignoreCase: true },
        output: grepHits,
      },
      {
        toolName: "edit",
        input: {
          path: "src/tui/sidebar.ts",
          edits: [
            { old: "width: 36", new: "width: SIDEBAR_WIDTH" },
            { old: "fixedHeight: 5", new: "fixedHeight: 6" },
            { old: "(waiting for usage)", new: "(no usage yet)" },
          ],
        },
        output: "applied 3 edits",
      },
      {
        toolName: "todo_write",
        input: {
          merge: false,
          todos: [
            { id: "1", content: "Audit tool block clamping", status: "completed" },
            { id: "2", content: "Wrap then clamp visual rows", status: "in_progress" },
            { id: "3", content: "Update playground with verbose fixtures", status: "pending" },
            { id: "4", content: "Add session cost in sidebar", status: "completed" },
          ],
        },
      },
      {
        toolName: "ls",
        input: { path: "src/tui" },
        output: ["app.ts", "history.ts", "paste.ts", "sidebar.ts", "theme.ts", "tool-formatters.ts"]
          .map((name) => `- ${name}`)
          .join("\n"),
      },
      {
        toolName: "find",
        input: { pattern: "*.eval.ts", path: "evals/" },
        output: [
          "evals/observer-priority.eval.ts",
          "evals/state-machine.eval.ts",
          "evals/memory-recall.eval.ts",
        ].join("\n"),
      },
      {
        toolName: "write",
        input: {
          path: "src/tui/scratch.ts",
          content: `// auto-generated scratchpad\nexport const HELLO = "world";\n`,
        },
        output: "wrote 56 bytes",
      },
      {
        toolName: "read_skill",
        input: { name: "release" },
        output:
          "# Release\n\nUse this workflow to publish a new version through the GitHub release workflow.",
      },
      {
        toolName: "ask_user_question",
        input: {
          questions: [
            {
              question: "Pick a deployment target",
              header: "Deploy",
              options: [
                { label: "staging" },
                { label: "production", description: "requires approval" },
              ],
            },
          ],
        },
        // Live formatter hides ask_user_question (the runner emits an `ask`
        // terminal event for the picker). Included here mostly to document
        // that path; the demo falls through with no transcript entry.
      },
      {
        toolName: "create_state_machine_definition",
        input: {
          definition: {
            name: "release-pipeline",
            states: [
              { name: "verify", kind: "agent" },
              { name: "wait-for-ci", kind: "poll", intervalMs: 60_000 },
              { name: "publish", kind: "agent" },
              { name: "announce", kind: "agent" },
            ],
          },
        },
        output: "state machine registered",
      },
      {
        toolName: "select_state_machine_state",
        input: {
          decision: {
            kind: "transition",
            state: "wait-for-ci",
            reason: "verify completed; CI workflow dispatched, polling for green checks",
          },
        },
        output: "moved to wait-for-ci",
      },
      {
        toolName: "get_current_state_machine_state",
        input: {},
        output: "current: wait-for-ci\nwakeAt: 2026-05-09T18:30:00Z\nattempts: 2",
      },
      {
        toolName: "mystery_tool",
        input: {
          deeplyNested: {
            config: {
              retries: 3,
              backoffMs: [100, 200, 400, 800, 1600],
              flags: { strict: true, dryRun: false },
            },
            payload: longJson,
          },
        },
        output: longJson,
      },
      {
        toolName: "bash",
        input: { command: "cargo test --workspace --no-fail-fast" },
        output:
          "error[E0277]: the trait bound is not satisfied\n  --> src/lib.rs:42:9\n   |\n42 |         do_thing();\n   |         ^^^^^^^^ the trait `Send` is not implemented for `Rc<T>`",
        isError: true,
      },
    ];

    for (const [index, fixture] of fixtures.entries()) {
      const toolCallId = `demo_${index}`;
      this.emit({
        type: "step",
        step: {
          type: "tool_call",
          toolName: fixture.toolName,
          toolCallId,
          status: "running",
          input: fixture.input,
        },
      });
      await this.sleep(400);
      if (this.interrupted) return undefined;
      this.emit({
        type: "step",
        step: {
          type: "tool_call",
          toolName: fixture.toolName,
          toolCallId,
          status: fixture.isError ? "error" : "completed",
          input: fixture.input,
          ...(fixture.output ? { output: [{ type: "text", text: fixture.output }] } : {}),
        },
      });
      await this.sleep(120);
      if (this.interrupted) return undefined;
    }

    // Cap the demo with an `ask` terminal so the question UI is exercised
    // even though `ask_user_question` hides itself live (the runner owns the
    // picker via this terminal event).
    return {
      type: "ask",
      state: { ...this.state, status: "waiting_for_human" },
      questions: [
        {
          question: "Pick a deployment target",
          header: "Deploy",
          options: [
            { label: "staging" },
            { label: "production", description: "requires approval" },
          ],
        },
      ],
    };
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
    packageName: "@duetso/agent",
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
