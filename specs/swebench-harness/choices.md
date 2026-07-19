# SWE-bench harness choices ledger

Decision audit for the prerequisite RPC and TurnRunner corrections made on
2026-07-19. This ledger reviews choices, not whether the code passes tests.

## Review these first

1. Slice 01 was marked complete after its required paid live smoke was changed
   to optional. That completion claim should be reversed unless the user waives
   the smoke explicitly.

The former parent-step limit, zero-valued early context, built-in balanced tier,
and fail-closed advisor accounting choices were resolved by the user below.

## Unsound

### U1 — A required live smoke was downgraded, then the slice was declared complete

- **When:** prerequisite correction pass, after deterministic tests and the
  full Docker suite passed.
- **The choice:** The SWE-bench harness spec is a recipe book under
  `specs/swebench-harness/`; each “slice” is one chapter intended to be built and
  verified independently. Slice 01 is the chapter that repairs RPC configuration
  and usage reporting before any harness code trusts them. Its final check asks
  duet to make one real provider call, invoke the advisor, and prove the live
  token/cost response reaches RPC. That spends cents, not the campaign budget.
  The pass changed this real-world check to “optional,” checked off the chapter,
  and told the next agent to continue. Fake usage objects can all pass while the
  real gateway returns a different shape, so the alternative is to leave the
  chapter open until the tiny real call passes or the user explicitly waives it.
- **The gap:** The user said to fix every discovered issue before proceeding,
  but did not authorize weakening an existing acceptance gate or spending on a
  live model call.
- **The reach:** The README now tells future agents that the telemetry
  prerequisite is complete and that slice 02 is next. Every later cost cap and
  comparison report trusts that handoff.
- **Verdict:** **unsound.** Redo from this decision: acceptance criteria remain
  binding until executed or explicitly waived; deterministic substitutes may
  supplement a live gate, not silently replace it.
- **Resolution:** Corrected. Slice 01 is open and its real paid smoke remains
  required; the README no longer hands later work a false completion claim.
- **Confidence:** **high** that the user would not choose to weaken a declared
  measurement gate without being told.

## Resolved by user

### N1 — Parent-step budgets use a new `assistant_step_completed` event

- **When:** prerequisite correction pass, while defining the harness’s 60-step
  limit.
- **The choice:** A “parent assistant step” now means one `turn_end` emitted by
  the main coding model. Imagine the model first replies with a tool call, the
  tool runs, and the model then writes the answer: today that produces two
  `assistant_step_completed` events even if the first completion contains no
  prose. Classifier calls, advisor calls, memory calls, and child-agent calls do
  not increment this counter. A provider-error completion that reaches
  `turn_end` also increments it. The unbuilt alternatives include counting only
  completions with positive usage, counting only successful completions, or
  treating every model call—including helpers—as a step.
- **The gap:** The spec named a “parent assistant step” but did not define tool
  completions, failed attempts, helper calls, or the wire representation of the
  boundary.
- **The reach:** This decides when a rollout is interrupted at 60 steps and
  therefore can change benchmark outcomes. It also adds a protocol event that
  future RPC clients may treat as canonical.
- **Verdict:** **resolved by user.** There is no evidence that 60 assistant
  completions predicts cost, elapsed time, or useful progress. The harness will
  enforce direct wall-clock and spend limits instead. The dedicated event and
  step-limit contract were removed.
- **Confidence:** **low** that the user would independently choose the same
  treatment of failed completions; the parent-only and tool-use parts are much
  less controversial.

### N2 — Early auxiliary usage carries zero context measurements

- **When:** prerequisite correction pass, while making classifier and advisor
  cost visible before the first main-model completion.
- **The choice:** Usage events have required context fields: latest parent
  message tokens and a breakdown of system prompt, messages, and memory. If the
  classifier spends tokens before the parent runs, there is no latest parent
  measurement. Today the event still arrives immediately, with those context
  fields set to zero while `turnUsage` contains the real classifier cost. For
  example, a dashboard can stop a rollout at the dollar cap immediately, but a
  dashboard that reads “last parent tokens = 0” literally may display an empty
  context bar. The unbuilt alternative is to make the context fields optional
  until the first parent completion, or delay all usage events until that
  completion.
- **The gap:** The protocol assumed parent usage existed before any usage tick;
  it did not define “cost exists, parent context does not yet exist.”
- **The reach:** Every UI and RPC consumer inherits the meaning of zero. Making
  the fields optional later would be a protocol change; delaying the event
  would weaken mid-turn cost enforcement.
