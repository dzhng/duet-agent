import { describe, expect, test } from "bun:test";
import assert from "node:assert";
import { createTurnRunner, createStateMachineState } from "./helpers/turn-runner-protocol.js";
import type { TurnState } from "../src/types/protocol.js";

// Coverage for the persist -> restore round-trip of a state-machine session
// across a process/runner restart. snapshotState() embeds the full
// StateMachineController session (currentState/terminal/history/progress) into
// the persisted TurnState (turn-runner.ts:~1196), and start() rehydrates it via
// stateMachineController.hydrate(state.stateMachine) (turn-runner.ts:~474). The
// only in-repo reseed path (turn-runner.ts:~1412) is guarded by
// `!getSession()`, so a snapshot that carried `stateMachine` must win over it
// and can never revert the session to firstState. That guarantee was
// structurally sound but entirely untested before this file.

// Models the host persistence boundary: a real restart serializes the snapshot
// to disk (state.json) and reads it back, so anything not JSON-survivable is
// already lost by the time runner B starts.
function persistThroughHost(state: TurnState): TurnState {
  return JSON.parse(JSON.stringify(state)) as TurnState;
}

describe("TurnRunner state-machine restart restore", () => {
  test("terminal session survives a restart without reverting to firstState", async () => {
    // Runner A: drive a live session from a mid-flight state to a terminal so
    // the snapshot carries real state_started/state_completed/state_machine_completed
    // history rather than a hand-built fixture.
    const { runner: runnerA } = createTurnRunner();
    await runnerA.start({ type: "start", state: createStateMachineState("waiting_for_reply") });
    // [select classify_reply] -> agent state; [none] is consumed by the
    // classify_reply sub-agent worker; [select meeting_scheduled] is the
    // parent's next decision after classify_reply completes, landing terminal.
    runnerA.controlResults.push(
      { type: "select_state_machine_state", decision: { state: "classify_reply" } },
      { type: "none" },
      { type: "select_state_machine_state", decision: { state: "meeting_scheduled" } },
    );

    const terminalEvent = await runnerA.turn({
      type: "prompt",
      message: "She replied yes — book the meeting.",
      behavior: "follow_up",
    });

    const sessionA = terminalEvent.state.stateMachine;
    assert(sessionA, "runner A snapshot must carry a state-machine session");
    assert(sessionA.terminal, "runner A must have reached a terminal");
    expect(sessionA.currentState).toBe("meeting_scheduled");
    expect(sessionA.history).toContainEqual(
      expect.objectContaining({ type: "state_completed", state: "classify_reply" }),
    );
    expect(sessionA.history).toContainEqual(
      expect.objectContaining({ type: "state_machine_completed" }),
    );

    const capturedTerminal = sessionA.terminal;
    const capturedCurrentState = sessionA.currentState;
    const capturedHistory = sessionA.history;
    const restored = persistThroughHost(terminalEvent.state);

    // Runner B is a brand-new runner with no in-memory session — it can only
    // know the terminal/history if the restore path rehydrates the snapshot.
    const { runner: runnerB } = createTurnRunner();
    const startState = await runnerB.start({ type: "start", state: restored });

    const sessionB = startState.stateMachine;
    assert(sessionB, "runner B must rehydrate the carried session");
    expect(sessionB.terminal).toEqual(capturedTerminal);
    // The bug under test reverts currentState to firstState; assert it stays
    // on the terminal state and is explicitly NOT the firstState.
    expect(sessionB.currentState).toBe(capturedCurrentState);
    expect(sessionB.currentState).toBe("meeting_scheduled");
    expect(sessionB.currentState).not.toBe("research_prospect");
    // History must round-trip identically: same length, same ordered entries.
    expect(sessionB.history).toEqual(capturedHistory);
    expect(sessionB.history.length).toBe(capturedHistory.length);
    // A restore must not re-seed firstState: no fresh state_started for it.
    expect(
      sessionB.history.some(
        (event) => event.type === "state_started" && event.state === "research_prospect",
      ),
    ).toBe(false);
    // The controller itself (not just the returned snapshot) holds the terminal.
    expect(runnerB.getState()?.stateMachine?.terminal).toEqual(capturedTerminal);
  });

  test("progressed (non-terminal) session survives a restart and unrelated prompts", async () => {
    // Runner A: drive a poll state to its first sleep so the snapshot carries a
    // genuine progress.nextWakeAt and a state_started entry.
    const { runner: runnerA } = createTurnRunner();
    await runnerA.start({ type: "start", state: createStateMachineState("poll_email_reply") });
    runnerA.controlResults.push({
      type: "select_state_machine_state",
      decision: { state: "poll_email_reply" },
    });

    const sleepEvent = await runnerA.turn({
      type: "prompt",
      message: "Keep polling for her reply.",
      behavior: "follow_up",
    });
    assert(sleepEvent.type === "sleep", "runner A must sleep on the poll state");

    const sessionA = sleepEvent.state.stateMachine;
    assert(sessionA, "runner A snapshot must carry a state-machine session");
    assert(!sessionA.terminal, "progressed session must not be terminal");
    const capturedCurrentState = sessionA.currentState;
    const capturedHistory = sessionA.history;
    const capturedWakeAt = sessionA.progress?.states.poll_email_reply?.nextWakeAt;
    expect(capturedCurrentState).toBe("poll_email_reply");
    expect(capturedWakeAt).toEqual(expect.any(Number));

    // Host resumes the persisted session for a new user prompt: serialize, then
    // mark running so the follow-up turn dispatches like an active session.
    const restored: TurnState = { ...persistThroughHost(sleepEvent.state), status: "running" };

    const { runner: runnerB } = createTurnRunner();
    const startState = await runnerB.start({ type: "start", state: restored });

    const sessionB = startState.stateMachine;
    assert(sessionB, "runner B must rehydrate the carried session");
    expect(sessionB.currentState).toBe(capturedCurrentState);
    expect(sessionB.history).toEqual(capturedHistory);
    expect(sessionB.progress?.states.poll_email_reply?.nextWakeAt).toBe(capturedWakeAt);

    // A follow-up unrelated prompt answers normally without mutating the
    // mid-flight currentState or the recorded wake time.
    const terminal = await runnerB.turn({
      type: "prompt",
      message: "What is the capital of France?",
      behavior: "follow_up",
    });
    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      result: expect.stringContaining("Paris"),
      state: { stateMachine: { currentState: "poll_email_reply" } },
    });
    expect(terminal.state.stateMachine?.terminal).toBeUndefined();
    expect(terminal.state.stateMachine?.progress?.states.poll_email_reply?.nextWakeAt).toBe(
      capturedWakeAt,
    );
  });

  // FALSIFICATION (red/green) — run manually, do not commit enabled:
  // In "terminal session survives a restart" strip the carried session from the
  // restored snapshot:
  //
  //   const restored = { ...persistThroughHost(terminalEvent.state), stateMachine: undefined };
  //
  // Restore here flows through start() -> stateMachineController.hydrate(), so
  // hydrate(undefined) leaves the controller with no session and snapshotState
  // returns stateMachine: undefined. The test then goes RED on
  // `assert(sessionB, "runner B must rehydrate the carried session")`, proving
  // the restore depends on the carried snapshot rather than any reseed.
  // (The :1412 reseed is on the turn() worker-control path, not start(), so it
  // is not what this restore exercises.) The currentState/not-firstState and
  // history assertions guard the related bug where hydrate keeps a session but
  // resets currentState to firstState. Reverting the strip restores GREEN.
  // Verified locally.
});
