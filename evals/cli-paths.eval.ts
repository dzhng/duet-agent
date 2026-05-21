import { describe, expect } from "bun:test";
import dedent from "dedent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CLI_MEMORY_MODEL } from "../src/model-resolution/resolver.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";
import { judge } from "../test/helpers/judge.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";
const memoryModel = process.env.EVAL_MEMORY_MODEL ?? DEFAULT_CLI_MEMORY_MODEL;

describe("CLI production paths", () => {
  testIfDocker(
    "observes memory through the JSONL CLI path",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "duet-cli-memory-"));
      try {
        const marker = "cli-memory-marker-742";
        const result = await runCliEvents([
          "--workdir",
          workDir,
          "--model",
          model,
          "--memory-model",
          memoryModel,
          dedent`
            Remember that ${marker} belongs to the CLI memory eval.
            Reply in one sentence that you have noted the marker.
          `,
        ]);

        expect(result.exitCode).toBe(0);
        expect(result.events.some((event) => event.type === "memory")).toBe(true);
        const judgment = await judge({
          model,
          prompt: dedent`
            The CLI event transcript must show a successful prompt run and a completed
            memory observation for the user-provided marker ${marker}. The memory
            observation may appear either as a completed memory event payload or as a
            completed no-op observation after the model decided there was nothing new
            to persist.
          `,
          value: summarizeCliRun(result.events),
        });
        expect(judgment.valid, judgment.reason).toBe(true);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  testIfDocker(
    "runs a script state machine through the JSONL CLI path",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "duet-cli-state-machine-"));
      try {
        const marker = "cli-script-marker-913";
        const result = await runCliEvents([
          "--workdir",
          workDir,
          "--model",
          model,
          "--incognito",
          "--system-prompt",
          dedent`
            This is a live eval. Use the state-machine tools, not a plain answer.
            Create a state machine named cli_script_eval with exactly these states:
            1. script state render_marker with command: printf 'marker=${marker}\\nstatus=script-ran\\n'
            2. terminal state done with status completed.
            Start with render_marker. After render_marker completes, select done.
            Do not ask the user questions.
          `,
          `Run the CLI script state-machine eval for marker ${marker}.`,
        ]);

        expect(result.exitCode).toBe(0);
        const judgment = await judge({
          model,
          prompt: dedent`
            The CLI event transcript must show that the agent used a state machine,
            executed a script state, completed successfully, and preserved script
            output containing marker ${marker} and status=script-ran.
          `,
          value: summarizeCliRun(result.events),
        });
        expect(judgment.valid, judgment.reason).toBe(true);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    240_000,
  );
});

async function runCliEvents(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  events: TurnEvent[];
}> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // The eval asserts CLI behavior, not default skill sync behavior.
      DUET_API_KEY: "",
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    exitCode,
    stdout,
    stderr,
    events: parseJsonEvents(stdout),
  };
}

function parseJsonEvents(stdout: string): TurnEvent[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TurnEvent);
}

function summarizeCliRun(events: TurnEvent[]): unknown {
  const terminal = findLastTerminal(events);
  return {
    eventTypes: events.map((event) => event.type),
    memoryEvents: events.filter((event) => event.type === "memory"),
    stateMachineEvents: events.filter((event) => event.type === "state_machine"),
    terminal,
    stateMachineHistory: terminal?.state.stateMachine?.history,
    result: terminal && "result" in terminal ? terminal.result : undefined,
    error: terminal && "error" in terminal ? terminal.error : undefined,
  };
}

function findLastTerminal(
  events: TurnEvent[],
): Extract<TurnEvent, { type: "complete" | "ask" | "interrupted" | "sleep" }> | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (
      event?.type === "complete" ||
      event?.type === "ask" ||
      event?.type === "interrupted" ||
      event?.type === "sleep"
    ) {
      return event;
    }
  }
  return undefined;
}