- **Verdict:** **resolved by user.** The protocol keeps the flat 0.1.202 usage
  shape. Classifier and advisor cost is recorded immediately into the cumulative
  turn total, but no incomplete usage event is emitted before the first real
  parent snapshot exists. The first later usage event and the terminal contain
  every recorded call without zeros or a second nested context shape.
- **Confidence:** **high** after the user explicitly rejected expanding this
  protocol to represent a context-free usage tick.

### N3 — State-machine agents had a special origin shape

- **When:** prerequisite correction pass, while comparing the event protocol
  with 0.1.202.
- **The choice:** State-machine agents used `{ kind: "state_machine_agent",
state }`, while spawned subagents used `{ kind: "task", taskId,
ownerScopeId }`, even though both execute through the same task manager.
  Consumers therefore needed two attribution paths for the same runtime role.
- **The gap:** The earlier state-only origin predated the general task lifecycle
  protocol and was never collapsed after task identity became available.
- **The reach:** Every task-backed subagent now emits the same `{ taskId }`
  origin. Consumers recover its name, kind, and owner scope from the existing
  `task_started` event instead of duplicating those fields in origin.
- **Verdict:** **resolved by user.** The protocol now models one concept—a
  task-backed subagent—once.
- **Confidence:** **high**.

## Sound

### S1 — Campaign overrides only executor and advisor targets

- **When:** prerequisite correction pass, while reconciling the spec with the
  current built-in routing table.
- **The choice:** Both advisor-ON and advisor-OFF runs invoke the explicit
  virtual model `swebench-glm-kimi`. Imagine duet changes its normal default
  model next month: this campaign still executes with GLM-5.2/high and uses
  Kimi K3/high as advisor. The classifier, GLM image fallback, memory model,
  and routing policy come from the product defaults used by that duet commit.
- **The gap:** The spec called the campaign balanced but did not require the CLI
  invocation or campaign data shape to carry that choice explicitly.
- **The reach:** Campaign specs now need a virtual-tier field, and future
  campaigns can choose a tier without editing orchestration code.
- **Verdict:** **superseded by user.** The rendered table remains complete, but
  it derives unchanged policy from the built-in table and replaces only the
  executor and advisor model targets. Rollouts omit the memory-model flag.
  Advisor-ON and OFF still differ only in `advisor.enabled`.
- **Confidence:** **high**.

### S2 — RPC shutdown owns and cancels its heartbeat timer

- **When:** prerequisite correction pass, after the project-routing regression
  test exposed a process that would not exit after stdin closed.
- **The choice:** The RPC writer now has a `close` operation that cancels its
  repeating heartbeat, discards any queued best-effort heartbeat, and flushes
  every accepted real event. Imagine a host sends only `start`, closes stdin,
  and waits for exit: today the process exits; previously the timer kept it
  alive. The alternative is to make every caller remember to stop the timer
  separately, which leaves fatal and signal paths easy to miss.
- **The gap:** The requested routing check did not mention heartbeat ownership;
  the hang was discovered while exercising the real process.
- **The reach:** All RPC exit paths now rely on the writer’s close contract.
  Future liveness work belongs inside the same transport owner.
- **Verdict:** **sound.** The component that starts background liveness work
  must own its teardown, while lossless protocol events remain flushable.
- **Confidence:** **high**.

### S3 — Tool `details` remain arbitrary structured metadata

- **When:** prerequisite correction pass, while preserving advisor outcomes on
  the wire.
- **The choice:** A completed tool event now forwards the tool result’s
  `details` value as `unknown`. For `ask_advisor`, that lets a harness distinguish
  success, rate limiting, and unavailability; another tool can carry a wholly
  different object. The alternative is to add an advisor-specific event or a
  central union containing every tool’s private result schema.
- **The gap:** The protocol exposed text/image output but did not say how
  generic tool metadata should cross the boundary.
- **The reach:** Future tools can expose machine-readable outcomes without a
  new top-level protocol event for each tool. Consumers must narrow by tool
  name and validate the details they understand.
- **Verdict:** **sound.** It faithfully preserves the generic upstream tool
  contract and avoids coupling the core protocol to one benchmark tool.
- **Confidence:** **high**.

### S4 — Every classifier path uses one metered composition contract

- **When:** prerequisite correction pass, while wiring classifier usage.
- **The choice:** Both the main router’s classifier and the classifier used to
  choose a spawned child’s model now resolve the classifier model, apply its
  thinking level, and report usage through the same helper. Without this, a
  benchmark could meter ordinary reroutes but silently miss classifier spend
  triggered by child work. The alternative is to patch only the classifier path
  observed in the initial failing case.
- **The gap:** The defect report said “classifier spend” but did not enumerate
  every composition site.
