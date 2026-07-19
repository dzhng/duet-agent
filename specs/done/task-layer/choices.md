# Choices ledger — task layer

Decision audit of the full implement run (slices 01–14 + close), traced from session
history, codex pass reports, and commits. The spec's binding ledger (unknowns-map.md)
was David-approved; entries here are what the implementation invented _beyond_ it.
Tree audited at 0edd88a; no code changed by the audit.

## Needs-user — all three RESOLVED by the user at audit review (2026-07-19)

Outcomes: N1 → sentinel deleted, `<system-reminder>` is the one tag (stripped from
observer/step-trigger projections, any role). N2 → gated asks stash their questions and
resurface them on the next parent pass. N3 → heartbeats unconditional (absence = wedged).
Original entries kept below for the record.

**N1 — The synthetic sentinel is visible to the model.**

- When: slice 11. Gap: the spec required machine injections to be strippable from
  memory/routing but didn't say whether the marker may appear in the model's context.
- Choice: literal `<duet-synthetic-user-message>` tags wrap every machine injection in
  the live transcript (settlements, nudges, reminders); stripping happens only in the
  observer/step-trigger projections.
- Reach: permanent prompt surface + tokens on every injection; models may treat
  tag-wrapped text differently. Evidence so far: one two-run A/B (markers disabled)
  showed no behavior shift — thin evidence, not proof.
- Provisional call: keep visible tags (simplest; storage and wire stay identical).
  Reverse by stripping the marker lines in the wire projection
  (`createMemoryTransform` path) so the model sees clean text while stored transcripts
  keep the tags.

**N2 — A gated ask is withheld, not deferred.**

- When: slice 07 fix round (ask gate). Gap: the spec said ask may only fire at
  no-open-work; it didn't say what happens to the question itself.
- Choice: the question is dropped and the parent gets `heldAskReminder` telling it to
  wait/stop tasks and ask again. The alternative — queue the ask and deliver it at
  quiescence — was not built.
- Reach: user-facing UX under load; a model that fails to re-ask loses the question
  silently (no eval pins re-asking).
- Provisional call: keep withhold+re-ask (matches "parent owns the question"; avoids
  delivering a stale question after settlements may have answered it). Reverse by
  buffering the ask payload and re-emitting it at quiescence.

**N3 — The heartbeat wire contract.**

- When: slice 12. Gap: the spec required "a periodic heartbeat event"; shape and
  cadence were unspecified.
- Choice: `{ type: "heartbeat", timestamp, activeTaskIds }` every 15s while running
  tasks hold RPC open; droppable/coalescing under backpressure (at most one queued).
- Reach: Aomni's RPC hosts will build liveness detection against this exact shape,
  cadence, and lossiness — it becomes a de-facto protocol commitment.
- Provisional call: keep as shipped. Reverse-friendly while no external host consumes
  it; once one does, changes need coordination.

## Unsound — FIXED (2026-07-19): output persistence debounced (1s trailing edge)

**U1 — Per-chunk full-state serialization on task output.**

- When: slice 12. Gap: my pass prompt said "persist also on task transitions"; the
  granularity was invented.
- Choice: every `task_output` event (each output chunk) triggers `persistLatestState`,
  which synchronously `JSON.stringify`s the entire `TurnState` — full transcript,
  pretty-printed — at enqueue time (`src/session/session.ts:504-510, 675-687`).
  Single-flight coalescing bounds _disk writes_ but not _serialization frequency_.
- Why unsound: a chatty background task makes main-thread CPU O(transcript size) per
  chunk burst; the cost grows with both output rate and session length. It works in
  evals because fixtures emit a handful of chunks — the classic passes-the-failing-case
  shape.
- Corrected decision: output-driven persistence goes through a trailing-edge debounce /
  minimum interval (~1s); `task_started`/`task_settled` stay immediate; tear-safety is
  preserved by keeping serialize-at-fire (the debounce gates the trigger, not the
  synchronous capture).

## Sound — architecture the user now owns

- **S1 Kernel pull API:** `nextSettled()` is a synchronous poll paired with
  `waitForSettlement(id?, waitMs?)` (spec sketched a promise). Consumers compose the
  two; the loop's park/wake depends on it.
- **S2 Recovery flattening:** recovered scopes lose parent linkage (flat
  re-registration); safe because lost tasks pre-settle, but post-restart cascades
  cannot traverse ancestry — future cross-restart scope semantics must re-add lineage.
- **S3 Quiescence enforcement failure mode:** open work leaking to the turn exit is
  force-stopped and the turn ends **failed**, never a lying `complete`. Failure is the
  honest signal for a loop bug.
- **S4 Settlement delivery mechanics:** a per-task posture map
  (`deliver`/`suppress`/`foreground_pending`) + same-tick coalescing decide which
  settlements re-prompt; mid-run steer requires parent-active ∧ no control captured ∧
  no state-task in the batch. Future task kinds must register a posture.
- **S5 Nested spawn semantics:** a grandchild's `fork_context` copies its _immediate
  caller's_ transcript, and nested model inheritance reuses the caller's concrete
  resolution (no re-classification). Most-local interpretation; documents itself into
  user expectations.
- **S6 Hydrate edge rules:** scheduled descriptor with invalid `wakeAt` → `lost`;
  persisted `sleeping` with no scheduled work → `interrupted`; the lost-task reminder
  carries a durable delivered-marker so a second crash can't double- or never-deliver.
- **S7 Test seams:** `requireRootScope` and `taskManager` widened to `protected` for
  probe runners — a deliberate, documented testing surface on `TurnRunner`.
- **S8 TUI historical gaps:** persisted descriptors carry no `settledAt` and per-task
  token history is not reconstructed on late attach — elapsed/tokens for historical
  tasks are omitted rather than faked. "How long did t3 take last week" needs a schema
  addition.
- **S9 Eval liveness re-anchors:** SIGTERM-marker assertions replaced with PID-gone +
  settled-stopped — ratified by the user's uniform-SIGKILL decision (banked; listed for
  completeness).

## Trivial discretion (not individually banked)

~a dozen cosmetic calls: task/scope id formats (`t${n}`, `task:tN`), notice tail
lengths (3 chunks), 54-char activity truncation, `TaskDescriptor.name` vs `label`
duality, wait-param units (seconds at tool surface, ms in kernel), `--no-ff` merge
style, worktree/branch naming.

## Plan-quality signal

Entries cluster on slice 12 (N3, U1, S6) and the settlement path (N2, S4) — the two
places the spec deliberately left "mechanics to the implementer". Consistent with the
fog the plan predicted there; no reslice warranted post-ship, but those areas carry
the most invented load-bearing detail.
