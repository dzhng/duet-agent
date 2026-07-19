import type {
  StateMachineAgentState,
  StateMachineDefinition,
  StateMachineSession,
} from "../../src/types/state-machine.js";
import {
  failActiveSession,
  getSession,
  hydrate,
  markTerminalAcknowledged,
  planDecision,
  planWake,
  recordPlannedTerminal,
  recordScheduled,
  recordSettled,
  startSession,
  supersede,
  type PlannedWork,
  type PollPolicy,
  type ShellSpec,
  type SettledDecision,
} from "../../src/turn-runner/state-machine-decisions.js";
import {
  createShellStateHandle,
  ShellCommandError,
  type ShellPartialOutput,
  type ShellStateHandle,
} from "../../src/turn-runner/shell-state-handle.js";
import type { SubagentRun, SubagentSpec } from "../../src/turn-runner/subagent.js";
import { resolveStateCwd, type StateMachineRunnerDecision } from "../../src/turn-runner/tools.js";

type HarnessOutcome = SettledDecision["outcome"];

export type ActiveStateOutput =
  | { state?: string; kind: "agent"; output?: { assistantText?: string } }
  | { state: string; kind: "script" | "poll"; output?: ShellPartialOutput };

type ActiveStateRunCommon = {
  /** Resolves only after the replaced executor has fully unwound. */
  finished: Promise<void>;
};

type ActiveStateRun =
  | (ActiveStateRunCommon & {
      kind: "agent";
      state: string;
      agent: SubagentRun;
    })
  | (ActiveStateRunCommon & {
      kind: "script" | "poll";
      state: string;
      shell: ShellStateHandle;
      pollPolicy?: PollPolicy;
    });

export interface StateMachineExecutionHarnessConfig {
  /** Default working directory used by script and poll-script states. */
  cwd: string;
  /** Builds a fresh transient sub-agent run for one planned agent-state execution. */
  createStateAgent(input: { state: StateMachineAgentState; prompt: string }): SubagentRun;
  /** Broadcasts snapshots when a state decision is planned or a session is superseded. */
  onSessionChanged?(session: StateMachineSession): void;
}

/** Test-only executor for the pure decision module's focused legacy assertions. */
export class StateMachineExecutionHarness {
  private session?: StateMachineSession;
  private activeRun?: ActiveStateRun;

  constructor(private readonly config: StateMachineExecutionHarnessConfig) {}

  hydrate(stateMachine: StateMachineSession | undefined): void {
    this.session = hydrate(stateMachine);
  }

  getSession(): StateMachineSession | undefined {
    return getSession(this.session);
  }

  markTerminalAcknowledged(): void {
    if (!this.session) return;
    this.session = markTerminalAcknowledged(this.session);
  }

  failActiveSession(state: string, error: string): HarnessOutcome {
    const settled = failActiveSession(this.requireSession(), state, error);
    this.session = settled.session;
    return settled.outcome;
  }

  hasActiveWork(): boolean {
    return Boolean(this.activeRun);
  }

  getActiveOutput(): ActiveStateOutput | undefined {
    const run = this.activeRun;
    if (!run) return undefined;
    if (run.kind === "agent") {
      const assistantText = run.agent.partialAssistantText();
      return assistantText
        ? { state: run.state, kind: "agent", output: { assistantText } }
        : { state: run.state, kind: "agent" };
    }
    const output = run.shell.partialOutput();
    return output
      ? { state: run.state, kind: run.kind, output }
      : { state: run.state, kind: run.kind };
  }

  startSession(input: {
    prompt: string;
    definition: StateMachineDefinition;
    currentState: string;
  }): void {
    this.session = startSession(input);
  }

  supersedeActiveSession(reason: string): void {
    if (!this.session || this.session.terminal) return;
    this.interrupt("Replaced by a new state machine.");
    this.session = supersede(this.requireSession(), reason);
    this.config.onSessionChanged?.(this.session);
  }

  interrupt(reason = "Interrupted"): void {
    const run = this.activeRun;
    if (!run) return;
    const settled = recordSettled(
      this.requireSession(),
      run.state,
      run.kind,
      { type: "interrupted", reason },
      this.interruptedOutput(run),
    );
    this.session = settled.session;
    if (run.kind === "agent") run.agent.interrupt(reason);
    else run.shell.interrupt(reason);
  }

  async runDecision(decision: StateMachineRunnerDecision): Promise<HarnessOutcome> {
    const previous = this.activeRun;
    if (previous) {
      this.interrupt("Replaced by a newly selected state.");
      await previous.finished;
    }
    const planned = planDecision(this.requireSession(), decision);
    this.session = planned.session;
    if (!("terminal" in planned.work) || planned.work.terminal.notifyStarted) {
      this.config.onSessionChanged?.(this.session);
    }
    return this.execute(planned.work);
  }

