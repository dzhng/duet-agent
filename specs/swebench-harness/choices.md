# SWE-bench harness choices ledger

Decision audit for the prerequisite RPC and TurnRunner corrections made on
2026-07-19. This ledger reviews choices, not whether the code passes tests.

## Review these first

N7 is the only open choice: the official benchmark names JavaScript and
TypeScript separately but publishes one combined repository group, so slice 02
uses the repositories' pinned primary-language classification to preserve the
spec's nine-way sample.

## Needs user — slice 02

### N7 — JavaScript and TypeScript repositories are separated by primary language

- **When:** slice 02 manifest implementation on 2026-07-20.
- **The choice:** Imagine the sampler receives an issue from `vuejs/core`. The
  official benchmark says its nine languages include both JavaScript and
  TypeScript, but its repository table and Python harness put both through one
  combined JavaScript/TypeScript runtime bucket. Today the manifest labels
  `vuejs/core`, `babel/babel`, `facebook/docusaurus`, and
  `immutable-js/immutable-js` as TypeScript, and labels `mrdoob/three.js`,
  `preactjs/preact`, and `axios/axios` as JavaScript, using each repository's
  primary language. The unbuilt alternative treats those seven repositories
  as one combined bucket, which follows the scorer more literally but makes
  the planned “all nine languages” stratification impossible.
- **The gap:** The spec requires nine separate language buckets and says the
  map comes from the official harness, while the official harness exposes only
  a combined JavaScript/TypeScript bucket. It does not define how to reconcile
  those two facts.
- **The reach:** This choice decides which three or four instances represent
  JavaScript versus TypeScript in every arm. It does not affect official image
  selection or scoring, which remain owned by the Python harness.
- **Verdict:** **needs-user.** Recommended provisional call: keep the explicit
  primary-language split because it satisfies the promised nine-language
  sample without inspecting individual issues. It is reversible before any
  measured rollout by changing the map, advancing the manifest algorithm, and
  regenerating the committed manifest; never change it after measurement.
- **Confidence:** **medium** that the user would preserve nine-way coverage
  rather than collapse to the scorer's seven reporting groups.

## Sound — slice 02

### S13 — Every arm uses one benchmark-only general route

- **When:** slice 02 routing-render implementation on 2026-07-20.
- **The choice:** When a SWE-bench issue starts, the active project table has
  one virtual tier named `swebench` and one `general` route. Every coding step
  therefore stays on the arm's declared executor: GLM stays GLM and Kimi stays
  Kimi. The classifier configuration is still copied from the product table,
  but it has no second destination to choose. The unbuilt alternative copies a
  normal multi-route product tier; then the classifier could send planning,
  implementation, or visual phases to different models and “pure GLM” would no
  longer mean one GLM executor.
- **The gap:** The spec required a custom complete table and fixed executor but
  did not name its virtual tier or state whether unused product routes should
  remain.
- **The reach:** Later rollout code must invoke `--model swebench` with the
  selected render installed. Adding routes later would change the experiment,
  not merely its configuration format.
- **Verdict:** **sound.** One route is the direct guarantee that the compared
  executor does all main-agent work while unchanged memory and advisor policy
  remain available.
- **Confidence:** **high** because the user explicitly rejected default model
  definitions for this benchmark.

### S14 — The dataset cache excludes gold answers

- **When:** slice 02 dataset-fetch implementation on 2026-07-20.
- **The choice:** The Hugging Face response contains issue text, tests, and the
  human-written solution patch (“gold”). The local ignored cache keeps only
  repository, instance id, and base commit—the fields needed to reproduce the
  pairing. The unbuilt alternative caches the complete response, making future
  code more convenient but putting reference solutions beside the rollout
  tooling where accidental prompt or artifact contamination is easier.
- **The gap:** The spec required a git-ignored cache but did not say whether it
  should preserve full dataset rows.
- **The reach:** Later slices fetch problem statements through their own
  rollout/scorer boundary rather than importing gold-bearing cached objects.
  Regenerating the manifest remains possible without retaining answer patches.
- **Verdict:** **sound.** Least-privilege benchmark data reduces contamination
  risk and the manifest needs no omitted field.
- **Confidence:** **high**.

### S15 — Remainder slots are assigned by the committed seed

