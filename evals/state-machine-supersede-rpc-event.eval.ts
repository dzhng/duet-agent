import { describe, expect } from "bun:test";
import dedent from "dedent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnEvent, TurnRunnerCommand } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * RPC-mode coverage for the create-while-active reset (supersede) path.
 *
 * `evals/state-machine-create-while-active-reset.eval.ts` proves the supersede
 * behavior against an in-process `TurnRunner`. This eval proves the same flow
 * over the real `duet --rpc` wire: a host driving the runner through stdin/
 * stdout must actually SEE the supersede happen as a `state_machine` event
 * carrying the superseded machine's `cancelled` terminal. The relay/board card
 * in chat-app is rendered off those `state_machine` events, so if the event is
 * never emitted (or omits the terminal), the superseded machine would silently
 * stay "running" in the consumer's UI even though the runner moved on.
 *
 * The model creates "active_machine", then deliberately creates a second
 * machine while the first is still active with `replaceActive: true`. The eval
 * asserts a `state_machine` event was emitted on the wire whose definition is
 * "active_machine" and whose terminal status is `cancelled`.
 *
 * Expected RED if supersede stops emitting the terminal event: no
 * `state_machine` event carries `active_machine` with a `cancelled` terminal.
 */
describe("RPC create-while-active supersede emits a cancelled state_machine event", () => {
  testIfDocker(
    "emits a state_machine event carrying the superseded machine's cancelled terminal",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "duet-rpc-supersede-"));
      try {
        const session = await runRpcSession(
          ["--workdir", workDir, "--incognito", "--model", model],
          [
            { type: "start", mode: "auto" },
            {
              type: "prompt",
              behavior: "follow_up",
              message: dedent`
                You are in a live eval that deliberately exercises the
                create-while-active reset path. Do not read, edit, or run
                anything outside the state-machine tools. Follow this script
                EXACTLY, including the intentional create-while-active in step
                2 — it is required for the test and must not be skipped.

                1. Create a state machine named "active_machine" with exactly
                   two states: an agent state named "work" whose prompt is
                   "reply with the single word: ok", and a terminal state named
                   "done" with status "completed". Use firstState "work" so the
                   runner runs "work" immediately after the create call.
                2. After "work" completes, the runner will wake you to choose
                   the next state. On THIS turn, you have decided to ABANDON
                   "active_machine" and run a different machine instead. Call
                   create_state_machine_definition to create a machine named
                   "second_machine" with one agent state named "noop" (prompt
                   "reply with the single word: ok") and a terminal state named
                   "second_done" with status "completed", using firstState
                   "noop". Because a machine is still active, you MUST pass
                   replaceActive: true to replace it — that is the intended
                   behavior here.
                3. After "noop" completes on "second_machine", the runner will
                   wake you to choose the next state. Select the terminal state
                   "second_done" to finish cleanly.
                4. Do not make any other tool calls.
              `,
            },
          ],
        );

        expect(session.exitCode).toBe(0);

        // The supersede must surface on the wire as a state_machine event for
        // "active_machine" whose terminal resolved to `cancelled`. This is the
        // signal a host (chat-app's relay card) reads to stop showing the old
        // machine as running.
        const supersededEvent = session.events.find(
          (event) =>
            event.type === "state_machine" &&
            event.stateMachine.definition.name === "active_machine" &&
            event.stateMachine.terminal?.status === "cancelled",
        );
        expect(
          supersededEvent,
          `Expected a state_machine event for "active_machine" with a cancelled terminal. Saw state_machine events: ${JSON.stringify(
            session.events
              .filter((event) => event.type === "state_machine")
              .map((event) => ({
                name: event.stateMachine.definition.name,
                terminal: event.stateMachine.terminal?.status ?? null,
              })),
          )}`,
        ).toBeDefined();

        // The replacement machine must become the running session and reach
        // its own completed terminal, proving the reset installed it rather
        // than being rejected.
        const terminal = expectTerminal(session.events);
        expect(terminal.type).toBe("complete");
        if (terminal.type === "complete") {
          expect(terminal.status).toBe("completed");
          expect(terminal.state.stateMachine?.definition?.name).toBe("second_machine");
          expect(terminal.state.stateMachine?.terminal?.status).toBe("completed");
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    240_000,
  );
});

interface RpcSessionResult {
  exitCode: number;
  events: TurnEvent[];
}

/**
 * Spawn `duet --rpc`, feed the commands to stdin as newline-delimited JSON,
 * and return the parsed stdout transcript. `--no-skill-sync` skips the
 * duet.so default-skill fetch the CLI runs at startup when DUET_API_KEY is
 * set — this eval asserts RPC state-machine events, not that side effect.
 */
async function runRpcSession(
  args: string[],
  commands: TurnRunnerCommand[],
): Promise<RpcSessionResult> {
  const proc = Bun.spawn(["bun", "src/cli.ts", "--rpc", "--no-skill-sync", ...args], {
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
  // Drain stderr so the buffer cannot stall the subprocess; not asserted on.
  void new Response(proc.stderr).text();
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const events = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TurnEvent);
  return { exitCode, events };
}

function expectTerminal(
  events: TurnEvent[],
): Extract<TurnEvent, { type: "complete" | "ask" | "interrupted" | "sleep" }> {
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
  throw new Error(`No terminal event in RPC output. Saw: ${events.map((e) => e.type).join(",")}`);
}
