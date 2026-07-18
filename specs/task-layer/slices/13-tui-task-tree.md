# 13 — TUI task tree + late-attach projection

**Contract unlocked:** the TUI renders concurrent task lanes with ownership, live output,
settlement, and "held awake by tN" status; stays running until a real terminal; reconstructs
tasks from hydrated state on late attach. LM-S6 (render half), LM-S4 (attribution half).

**Seam:**

- `src/tui/task-tree.ts`: a PURE projection from `TurnState.tasks` + task events → render
  rows (target look: the accepted sketch in `assets/transcript-fragments.md`).
- `session-subscription.ts` (~:101-105): stop dropping `origin`; route task-origin steps to
  lanes. Seed lanes from `session.getState()?.tasks` on attach (pattern: follow-up queue
  hydration ~:95-99); late attach must not depend on `getLastTerminal()` (undefined for the
  whole held-open turn).
- `StepRenderer`: sibling task renderer — do not overload `activeToolBlocks` (keyed by tool
  call id, assumes one linear lane, step-renderer.ts ~:26-41).
- `StatusController`: running/held-awake derives from the root task set, not the
  every-terminal `markIdle` flip (session-subscription.ts ~:144-165); idle only after the
  terminal.
- Origin-aware usage attribution in the sidebar without changing the aggregate invariant.
- Follow-up-queue panel: show pending settlements read-only, or record the deliberate
  omission in the README (open product call).

**Run:** TUI harness with the slice-02 fixtures: a background bash + two spawned agents
(one with a nested child) render as the accepted tree; after settlement, lanes keep concise
final status; chrome goes idle only at the terminal. kill/reattach mid-turn shows lanes
rebuilt from state.

**Verification:** pure tests `tui-task-tree.test.ts`, `tui-task-subscription.test.ts`;
extend `tui-streaming`, `tui-resume`, `tui-context-bar`, `tui-rendering` tests. Docker TUI
harness shot verifies nesting, held-awake text, late attach, no premature idle.
**Visual gate:** run an unprimed [screenshot-critique](../../../.claude/skills/screenshot-critique/SKILL.md)
on the task-tree shot as the LAST check before acceptance, and
[compare-screenshots](../../../.claude/skills/compare-screenshots/SKILL.md) against the
accepted sketch (candidate-vs-target: judge less-wrong, not pixel match). Falsifications:
ignore owner linkage (nested row fails); init from events only (late-attach fixture empty);
mark idle when parent pi settles (held-awake disappears early).

**Human review checkpoint (non-blocking):** open the tree shots with
[preview-shots](../../../.claude/skills/preview-shots/SKILL.md); give ~5 min for a response;
on silence, decide on the evidence, record the call here, close the shots, proceed.

**Must stay green:** all tui tests, `test/tui-rendering.test.ts` frame fixtures re-anchored
deliberately (assets under the tui snapshot flow).

**Feedback that would change this slice:** lane density/verbosity, spinner glyphs, whether
settled lanes collapse — taste calls; the sketch is the anchor.