- **When:** slice 02 manifest implementation on 2026-07-20.
- **The choice:** Thirty instances cannot divide evenly across nine languages:
  three languages must receive four slots and six receive three. Today the same
  seeded shuffle that samples instances also chooses the three extra-language
  buckets, producing four Go, four Java, and four Ruby entries for seed
  `20260720`. The unbuilt alternative always awards extra slots to the first
  languages in a hard-coded list, which is deterministic but quietly favors
  list order.
- **The gap:** The spec required bucket sizes to differ by at most one but did
  not allocate the remainder.
- **The reach:** Changing this rule changes the pairing and requires a new
  algorithm version plus a regenerated manifest before measurement.
- **Verdict:** **sound.** Seeded allocation is reproducible without turning
  enum order into sampling policy.
- **Confidence:** **medium**; a different neutral remainder rule would also be
  defensible, but none would improve the paired comparison after commitment.

The former parent-step limit, zero-valued early context, built-in balanced tier,
and fail-closed advisor accounting choices were resolved by the user below.

## Resolved by user — routing follow-up

### N6 — The campaign runs locally as four arms under one $500 envelope

- **When:** benchmark implementation resumed on 2026-07-20 after the user
  replaced the rented-box plan with “just run the bench on this Mac.”
- **The choice:** One committed 30-instance manifest feeds four explicit arms:
  GLM pure, GLM with Kimi advisor, Kimi pure, and Kimi with Fable advisor. The
  report treats these as two paired experiments, not one four-way causal
  comparison. “Pure” disables only the advisor; product-default memory and
  other unchanged policies remain. All prerequisite smoke, pilots, and 120
  campaign rollouts share a $500 model-spend envelope.
- **The reach:** The local harness uses official x86_64 scorer images through
  Docker Desktop emulation, starts at concurrency one, and schedules all four
  arms in an instance block. Capacity is proven empirically; resource pressure
  cannot silently shrink the manifest, change the scorer, or drop a comparison.
- **Verdict:** **resolved by user.** This is the explicit requested deliverable.
- **Confidence:** **high**.

### N4 — The mixed-model live eval uses best-of-two acceptance

- **When:** routing-continuity follow-up, while strengthening and rerunning
  `model-routing-mixed-task.eval.ts`.
- **The choice:** The live eval runs the same frontend-then-backend coding task
  up to twice and passes if either attempt succeeds. In the final verification,
  attempt one let Kimi put several backend tool calls into one assistant message;
  the router could only switch after that whole message, so Kimi performed the
  backend mutations and the attempt failed. Attempt two obeyed the requested
  one-tool-per-message rhythm, switched to Sol at the boundary, and made the
  overall eval green. The unbuilt alternative is a reliability gate: require
  every attempt to pass, or run a fixed sample and assert/report a pass rate
  instead of discarding failed attempts.
- **The gap:** The user authorized paid eval runs and asked whether routing is
  correct, but did not choose whether this test should answer “can the routing
  work?” or “how reliably does the routing work?” The existing best-of-two
  helper answered the first question, and the follow-up retained it.
- **The reach:** A regression that succeeds only intermittently can still leave
  this eval green. That is acceptable for a local capability smoke, but it is
  too weak to support a campaign-readiness or reliability claim by itself.
- **Verdict:** **resolved by user.** Best-of-two is accepted for this live eval;
  it is intentionally a capability smoke that tolerates one executor-variance
  attempt rather than a per-run reliability measurement.
- **Confidence:** **high** after explicit user confirmation.

### N5 — Effort-only route switches reset the advisor cooldown

- **When:** routing-continuity follow-up, while replacing the prompt-coupled
  advisor exemption with a direct cooldown reset.
- **The choice:** A router switch can mean either “use a different concrete
  model” or “keep the same model but change its thinking effort.” Today both
  clear the last-advisor timestamp. For example, if Sol stays Sol but moves from
  medium to high thinking, it may consult the advisor immediately even if Sol
  consulted one step ago. The unbuilt alternative resets the cooldown only when
  the concrete model name changes; an effort-only adjustment would inherit the
  existing wait because no replacement model arrived.
- **The gap:** The user explicitly said a route/model switch should reset the
  cooldown, but did not define the same-model, different-effort edge case. The
  implementation used the router's existing broad definition of a switch.
- **The reach:** This determines advisor call frequency and cost for routing
  tables that map multiple routes to one model at different efforts. It also
  decides whether future code can read “switch” as “new model” or must remember
  that effort changes have the same side effects.