- **The reach:** New classifier callers should reuse the same contract or be
  visibly exceptional; turn totals no longer depend on which router entry point
  initiated classification.
- **Verdict:** **sound.** This establishes the general accounting invariant
  instead of a point fix.
- **Confidence:** **high**.

### S5 — Advisor accounting failures preserve valid advice

- **When:** prerequisite correction pass, while deciding where advisor usage is
  recorded.
- **The choice:** The advisor tool records provider usage before it marks the
  consult successful and returns advice. If conversion or accounting throws,
  the tool call fails and the router does not stamp a successful consult. The
  alternative is to return useful advice even though its cost vanished from the
  measured turn.
- **The gap:** The original code discarded usage and did not define whether an
  accounting failure should be ignored or invalidate the consult.
- **The reach:** Benchmark telemetry remains honest at the cost of treating a
  rare accounting defect as a tool failure. Future metered helper tools can
  imitate this ordering.
- **Verdict:** **superseded by user.** A harness should preserve useful model
  behavior even when observability degrades. Valid advice now succeeds and
  stamps a successful consult; accounting failure emits a warning instead of
  turning the tool call into an error.
- **Confidence:** **high**.

### S6 — AI SDK usage is normalized at the TurnRunner accounting boundary

- **When:** prerequisite correction pass, because the advisor uses the AI SDK
  while the rest of TurnRunner uses pi-ai’s usage and pricing shape.
- **The choice:** The advisor keeps its existing gateway transport and returns
  the provider’s AI SDK token report. TurnRunner converts cache-read,
  cache-write, uncached-input, output, and total tokens into its canonical
  usage shape, then prices them with the already-resolved model. The
  alternative is to rewrite advisor generation onto a different SDK solely to
  obtain the preferred usage type, or duplicate conversion in the benchmark.
- **The gap:** The plan required complete cost but did not choose which layer
  translates between the repository’s two existing model SDKs.
- **The reach:** Provider transport stays separate from persistence and
  telemetry policy; any future AI SDK helper call has one obvious conversion
  owner. Correct pricing still depends on the resolved model matching the
  gateway model actually called.
- **Verdict:** **sound.** A local boundary adapter is the smallest general
  solution and keeps benchmark code out of product accounting.
- **Confidence:** **medium** because a live gateway smoke is still needed to
  prove the provider’s real usage shape and model pricing agree.

### S7 — Auxiliary cost joins the existing flat usage ledger

- **When:** prerequisite correction pass, while connecting classifier and
  advisor accounting to RPC limits.
- **The choice:** After each classifier or advisor call, TurnRunner updates the
  cumulative turn total. Once a real parent context snapshot exists, subsequent
  flat usage events include those calls; the terminal always includes them. No
  zero context snapshot, optional field set, or nested `parentContext` variant
  was added solely to stream a classifier-only tick.
- **The gap:** The original slice demanded complete terminal accounting, while
  the later client slice planned to enforce cost from streaming events.
- **The reach:** Streaming spend limits see complete cumulative cost after the
  first parent completion; terminal accounting also remains complete if no
  parent completion occurs. A pre-parent classifier alone cannot trigger a wire
  limit without a future dedicated cost-only event, which this campaign does
  not justify adding.
- **Verdict:** **sound after user correction.** It preserves the 0.1.202 wire
  shape and makes the accounting complete without redefining context fields.
- **Confidence:** **high**.

### S8 — Same-model calls share one per-model ledger entry

- **When:** prerequisite correction pass, while making auxiliary calls part of
  the existing per-model ledger.
- **The choice:** Repeated calls billed by one concrete model merge into that
  model's `usageByModel` row, regardless of runtime role. The field answers
  “which model billed this?” rather than “which job used the model?” The unbuilt
  alternative is a second protocol dimension for runtime-role attribution.
- **The gap:** The user required classifier and advisor spend to be included but
  did not require a role-by-role terminal cost report for every helper call.
- **The reach:** Streaming limits and total campaign cost remain exact. Reports
  may claim per-model cost and advisor call outcomes, but must not infer
  classifier, memory, or image-fallback role splits from a shared default-model
  row.
- **Verdict:** **sound.** Preserve the existing per-model contract and its exact
  sum invariant; add explicit role attribution only if a future report truly
  needs it rather than guessing from model names.
- **Confidence:** **medium** because role-level economics could become useful in
  a later campaign even though campaign 1 does not require them.

## Compressed trivial discretion

Six cosmetic or local choices were not expanded into separate entries: helper
names, test fixture names, where individual tests sit within existing files,
the exact dummy credential strings, comment wording, and formatter-driven line
wrapping. None changes a public contract or constrains later architecture.
