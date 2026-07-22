import { describe, expect, test, spyOn } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  RpcEventWriter,
  driveRpcLoop,
  parseRpcArgs,
  parseRpcCommandLine,
  shouldEmitFatalTerminal,
  type RpcRunner,
  type RpcWritable,
} from "../src/cli/rpc.js";
import { buildCliTurnConfig } from "../src/cli/run.js";
import { MemoryDb } from "../src/cli/memory-db.js";
import { appendObservation, loadStoredMemory } from "../src/memory/storage.js";
import { writeEntry } from "../src/memory/store/store.js";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";
import { testIfDocker } from "./helpers/docker-only.js";
import type {
  RpcCommandAcceptedEvent,
  RpcRunnerCommand,
  TurnCompactCommand,
  TurnEditFollowUpQueueCommand,
  TurnInterruptCommand,
  TurnRunnerCommand,
  TurnState,
  TurnSystemEvent,
  TurnTerminalEvent,
} from "../src/types/protocol.js";
import { ManualRuntimeClock } from "./helpers/manual-runtime-clock.js";

class BackpressuredWritable implements RpcWritable {
  readonly lines: string[] = [];
  private drainListener?: () => void;
  blocked = true;

  write(chunk: string): boolean {
    this.lines.push(chunk);
    return !this.blocked;
  }

  once(event: "drain", listener: () => void): this {
    if (event === "drain") this.drainListener = listener;
    return this;
  }

  release(): void {
    this.blocked = false;
    this.drainListener?.();
    this.drainListener = undefined;
  }
}

/**
 * Async iterable helper for `driveRpcLoop`. Pulling from an array makes the
 * loop's phase transitions easy to assert: each yielded value is a single
 * stdin line the loop would have read.
 */
function commandStream(commands: RpcRunnerCommand[]): AsyncIterable<RpcRunnerCommand> {
  return (async function* () {
    for (const command of commands) yield command;
  })();
}

interface RecordedRunner extends RpcRunner {
  starts: Array<Extract<TurnRunnerCommand, { type: "start" }>>;
  turns: Array<Extract<TurnRunnerCommand, { type: "prompt" | "answer" | "wake" }>>;
  interrupts: TurnInterruptCommand[];
  editQueues: TurnEditFollowUpQueueCommand[];
  compacts: TurnCompactCommand[];
  acceptNextTurn: () => void;
  resolveTurn: (terminal: TurnTerminalEvent) => void;
}

/**
 * Capture the {@link TurnSystemEvent}s the dispatch loop emits for soft
 * protocol errors (malformed commands, premature commands before start,
 * unknown command types). Used in lieu of the older fatal-exit assertions.
 */
function buildEventSink(): {
  emit: (event: TurnSystemEvent | RpcCommandAcceptedEvent) => void;
  events: TurnSystemEvent[];
} {
  const events: TurnSystemEvent[] = [];
  return {
    events,
    emit: (event) => {
      if (event.type === "system") events.push(event);
    },
  };
}

/**
 * In-memory {@link RpcRunner} that records dispatched commands and exposes a
 * `resolveTurn` hook so tests can decide when the in-flight turn settles. This
 * lets us assert that mid-turn commands reach the runner before the terminal
 * event.
 */
