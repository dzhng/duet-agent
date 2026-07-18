# 10 — Park state + parent-only ask

**Contract unlocked:** the machine can hold position with no execution and no task while the
parent drives; state-agent ask machinery is removed; the prompt corpus stops contradicting
the design. LM-K1, LM-K2; ledger #6, #7.

**Seam:**

- `park` state kind: added to `src/types/state-machine.ts` union and BOTH Typebox unions
  (tools.ts ~:353-359 state schema, ~:227-231 override schema) + tool doc strings. Audit
  every string-literal `kind ===` predicate — `currentScheduledState`
  (state-machine-session.ts ~:61-70) and friends default park into "not waiting/run it";
  only the (now-dissolved) controller switch was compiler-guarded. Parked = neither
  in-process nor scheduled in `computePendingWork` (parked-only ⇒ turn may end in `ask` or
  `complete`).
- Selecting park: records the selection/current state, creates no task, returns control to
  the parent, is exempt from `repeatedSelectionLoopWarning` (turn-runner.ts ~:1133-1146)
  while real loops still trip.
- **End-of-every-turn park nudge** (B4 wording, one builder in prompts.ts): appended while
  parked — "if the park's purpose is fulfilled, select the next state; otherwise end your
  turn and the machine stays parked."
- Ask removal: delete `recordStateAskedUser`, `isAwaitingUserAnswer`,
  `enforceTransitionAfterAnsweredAsk`, the `StateAgentResult.ask` variant, and the
  prompts.ts ~:197-200 doctrine ("no idle/hold selection" + state-agent-ask guidance) —
  rewritten to park guidance in the same commit. `ask_user_question` remains parent-only;
  `TurnAskEvent` stays single-sourced.

**Run:** "watch for my go-ahead before deploying" → machine parks; TUI shows the parked
state; each turn ends with the nudge; the user's later "go ahead" turn advances the machine.
A state agent's toolset visibly lacks ask.

**Verification:** live evals red-first w/ falsification: `state-machine-park` (park creates
no task; parent transitions after the nudge; falsify: treat park as agent state → unexpected
task event; include park in hot-loop warning → repeated-park eval reds). Rewire the ask
family deliberately red→green: `state-machine-answered-ask-enforces-transition.eval.ts` →
parent-asks-while-parked equivalent; `state-machine-answered-ask-guard.test.ts` → park
guard; `state-machine-repeated-selection-loop.test.ts` updated for the exemption. Re-run
`promised-wait-needs-state-machine.eval.ts` (prompt-corpus change can shift it).

**Must stay green:** everything else, esp. `state-machine-relay-*` and transition
carry-forward evals.

**Feedback that would change this slice:** the kind name (`park` vs `hold`); nudge wording.
