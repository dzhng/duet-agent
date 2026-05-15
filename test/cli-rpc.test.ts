import { describe, expect, test, spyOn } from "bun:test";
import { driveRpcLoop, parseRpcArgs, parseRpcCommandLine, type RpcRunner } from "../src/cli/rpc.js";
import type {
  TurnEditFollowUpQueueCommand,
  TurnInterruptCommand,
  TurnRunnerCommand,
  TurnSystemEvent,
  TurnTerminalEvent,
} from "../src/types/protocol.js";

/**
 * Async iterable helper for `driveRpcLoop`. Pulling from an array makes the
 * loop's phase transitions easy to assert: each yielded value is a single
 * stdin line the loop would have read.
 */
function commandStream(commands: TurnRunnerCommand[]): AsyncIterable<TurnRunnerCommand> {
  return (async function* () {
    for (const command of commands) yield command;
  })();
}

interface RecordedRunner extends RpcRunner {
  starts: Array<Extract<TurnRunnerCommand, { type: "start" }>>;
  turns: Array<Extract<TurnRunnerCommand, { type: "prompt" | "answer" | "wake" }>>;
  interrupts: TurnInterruptCommand[];
  editQueues: TurnEditFollowUpQueueCommand[];
  resolveTurn: (terminal: TurnTerminalEvent) => void;
}

/**
 * Capture the {@link TurnSystemEvent}s the dispatch loop emits for soft
 * protocol errors (malformed commands, premature commands before start,
 * unknown command types). Used in lieu of the older fatal-exit assertions.
 */
function buildEventSink(): {
  emit: (event: TurnSystemEvent) => void;
  events: TurnSystemEvent[];
} {
  const events: TurnSystemEvent[] = [];
  return { events, emit: (event) => events.push(event) };
}

/**
 * In-memory {@link RpcRunner} that records dispatched commands and exposes a
 * `resolveTurn` hook so tests can decide when the in-flight turn settles. This
 * lets us assert that mid-turn commands reach the runner before the terminal
 * event.
 */
function buildRunner(): RecordedRunner {
  let resolveTurn!: (terminal: TurnTerminalEvent) => void;
  const turnPromise = new Promise<TurnTerminalEvent>((resolve) => {
    resolveTurn = resolve;
  });
  const runner: RecordedRunner = {
    starts: [],
    turns: [],
    interrupts: [],
    editQueues: [],
    resolveTurn,
    async start(command) {
      runner.starts.push(command);
    },
    async turn(command) {
      runner.turns.push(command);
      return turnPromise;
    },
    interrupt(command) {
      runner.interrupts.push(command);
    },
    editFollowUpQueue(command) {
      runner.editQueues.push(command);
    },
  };
  return runner;
}

describe("parseRpcArgs", () => {
  test("collects supported flags and defaults workDir to cwd", () => {
    const parsed = parseRpcArgs([
      "--rpc",
      "--model",
      "opus-4.7",
      "--memory-model",
      "haiku-4.5",
      "--workdir",
      "/tmp/repo",
      "--system-prompt",
      "be brief",
      "--system-prompt-file",
      "A.md",
      "--system-prompt-file",
      "B.md",
      "--env-file",
      "/etc/duet/env",
      "-i",
    ]);
    expect(parsed.modelName).toBe("opus-4.7");
    expect(parsed.memoryModelName).toBe("haiku-4.5");
    expect(parsed.workDir).toBe("/tmp/repo");
    expect(parsed.systemInstructions).toBe("be brief");
    expect(parsed.systemPromptFiles).toEqual(["A.md", "B.md"]);
    expect(parsed.envFilePath).toBe("/etc/duet/env");
    expect(parsed.incognito).toBe(true);
    expect(parsed.noSkillSync).toBe(false);
  });

  test("--db sets an explicit memory database path", () => {
    const parsed = parseRpcArgs(["--db", "/tmp/custom.db"]);
    expect(parsed.dbPath).toBe("/tmp/custom.db");
  });

  test("omitting --db leaves dbPath undefined so the default applies", () => {
    const parsed = parseRpcArgs([]);
    expect(parsed.dbPath).toBeUndefined();
  });

  test("--no-skill-sync sets the skip-skill-sync flag", () => {
    const parsed = parseRpcArgs(["--no-skill-sync"]);
    expect(parsed.noSkillSync).toBe(true);
  });

  test("--no-auto-upgrade is accepted as a no-op", () => {
    // RPC mode never auto-upgrades; the flag is tolerated for host scripts
    // that forward run-mode flags into `--rpc` invocations.
    expect(() => parseRpcArgs(["--no-auto-upgrade"])).not.toThrow();
  });

  test("--no-system-prompt-files resets the system prompt file list", () => {
    const parsed = parseRpcArgs(["--system-prompt-file", "A.md", "--no-system-prompt-files"]);
    expect(parsed.systemPromptFiles).toEqual([]);
  });

  test("--provider pins the catalog defaults and rejects --model overlap", () => {
    const ok = parseRpcArgs(["--provider", "openai"]);
    expect(ok.modelName).toBeDefined();
    expect(ok.memoryModelName).toBeDefined();

    const exitSpy = stubProcessExit();
    try {
      expect(() => parseRpcArgs(["--provider", "openai", "--model", "gpt-5.5"])).toThrow();
    } finally {
      exitSpy.mockRestore();
    }
  });

  test("rejects positional arguments because RPC reads commands from stdin", () => {
    const exitSpy = stubProcessExit();
    try {
      expect(() => parseRpcArgs(["stray"])).toThrow();
    } finally {
      exitSpy.mockRestore();
    }
  });

  test("rejects unknown flags", () => {
    const exitSpy = stubProcessExit();
    try {
      expect(() => parseRpcArgs(["--bogus"])).toThrow();
    } finally {
      exitSpy.mockRestore();
    }
  });
});