- **Verdict:** **resolved by user.** Every actual route switch resets the advisor
  cooldown, including a same-model switch that changes only thinking effort.
- **Confidence:** **high** after explicit user confirmation.

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

### S17 — Scorer cleanup and wrapper cleanup are idempotent owners of the same exact image

- **When:** slice 04 resumable 30-instance gold gate on 2026-07-20.
- **The choice:** The official scorer's `--clean true` can remove the exact
  instance image before the Mac wrapper reaches its own cleanup step. The
  wrapper now checks that exact image and treats absence as success; it still
  removes it when present and never broad-prunes Docker state. Completed gold
  rows are detected from both a resolved summary row and a real report, so a
  registry timeout or operator interrupt resumes rather than redoing them.
- **The gap:** The first manifest run resolved five tasks but incorrectly
  counted each post-scorer “No such image” response as a wrapper failure.
- **The reach:** Gold and prediction scoring are restart-safe under transient
  registry failures while preserving the one-image-at-a-time disk policy.
- **Verdict:** **sound.** Cleanup guarantees absence, not which cooperating
  layer happened to remove the exact owned object first.
- **Confidence:** **high**.

### S16 — Crashed attempts reserve their full cost cap and retries never overwrite evidence

- **When:** slice 06 filesystem and budget implementation on 2026-07-20.
- **The choice:** The first rollout uses `<instance>-t<trial>` and each retry
  receives an immutable `-aN` directory. A stale `running` marker resumes as a
  new attempt, but budget accounting charges the abandoned attempt's full
  configured cap because its exact provider spend may have been lost with the
  process. The unbuilt alternative overwrites one directory or assumes a crash
  spent zero, either destroying evidence or weakening the $500 breaker.
- **The gap:** The spec required immutable attempts and a reserve-first breaker
  but did not state how unknown spend from a host crash is charged.
- **The reach:** Resume is conservative and auditable; it may stop early after
  crashes, but it cannot knowingly spend past the envelope based on missing
  telemetry.
- **Verdict:** **sound.** Unknown paid work must be budgeted at its proven upper
  bound.
- **Confidence:** **high**.

### S13 — The compiled entry point is the only owner of compiled CLI dispatch

- **When:** slice 05 Linux-x64 RPC smoke on 2026-07-20.
- **The choice:** `cli-entry.ts` explicitly calls the dispatcher in compiled
  builds, while `cli.ts` auto-runs only when that source or its emitted
  `cli.js` file is invoked directly. Bun gives bundled modules the compiled
  executable URL, so a URL-equality guard made both modules dispatch the same
  RPC input. The filename guard preserves direct source use without making an
  imported module a second process owner.
- **The gap:** Unit tests exercised source dispatch, but the first compiled
  binary smoke exposed two `turn_started` events and two paid model turns.
- **The reach:** Every compiled CLI command, including benchmark RPC, has one
  dispatcher and cannot duplicate side effects or spend.
- **Verdict:** **sound.** Process startup must have exactly one explicit owner.
- **Confidence:** **high**.

### S11 — Agent patches are measured from the official image's real starting tree

- **When:** slice 05 live Druid packaging and patch smoke on 2026-07-20.
- **The choice:** A fresh official Druid container already reports `pom.xml` as
  modified because its image pins a Maven resource bundle needed by the test
  environment. The harness snapshots that exact starting tree into a private
  Git tree, then computes only what the agent changed afterward. The unbuilt
  alternative resets to the repository commit before the agent runs, which
  removes official environment setup and can make builds fail for reasons the
  benchmark image intentionally fixed.
- **The gap:** The spec assumed official images had clean Git worktrees; the
  first live image disproved it.
- **The reach:** Harness-owned environment changes never leak into predictions,
  while agents still work and score in the official configured filesystem. The
  same baseline-relative rule handles tracked and untracked starting changes.
- **Verdict:** **sound.** The image's actual initial tree is the only fair
  boundary between environment setup and agent work.
- **Confidence:** **high**.

### S12 — Cross-compilation installs Linux optional packages in an isolated tree

