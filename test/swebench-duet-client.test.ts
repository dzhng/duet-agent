import { describe, expect, test } from "bun:test";
import { runDuetTurn, type ExecTransport } from "../benchmarks/swebench/src/duet-client.js";
import type { TurnEvent, TurnRunnerCommand } from "../src/types/protocol.js";
import { ManualRuntimeClock } from "./helpers/manual-runtime-clock.js";

const STATE = { status: "completed", mode: "agent", agent: { status: "completed", messages: [] } };

class LineQueue implements AsyncIterable<string> {
  private readonly values: string[] = [];
  private readonly waiters: Array<(value: IteratorResult<string>) => void> = [];
  private ended = false;

  push(value: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.ended) return { done: true, value: undefined };
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

class FakeTransport implements ExecTransport {
  readonly commands: TurnRunnerCommand[] = [];
  readonly stdout = new LineQueue();
  readonly stderr = new LineQueue();
  readonly stdoutLines = this.stdout;
  readonly stderrLines = this.stderr;
  readonly exited = new Promise<{ code: number | null; signal: string | null }>(() => {});
  killed = false;
  interruptResponse?: TurnEvent;

  readonly stdin = {
    write: async (line: string): Promise<void> => {
      const command = JSON.parse(line) as TurnRunnerCommand;
      this.commands.push(command);
      if (command.type === "interrupt" && this.interruptResponse) {
        this.stdout.push(JSON.stringify(this.interruptResponse));
      }
    },
  };

  kill(): void {
    this.killed = true;
    this.stdout.end();
  }
}

function usageEvent(cost: number): TurnEvent {
  return {
    type: "usage",
    turnUsage: {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    },
    usageByModel: [],
    lastMessageUsage: {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    },
    effectiveContextWindow: 200_000,
    contextWindowUsage: { systemPrompt: 2, messages: 10, localMemory: 0, globalMemory: 0 },
  };
}

function terminal(status: "completed" | "failed" = "completed"): TurnEvent {
  return { type: "complete", status, state: STATE } as TurnEvent;
}

async function startTurn(
  transport: FakeTransport,
  clock = new ManualRuntimeClock(),
  limits = { costUsd: 1, wallClockMs: 1_000, interruptGraceMs: 100 },
) {
  const result = runDuetTurn(transport, { limits }, "Fix the issue.", clock);
  await Promise.resolve();
  await Promise.resolve();
  return { result, clock };
}

describe("SWE-bench duet RPC client", () => {
  test("writes start then an explicit follow-up prompt and returns the first terminal", async () => {
    const transport = new FakeTransport();
    const { result } = await startTurn(transport);
    transport.stdout.push(JSON.stringify({ type: "turn_started", state: STATE }));
    transport.stdout.push(JSON.stringify(terminal()));

    const outcome = await result;
    expect(transport.commands).toEqual([
      { type: "start", mode: "agent" },
      { type: "prompt", message: "Fix the issue.", behavior: "follow_up" },
    ]);
    expect(outcome.terminal).toEqual(
      expect.objectContaining({ type: "complete", status: "completed" }),
    );
    expect(outcome.events.map((event) => event.type)).toEqual(["turn_started", "complete"]);
  });

  test("surfaces a failed completion and an ask terminal without throwing", async () => {
    const failedTransport = new FakeTransport();
    const failed = await startTurn(failedTransport);
    failedTransport.stdout.push(JSON.stringify(terminal("failed")));
    expect((await failed.result).terminal).toEqual(
      expect.objectContaining({ type: "complete", status: "failed" }),
    );

    const askTransport = new FakeTransport();
    const asked = await startTurn(askTransport);
    askTransport.stdout.push(
      JSON.stringify({
        type: "ask",
        questions: [],
        state: { ...STATE, status: "waiting_for_human" },
      }),
    );
    expect((await asked.result).terminal).toEqual(expect.objectContaining({ type: "ask" }));
  });

  test("interrupts at the cumulative cost cap and accepts the interrupted terminal", async () => {
    const transport = new FakeTransport();
    transport.interruptResponse = {
      type: "interrupted",
      state: { ...STATE, status: "interrupted" },
    } as TurnEvent;
    const { result } = await startTurn(transport);
    transport.stdout.push(JSON.stringify(usageEvent(0.25)));
    transport.stdout.push(JSON.stringify(usageEvent(1)));

    const outcome = await result;
    expect(transport.commands.at(-1)).toEqual({ type: "interrupt" });
    expect(outcome.terminal).toEqual(expect.objectContaining({ type: "interrupted" }));
    expect(outcome.timedOut).toBe(false);
    expect(transport.killed).toBe(false);
  });

  test("interrupts a stalled stream at wall clock and kills after the manual grace", async () => {
    const transport = new FakeTransport();
    const { result, clock } = await startTurn(transport);

    await clock.advanceBy(1_000);
    await Promise.resolve();
    expect(transport.commands.at(-1)).toEqual({ type: "interrupt" });
    await clock.advanceBy(100);

    const outcome = await result;
    expect(outcome).toEqual(
      expect.objectContaining({ terminal: "killed", timedOut: true, wallClockMs: 1_100 }),
    );
    expect(transport.killed).toBe(true);
  });

  test("skips garbage stdout and drains but never parses the stderr banner", async () => {
    const transport = new FakeTransport();
    const { result } = await startTurn(transport);
    transport.stderr.push("@duetso/agent 0.2.3 rpc");
    transport.stdout.push("not json");
    transport.stdout.push("{}");
    transport.stdout.push(JSON.stringify(terminal()));

    const outcome = await result;
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]?.type).toBe("complete");
  });
});