/**
 * Replace `process.exit` with a throwing stub for the duration of one test.
 * `fail()` calls `process.exit(1)`, which would terminate the test runner;
 * the stub turns that into a regular thrown error the test can assert on.
 */
function stubProcessExit() {
  return spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
}

describe("parseRpcCommandLine", () => {
  test("returns a skip result for blank/whitespace lines so the iterator can skip them", () => {
    expect(parseRpcCommandLine("")).toEqual({ kind: "skip" });
    expect(parseRpcCommandLine("   \t  ")).toEqual({ kind: "skip" });
  });

  test("parses a well-formed JSON command", () => {
    expect(parseRpcCommandLine('{"type":"start"}')).toEqual({
      kind: "command",
      command: { type: "start" },
    });
  });

  test("reports malformed JSON as an error result instead of exiting", () => {
    const result = parseRpcCommandLine("{not json");
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unreachable");
    expect(result.message).toMatch(/Invalid RPC command JSON/);
  });

  test("reports JSON without a string `type` field as an error result", () => {
    const missingType = parseRpcCommandLine('{"foo":"bar"}');
    expect(missingType.kind).toBe("error");
    const plainString = parseRpcCommandLine('"plain string"');
    expect(plainString.kind).toBe("error");
  });
});

describe("driveRpcLoop", () => {
  test("returns cleanly when stdin closes before any command arrives", async () => {
    const runner = buildRunner();
    const sink = buildEventSink();
    await driveRpcLoop(runner, commandStream([]), { emit: sink.emit });
    expect(runner.starts).toHaveLength(0);
    expect(runner.turns).toHaveLength(0);
    expect(sink.events).toEqual([]);
  });

  test("forwards a start command, drives a turn, and resolves on terminal", async () => {
    const runner = buildRunner();
    const terminal: TurnTerminalEvent = {
      type: "complete",
      status: "completed",
      state: {} as never,
    };
    const loop = driveRpcLoop(
      runner,
      commandStream([{ type: "start" }, { type: "prompt", message: "hi", behavior: "follow_up" }]),
    );
    // Settle on the next microtask so the loop pumps the start and turn
    // before we resolve the in-flight turn promise.
    await new Promise((resolve) => setImmediate(resolve));
    runner.resolveTurn(terminal);
    await loop;
    expect(runner.starts).toEqual([{ type: "start" }]);
    expect(runner.turns).toEqual([{ type: "prompt", message: "hi", behavior: "follow_up" }]);
  });

  test("emits a soft error and keeps waiting when the first command is not start", async () => {
    // The loop surfaces pre-start protocol violations as TurnSystemEvent
    // errors and keeps reading; only a terminal event or stdin EOF ends
    // the process, so a stray buffered command cannot kill the session.
    const runner = buildRunner();
    const sink = buildEventSink();
    const terminal: TurnTerminalEvent = {
      type: "complete",
      status: "completed",
      state: {} as never,
    };
    const loop = driveRpcLoop(
      runner,
      commandStream([
        { type: "prompt", message: "too early", behavior: "follow_up" },
        { type: "start" },
        { type: "prompt", message: "after start", behavior: "follow_up" },
      ]),
      { emit: sink.emit },
    );
    await new Promise((resolve) => setImmediate(resolve));
    runner.resolveTurn(terminal);
    await loop;
    expect(runner.starts).toEqual([{ type: "start" }]);
    expect(runner.turns).toEqual([
      { type: "prompt", message: "after start", behavior: "follow_up" },
    ]);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({ type: "system", level: "error" });
    expect(sink.events[0]?.message).toMatch(/start/i);
  });

  test("routes interrupt and edit_follow_up_queue mid-turn into the runner", async () => {
    const runner = buildRunner();
    const terminal: TurnTerminalEvent = {
      type: "interrupted",
      state: {} as never,
    };
    const editCommand: TurnEditFollowUpQueueCommand = {
      type: "edit_follow_up_queue",
      prompts: [{ message: "queued" }],
    };
    const interruptCommand: TurnInterruptCommand = { type: "interrupt" };
    const loop = driveRpcLoop(
      runner,
      commandStream([
        { type: "start" },
        { type: "prompt", message: "go", behavior: "follow_up" },
        editCommand,
        interruptCommand,
      ]),
    );
    // Give the loop time to consume all stdin commands before the turn resolves.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(runner.editQueues).toEqual([editCommand]);
    expect(runner.interrupts).toEqual([interruptCommand]);
    runner.resolveTurn(terminal);
    await loop;
  });

  test("emits a soft error and continues when a second start arrives", async () => {
    const runner = buildRunner();
    const sink = buildEventSink();
    const terminal: TurnTerminalEvent = {
      type: "complete",
      status: "completed",
      state: {} as never,
    };
    const loop = driveRpcLoop(
      runner,
      commandStream([
        { type: "start" },
        { type: "start" },
        { type: "prompt", message: "hi", behavior: "follow_up" },
      ]),
      { emit: sink.emit },
    );
    await new Promise((resolve) => setImmediate(resolve));
    runner.resolveTurn(terminal);
    await loop;
    expect(runner.starts).toHaveLength(1);
    expect(runner.turns).toEqual([{ type: "prompt", message: "hi", behavior: "follow_up" }]);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.message).toMatch(/already started/i);
  });

  test("emits a soft error and continues when an unknown command type arrives", async () => {
    const runner = buildRunner();
    const sink = buildEventSink();
    const terminal: TurnTerminalEvent = {
      type: "complete",
      status: "completed",
      state: {} as never,
    };
    const loop = driveRpcLoop(
      runner,
      commandStream([
        { type: "start" },
        { type: "bogus" } as unknown as TurnRunnerCommand,
        { type: "prompt", message: "hi", behavior: "follow_up" },
      ]),
      { emit: sink.emit },
    );
    await new Promise((resolve) => setImmediate(resolve));
    runner.resolveTurn(terminal);
    await loop;
    expect(runner.turns).toEqual([{ type: "prompt", message: "hi", behavior: "follow_up" }]);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.message).toMatch(/Unknown RPC command type/i);
  });

  test("forwards extra prompt/answer/wake commands mid-turn so the runner can queue them", async () => {
    // The runner is the source of truth for command sequencing: repeated
    // turn() calls extend or queue behind the active chain and the chain
    // emits exactly one terminal. The RPC loop must not pre-empt that
    // contract by rejecting additional turn-driving commands.
    const runner = buildRunner();
    const terminal: TurnTerminalEvent = {
      type: "complete",
      status: "completed",
      state: {} as never,
    };
    const first = { type: "prompt" as const, message: "one", behavior: "follow_up" as const };
    const second = { type: "prompt" as const, message: "two", behavior: "follow_up" as const };
    const wake = { type: "wake" as const };
    const third = { type: "prompt" as const, message: "three", behavior: "steer" as const };
    const fourth = { type: "prompt" as const, message: "four", behavior: "follow_up" as const };
    const loop = driveRpcLoop(
      runner,
      commandStream([{ type: "start" }, first, second, wake, third, fourth]),
    );
    // Let the loop drain stdin before the turn resolves.
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(runner.turns).toEqual([first, second, wake, third, fourth]);
    runner.resolveTurn(terminal);
    await loop;
  });
});