- **When:** slice 05 Linux-x64 packaging smoke on 2026-07-20.
- **The choice:** A normal Mac install contains OpenTUI's Darwin native package,
  so Bun cannot bundle the Linux package when cross-compiling. Packaging copies
  only source and lock files to a temporary directory, installs locked optional
  dependencies for `linux/x64`, compiles there, and deletes the directory. The
  unbuilt alternative mutates the developer's main `node_modules` between Mac
  and Linux platforms or adds native-package exceptions to product imports.
- **The gap:** The spec chose Linux cross-compilation but did not define how
  platform-specific optional dependencies would be resolved on Apple Silicon.
- **The reach:** The artifact is reproducible from `bun.lock`, the host install
  stays usable, and no benchmark workaround enters the CLI/TUI module graph.
- **Verdict:** **sound.** Target dependencies belong to the target build tree.
- **Confidence:** **high**.

### S14 — Capacity telemetry measures the scorer and its instance container separately

- **When:** slice 04 Mac-local capacity tooling, 2026-07-20.
- **The choice:** The capacity runner samples two kinds of memory once per
  second: the Python scorer process plus its child processes, and any Docker
  instance container whose name contains that run's id. It also watches the
  lowest free space on the benchmark artifact disk. For example, a Java test
  can consume memory inside Docker while the Python scorer remains small; the
  report preserves both numbers instead of pretending one is the whole run.
  The unbuilt alternative is a single host-wide memory number, which includes
  unrelated applications and cannot tell whether scorer or testbed caused a
  spike.
- **The gap:** The spec required peak disk and memory evidence but did not
  define which processes count or how emulated-container memory is separated.
- **The reach:** Every later capacity decision inherits these metric meanings.
  They support one-worker safety decisions, not a claim about total Docker
  Desktop VM overhead or safe parallelism.
- **Verdict:** **sound.** The split is directly observable and avoids assigning
  unrelated Mac memory to the benchmark.
- **Confidence:** **medium** because a future operator may also want Docker VM
  total memory pressure as a third metric.

### S15 — The local replication tool is pinned to mini-swe-agent 2.4.5

- **When:** slice 04 Mac-local provisioner, 2026-07-20.
- **The choice:** Provisioning installs `mini-swe-agent==2.4.5` beside the
  required `swebench==4.1.0`, and records both in the environment lock. Imagine
  mini-swe-agent releases a new prompt or prediction format tomorrow: rerunning
  this campaign still uses 2.4.5 instead of silently changing the replication
  baseline. The alternative is an unversioned install that can change between
  the spike and a later rerun.
- **The gap:** The spec required a pinned mini-swe-agent but did not select its
  exact package release.
- **The reach:** The pending replication spike and its documented prompt shape
  are tied to this version. Changing it is explicit: update the provisioner,
  regenerate the lock, and rerun the spike.
- **Verdict:** **sound.** A benchmark prerequisite must be reproducible.
- **Confidence:** **medium** because compatibility still has to be proven by
  the pending spike.

### S7 — Official x86 images remain the scoring authority on Apple Silicon

- **When:** Mac-local campaign reconciliation on 2026-07-20.
- **The choice:** The Mac has an ARM processor, but the official benchmark
  publishes x86_64 instance images and the official harness still selects
  those images. Docker Desktop has proved it can emulate x86_64 here, so the
  campaign keeps the official image and accepts slower execution. The unbuilt
  alternative is to create native ARM images or patch the scorer's architecture
  selection, which would produce a different environment from the benchmark.
- **The gap:** The original plan avoided architecture questions by requiring a
  rented x86_64 box; the user later required this Mac instead.
- **The reach:** Every gold check, rollout container, and scored prediction uses
  the same official x86 environment. If emulation fails, the capacity gate
  stops; it does not quietly switch the benchmark definition.
- **Verdict:** **sound.** Comparability is more important than local speed.
- **Confidence:** **high**.

### S8 — Local scheduling starts with one worker and cleans only its own images

- **When:** Mac-local campaign reconciliation on 2026-07-20.
- **The choice:** Docker has about 8.3 GB RAM and the host has about 37 GiB free,
  both below official recommendations. The harness therefore runs one work unit
  at a time and may delete only images and containers it created after an
  instance's four arms are safely scored. The unbuilt alternative launches
  several instances concurrently or broadly prunes Docker, risking out-of-memory
  failures or deleting unrelated user data.
- **The gap:** The user selected the machine but did not prescribe resource
  scheduling or authorize deleting its existing Docker objects.
