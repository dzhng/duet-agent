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

## Visual gate resolution (orchestrator, 2026-07-18)

Frames captured from the real TUI in docker (assets/tui-switch-notice-frame.txt,
assets/tui-route-inspector-frame.txt) and run through an unprimed critique. Outcomes:

- Critique's critical finding ("/route renders nothing") was a capture artifact — the first
  Enter feeds the slash autocomplete picker; a second Enter submits. Verified live: /route
  renders the full labeled inspector (tier/current/rationale/cadence/advisor/pinned).
- Applied from the critique: the switch notice's bare trailing trigger token read as truncated
  ("· cadence"); now rendered as prose ("via cadence check" / "via advisor milestone" /
  "at turn start") and the from-model is included (`frontier: luna → sol (high)`).
- Dismissed with reasons: banner wrap, `vharness`/`harness + harness` header, `--%` context
  gauge — all fake-harness fixture artifacts, not production rendering; `loc`/`glb` legend and
  hint-bar truncation are pre-existing TUI cosmetics outside this slice's variable.
