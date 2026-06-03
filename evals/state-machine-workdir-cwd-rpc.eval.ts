import { describe, expect } from "bun:test";
import dedent from "dedent";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnEvent, TurnRunnerCommand, TurnTerminalEvent } from "../src/types/protocol.js";
import type { StateMachineSessionEvent } from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * End-to-end proof that a relative per-state `cwd` resolves against the
 * runner's `--workDir` base, not the launching process's cwd.
 *
 * `--workDir` + `--rpc` is the only setup where `config.cwd` genuinely
 * differs from `process.cwd()`: the eval spawns `bun src/cli.ts` from the repo
 * root (process.cwd()) but points `--workdir` at a throwaway temp dir. A
 * script state with the relative cwd `"probe"` and the command
 * `cat sentinel.txt` can only print the sentinel if `"probe"` resolved against
 * the temp `--workdir` (where `probe/sentinel.txt` exists). If it resolved
 * against the repo root instead — the pre-fix runtime behavior — there is no
 * `probe/` directory there and `cat` fails, so the sentinel never appears.
 * The sentinel is an unguessable token planted only inside the temp dir, so
 * the assertion can hold for no other reason.
 */
describe("state machine relative cwd via --workDir + --rpc", () => {
  testIfDocker(
    "resolves a relative script-state cwd against --workDir, not process.cwd()",
    async () => {
      const workDir = await realpath(await mkdtemp(join(tmpdir(), "duet-workdir-cwd-")));
      const sentinel = "WORKDIR_CWD_SENTINEL_7Q2X9";
      try {
        // The probe directory and its sentinel exist ONLY under --workdir.
        // No `probe/` exists at the repo root the CLI process launches from.
        await mkdir(join(workDir, "probe"));
        await writeFile(join(workDir, "probe", "sentinel.txt"), sentinel);

        const session = await runRpcSession(
          ["--workdir", workDir, "--incognito", "--no-skill-sync", "--model", model],
          [
            { type: "start" },
            {
              type: "prompt",
              behavior: "follow_up",
              message: dedent`
                This is a live eval of relative state-cwd resolution. Do exactly
                this and nothing else:

                1. Call create_state_machine_definition once with a definition
                   whose states are:
                   - a script state named "probe" with command "cat sentinel.txt"
                     and cwd set to the RELATIVE path "probe" (exactly that, not
                     an absolute path).
                   - a terminal state named "done" with status "completed".
                   Set firstState to "probe".
                2. The probe script runs automatically. After it completes,
                   call select_state_machine_state to select "done".
                3. Then reply with exactly the stdout the probe script produced
                   and nothing else.

                Never set an absolute cwd. Use the relative path "probe".
              `,
            },
          ],
        );

        expect(session.exitCode).toBe(0);
        const terminal = expectTerminal(session.events);
        expect(terminal.type).toBe("complete");
        expect(terminal.state.stateMachine?.terminal).toMatchObject({
          state: "done",
          status: "completed",
        });

        // The only-if assertion: the probe script's captured stdout contains
        // the sentinel, which is reachable solely by resolving "probe" against
        // --workdir. Exit code 0 confirms `cat` actually found the file rather
        // than erroring on a missing path.
        const probe = scriptOutput(terminal, "probe");
        expect(probe.exitCode).toBe(0);
        expect(probe.stdout).toContain(sentinel);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    240_000,
  );
});

interface ScriptStateOutput {
  stdout: string;
  exitCode: number;
}

/**
 * Pull a completed script state's captured shell output out of the state
 * machine history carried on the terminal event. Script/poll states record
 * `{ stdout, stderr, exitCode, parsed }`; we assert on stdout + exitCode.
 */
function scriptOutput(terminal: TurnTerminalEvent, stateName: string): ScriptStateOutput {
  const history = terminal.state.stateMachine?.history ?? [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index] as StateMachineSessionEvent;
    if (event.type === "state_completed" && event.state === stateName) {
      const output = event.output;
      if (output && typeof output === "object") {
        const stdout = "stdout" in output && typeof output.stdout === "string" ? output.stdout : "";
        const exitCode =
          "exitCode" in output && typeof output.exitCode === "number" ? output.exitCode : -1;
        return { stdout, exitCode };
      }
      return { stdout: output === undefined ? "" : JSON.stringify(output), exitCode: -1 };
    }
  }
  throw new Error(`Expected state_completed for "${stateName}" in state machine history.`);
}

interface RpcSessionResult {
  exitCode: number;
  events: TurnEvent[];
}

/**
 * Spawn `duet --rpc` with `args`, feed the commands to stdin as
 * newline-delimited JSON, and return the parsed stdout transcript. One call is
 * one full CLI process — the unit a real RPC consumer drives.
 */
async function runRpcSession(
  args: string[],
  commands: TurnRunnerCommand[],
): Promise<RpcSessionResult> {
  const proc = Bun.spawn(["bun", "src/cli.ts", "--rpc", ...args], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const sink = proc.stdin;
  for (const command of commands) {
    sink.write(`${JSON.stringify(command)}\n`);
    await sink.flush();
  }
  await sink.end();
  // Drain stderr so the buffer cannot stall the subprocess.
  void new Response(proc.stderr).text();
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const events = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TurnEvent);
  return { exitCode, events };
}

function expectTerminal(events: TurnEvent[]): TurnTerminalEvent {
  for (let index = events.length - 1; index >= 0; index -= 1) {
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
  throw new Error(`No terminal event in RPC output. Saw: ${events.map((e) => e.type).join(",")}`);
}