- **The reach:** The campaign takes longer but preserves pairing and user-owned
  Docker state. A later measured capacity gate may raise concurrency explicitly.
- **Verdict:** **sound.** It is the direct local guarantee that respects both the
  fixed experiment and destructive-action boundaries.
- **Confidence:** **high**.

### S9 — An unexpected `ask` terminal ends an unattended rollout

- **When:** Mac-local campaign reconciliation on 2026-07-20.
- **The choice:** RPC closes after its first terminal result. If an agent asks the
  user a question, continuing would require starting a second RPC process with
  the returned state and manufacturing an answer. The harness instead uses one
  frozen prompt that says to proceed unattended and counts any remaining `ask`
  as an unresolved agent outcome. The unbuilt alternative silently answers the
  question on the user's behalf and gives that rollout extra turns.
- **The gap:** The old slice assumed two questions could be auto-answered in one
  process, but the actual RPC lifecycle does not support that assumption.
- **The reach:** All four arms get the same single-turn interaction contract and
  the harness does not invent task-specific user input.
- **Verdict:** **sound.** Treating an inability to proceed autonomously as an
  outcome is fairer than hidden continuation policy.
- **Confidence:** **medium**.

### S10 — The $500 breaker reserves one rollout before launching it

- **When:** Mac-local campaign reconciliation on 2026-07-20.
- **The choice:** Streaming usage can stop a running rollout at its own cap, but
  a provider call can spend between two events. Before launching another
  rollout, the campaign therefore requires remaining budget to cover that
  rollout's full configured cap. The unbuilt alternative starts whenever the
  current total is under $500 and can knowingly place the next whole cap beyond
  the envelope.
- **The gap:** The user supplied a total budget, not the launch-time reservation
  rule needed to enforce it locally.
- **The reach:** Some budget may remain unused, but the orchestrator never starts
  work it already knows cannot fit. A provider-side key cap remains the harder
  outer protection when available.
- **Verdict:** **sound.** This is the conservative enforceable interpretation of
  a fixed total budget.
- **Confidence:** **high**.

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

### S9 — Foreground task-backed shell calls execute in model order

- **When:** routing-continuity follow-up, after the state-scope eval exposed two
  parallel shell calls where the first completed and the second never settled.
- **The choice:** When one assistant message contains two ordinary shell calls,
  the runner now starts the second only after the first returns its foreground
  result. A model that genuinely wants concurrent commands can still mark each
  call `run_in_background`, which returns immediately and lets the task manager
  own both lifecycles. The unbuilt alternative keeps implicit parallelism for
  ordinary foreground calls and requires every shell backend and result-delivery
  path to be safe when several calls begin together.
- **The gap:** The task layer documented an explicit background mechanism but
  did not define ordering when a model emitted several foreground calls in one
  message. The live hang forced that ambiguity into a product behavior choice.
- **The reach:** This applies to every tool wrapped by the generic
  backgroundable-task adapter—currently shell—and gives future wrappers the
  same ordered-foreground/explicit-background contract. It trades accidental
  foreground parallelism for deterministic delivery and cleanup.
- **Verdict:** **sound.** Explicit background work is the clearer concurrency
  boundary, while foreground results preserve the order the model wrote.
- **Confidence:** **medium** because some workloads may value automatic shell
  parallelism, although the existing background API preserves that capability
  deliberately.

### S10 — Every state-scope eval attempt owns a fresh process group

- **When:** routing-continuity follow-up, while fixing the live state-scope eval
  that could leave a stuck TurnRunner alive after its timeout.
- **The choice:** Each of the five model attempts now runs in a new Linux process
  group. At 180 seconds the parent sends a polite termination signal, waits five
  seconds for runner cleanup, then kills the whole group if anything remains.
  Only that infrastructure timeout receives one retry in another fresh process;
  a completed attempt that edits the file is never retried away. The unbuilt
  alternative reuses one process and trusts in-process cancellation, allowing a
  leaked shell, timer, or model request to contaminate later samples.
- **The gap:** The eval specified repeated fresh runners but not an operating
  system boundary or what kinds of failure were eligible for retry.
- **The reach:** Repeated stochastic evals can now distinguish model behavior
  from broken cleanup, and one failed cancellation cannot poison later samples.
  The mechanism is intentionally Docker/Linux-specific; the eval is skipped
  outside Docker.
