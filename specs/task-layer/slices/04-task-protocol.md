# 04 — Task protocol + durable snapshot contract

**Contract unlocked:** hosts (RPC + TUI) can parse task identity/lifecycle before any
behavior exists; the live task set survives snapshots and compaction; late attach can
reconstruct tasks without replaying the transcript. LM-S3, LM-S6 (types half), LM-C1.

**Seam:** `src/types/protocol.ts` (+ wire-shaping, serializer):

- `TurnTaskStartedEvent | TurnTaskOutputEvent | TurnTaskSettledEvent` added to
  `TurnDuringEvent` (~:811-819). `TurnEventOrigin` gains task identity + owner linkage
  (today only `{kind:"state_machine_agent"; state}`, ~:583).
- `TurnState.tasks: TaskDescriptor[]` + `TurnState.nextTaskId` — reuse `src/tasks/types.ts`
  verbatim; NO mirror wire type.
- Type comments document operational meaning: which statuses hold the process awake;
  cumulative vs delta output; how `lost` differs from `stopped`; why descriptors persist but
  promises/controllers don't.
- **Terminal union unchanged** (`ask|complete|interrupted|sleep`, ~:818-822) — task
  vocabulary is during-events only; RPC reap semantics never change shape.
- `compactTurnState` (state-compaction.ts ~:77-109): pin live-task tool-result message pairs
  where possible (note `isInvalidHead` cascades can split call/result pairs — pin the pair),
  but `TurnState.tasks` is the source of truth; `task_output` must never depend on retained
  transcript text.

**Run:** protocol fixture round-trip prints three ordered during-events and a resumed
`TurnState.tasks` with the same id + owner linkage.

**Verification:** red-first in `test/task-protocol.test.ts` + extensions to
`turn-runner-serialization` / `state-compaction` / `turn-runner-state-compaction` tests.
Value-level assertions (ids, links, buffered output, wakeAt, nextTaskId) — not array
lengths. Falsifications: drop `tasks` in round-trip; let compaction evict the only live-task
handle; remove origin task id.

**Must stay green:** `test/turn-runner-protocol.test.ts`, `test/wire-shaping.test.ts`,
serializer suite.

**Feedback that would change this slice:** event payload shape for hosts (D1 said both RPC
and TUI are first-class — if the product side wants different output-chunk semantics, say so
here, before slices 08/12/13 consume them).