  async wake(): Promise<HarnessOutcome | undefined> {
    const planned = planWake(this.session);
    if (!planned) return undefined;
    this.session = planned.session;
    return this.execute(planned.work);
  }

  private execute(work: PlannedWork): Promise<HarnessOutcome> {
    if ("terminal" in work) {
      const settled = recordPlannedTerminal(this.requireSession(), work.terminal);
      this.session = settled.session;
      return Promise.resolve(settled.outcome);
    }
    if ("schedule" in work) {
      if (work.schedule.wakeAt > Date.now()) {
        const settled = recordScheduled(
          this.requireSession(),
          work.schedule.stateName,
          work.schedule.wakeAt,
        );
        this.session = settled.session;
        return Promise.resolve(settled.outcome);
      }
      const now = Date.now();
      const startedAt = this.session?.progress?.states[work.schedule.stateName]?.startedAt;
      const settled = recordSettled(this.requireSession(), work.schedule.stateName, "timer", {
        type: "completed",
        output: {
          elapsedMs: startedAt === undefined ? 0 : Math.max(0, now - startedAt),
          timestamp: now,
        },
      });
      this.session = settled.session;
      return Promise.resolve(settled.outcome);
    }
    if ("park" in work) {
      throw new Error("Park has no execution outcome; test it through TurnRunner.");
    }
    if ("subagent" in work.run) return this.runAgent(work.run.subagent, work.run.stateName);
    return this.runShell(work.run.shell, work.run.stateName, work.run.pollPolicy);
  }

  private async runAgent(spec: SubagentSpec, stateName: string): Promise<HarnessOutcome> {
    const state: StateMachineAgentState = { kind: "agent", name: stateName, ...spec };
    const agent = this.config.createStateAgent({ state, prompt: spec.prompt });
    const finished = createDeferredVoid();
    const run: ActiveStateRun = {
      kind: "agent",
      state: stateName,
      agent,
      finished: finished.promise,
    };
    this.activeRun = run;
    try {
      const result = await agent.prompt();
      const settled = recordSettled(
        this.requireSession(),
        stateName,
        "agent",
        result.type === "interrupted" ? { ...result, reason: agent.interruptedReason() } : result,
        this.interruptedOutput(run),
      );
      this.session = settled.session;
      return settled.outcome;
    } finally {
      if (this.activeRun === run) this.activeRun = undefined;
      finished.resolve();
    }
  }

  private async runShell(
    spec: ShellSpec,
    stateName: string,
    pollPolicy?: PollPolicy,
  ): Promise<HarnessOutcome> {
    const shell = createShellStateHandle({
      command: spec.command,
      cwd: resolveStateCwd(spec.cwd, this.config.cwd),
      timeoutMs: spec.timeoutMs,
      successCodes: spec.successCodes,
    });
    const finished = createDeferredVoid();
    const kind = pollPolicy ? "poll" : "script";
    const run: ActiveStateRun = {
      kind,
      state: stateName,
      shell,
      pollPolicy,
      finished: finished.promise,
    };
    this.activeRun = run;
    try {
      let settled;
      try {
        const output = await shell.run();
        settled = recordSettled(this.requireSession(), stateName, kind, {
          type: "completed",
          output,
        });
      } catch (error) {
        const interruptedReason = shell.interruptedReason();
        settled = recordSettled(
          this.requireSession(),
          stateName,
          kind,
          interruptedReason === undefined
            ? { type: "failed", error: error instanceof Error ? error.message : String(error) }
            : { type: "interrupted", reason: interruptedReason },
          shellPartialOutput(error) ?? shell.partialOutput(),
        );
      }
      this.session = settled.session;
      return settled.outcome;
    } finally {
      if (this.activeRun === run) this.activeRun = undefined;
      finished.resolve();
    }
  }

  private interruptedOutput(
    run: ActiveStateRun,
  ): { assistantText?: string } | ShellPartialOutput | undefined {
    if (run.kind === "agent") {
      const assistantText = run.agent.partialAssistantText();
      return assistantText ? { assistantText } : undefined;
    }
    return run.shell.partialOutput();
  }

  private requireSession(): StateMachineSession {
    if (!this.session) throw new Error("No state machine is active.");
    return this.session;
  }
}

function shellPartialOutput(error: unknown): ShellPartialOutput | undefined {
  return error instanceof ShellCommandError
    ? { stdout: error.output.stdout, stderr: error.output.stderr }
    : undefined;
}

function createDeferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