- **Verdict:** **sound.** A process group is the first boundary that guarantees
  cleanup even when the code being tested is precisely what failed to cancel.
- **Confidence:** **high**; the user approved process isolation, and the forced
  timeout falsification left no child process or container behind.

### S11 — The state-scope eval keeps implementation tools available and unprimed

- **When:** routing-continuity follow-up, after diagnosing the parallel-shell
  hang.
- **The choice:** The permanent eval does not tell the planning model “never use
  write/edit.” It leaves real read, shell, write, and edit tools available, then
  fails if the planning state calls write/edit or if the fixture changes on
  disk. A temporary diagnostic prompt forbade inspection and made the eval pass,
  but that would have taught the model the answer. The unbuilt alternative keeps
  that over-primed prompt or removes mutation tools, producing a green result
  that cannot prove the state-machine context prevented implementation.
- **The gap:** Fixing the infrastructure hang could have been done either by
  narrowing the scenario until it stopped hanging or by repairing the runtime
  ordering that the scenario exercised.
- **The reach:** This preserves the eval as evidence for real model restraint,
  not prompt compliance manufactured by the test harness. Future prompt-layer
  changes can continue using its five-run outcome as a meaningful signal.
- **Verdict:** **sound.** The only-if assertion remains intact: a green attempt
  still had the opportunity to implement and demonstrably did not.
- **Confidence:** **high**.

### S12 — The mixed task places the cadence boundary immediately before backend mutation

- **When:** routing-continuity follow-up, while making transcript transfer
  observable in the live eval.
- **The choice:** The task now uses eight required calls instead of twelve. Its
  fifth call reads the backend skeleton, so the production five-step cadence can
  classify the phase change before the first backend edit. The eval requires the
  first backend mutation to come from Sol, forbids Sol from replaying frontend
  mutations, and requires exactly one user message so no hidden reroute prompt
  can coach the replacement model. The unbuilt alternative leaves several extra
  backend actions before the expected switch, which can pass even when transfer
  is late or the replacement repeats earlier work.
- **The gap:** The old live task proved both models appeared somewhere, but did
  not isolate seamless continuation at the exact handoff boundary.
- **The reach:** A green attempt now demonstrates the behavior a user sees when
  `/model` changes mid-turn: the next model receives the same transcript and
  continues at the next unfinished action. It also keeps classifier, Kimi, and
  Sol usage in the existing per-model total invariant.
- **Verdict:** **sound.** The shorter scenario removes unrelated work while
  strengthening the routing and continuity claims.
- **Confidence:** **medium** because the live model can still batch several
  calls into one message, which is why N4's acceptance-policy choice remains.

### S13 — A cost ceiling is inclusive

- **When:** slice 03, while implementing streamed rollout limits.
- **The choice:** The client interrupts as soon as cumulative model spend is
  equal to or greater than the configured ceiling. For example, with a $1 cap,
  a usage event reporting exactly $1 starts graceful interruption immediately;
  it does not permit another provider call. The unbuilt alternative treats $1
  as still allowed and waits until a later event reports more than $1, which can
  knowingly launch work after the entire allowance has already been consumed.
- **The gap:** The slice said “cost cap” and “on breach” without defining whether
  equality is inside or outside the allowed launch envelope.
- **The reach:** Every pilot and campaign rollout inherits this boundary. The
  streamed total can still jump past the cap between provider events, but the
  client never continues once it observes that no allowance remains.
- **Verdict:** **sound.** An inclusive stop is the conservative meaning of a
  hard spend ceiling and agrees with the campaign-level reservation rule.
- **Confidence:** **high**.

### S14 — Descriptive step telemetry counts canonical parent events

- **When:** slice 03, because the protocol no longer has a dedicated assistant-
  completion event but the planned report still requested a `steps` number.
- **The choice:** `steps` counts finished parent events—text, reasoning, system,
  and completed tool calls—and ignores streaming fragments plus subagent events.
  Imagine one answer arrives as ten text fragments and then one finished text
  event: today it counts as one, not eleven. A child agent's work is also not
  mixed into its parent's count. The unbuilt alternatives count every fragment
  (transport-dependent noise), count only tool calls, or add a new protocol
  event after the user explicitly rejected a step-limit protocol expansion.
- **The gap:** The slice named the field but did not define a step after the
  earlier assistant-step limit and its protocol event were removed.
