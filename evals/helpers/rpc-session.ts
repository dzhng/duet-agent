import type { TurnEvent, TurnRunnerCommand } from "../../src/types/protocol.js";
import { withRequestId } from "./rpc-command.js";

export interface RpcSessionResult {
  exitCode: number;
  events: TurnEvent[];
}

/**
 * Send/receive handle exposed to a streaming RPC driver. `send` writes one
 * command to stdin (flushed immediately); `events` is an async iterable that
 * drains an internal queue so the underlying stdout reader keeps running
 * regardless of how the drive function exits its loop.
 */
export interface RpcSessionHandle {
  send: (command: TurnRunnerCommand) => Promise<void>;
  events: AsyncIterable<TurnEvent>;
}

/**
 * Spawn `duet --rpc` and hand the caller a {@link RpcSessionHandle} so it can
 * interleave stdin writes with stdout reads. Use this when the eval needs to
 * react to runtime events (e.g. sending `interrupt` only after the bash tool
 * call has actually started). The drive function returns when stdin should
 * be closed; this helper then waits for the process to settle and returns
 * the full collected transcript.
 */
export async function runRpcSessionStreaming(
  args: string[],
  drive: (handle: RpcSessionHandle) => Promise<void>,
  options: {
    timeoutMs?: number;
    maxToolCalls?: number;
    onEvent?: (event: TurnEvent) => void;
  } = {},
): Promise<RpcSessionResult> {
  // --no-skill-sync skips the duet.so default-skill fetch the CLI normally
  // runs at startup when DUET_API_KEY is set. The eval asserts RPC behavior,
  // not that side effect.
  const proc = Bun.spawn(
    [
      ...(process.platform === "linux" ? ["setsid"] : []),
      "bun",
      "src/cli.ts",
      "--rpc",
      "--no-skill-sync",
      ...args,
    ],
    {
      cwd: process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  let limitFailure: string | undefined;
  let calls = 0;
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      if (typeof proc.exitCode === "number" || typeof proc.signalCode === "string") return;
      // The CLI's SIGTERM handler disposes the runner and reaps separately
      // detached shell groups. Killing the CLI group first would orphan them.
      proc.kill("SIGTERM");
      // Let the product's five-second disposal watchdog finish before forcing
      // exit. Each matrix attempt also owns a container if disposal wedges.
      const force = setTimeout(() => {
        if (process.platform === "linux") {
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
        } else proc.kill("SIGKILL");
      }, 6_000);
      try {
        await proc.exited;
      } finally {
        clearTimeout(force);
      }
    })();
    return stopping;
  };
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          limitFailure = "RPC attempt wall-clock limit exceeded";
          void stop();
        }, options.timeoutMs);
  const stream = new EventStream(proc.stdout, (event) => {
    options.onEvent?.(event);
    if (event.type === "step" && event.step.type === "tool_call_start") {
      calls++;
      if (options.maxToolCalls !== undefined && calls >= options.maxToolCalls) {
        limitFailure = "RPC attempt tool-call limit exceeded";
        void stop();
      }
    }
  });
  // Drain stderr so the buffer cannot stall the subprocess; the contents
  // are not asserted on but the pipe must keep moving.
  void new Response(proc.stderr).text();
  const send = async (command: TurnRunnerCommand) => {
    proc.stdin.write(`${JSON.stringify(withRequestId(command))}\n`);
    await proc.stdin.flush();
  };

  try {
    await drive({ send, events: stream.iterate() });
    await proc.stdin.end();
    await stream.done();
    const exitCode = await proc.exited;
    if (limitFailure) throw new Error(limitFailure);
    return { exitCode, events: stream.collected };
  } finally {
    clearTimeout(timer);
    await stop();
  }
}

/**
 * Background-pumped reader over the child's stdout. Parses one JSON event
 * per line, pushes every event into `collected`, and lets multiple consumers
 * iterate independently without tearing down the underlying stream when one
 * of them stops early. The pump only finishes when the child closes stdout,
 * so events emitted after the drive function returns still land in
 * `collected`.
 */
class EventStream {
  readonly collected: TurnEvent[] = [];
  private readonly pending: Array<(event: TurnEvent | undefined) => void> = [];
  private finished = false;
  private readonly pump: Promise<void>;

  constructor(
    stream: ReadableStream<Uint8Array>,
    private readonly onEvent: (event: TurnEvent) => void,
  ) {
    this.pump = this.read(stream);
  }

  iterate(): AsyncIterable<TurnEvent> {
    let cursor = 0;
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<TurnEvent>> => {
          if (cursor < this.collected.length) {
            return { value: this.collected[cursor++]!, done: false };
          }
          if (this.finished) return { value: undefined, done: true };
          const event = await new Promise<TurnEvent | undefined>((resolve) => {
            this.pending.push(resolve);
          });
          if (event === undefined) return { value: undefined, done: true };
          cursor++;
          return { value: event, done: false };
        },
      }),
    };
  }

  done(): Promise<void> {
    return this.pump;
  }

  private async read(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) this.publish(JSON.parse(line) as TurnEvent);
          newlineIndex = buffer.indexOf("\n");
        }
      }
      const tail = buffer.trim();
      if (tail) this.publish(JSON.parse(tail) as TurnEvent);
    } finally {
      this.finished = true;
      while (this.pending.length > 0) this.pending.shift()!(undefined);
      reader.releaseLock();
    }
  }

  private publish(event: TurnEvent): void {
    this.collected.push(event);
    this.onEvent(event);
    while (this.pending.length > 0) this.pending.shift()!(event);
  }
}
