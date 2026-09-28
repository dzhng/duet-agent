import { expect, test } from "bun:test";
import { repeatedSelectionLoopCount } from "../src/turn-runner/state-machine-session.js";
import type {
  StateMachineSession,
  StateMachineSessionEvent,
  StateMachineExecutionReceipt,
} from "../src/types/state-machine.js";

function receipt(id: string, fingerprint = "same", state = "work"): StateMachineExecutionReceipt {
  return {
    id,
    state,
    kind: "agent",
    fingerprint,
    cwd: "/work",
    forkContext: false,
    suppliedInputKeys: [],
    renderedInputKeys: [],
    persistOverride: false,
    preview: "Work.",
    previewTruncated: false,
  };
}
function cycle(
  execution: StateMachineExecutionReceipt,
  timestamp: number,
): StateMachineSessionEvent[] {
  return [
    { type: "runner_decided", timestamp, decision: { state: execution.state }, execution },
    { type: "state_started", timestamp, state: execution.state, execution },
    {
      type: "state_completed",
      timestamp,
      state: execution.state,
      output: { result: "same result" },
    },
  ];
}
function session(history: StateMachineSessionEvent[]): StateMachineSession {
  return {
    definition: {
      name: "retries",
      prompt: "Work.",
      states: [
        { kind: "agent", name: "work", prompt: "Work." },
        { kind: "agent", name: "other", prompt: "Other." },
      ],
    },
    prompt: "Work.",
    currentState: "work",
    history,
    createdAt: 0,
    updatedAt: 0,
  };
}

test("three identical settled attempts warn even when slow and alternating", () => {
  const history = [
    ...cycle(receipt("t1"), 0),
    ...cycle(receipt("t2", "other", "other"), 1000),
    ...cycle(receipt("t3"), 60 * 60_000),
    ...cycle(receipt("t4", "other", "other"), 61 * 60_000),
    ...cycle(receipt("t5"), 120 * 60_000),
  ];
  expect(repeatedSelectionLoopCount(session(history), "work")).toBe(3);
});

test("changed effective work resets the state's streak", () => {
  const history = [
    ...cycle(receipt("t1"), 0),
    ...cycle(receipt("t2"), 1),
    ...cycle(receipt("t3", "changed"), 2),
    ...cycle(receipt("t4"), 3),
  ];
  expect(repeatedSelectionLoopCount(session(history), "work")).toBeUndefined();
});

test("legacy, unstarted, and evicted attempts are unknown", () => {
  const legacy: StateMachineSessionEvent[] = [
    { type: "state_started", state: "work", timestamp: 0 },
    { type: "state_completed", state: "work", timestamp: 1 },
  ];
  expect(
    repeatedSelectionLoopCount(
      session([...legacy, ...cycle(receipt("t1"), 2), ...cycle(receipt("t2"), 3)]),
      "work",
    ),
  ).toBeUndefined();
  const failedAdmission: StateMachineSessionEvent[] = [
    { type: "runner_decided", timestamp: 2, decision: { state: "work" } },
    { type: "state_failed", timestamp: 3, state: "work", error: "Not admitted" },
  ];
  expect(
    repeatedSelectionLoopCount(
      session([
        ...cycle(receipt("t1"), 0),
        ...failedAdmission,
        ...cycle(receipt("t2"), 4),
        ...cycle(receipt("t3"), 5),
      ]),
      "work",
    ),
  ).toBeUndefined();
  const evicted = [
    ...cycle(receipt("t1"), 0),
    ...cycle(receipt("t2"), 1),
    ...cycle(receipt("t3"), 2),
  ].slice(3);
  expect(repeatedSelectionLoopCount(session(evicted), "work")).toBeUndefined();
});

test("poll and timer cadence never enters the immediate-work diagnostic", () => {
  for (const state of [
    { kind: "poll", name: "work", command: "check", intervalMs: 1000 },
    { kind: "timer", name: "work", wakeAfterMs: 1000 },
  ] as const) {
    const saved = session([
      ...cycle(receipt("t1"), 0),
      ...cycle(receipt("t2"), 1),
      ...cycle(receipt("t3"), 2),
    ]);
    saved.definition.states = [state];
    expect(repeatedSelectionLoopCount(saved, "work")).toBeUndefined();
  }
});