- **The reach:** Reports may use the number descriptively, but never as a time or
  spend limit. It remains stable across streaming chunk sizes and does not
  pretend to measure auxiliary-model work.
- **Verdict:** **sound.** It derives the least surprising stable diagnostic from
  existing events without changing the product protocol.
- **Confidence:** **medium** because the campaign may ultimately find the field
  uninformative enough to omit from human-facing tables.

### S15 — A terminal racing with interruption is preserved

- **When:** slice 03, while defining the grace period after a cost or wall-clock
  interrupt.
- **The choice:** After the client sends `interrupt`, the first real terminal
  wins even if it is `complete`, `failed`, `ask`, or `sleep` rather than
  `interrupted`. For example, the model may finish a millisecond before the
  interrupt reaches the runner; today the completed result is retained. The
  unbuilt alternative rejects that terminal and waits only for `interrupted`,
  then kills a process that has already supplied its authoritative outcome.
- **The gap:** The slice said to wait for an interrupted terminal but did not
  define the unavoidable race where normal completion was already in flight.
- **The reach:** Artifact extraction and failure classification retain the exact
  runner outcome instead of converting timing races into synthetic kills. An
  unexpected `ask` still ends the unattended rollout as settled in S9.
- **Verdict:** **sound.** The RPC contract says the first terminal ends the turn;
  the client should not override that authority based on command timing.
- **Confidence:** **high**.

### S18 — Gold-incompatible tasks are replaced inside their seeded language bucket

- **When:** slice 04's 30-instance Mac gold gate, after the official
  `fmtlib__fmt-2310` pass-to-pass test aborted under Rosetta.
- **The choice:** The manifest now records the incompatible task, removes it
  only after the C++ bucket has been shuffled with the original seed, and takes
  the next C++ task from that same order. Imagine drawing three numbered C++
  cards after separately shuffling all nine language piles: if one chosen card
  cannot physically run on this Mac, today we discard that card and draw the
  next card from the already-shuffled C++ pile. Every card in the other eight
  piles stays exactly where it was. The unbuilt alternative changes the seed
  and reshuffles all 30 tasks, throwing away 29 already-proven selections
  because one runtime was incompatible.
- **The gap:** The plan allowed pre-measurement re-selection after a gold
  failure, but its earlier wording suggested a new seed and did not say whether
  unaffected language buckets should move.
- **The reach:** Future campaign results remain paired over the intended nine-
  language sample, and adding another infrastructure exclusion cannot
  accidentally cherry-pick tasks based on model performance. The manifest
  itself exposes the exclusion instead of hiding it in a handwritten edit.
- **Verdict:** **sound.** It preserves the original randomization as much as
  possible while replacing only a task the official gold scorer cannot execute
  faithfully on the campaign machine.
- **Confidence:** **high** because the exclusion was decided and validated
  before any measured arm ran, and a test proves every unaffected bucket is
  byte-for-byte unchanged.

### S19 — The committed gold evidence is one complete resource table, not 30 raw scorer trees

- **When:** slice 04's corrected 30/30 gold gate.
- **The choice:** The repo keeps one row per task with the official resolved
  status, elapsed time, peak instance-container memory, and peak transient disk
  use. The full scorer directories stay in the ignored local cache. Concretely,
  a reviewer can verify that all 30 rows resolved and see the worst resource
  case without checking in duplicated logs, test output, and image metadata for
  every task. The unbuilt alternative commits all 30 raw scorer trees, making
  the repository much larger while preserving mostly temporary execution
  detail.
- **The gap:** The spec required captured gold evidence but did not define how
  much of the raw official output should be durable after the narrow real JSON
  parser fixture already existed.
- **The reach:** Future Mac-capacity decisions have a compact measured baseline,
  while parser compatibility remains owned by the existing sanitized official
  JSON fixture. A deeper failure investigation can still use the local cache
  named by the fixture documentation.
- **Verdict:** **sound.** The committed table proves the gate and its resource
  ceiling without turning transient harness output into source code.
- **Confidence:** **high** because the durable columns are exactly the gate's
  acceptance and capacity signals; raw logs are not needed to reproduce the
  official command.

## Compressed trivial discretion

Six cosmetic or local choices were not expanded into separate entries: helper
names, test fixture names, where individual tests sit within existing files,
the exact dummy credential strings, comment wording, and formatter-driven line
wrapping. None changes a public contract or constrains later architecture.
