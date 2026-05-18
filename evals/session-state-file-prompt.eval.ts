import { describe, expect } from "bun:test";
import dedent from "dedent";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * The base system prompt grows a `<session_state_file>` layer right after
 * `<cwd>` that hands the agent the absolute path to its own `state.json`.
 * This eval drives the production CLI in non-TTY JSONL mode (the same path
 * `duet "<prompt>" | jq` exercises) and verifies the agent can read the
 * path back verbatim from its system prompt. We also assert the file
 * actually exists on disk so a future regression that leaks a stale or
 * synthesized path would fail loudly.
 */
describe("session state file system prompt layer", () => {
  testIfDocker(
    "advertises the session state.json path via the CLI JSON event stream",
    async () => {
      const homeDir = await mkdtemp(join(tmpdir(), "duet-session-state-home-"));
      const workDir = await mkdtemp(join(tmpdir(), "duet-session-state-work-"));
      try {
        const result = await runCliEvents(
          [
            "--workdir",
            workDir,
            "--incognito",
            "--no-skill-sync",
            "--model",
            model,
            dedent`
              Look at the <session_state_file> block in your system prompt.
              Reply with exactly one line of the form:

              STATE_FILE=<absolute path>

              where <absolute path> is the value of the "Session state file:"
              path verbatim. Do not add punctuation, markdown, quoting, or any
              other words.
            `,
          ],
          { HOME: homeDir },
        );

        expect(result.exitCode, `CLI exited ${result.exitCode}. stderr=\n${result.stderr}`).toBe(0);
        const terminal = findLastTerminal(result.events);
        expect(terminal?.type, `Expected complete terminal. stderr=\n${result.stderr}`).toBe(
          "complete",
        );
        const reply =
          terminal?.type === "complete" && terminal.result ? terminal.result.trim() : "";
        const match = reply.match(/STATE_FILE=(.+\/state\.json)\s*$/m);
        expect(match, `Expected STATE_FILE=<path>/state.json, got: ${reply}`).toBeTruthy();
        const path = match![1]!;
        // The advertised path must live under the temp HOME's session
        // storage and must actually exist on disk after the run.
        expect(path.startsWith(join(homeDir, ".duet", "sessions"))).toBe(true);
        expect(path.endsWith("/state.json")).toBe(true);
        await access(path);
      } finally {
        await rm(homeDir, { recursive: true, force: true });
        await rm(workDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

async function runCliEvents(
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; events: TurnEvent[] }> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Suppress the on-load default-skill sync so the eval only exercises
      // the base system prompt, not the skills layer.
      ...envOverrides,
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr, events: parseJsonEvents(stdout) };
}

function parseJsonEvents(stdout: string): TurnEvent[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TurnEvent);
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
