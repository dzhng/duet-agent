import { describe, expect, test, spyOn } from "bun:test";
import { driveRpcLoop, parseRpcArgs, parseRpcCommandLine, type RpcRunner } from "../src/cli/rpc.js";
import type {
  TurnEditFollowUpQueueCommand,
  TurnInterruptCommand,
  TurnRunnerCommand,
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
  test("returns undefined for blank/whitespace lines so the iterator can skip them", () => {
    expect(parseRpcCommandLine("")).toBeUndefined();
    expect(parseRpcCommandLine("   \t  ")).toBeUndefined();
  });

  test("parses a well-formed JSON command", () => {
    const parsed = parseRpcCommandLine('{"type":"start"}');
    expect(parsed).toEqual({ type: "start" });
  });

  test("rejects malformed JSON", () => {
    const exitSpy = stubProcessExit();
    try {
      expect(() => parseRpcCommandLine("{not json")).toThrow();
    } finally {
      exitSpy.mockRestore();
    }
  });

  test("rejects valid JSON without a string `type` field", () => {
    const exitSpy = stubProcessExit();
    try {
      expect(() => parseRpcCommandLine('{"foo":"bar"}')).toThrow();
      expect(() => parseRpcCommandLine('"plain string"')).toThrow();
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("driveRpcLoop", () => {
  test("returns cleanly when stdin closes before any command arrives", async () => {
    const runner = buildRunner();
    await driveRpcLoop(runner, commandStream([]));
    expect(runner.starts).toHaveLength(0);
    expect(runner.turns).toHaveLength(0);
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

  test("aborts when the first command is not start", async () => {
    const exitSpy = stubProcessExit();
    try {
      const runner = buildRunner();
      await expect(
        driveRpcLoop(
          runner,
          commandStream([{ type: "prompt", message: "hi", behavior: "follow_up" }]),
        ),
      ).rejects.toThrow();
      expect(runner.starts).toHaveLength(0);
    } finally {
      exitSpy.mockRestore();
    }
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

  test("rejects a second start command", async () => {
    const exitSpy = stubProcessExit();
    try {
      const runner = buildRunner();
      await expect(
        driveRpcLoop(runner, commandStream([{ type: "start" }, { type: "start" }])),
      ).rejects.toThrow();
    } finally {
      exitSpy.mockRestore();
    }
  });

  test("rejects extra turn-driving commands sent mid-turn", async () => {
    const exitSpy = stubProcessExit();
    try {
      const runner = buildRunner();
      const firstPrompt = {
        type: "prompt" as const,
        message: "first",
        behavior: "follow_up" as const,
      };
      const loopPromise = driveRpcLoop(
        runner,
        commandStream([
          { type: "start" },
          firstPrompt,
          { type: "prompt", message: "second", behavior: "steer" },
        ]),
      );
      await expect(loopPromise).rejects.toThrow();
      expect(runner.turns).toEqual([firstPrompt]);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
