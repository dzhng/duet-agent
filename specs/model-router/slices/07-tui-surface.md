# 07 — TUI: two-layer display, `router_switch` rendering, `/route` inspector

## Contract unlocked

Routing is legible from inside a session: what tier you're on, what concrete model is burning
tokens right now, why, and when the next check happens.

## API seam

- `src/tui/session-subscription.ts:100-148`: `router_switch` branch (mirror the `memory`/`system`
  branches) rendering a concise line: `[route] frontier → gpt-5.6-sol (high) · implement · cadence`.
- Sidebar/status line: two-layer display `frontier → gpt-5.6-sol (high)` fed from
  `ModelRouter.status()`; context-bar ceiling recomputed on swap (cosmetic jitter fix from the
  map). UI reads router snapshots only — it never reconstructs cadence/route/advisor state.
- `/route` inspector (`slash-commands.ts`): tier, current route + concrete model + effort, last
  rationale, step position and next cadence check, advisor enabled/cooldown, pinned state.

## What the human can run

A live routed TUI session: watch the status line, trigger a mid-task switch, read the switch
line, run `/route`.

## Verification

- Extend TUI rendering test fixtures with a `router_switch` event; `/route` output snapshot
  tests for: before first classification, mid-routing, after a concrete pin.
- **Visual gate:** capture the sidebar/status-line and switch-line shots and run
  **screenshot-critique** (unprimed second opinion) as the final check before accepting the
  slice. No reference image exists, so no compare-screenshots step.

## Must stay green

All `tui-*.test.ts`.

## Human review checkpoint (non-blocking)

Open the shots with **preview-shots**; ~5-minute window; if silent, decide on the evidence,
record here, close the shots, proceed.

## Feedback that would change this slice

Wording/density of the switch line and `/route` layout — display-only iteration.

## Dependencies

Slices 05 (event) + 06 (status semantics). Parallel with slice 08.