function buildRunner(): RecordedRunner {
  let resolveTurn!: (terminal: TurnTerminalEvent) => void;
  const pendingAcceptances: Array<() => void> = [];
  const turnPromise = new Promise<TurnTerminalEvent>((resolve) => {
    resolveTurn = resolve;
  });
  const runner: RecordedRunner = {
    starts: [],
    turns: [],
    interrupts: [],
    editQueues: [],
    compacts: [],
    acceptNextTurn() {
      pendingAcceptances.shift()?.();
    },
    resolveTurn,
    async start(command) {
      runner.starts.push(command);
    },
    async turn(command, onAccepted) {
      runner.turns.push(command);
      if (onAccepted) pendingAcceptances.push(onAccepted);
      return turnPromise;
    },
    interrupt(command) {
      runner.interrupts.push(command);
    },
    editFollowUpQueue(command) {
      runner.editQueues.push(command);
    },
    compact(command) {
      runner.compacts.push(command);
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
  });

  test("expands a leading ~ in --workdir to the user's home directory", () => {
    const home = homedir();
    expect(parseRpcArgs(["--workdir", "~/code/foo"]).workDir).toBe(join(home, "code/foo"));
    expect(parseRpcArgs(["-w", "~"]).workDir).toBe(home);
    // Non-tilde paths pass through unchanged so relative workdirs still
    // resolve against the spawning shell's cwd.
    expect(parseRpcArgs(["--workdir", "/abs/path"]).workDir).toBe("/abs/path");
    expect(parseRpcArgs(["--workdir", "relative/path"]).workDir).toBe("relative/path");
  });

  test("--db sets an explicit memory database path", () => {
    const parsed = parseRpcArgs(["--db", "/tmp/custom.db"]);
    expect(parsed.dbPath).toBe("/tmp/custom.db");
  });

  test("--session captures the caller-owned attribution id", () => {
    const parsed = parseRpcArgs(["--session", "sess_rpc_1"]);
    expect(parsed.sessionId).toBe("sess_rpc_1");
  });

  test("omitting --session leaves sessionId undefined", () => {
    expect(parseRpcArgs([]).sessionId).toBeUndefined();
  });

  test("--session requires a value", () => {
    const exitSpy = stubProcessExit();
    try {
      expect(() => parseRpcArgs(["--session"])).toThrow();
    } finally {
      exitSpy.mockRestore();
    }
  });

  test("omitting --db leaves dbPath undefined so the default applies", () => {
    const parsed = parseRpcArgs([]);
    expect(parsed.dbPath).toBeUndefined();
  });

  test("--no-skill-sync is accepted as a deprecated no-op", () => {
    // Tolerated so host scripts that pass it do not break.
    expect(() => parseRpcArgs(["--no-skill-sync"])).not.toThrow();
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
    const ok = parseRpcArgs(["--provider", "openrouter"]);
    expect(ok.modelName).toBeDefined();
    expect(ok.memoryModelName).toBeDefined();

    const exitSpy = stubProcessExit();
    try {
      expect(() => parseRpcArgs(["--provider", "openrouter", "--model", "gpt-5.5"])).toThrow();
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

describe("RPC --session attribution", () => {
  test("buildCliTurnConfig threads the parsed --session id onto config.sessionId", () => {
    // Mirror the construction runRpcCommand performs: the parsed spawn flag
    // must land on config.sessionId *before* `new TurnRunner(config)`, since
    // RPC reads the first `start` command only after the runner exists.
    const parsed = parseRpcArgs(["--rpc", "--session", "sess_rpc_2", "--db", "/tmp/x.db"]);
    const { config } = buildCliTurnConfig(
      {
        incognito: parsed.incognito,
        ...(parsed.dbPath ? { dbPath: parsed.dbPath } : {}),
        ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
        workDir: parsed.workDir,
      },
      new Set(),
    );
    expect(config.sessionId).toBe("sess_rpc_2");
    expect(config.memoryDbPath).toBe("/tmp/x.db");
  });

  test("buildCliTurnConfig leaves sessionId unset when --session is omitted", () => {
    const parsed = parseRpcArgs(["--rpc", "--db", "/tmp/x.db"]);
    const { config } = buildCliTurnConfig(
      {
        incognito: parsed.incognito,
        ...(parsed.dbPath ? { dbPath: parsed.dbPath } : {}),
        ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
        workDir: parsed.workDir,
      },
      new Set(),
    );
    expect(config.sessionId).toBeUndefined();
  });

  testIfDocker("a memory written during an RPC session carries the --session id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duet-rpc-session-"));
    const dbPath = join(dir, "memory.db");
    try {
      // Build the exact config runRpcCommand hands to `new TurnRunner(config)`.
      const parsed = parseRpcArgs(["--rpc", "--session", "sess_rpc_write", "--db", dbPath]);
      const { config } = buildCliTurnConfig(
        {
          incognito: parsed.incognito,
          ...(parsed.dbPath ? { dbPath: parsed.dbPath } : {}),
          ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
          workDir: parsed.workDir,
        },
        new Set(),
      );
      expect(config.sessionId).toBe("sess_rpc_write");

      // Open the same db the runner opens and write through the production
      // storage helper with `config.sessionId` — the exact value the runner's
      // post-turn memory write passes at its `sessionId: this.config.sessionId`
      // site. Proves the spawn flag reaches a persisted observation.
      const persistence = await loadStoredMemory(config.memoryDbPath as string, config.cwd!, {});
      const now = new Date().toISOString();
      await appendObservation(persistence.session!, {
        kind: "observation",
        ...(config.sessionId !== undefined ? { sessionId: config.sessionId } : {}),
        observedDate: now.slice(0, 10),
        priority: "medium",
        source: { kind: "system" },
        content: "RPC turn recorded a durable fact.",
        tags: ["observational-memory"],
      });
      await persistence.dispose();

      // Reopen independently and prove the stored row carries the session id.
      const db = await MemoryDb.open(dbPath);
      try {
        const stored = await db.listRanked({ limit: 25, offset: 0 });
        expect(stored).toHaveLength(1);
        expect(stored[0]!.sessionId).toBe("sess_rpc_write");
        expect(stored[0]!.content).toBe("RPC turn recorded a durable fact.");
      } finally {
        await db.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("RPC project routing", () => {
  testIfDocker(
    "gateway argv loads nearest and inherited store content into a real turn",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "duet-rpc-stored-context-"));
      const workDir = join(root, "agents", "researcher", "work");
      const nearestStore = join(root, "agents", "researcher", ".agents", "memories");
      const rootStore = join(root, ".agents", "memories");
      const dbPath = join(root, "memory.db");
      const requests: unknown[] = [];
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          requests.push(await request.json());
          return anthropicFixtureResponse(requests.length === 1 ? "actor" : "observer");
        },
      });
      try {
        await mkdir(workDir, { recursive: true });
        await writeEntry(rootStore, rpcStoreEntry("root", 1, "ROOT INHERITED MEMORY"));
        await writeEntry(rootStore, rpcStoreEntry("shared", 4, "SHADOWED ROOT MEMORY"));
        await writeEntry(nearestStore, rpcStoreEntry("nearest", 2, "NEAREST AGENT MEMORY"));
        await writeEntry(nearestStore, rpcStoreEntry("shared", 3, "NEAREST COLLISION WINNER"));

        const proc = Bun.spawn(
          [
            "bun",
            "src/cli.ts",
            "--rpc",
            "--session",
            "sess_store_gateway",
            "--db",
            dbPath,
            "--workdir",
            workDir,
            "--model",
            "duet:anthropic/claude-haiku-4-5",
            "--memory-model",
            "duet:anthropic/claude-haiku-4-5",
            "--no-system-prompt-files",
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              DUET_API_KEY: "duet_gt_test",
              DUET_GATEWAY_BASE_URL: server.url.origin,
            },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        proc.stdin.write(`${JSON.stringify({ type: "start" })}\n`);
        proc.stdin.write(
          `${JSON.stringify({ type: "prompt", requestId: "req_store", message: "Use the context.", behavior: "follow_up" })}\n`,
        );
        proc.stdin.end();

        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(exitCode, `${stderr}\n${stdout}`).toBe(0);
        const actorRequest = JSON.stringify(requests[0]);
        expect(actorRequest).toContain("ROOT INHERITED MEMORY");
        expect(actorRequest).toContain("NEAREST AGENT MEMORY");
        expect(actorRequest).toContain("NEAREST COLLISION WINNER");
        expect(actorRequest).not.toContain("SHADOWED ROOT MEMORY");
      } finally {
        server.stop(true);
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  testIfDocker("boots from the project routing table's default tier", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "duet-rpc-routing-"));
    try {
      const table = structuredClone(BUILT_IN_ROUTING_TABLE);
      table.defaultTier = "project-default";
      table.tiers = { "project-default": table.tiers.economy! };
      await mkdir(join(workDir, ".duet"));
      await writeFile(join(workDir, ".duet", "models.json"), JSON.stringify(table));

      const proc = Bun.spawn(
        [
          "bun",
          "src/cli.ts",
          "--rpc",
          "--incognito",
          "--workdir",
          workDir,
          "--memory-model",
          "openrouter:gpt-5.4-mini",
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, DUET_API_KEY: "duet_gt_test" },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      proc.stdin.write(`${JSON.stringify({ type: "start" })}\n`);
      proc.stdin.end();

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      const events = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; state?: TurnState });
      const started = events.find((event) => event.type === "turn_started");
      expect(started?.state?.options?.model).toBe("project-default");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

function rpcStoreEntry(slug: string, createdAt: number, content: string) {
  return {
    slug,
    version: 1 as const,
    id: `mem_${slug}_${createdAt}`,
    kind: "train" as const,
    createdAt,
    content,
  };
}

function anthropicFixtureResponse(kind: "actor" | "observer"): Response {
  const contentBlock =
    kind === "actor"
      ? {
          start: { type: "text", text: "" },
          delta: { type: "text_delta", text: "done" },
          stopReason: "end_turn",
        }
      : {
          start: { type: "tool_use", id: "tool_observer", name: "recordObservations", input: {} },
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({ hasMemory: false, observations: "" }),
          },
          stopReason: "tool_use",
        };
  const events = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: `msg_${kind}`,
          type: "message",
          role: "assistant",
          model: "anthropic/claude-haiku-4-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: contentBlock.start },
    ],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: contentBlock.delta }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: contentBlock.stopReason, stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ] as const;
  const body = events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
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

  test("rejects turn-driving commands without a non-empty requestId", () => {
    for (const line of [
      '{"type":"prompt","message":"hello","behavior":"steer"}',
      '{"type":"answer","requestId":"","questions":[],"answers":{},"behavior":"steer"}',
      '{"type":"wake","requestId":"   "}',
    ]) {
      const result = parseRpcCommandLine(line);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") throw new Error("unreachable");
      expect(result.message).toMatch(/requestId/);
    }
  });
});

describe("RpcEventWriter", () => {
  test("keeps task and terminal events ordered while dropping queued heartbeats under backpressure", async () => {
    const clock = new ManualRuntimeClock(1_000);
    const stream = new BackpressuredWritable();
    const writer = new RpcEventWriter(stream, clock);

    writer.emit({
      type: "task_started",
      task: {
        id: "t1",
        kind: "tool",
        name: "long job",
        label: "Run a long job",
        ownerScopeId: "turn-1",
        status: "running",
        startedAt: clock.now(),
      },
    });
    await clock.advanceBy(30_000);
    writer.emit({ type: "command_accepted", requestId: "request-1", commandType: "prompt" });
    writer.emit({
      type: "task_settled",
      settlement: {
        id: "t1",
        status: "completed",
        settledAt: clock.now(),
        result: "done",
      },
    });
    writer.emit({ type: "complete", status: "completed", state: {} as TurnState });

    stream.release();
    await writer.flush();

    expect(stream.lines.map((line) => JSON.parse(line).type)).toEqual([
      "task_started",
      "command_accepted",
      "task_settled",
      "complete",
    ]);
  });

  test("emits clock-driven heartbeats unconditionally until the terminal", async () => {
    const clock = new ManualRuntimeClock(5_000);
    const lines: string[] = [];
    const writer = new RpcEventWriter(
      {
        write(chunk) {
          lines.push(chunk);
          return true;
        },
        once() {
          return this;
        },
      },
      clock,
    );

    writer.emit({
      type: "task_started",
      task: {
        id: "t4",
        kind: "subagent",
        name: "background research",
        label: "Research in the background",
        ownerScopeId: "turn-1",
        status: "running",
        startedAt: clock.now(),
      },
    });
    await clock.advanceBy(15_000);
    writer.emit({
      type: "task_settled",
      settlement: {
        id: "t4",
        status: "completed",
        settledAt: clock.now(),
        result: "done",
      },
    });
    await clock.advanceBy(30_000);
    writer.emit({
      type: "complete",
      status: "completed",
      state: { status: "completed", mode: "agent", agent: {} as TurnState["agent"] },
    });
    await clock.advanceBy(30_000);
    await writer.flush();

    const events = lines.map((line) => JSON.parse(line));
    // Heartbeats flow with AND without active tasks (absence = wedged process);
    // the terminal stops them because the process exits right after.
    expect(events).toEqual([
      expect.objectContaining({ type: "task_started" }),
      { type: "heartbeat", timestamp: 20_000, activeTaskIds: ["t4"] },
      expect.objectContaining({ type: "task_settled" }),
      { type: "heartbeat", timestamp: 35_000, activeTaskIds: [] },
      { type: "heartbeat", timestamp: 50_000, activeTaskIds: [] },
      expect.objectContaining({ type: "complete" }),
    ]);
    const afterTerminal = events.filter((event) => event.type === "heartbeat").length;
    expect(afterTerminal).toBe(3);
  });
});

describe("fatal terminal guard", () => {
  test("does not fabricate quiescence while a recovered runner still has open work", () => {
    const base = {
      status: "running",
      mode: "agent",
      agent: {} as TurnState["agent"],
    } satisfies TurnState;
    expect(
      shouldEmitFatalTerminal({
        ...base,
        tasks: [
          {
            id: "t9",
            kind: "tool",
            name: "still live",
            label: "Still live",
            ownerScopeId: "turn-1",
            status: "running",
            startedAt: 1,
          },
        ],
      }),
    ).toBe(false);
    expect(shouldEmitFatalTerminal({ ...base, tasks: [] })).toBe(true);
    expect(shouldEmitFatalTerminal(undefined)).toBe(false);
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
      commandStream([
        { type: "start" },
        { type: "prompt", requestId: "request-1", message: "hi", behavior: "follow_up" },
      ]),
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
        {
          type: "prompt",
          requestId: "request-before",
          message: "too early",
          behavior: "follow_up",
        },
        { type: "start" },
        {
          type: "prompt",
          requestId: "request-after",
          message: "after start",
          behavior: "follow_up",
        },
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
        { type: "prompt", requestId: "request-1", message: "go", behavior: "follow_up" },
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

  test("routes compact mid-turn into the runner without ending the chain", async () => {
    const runner = buildRunner();
    const terminal: TurnTerminalEvent = {
      type: "complete",
      status: "completed",
      state: {} as never,
    };
    const compactCommand: TurnCompactCommand = { type: "compact" };
    const loop = driveRpcLoop(
      runner,
      commandStream([
        { type: "start" },
        { type: "prompt", requestId: "request-1", message: "go", behavior: "follow_up" },
        compactCommand,
      ]),
    );
    // Let the loop consume every queued stdin command before resolving the
    // in-flight turn. compact is out-of-band so it must not end the chain;
    // the only way the loop exits is the explicit terminal we resolve below.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(runner.compacts).toEqual([compactCommand]);
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
        { type: "prompt", requestId: "request-1", message: "hi", behavior: "follow_up" },
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
        { type: "bogus" } as unknown as RpcRunnerCommand,
        { type: "prompt", requestId: "request-1", message: "hi", behavior: "follow_up" },
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
    const first = {
      type: "prompt" as const,
      requestId: "request-1",
      message: "one",
      behavior: "follow_up" as const,
    };
    const second = {
      type: "prompt" as const,
      requestId: "request-2",
      message: "two",
      behavior: "follow_up" as const,
    };
    const wake = { type: "wake" as const, requestId: "request-3" };
    const third = {
      type: "prompt" as const,
      requestId: "request-4",
      message: "three",
      behavior: "steer" as const,
    };
    const fourth = {
      type: "prompt" as const,
      requestId: "request-5",
      message: "four",
      behavior: "follow_up" as const,
    };
    const loop = driveRpcLoop(
      runner,
      commandStream([{ type: "start" }, first, second, wake, third, fourth]),
    );
    // Let the loop drain stdin before the turn resolves.
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(runner.turns).toEqual([
      { type: "prompt", message: "one", behavior: "follow_up" },
      { type: "prompt", message: "two", behavior: "follow_up" },
      { type: "wake" },
      { type: "prompt", message: "three", behavior: "steer" },
      { type: "prompt", message: "four", behavior: "follow_up" },
    ]);
    runner.resolveTurn(terminal);
    await loop;
  });

  test("acknowledges a correlated prompt only after the runner accepts it", async () => {
    const runner = buildRunner();
    const events: unknown[] = [];
    const terminal: TurnTerminalEvent = {
      type: "complete",
      status: "completed",
      state: {} as never,
    };
    const command = {
      type: "prompt" as const,
      requestId: "request-1",
      message: "hello",
      behavior: "steer" as const,
    };

    const loop = driveRpcLoop(runner, commandStream([{ type: "start" }, command]), {
      emit: (event) => events.push(event),
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(runner.turns).toEqual([{ type: "prompt", message: "hello", behavior: "steer" }]);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "command_accepted" }));
    runner.acceptNextTurn();
    expect(events).toContainEqual({
      type: "command_accepted",
      requestId: "request-1",
      commandType: "prompt",
    });

    runner.resolveTurn(terminal);
    await loop;
  });
});
