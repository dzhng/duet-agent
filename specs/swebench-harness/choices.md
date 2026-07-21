# SWE-bench harness choices ledger

Decision audit for the prerequisite RPC and TurnRunner corrections made on
2026-07-19. This ledger reviews choices, not whether the code passes tests.

## Review these first

N7 remains the only open user choice. For the active campaign, also review
S49's five-repeat restart-gate size: it is a provisional balance between
stochastic evidence and the remaining $500 envelope, not a claim of power.

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

### S20 — The replication spike ignores mini's missing price map and uses an action ceiling

- **When:** slice 04's mini-swe-agent replication, after Luna returned valid
  gateway responses that mini rejected during local price lookup.
- **The choice:** Only the throwaway replication runner disables mini's local
  cost calculation and caps each task at 40 model actions. Think of a taxi whose
  meter does not recognize a newly opened road: the ride itself works, but the
  meter throws after the first block. For this two-task plumbing check, we let
  the ride continue, count at most 40 turns, and read the actual charge from the
  gateway receipt saved on each response. The real Duet campaign keeps its own
  streamed dollar meter and has no action-count limit. The unbuilt alternatives
  switch to a different model just to satisfy LiteLLM's stale table, or patch a
  third-party price catalog inside the pinned environment.
- **The gap:** The spec fixed a cheap replication model and spend target but did
  not say how to handle a provider model that is callable and reports actual
  gateway cost while LiteLLM's bundled static catalog lacks its name.
- **The reach:** The replication still proves Docker, tool execution,
  prediction emission, and official scoring without weakening or contaminating
  the measured four-arm harness. The successful trajectories report $0.128210
  in gateway cost across 27 calls.
- **Verdict:** **sound.** An action ceiling is appropriate only for this
  non-measurement compatibility spike; the benchmark under comparison retains
  the user's requested time-and-dollar limits.
- **Confidence:** **high** because both untouched predictions scored 2/2 and
  the workaround is confined to an external replication tool, not campaign
  execution or accounting.

### S21 — The language matrix takes the first committed task in each bucket

- **When:** slice 05's `rollout smoke --all-languages` command.
- **The choice:** The command walks the benchmark's fixed language order and
  takes the first manifest row for each language. For example, Java always gets
  the first alphabetically stored Java task in the committed manifest; a later
  run does not choose whichever image happens to be cached or fastest that day.
  The unbuilt alternative maintains a second hand-picked nine-task list or
  chooses tasks dynamically from measured resource results.
- **The gap:** The spec required one image per language but did not define which
  of the three or four committed tasks represents that language in packaging
  smoke.
- **The reach:** Anyone rerunning the command gets the same nine images without
  another manifest-like artifact that could drift. This selection controls only
  compatibility smoke, never which tasks enter the four-arm measurement.
- **Verdict:** **sound.** The committed manifest is already sorted and fixed;
  consuming its first row is transparent, deterministic, and independent of
  model outcomes.
- **Confidence:** **high** because all 30 candidates have already passed the
  official gold gate, so no compatibility information is hidden by this rule.

### S22 — Packaging smoke is a pure-GLM one-file task stored outside campaign runs

- **When:** slice 05's live smoke workflow.
- **The choice:** Each image receives the real compiled Duet binary and
  `glm-pure` routing file, then the model is asked to create one exact sentinel
  text file. Its immutable RPC evidence lives under the ignored
  `.cache/smoke-runs` tree, and the patch must contain only that file before it
  is applied byte-for-byte to a fresh container. Think of this as testing a
  delivery truck with one labeled box: if the box arrives intact in every
  language-specific garage, packaging, tools, gateway access, patch extraction,
  and teardown all worked. The unbuilt alternative asks nine real benchmark
  issues, mixing model problem-solving ability into what should be a plumbing
  check and mixing smoke attempts into measured campaign artifacts.
- **The gap:** The slice prescribed a sentinel and advisor-OFF run but did not
  choose one of the two executors or an artifact namespace.
- **The reach:** Cross-language failures stay attributable to packaging or
  infrastructure. Kimi's executor path is exercised by the subsequent four-arm
  live gate; this matrix specifically proves the Linux artifact and pure-tool
  surface once per language.
- **Verdict:** **sound.** One executor is sufficient for image compatibility,
  and isolating synthetic artifacts prevents accidental inclusion in campaign
  predictions or spend reports.
- **Confidence:** **medium** because running both executors would add redundant
  provider coverage, although it would not strengthen the packaging contract.

### S23 — Each packaging smoke reserves $0.25, five minutes, and a 20 KB patch

- **When:** slice 05's live smoke workflow.
- **The choice:** A sentinel task is interrupted if streamed spend reaches
  $0.25 or wall time reaches five minutes, and rejected if its one-file patch
  exceeds 20 KB. The earlier Java checkpoint cost about one cent, so these
  ceilings leave ample room for a slow image without allowing a confused model
  to consume campaign-scale resources. The unbuilt alternative reuses the much
  larger real-issue rollout limits or adds an arbitrary assistant-step count.
- **The gap:** The spec capped the entire matrix below a dollar but did not set
  per-image time, spend, or patch ceilings.
- **The reach:** Worst-case reserved model spend for the nine-task matrix is
  $2.25, still inside the shared $500 envelope, and the same client interrupt
  path used by measured rollouts is exercised before the campaign.
- **Verdict:** **sound.** Direct time, dollar, and output-size limits bound the
  actual resources of concern without reviving the rejected step limit.
- **Confidence:** **high** because the limits are over 20× the observed Java
  model spend and the gold gate proves five minutes is enough for every image's
  official test path.

### S24 — The paid campaign starts with a conservative $1 prerequisite reserve

- **When:** immediately before slice 06's two-task four-arm campaign.
- **The choice:** The campaign breaker treats $1 as already spent before it
  launches the first measured rollout. The directly recovered prerequisite
  charges are about $0.27: the original live packaging check, the successful
  mini replication, and the nine-language matrix. A failed two-call mini probe
  could not be priced locally because that missing price entry caused the
  failure, so the reserve rounds the entire prerequisite phase up to $1. The
  unbuilt alternative records only the known cents and implicitly claims the
  failed provider calls were free.
- **The gap:** The spec required prerequisite spend to count against $500 but
  did not define how to account for a provider response whose third-party
  runner threw before persisting its cost.
- **The reach:** Every smoke, pilot, and full-campaign launch leaves at least
  $499 for future reservations and cannot knowingly erase earlier spend. The
  reserve is deliberately conservative; reports keep measured rollout spend
  separate from this sunk allowance.
- **Verdict:** **sound.** Over-reserving less than one dollar protects the hard
  envelope without changing any comparison or materially reducing campaign
  capacity.
- **Confidence:** **high** because $1 exceeds recovered prerequisite spend by
  more than 3× and the unknown probe made only two Luna calls.

### S25 — The zero-consult smoke is retained as a STOP, not called an advisor comparison

- **When:** slice 07's first two-instance, four-arm paid campaign.
- **The choice:** Preserve its artifacts and official 8/8 resolved scores, but
  exclude it from any claim about advisor effect. All four nominally advised
  attempts made zero consultations, and three final Carbon patches contained
  forbidden test/cache paths. The unbuilt alternative treats tool availability
  as treatment exposure and reports ordinary stochastic reruns as advisor ON.
- **The gap:** The report could label an enabled arm even when no advisor call
  occurred, and patch lint was only a late report assertion.
- **The reach:** Future reports can cite this run as packaging and patch-quality
  evidence only. Admission still requires a fresh campaign id whose advised
  arms demonstrably consult and whose patches pass policy before export.
- **Verdict:** **sound.** A treatment that never occurs cannot explain an
  outcome, regardless of the patches' official scores.
- **Confidence:** **high** because raw telemetry records zero calls in all four
  enabled attempts and the official report records the exact path violations.

### S26 — Every arm receives one identical controlled-advisor instruction

- **When:** the STOP loop from the zero-consult smoke returned to prompt
  ownership in slice 06.
- **The choice:** The shared benchmark prompt says to call `ask_advisor`
  exactly once after initial inspection and before implementation when that
  tool is available; pure arms see the same text and continue normally because
  the tool is absent. Think of a medical trial where the prescription is the
  same sheet for everyone, but only the treatment group receives the tablet.
  The unbuilt alternatives rely on optional product guidance that all sampled
  models skipped, or inject a hidden reroute message only into advised arms.
- **The gap:** Tool availability alone did not produce treatment exposure, so
  the original comparison could not answer the user's question.
- **The reach:** Advisor-enabled campaigns now measure one standardized
  consultation while keeping issue text, executor, memory, classifier, and
  visible prompt bytes fixed inside each pair. Telemetry remains the acceptance
  proof that the prescribed call actually occurred.
- **Verdict:** **sound.** The benchmark is explicitly comparing an executor
  alone with that executor plus one advisor consultation; guaranteed exposure
  is part of the treatment, not prompt tuning for task success.
- **Confidence:** **medium-high** until the fresh paid pilot proves both
  executors obey the instruction without disturbing pure arms.
- **Resolution after stopped E2B v4:** Superseded by U2. Exactly-once remains a
  historical controlled-exposure protocol, not the product-policy treatment or
  an Anthropic reproduction.

### S27 — Patch policy is enforced at rollout completion, before prediction export

- **When:** the stopped smoke report found test and cache paths in otherwise
  officially resolving Carbon patches.
- **The choice:** Run the same exact-path lint immediately after patch
  extraction and persist a `patch` failure instead of a completed rollout when
  it finds tests, runtime files, emptiness, or oversize output. The shared prompt
  also tells agents to revert test-run cache side effects before finishing. The
  unbuilt alternative scores first and merely prints a failed assertion later.
- **The gap:** `buildPredictions` legitimately trusted the completed marker, but
  completion was written before the report-owned policy ran.
- **The reach:** Forbidden patches cannot enter official prediction files or a
  resumed campaign's completed set. Reporting and runtime import one policy
  owner, so their definitions cannot drift.
- **Verdict:** **sound.** Admission invariants belong at the boundary that marks
  an artifact admissible, with reporting as a second check rather than the only
  check.
- **Confidence:** **high** because a falsified regression test observed the old
  completed status and now proves a durable patch failure plus teardown.
- **Resolution after product-policy cleanup:** Superseded by S54 for test and
  harness-runtime paths. Oversize output still fails at extraction; empty
  production output remains scoreable.

### S28 — Official scoring groups all arms by instance and uses absolute work paths

- **When:** the first live campaign score pass and its subsequent throughput
  review.
- **The choice:** Resolve the output root before changing directories, group
  predictions by instance, pull that official image once, score every pending
  arm, then remove it. Cached official reports bypass Docker entirely on resume.
  The unbuilt alternative keeps config-major order, re-pulling every multi-GB
  image four times and repeating those pulls after interruption.
- **The gap:** Relative prediction paths became unreadable under the scorer's
  per-attempt working directory, and lifecycle ownership was scoped to one arm
  rather than the instance block.
- **The reach:** A 30-instance four-arm campaign performs at most 30 image
  lifecycles instead of 120, while still using one official worker and exact-
  image cleanup on this Mac.
- **Verdict:** **sound.** Image identity belongs to the SWE-bench instance, not
  the model label, and absolute paths survive working-directory changes.
- **Confidence:** **high** because the path regression failed with the exact
  doubled live path, batching is unit-tested, and an eight-result live resume
  completed with no Docker pulls.

### S29 — The three-task pilot is a seeded distinct-language draw from the committed 30

- **When:** preparing the fresh slice 07 pilot after the stopped smoke.
- **The choice:** Shuffle the committed manifest with the same checked-in PRNG,
  then take the first three entries whose languages have not appeared yet. The
  campaign records seed `20260721`, which selects `fmtlib__fmt-3729`,
  `preactjs__preact-2757`, and `sharkdp__bat-1892` (C++, JavaScript, Rust). The
  runtime validates the recorded ids against that seed. The unbuilt alternative
  takes the alphabetically first rows or reuses the two already-observed smoke
  tasks and adds a convenient third.
- **The gap:** The spec required three languages and a recorded seed but the
  full-manifest selector deliberately requires all nine languages, so it could
  not represent a three-task subset directly.
- **The reach:** Pilot admission cannot be steered toward easy tasks, cached
  images, or known 100% smoke outcomes. Future pilot subsets use the same public
  rule and fail validation if someone hand-edits their ids.
- **Verdict:** **sound.** A distinct-language seeded draw preserves diversity
  and makes the small sample reproducible without pretending it is a new full
  manifest.
- **Confidence:** **high** because selection is pure, red/green tested, and the
  committed campaign is checked against its seed.

### S30 — The fresh pilot carries a conservative $5 sunk-spend reserve

- **When:** freezing the fresh three-task campaign after the $3.6834 stopped
  smoke.
- **The choice:** Advance the earlier $1 prerequisite reserve to $5, rounding
  up after adding the entire stopped-smoke model spend. The unbuilt alternative
  starts a new campaign id with its breaker reset to the old prerequisite-only
  value.
- **The gap:** Campaign ids isolate provenance and artifacts, but the user's
  $500 envelope spans the whole experiment rather than one id.
- **The reach:** Every fresh-pilot launch reserves against all known earlier
  spend while retaining over $495 of the envelope. Final reports can keep each
  campaign's measured cost separate without weakening the global breaker.
- **Verdict:** **sound.** Rounding upward is conservative and immaterial to
  capacity, while forgetting prior campaign spend would violate the hard cap.
- **Confidence:** **high** because $5 exceeds the known prerequisite plus
  stopped-smoke spend and the per-rollout breaker reserves before launch.

### S31 — An empty patch is a scoreable model failure, not broken infrastructure

- **When:** the first pure-GLM task in the corrected pilot investigated
  `fmtlib__fmt-3729`, announced an implementation step, then terminated without
  editing.
- **The choice:** Complete the rollout with an empty `patch.diff`, export it in
  the official prediction schema, and let SWE-bench report `empty_patch` in the
  denominator. Lint still exposes emptiness as a model outcome, but the patch
  integrity assertion covers only blocking conditions such as test/runtime
  edits and oversize output. The unbuilt alternative stores a `patch` failure,
  omits the prediction, and makes a weak model answer look like harness damage.
- **The gap:** Extraction treated zero bytes as malformed even though the
  official scorer has a first-class empty-patch outcome and the report promised
  never to drop failures from denominators.
- **The reach:** Full-campaign reliability and resolve rates now include agents
  that stop before editing. Resume planning can distinguish a completed poor
  answer from infrastructure that deserves a retry.
- **Verdict:** **sound.** Benchmarks measure model failures; they must not erase
  or relabel them merely to keep the patch assertion green.
- **Confidence:** **high** because the live transcript proves the agent ended
  normally, and red/green tests cover extraction through prediction export.

### S32 — The semantically corrected pilot restarts under v3 with $6 sunk

- **When:** after v2 completed the first GLM pair, proved one successful Kimi
  consultation, and was interrupted as its next arm started.
- **The choice:** Keep v2 immutable as evidence and restart all twelve logical
  rollouts under `multilingual-pilot-3-20260720-v3`, with a $6 sunk reserve. The
  unbuilt alternatives mutate v2's failed status into completed or splice its
  two results into artifacts produced under different harness semantics.
- **The gap:** Harness source is not part of the Duet binary hash recorded in a
  rollout spec, so changing empty-patch admission cannot safely reuse the same
  filesystem namespace.
- **The reach:** Every v3 result shares one treatment prompt, one binary, one
  patch-admission definition, and one resumable campaign tree. The extra reserve
  covers v2's recorded $0.8106 plus its interrupted sub-minute arm.
- **Verdict:** **sound.** Repeating two tasks costs little relative to the
  envelope and avoids provenance ambiguity in the final admission report.
- **Confidence:** **high** because campaign ids are the documented boundary for
  frozen-input changes and $6 conservatively exceeds known cumulative spend.

### S33 — The official scorer decides preserved cutoff-patch outcomes

- **When:** the corrected pilot's C++ arms reached a cost or wall limit after
  writing production patches that remained valid benchmark submissions.
- **The choice:** Count an official `resolved` result whenever the rollout
  completed its artifact bundle, even if Duet's terminal status is
  `interrupted`. Keep that terminal status as reliability and throughput data.
  The unbuilt alternative overrides a resolved official score merely because
  the harness stopped further model work at its configured limit.
- **The gap:** The report originally required both an exported artifact and a
  normal agent terminal, conflating whether a patch was scoreable with how the
  agent stopped producing it.
- **The reach:** Cost- and wall-limited patches stay in the denominator and can
  resolve normally; actual infrastructure failures still lack a completed
  artifact and cannot become successes. Paired comparisons use the same rule.
- **Verdict:** **sound.** SWE-bench evaluates the submitted repository diff;
  the terminal label describes the generation process and must not replace the
  official test outcome.
- **Confidence:** **high** because the distinction is represented directly in
  the artifact tree and a regression test covers an interrupted rollout with a
  resolved official score.

### S34 — Campaign scoring owns image cleanup outside each official invocation

- **When:** the corrected pilot's first Fmt arm resolved, then the official
  scorer's `--clean true` removed the shared image and the next arm failed with
  `No such image`.
- **The choice:** Invoke the unmodified official scorer with `--clean false`
  while scoring every arm for one instance, then remove that exact image once
  in the campaign wrapper's `finally` block. The one-row gold checker keeps
  `--clean true`. The unbuilt alternative pulls the same multi-gigabyte image
  again before every arm.
- **The gap:** Grouping arms around one explicit pull did not help while each
  nested scorer invocation still owned image deletion.
- **The reach:** All arms for an instance see the same official image, scoring
  remains serial, interrupted scoring still releases the owned image, and no
  unrelated Docker images are pruned.
- **Verdict:** **sound.** Cleanup belongs to the layer that knows the image is
  shared; the official test execution itself is unchanged.
- **Confidence:** **high** because the live failure reproduced the lifecycle
  bug and a red/green regression drives two arms through the wrapper while
  simulating deletion semantics.

### S35 — Admission assertions include rejected patches and intended advisor identity

- **When:** the v3 report correctly counted the rejected Rust Kimi+Fable arm as
  unresolved but still printed `Patch integrity assertion: PASS`, while the
  GLM+Kimi advisor miss appeared only as an aggregate call count of two.
- **The choice:** Preserve failed status messages in report attempts, fail patch
  integrity on every patch-admission failure, and require each advised rollout
  to record exactly one successful call to its configured concrete advisor.
  The unbuilt alternative relies on a human to reconcile status files against
  a superficially green report footer.
- **The gap:** Completed artifacts carried patch lint, but rejected artifacts
  carried their actionable evidence only in `status.json`; advisor totals did
  not prove per-instance attribution or model identity.
- **The reach:** The machine report now makes both treatment contamination and
  patch contamination explicit STOP conditions without dropping the rollout
  from paired denominators.
- **Verdict:** **sound.** An admission assertion must cover the failures that
  admission itself produced, and advisor-effect claims require the intended
  model to have been consulted on every treated sample.
- **Confidence:** **high** because independent red/green tests cover both a
  rejected patch message and a successful call attributed to the wrong model.

### S36 — Exact advisor timing is a shared system rule, not a routing-protocol change

- **When:** GLM followed the byte-identical user prompt on two pilot tasks but
  skipped `ask_advisor` on Rust, and Rust validation commands remained alive
  after their foreground wait budgets.
- **The choice:** Pass one benchmark-owned system instruction identically to all
  four arms. It makes a present advisor mandatory exactly once after read-only
  inspection and before edits; a pure arm proceeds when the tool is absent.
  Normalize `CI`, `PAGER`, `GIT_PAGER`, `BAT_PAGER`, and `TERM` identically in
  every container, and tell every arm to stop a validation command that is
  still running after two minutes. Record the system instruction's hash in each
  rollout spec. The unbuilt alternative adds benchmark-only required-advisor
  state to the RPC or public routing schema.
- **The gap:** Product guidance correctly says routine tasks may skip optional
  advice, which conflicts with this experiment's deliberately controlled
  exposure. Official images can also expose interactive pager defaults through
  a pseudo-terminal.
- **The reach:** Treatment compliance becomes stronger without changing Duet's
  general advisor semantics or the user prompt between arms. Non-interactive
  environment defaults remove pager variance, while the explicit two-minute
  rule bounds any candidate or validation process that still remains alive.
  Resume rejects artifacts from a different system instruction.
- **Verdict:** **sound.** The benchmark owns experimental instructions and
  non-interactive process policy; the product protocol should remain general.
- **Confidence:** **high.** The targeted live Rust rerun recorded exactly one
  successful `moonshotai/kimi-k3` call from GLM and one successful
  `anthropic/claude-fable-5` call from Kimi. Both production-only patches then
  resolved under the official scorer. That rerun also falsified the assumption
  that pager variables alone bound all validation, motivating the shared
  two-minute instruction before the full campaign.
- **Resolution after stopped E2B v4:** The single targeted success did not prove
  repeated compliance. S49 replaces it as the restart gate.

### S37 — The production campaign retires the $1.25 pilot cutoff

- **When:** The compliance GLM rollout completed normally at $1.2622, directly
  proving that the pilot ceiling could interrupt a valid treatment outcome.
- **The choice:** Give every production rollout the same $4 emergency spend
  ceiling and 30-minute wall, with concurrency one. Carry a conservative $20
  allowance for all prerequisite live work. The unbuilt alternative keeps the
  pilot's $1.25 cutoff even though the budget can support materially more work.
- **The gap:** A campaign-wide $500 envelope still needs a finite per-launch
  reservation so the breaker can prove it will not knowingly overspend.
- **The reach:** The old treatment-limiting cutoff is gone, while the worst-case
  reservation remains exact: `$20 + 120 × $4 = $500`. Cost and time cutoffs are
  denominator-visible unresolved outcomes, never dropped attempts.
- **Verdict:** **sound.** Four dollars is over three times the falsified pilot
  ceiling and much larger than the observed complete rollouts, while preserving
  a hard global guarantee.
- **Confidence:** **high** in the arithmetic and **medium** that no unusually
  expensive task reaches $4; the full report will expose any such cutoff.

### S38 — Report admission has one executable gate

- **When:** the report rendered advised-arm attribution failures correctly, but
  the CLI exit status checked only pure-arm silence and patch integrity.
- **The choice:** Centralize the three report admission assertions in
  `campaignReportPassesAdmission` and use it for the CLI exit decision. The
  unbuilt alternative leaves human-readable STOP output with a successful
  process status.
- **The gap:** Rendering a failed assertion is not sufficient for unattended
  orchestration or release checks.
- **The reach:** Pure-arm contamination, missing/wrong advisor treatment, and
  patch contamination now all fail the report command consistently.
- **Verdict:** **sound.** One admission concept should have one executable
  definition.
- **Confidence:** **high** because a red/green report test proves a wrong
  advisor identity makes the aggregate gate false.

### S39 — The benchmark client speaks the correlated RPC envelope

- **When:** after rebasing onto `v0.2.4`, the first production attempt remained
  read-only because RPC correctly rejected its prompt: the new transport
  requires `requestId`, while the benchmark still serialized the internal
  `TurnRunnerCommand` shape.
- **The choice:** Type outbound benchmark commands as `RpcRunnerCommand` and
  attach one stable request id to the single rollout prompt. Preserve the
  zero-cost v1 attempt and restart under v2 after rebuilding Duet. The unbuilt
  alternative weakens the new RPC validation or deletes evidence to reuse the
  original campaign id.
- **The gap:** Unit tests modeled the pre-`v0.2.4` wire contract and therefore
  accepted a command the live CLI rejected.
- **The reach:** Future RPC-envelope changes become type errors at the benchmark
  boundary. The v2 campaign has clean provenance; v1 remains an auditable
  zero-spend rejected launch.
- **Verdict:** **sound.** A wire client must depend on the wire type, not the
  runner's internal command union.
- **Confidence:** **high** because the regression test failed on the missing id
  before the change and now asserts the exact serialized envelope.

### S40 — Benchmark tests are owned and run outside the product test tree

- **When:** while adding the E2B backend before the final campaign.
- **The choice:** Move every SWE-bench TypeScript test to
  `benchmarks/swebench/test/`, retain the Mac helper tests under
  `benchmarks/swebench/mac/tests/`, and expose a separate `bun run
test:swebench` Docker runner. The root `test/` tree and `bun run test` remain
  product-only.
- **The gap:** Benchmark tests depended on benchmark fixtures and execution
  policy but were discovered as ordinary product tests, obscuring package
  ownership and making the standard suite responsible for experimental code.
- **The reach:** Benchmark changes have an explicit isolated gate without
  shrinking product coverage. Shared generic test helpers may still be imported
  from the product test infrastructure; benchmark-specific files do not live
  there.
- **Verdict:** **sound and user-directed.** The filesystem and commands now
  express the intended ownership boundary directly.
- **Confidence:** **high** because both isolated Docker suites pass after the
  move: 60 benchmark tests and 1,146 product tests.

### S41 — E2B parallelizes instance blocks without changing the harness

- **When:** after Mac-local throughput projected roughly a day for the final
  generation run and the user supplied an E2B key.
- **The choice:** Start a new final campaign namespace on an immutable,
  commit-derived x86_64 E2B template. Run up to sixteen independent instance
  blocks concurrently, while each block preserves seeded four-arm serial order
  and each arm still runs inside a fresh official SWE-bench Docker container.
  Preserve but do not mix the partial Mac v2 outcomes.
- **The gap:** Raising local concurrency exceeded the admitted Docker VM memory;
  reusing partial local outcomes under a different execution environment would
  weaken provenance.
- **The reach:** Generation time falls with cloud concurrency while model,
  prompt, image, patch, telemetry, and official-scoring semantics stay the same.
  A stable environment lock and per-instance archive boundary make resume and
  attribution auditable.
- **Verdict:** **sound and user-directed.** E2B supplies capacity around the
  existing official container boundary instead of replacing it.
- **Confidence:** **medium-high** until the immutable template capacity probe
  and first live instance block pass.

The initial value was eight workers. Before final generation, the user
explicitly raised it to sixteen; this changes elapsed time and E2B compute, not
the number of rollouts or the independently enforced model-spend bound.

### S42 — The E2B campaign preserves the global budget after the local pivot

- **When:** freezing the new campaign after two valid Mac v2 arms recorded
  $0.7933.
- **The choice:** Round cumulative prerequisite and superseded-campaign spend to
  a conservative $21, then set the uniform emergency ceiling to $3.99. The
  frozen worst case is `$21 + 120 × $3.99 = $499.80`. E2B infrastructure cost
  is accounted separately because it is not model-gateway spend.
- **The gap:** Copying the prior `$20 + 120 × $4` inputs into a new campaign
  would ignore the additional valid local generation and knowingly exceed the
  user's $500 model envelope in the worst case.
- **The reach:** Every one of the 120 logical outcomes retains a large,
  non-binding generation ceiling while the reserve-first breaker has twenty
  cents of arithmetic headroom.
- **Verdict:** **sound.** It is the smallest uniform adjustment that preserves
  the hard global guarantee without introducing per-arm treatment differences.
- **Confidence:** **high** in the bound; measured rollouts remain far below the
  $3.99 emergency cutoff.

### S43 — The immutable template owns the campaign binary and dataset

- **When:** the first E2B Druid block passed all four rollout and official-score
  gates, but expansion to fresh sandboxes triggered the provenance mismatch
  guard before any additional model calls.
- **The choice:** Compile Duet once while building the commit-derived E2B
  template, cache the pinned dataset there, and make every worker hash and use
  that exact prebuilt binary. Preserve the scored Druid block as admission
  evidence and restart the final measurement under a clean v2 campaign id. The
  unbuilt alternative disables binary provenance or treats independently
  compiled, byte-different executables as one treatment.
- **The gap:** Bun's compiled output is not byte-reproducible across independent
  sandboxes even when every source input and tool version matches. Re-fetching
  the same pinned dataset in every worker also introduced avoidable transient
  5xx failures.
- **The reach:** Campaign provenance now describes one actual executable shared
  by all 120 rollouts. Dataset startup is offline, transient template downloads
  retry before snapshotting, and controller-level sandbox creation retries only
  before a worker can receive a model command.
- **Verdict:** **sound.** One campaign must execute one byte-identical harness;
  provenance rejection found treatment drift that scoring alone could not.
- **Confidence:** **high** in the diagnosed cause because a disposable worker
  reproduced a different binary SHA while spec, git SHA, manifest, renders, and
  environment were byte-identical. Final confidence awaits the v2 two-worker
  hash gate and full campaign.

### S44 — The clean E2B restart accounts for the admitted block as sunk spend

- **When:** after the v1 E2B Druid admission block spent $1.4304 and the binary
  fix required a new campaign namespace.
- **The choice:** Conservatively raise sunk model spend from $21 to $22.44 and
  lower the uniform emergency ceiling from $3.99 to $3.97. The new worst case
  is `$22.44 + 120 × $3.97 = $498.84`.
- **The gap:** Reusing the old campaign id would violate write-once provenance;
  omitting its model calls from the global envelope would undercount spend.
- **The reach:** All four v1 outcomes stay auditable but none is mixed into the
  v2 estimate. Every v2 arm retains the same non-binding cap and $1.16 of
  arithmetic headroom remains.
- **Verdict:** **sound.** Restarting a treatment requires both a new namespace
  and honest cumulative accounting.
- **Confidence:** **high** because the four persisted terminal ledgers sum to
  $1.4304 and the bound is direct arithmetic.

### S45 — Provider credentials stay out of Docker process arguments

- **When:** while inspecting the v2 security admission before expansion.
- **The choice:** Pass provider variables to the Docker client through its
  process environment and use name-only `docker exec --env NAME` arguments.
  Stop the active v2 admission, reserve its full $3.97 per-arm ceiling as sunk
  spend, and restart under a v3 namespace with a uniform $3.94 cap. The new
  worst case is `$26.41 + 120 × $3.94 = $499.21`.
- **The gap:** `--env NAME=value` made credential values visible in process
  listings and command-failure text. The stopped sandbox was destroyed before
  telemetry download, so its exact partial spend cannot be proven.
- **The reach:** Containerized evals still receive exactly the requested
  provider variables, but their values are absent from argv. No v2 outcome can
  enter the v3 estimate, and reserving the maximum possible interrupted spend
  preserves the global model-spend guarantee.
- **Verdict:** **sound.** Credential transport and campaign accounting both
  fail closed without changing the benchmark treatment.
- **Confidence:** **high** in the argv boundary because the regression test was
  observed red on the old behavior and green on the new behavior; the spend
  reservation is deliberately worst-case because exact telemetry was lost.

### S46 — General advisor timing yields to stricter workflow rules

- **When:** the v3 Druid admission completed all four arms, but Kimi skipped
  Fable despite the benchmark's mandatory exactly-once system instruction.
- **The choice:** In an ordinary Duet task, the working model is told to ask a
  second model for advice only when the work is consequential or unclear, and
  to skip advice for a routine fix. A workflow can add a stricter rule: this
  benchmark tells the working model to consult exactly once even when the fix
  looks routine, because the experiment is invalid if the “advisor on” arm
  never exposes the advisor. Make the ordinary rule explicitly yield in that
  situation while leaving normal Duet tasks optional. The unbuilt alternatives
  reorder every system-prompt layer, or add a new protocol switch that forces a
  tool call. Preserve v3 as failed admission evidence and restart v4 with
  `$27.64` sunk and a uniform `$3.93` emergency ceiling; the worst case is
  `$27.64 + 120 × $3.93 = $499.24`.
- **The gap:** The benchmark instruction appeared before a later general layer
  saying to skip routine work. Both were system instructions, so Kimi sometimes
  followed the later default while GLM and earlier Kimi samples followed the
  experiment-specific requirement.
- **The reach:** Product behavior remains optional unless a workflow explicitly
  imposes a stricter schedule; the benchmark needs no protocol/config special
  case. V3's exact $1.2233279 is conservatively included in sunk spend and none
  of its outcomes enters the v4 estimate.
- **Verdict:** **sound.** A general default should not contradict a deliberate
  workflow invariant, and explicit precedence is narrower than reordering all
  system layers or adding required-advisor protocol state.
- **Confidence:** **medium-high** until the v4 live Druid admission proves Kimi
  calls Fable. The composed-prompt regression was observed red before the fix
  and green after it, and the focused product test pins the same contract.
- **Resolution after stopped E2B v4:** Superseded by U2. V4 still produced three
  zero-call attempts and one double call, so prompt precedence did not turn the
  protocol into deterministic or product-representative exposure.

## Unsound after stopped E2B v4

### U2 — Mandatory exactly-once exposure was treated as the advisor strategy

- **When:** slice 08 stopped-v4 diagnosis on 2026-07-20.
- **The choice:** Earlier passes told every enabled executor to call its advisor
  exactly once before editing and described a successful call as the treatment
  the campaign was meant to measure. Imagine enabling advice on a routine task:
  shipped Duet lets the executor decide that no consultation is worthwhile,
  while the benchmark ordered one anyway. Anthropic's server tool also leaves
  timing to the executor, sends the full transcript, and its coding guidance
  aims for early and completion-time review—roughly two or three calls—not
  exactly one. The unbuilt alternative was to make advisor availability the
  assignment, keep every rollout in the primary comparison, and report actual
  calls separately.
- **The gap:** Zero calls made the first pilot uninterpretable, and the plan
  solved exposure by prescribing a call without revisiting which real-world
  behavior the resulting number represented.
- **The reach:** V1–v4 may describe their own controlled protocols, but none can
  be presented as the effect of shipped Duet's advisor policy or a reproduction
  of Anthropic's published result. Future campaigns must name assignment and
  exposure separately.
- **Verdict:** **unsound.** Correct decision: the primary estimate is assignment
  to shipped advisor availability; observed successful consultation is a
  secondary per-protocol description, and forced-call experiments are labeled
  as a different protocol.
- **Confidence:** **high** because Anthropic's official documentation and v4's
  observed zero- and double-call attempts directly contradict exact-one
  equivalence.

## Sound after stopped E2B v4

### S47 — Product-policy assignment is primary; per-protocol exposure is descriptive

- **When:** slice 08 stopped-v4 reporting correction on 2026-07-20.
- **The choice:** Pair every pure outcome with the outcome assigned to the
  advisor-enabled product, even if that executor called zero or several times.
  Then show a second table for the tasks where advice actually returned. For
  example, the three scored v4 rows where pure resolved and enabled did not are
  real assignment outcomes, but all three enabled runs made zero calls, so they
  are not evidence that advice content caused harm. The unbuilt alternative
  drops non-callers and reports only exposed tasks as though models chose to
  call at random.
- **The gap:** The old report had one “advisor effect” label for both tool
  availability and successful use.
- **The reach:** The primary result answers a product decision—whether to enable
  the policy. The secondary result explains mechanism and compliance but is
  visibly selection-prone because harder tasks may be more likely to trigger a
  call.
- **Verdict:** **sound.** Assignment is fixed by the experiment; exposure is a
  model behavior observed after assignment and cannot replace it causally.
- **Confidence:** **high**.

### S48 — Full available transcript fidelity is an admission gate

- **When:** comparing Duet's client-side advisor with Anthropic's official
  server-side advisor during the stopped-v4 diagnosis.
- **The choice:** Before another full campaign, capture a call after meaningful
  inspection and prove the advisor receives the executor's system prompt, tool
  definitions, ordered messages, tool calls/results, and current-turn text. If
  that material fits the advisor context window, no text-preview conversion or
  configured elision is allowed. The current curated 10,000-token summary keeps
  selected headlines and a recent tail; the unbuilt alternative calls that
  equivalent to the complete transcript even when earlier evidence or tool
  structure was removed.
- **The gap:** The campaign borrowed Anthropic's “shared context” rationale but
  never gated the custom advisor transport against the documented full-context
  contract.
- **The reach:** A future report can state exactly which context the advisor saw.
  Passing this gate still does not make different models and client-side system
  prompts identical to Anthropic's service; it removes one known semantic gap.
- **Verdict:** **sound.** Advice quality cannot be attributed to a shared-context
  strategy until the sharing boundary is proven rather than inferred.
- **Confidence:** **high**.

### S49 — The restart gate repeats the three known zero-call loss cases five times per pair (superseded by S60)

- **When:** defining what must replace the single targeted compliance rerun
  before E2B v5.
- **The choice:** Run five fresh pure/enabled pairs on each of the three v4
  cases where the enabled arm lost without calling: one Fluentd task for
  GLM/Kimi and two Docusaurus tasks for Kimi/Fable. This produces 30 rollouts.
  Keep all attempts, including zero and multiple calls. The unbuilt alternatives
  accept one green rerun again, or spend on another full 120-rollout campaign
  before learning whether the same failure mode is stochastic and recurrent.
- **The gap:** The user required focused repeated rollouts but did not set the
  repeat count or admission threshold.
- **The reach:** Superseded. Consultation occurrence is telemetry, not an
  outcome-safety threshold. The user later set the pairwise non-regression rule
  and required clean batches to expand to more tasks.
- **Verdict:** **superseded by S60.** The pair-specific campaign shape remains
  useful, but its admission semantics were wrong.
- **Confidence:** **medium** because three or ten repeats would also be
  defensible cost/reliability tradeoffs.

### S50 — Prompt or product changes require a clean v5 measurement namespace

- **When:** freezing v4 after its diagnosis.
- **The choice:** Preserve every v4 artifact, count its $72.2112 recorded spend,
  and reserve `multilingual-30-four-arm-e2b-20260720-v5` for the next full run
  after context and prompt changes pass the focused gate. The unbuilt
  alternative resumes v4 with a different binary and prompt, making one report
  combine incompatible treatments.
- **The gap:** V4 stopped after 100 generated rollouts, so resuming it would be
  cheaper than repeating completed work but would break the campaign's own
  frozen-hash contract.
- **The reach:** V1–v4 remain useful engineering evidence and global budget
  inputs, while every v5 outcome shares one product, prompt, binary, and
  reporting definition.
- **Verdict:** **sound.** Experimental provenance is worth more than salvaging
  outcomes produced under a rejected treatment definition.
- **Confidence:** **high**.

### S51 — Advisor context is bounded only by the receiving model's real window (superseded by S65)

- **When:** implementing the stopped-v4 context-fidelity correction.
- **The choice:** Capture the executor's resolved system prompt, exact tool
  definitions, converted messages, thinking, tool calls, complete tool results,
  current turn, and images at tool execution time. Send that structured context
  without the observer projection or a tier-configured 10,000-token cap. Reserve
  2,048 tokens for advice and two percent for provider-tokenizer and framing
  differences; only if the remaining receiving-model window is exceeded, keep
  the first user task plus the newest whole-message suffix and report every
  omission. Multibyte text is also charged by UTF-8 size so CJK-heavy context
  cannot appear artificially cheap. The unbuilt alternative preserved a
  smaller configurable transcript budget even when the advisor could accept
  more, or trusted a rough character estimate all the way to the hard limit.
- **The gap:** Anthropic's result depends on shared working context, while v4
  silently discarded tool structure, thinking, and most long tool results.
- **The reach:** Product config no longer exposes `transcriptTokens`; runtime
  calls and CLI previews share one capture owner; successful benchmark calls
  must carry parseable context-window telemetry. A smaller advisor model can
  still truncate, but the report makes that explicit instead of calling a
  projection “full context.”
- **Verdict:** **sound for removing the old lossy 10k projection, superseded for
  steady-state policy by S65.** The hard provider limit remains the final safety
  guarantee, but observations plus a measured soft target now bound repeated
  advisor cost without reviving the old preview projection.
- **Confidence:** **high** after GLM and Kimi recovered an unguessable marker
  beyond the former tool-result cutoff, the temporary old cutoff made the eval
  fail, and restoration made it pass again.

### S51a — Image capability is checked on the concrete consultation

- **When:** the independent review of the full-context implementation.
- **The choice:** Keep text-only advisors valid for text-only transcripts. At
  tool execution, inspect the resolved model capability and the captured
  context together. If the context contains images the advisor cannot inspect,
  do not send the invalid provider request: log the failed consultation, release
  the reserved cooldown slot, and let the executor continue. The first review
  response rejected every enabled text-only advisor at configuration time; the
  live GLM fidelity eval proved that was broader than the actual failure mode,
  so it was removed before the restart gate.
- **The gap:** The routing schema previously guaranteed image support only for
  executor fallbacks, not for advisors that now receive the same context.
- **The reach:** Text-only advisors still work for ordinary coding transcripts;
  image-bearing consultations require a vision-capable target and remain
  observable as failed exposure when that condition is not met.
- **Verdict:** **sound.** The direct request boundary checks the one condition
  that matters without rejecting configurations that can work, and it neither
  sends an invalid request nor silently degrades visual evidence.
- **Confidence:** **high** after the text-only live eval exposed the overbroad
  configuration rule and the request-boundary unit test pinned the real case.

### S52 — Repeated trials receive distinct official scorer identities

- **When:** preparing S49's five-repeat restart gate.
- **The choice:** Keep trial one's historical scorer name `duet-<config>` and
  name later trials `duet-<config>-trial-<n>`. Parse that identity back into the
  arm and trial, reject duplicates or unscheduled rows, and make every report
  outcome and consultation row trial-explicit. The unbuilt alternative emitted
  the same scorer model name for every repeat, allowing SWE-bench outputs and
  caches to overwrite one another.
- **The gap:** The orchestrator already supported `trials > 1`, but prediction,
  scoring, and report identities did not.
- **The reach:** Focused reports now cross-foot every repetition independently;
  single-trial historical artifacts retain their existing names.
- **Verdict:** **sound.** One logical rollout must map to one official scorer
  identity or repeated evidence is not auditable.
- **Confidence:** **high** from the duplicate-rejection and two-trial scorer and
  report tests.

### S53 — The restart gate is two pair-specific campaigns with a conservative shared reserve

- **When:** freezing the paid gate inputs after trial-aware reporting landed.
- **The choice:** Run one 10-rollout GLM/Kimi campaign on Fluentd and one
  20-rollout Kimi/Fable campaign on the two Docusaurus tasks. Each report accepts
  only its scheduled arms and complete comparison. The second campaign's sunk
  value reserves all ten GLM rollouts at their $3.93 ceiling, so the combined
  worst case remains inside the global $500 envelope even if both E2B jobs
  overlap. The unbuilt alternative put all four arms on all three tasks for 60
  rollouts or let unrelated arms appear as phantom missing rows.
- **The gap:** Campaign specs apply one arm list to every selected instance, but
  S49 intentionally assigns different model pairs to different tasks.
- **The reach:** The gate spends 30 rather than 60 rollouts, preserves pairwise
  denominators, and recalculates v5 from actual gate spend plus any unknown
  interrupted reserve. These are adaptive engineering diagnostics subject to
  S60's per-pair fail-fast rule and never rows in the final estimate.
- **Verdict:** **sound.** Pair-specific namespaces express the intended design
  directly without weakening provenance or the budget breaker.
- **Confidence:** **high** in the accounting bound and report shape; the paid
  gate remains to be observed.

### S54 — Working tests are allowed; only production paths enter scoring (superseded by S58)

- **When:** removing benchmark-owned workflow constraints before restarting
  slice 08.
- **The choice:** Let the coding agent create or edit tests while it investigates
  a task, just as it would in the product. When the run ends, the harness splits
  the changed paths into two lists: production paths become the official
  prediction, while test and `.duet` runtime paths are recorded in a separate
  sidecar and omitted. For example, if an agent fixes `src/parser.ts` and adds
  `tests/parser.test.ts`, the scorer receives only the parser fix and the
  artifact still records that the test existed. If it writes only a test, the
  scorer receives an honest empty patch. The unbuilt alternatives either tell
  the model not to write tests and reject an otherwise useful production fix,
  or submit changed tests and risk letting the candidate patch influence the
  checks that judge it.
- **The gap:** The original spec required production-only scoring but did not
  say whether that policy should constrain the model's work or the submission
  boundary. Earlier code chose both: a prompt prohibition plus rollout failure.
- **The reach:** Pure and advisor-enabled arms can use normal coding workflows
  without test-writing becoming a hidden failure mode. The same path
  classifier owns both new extraction and historical artifact linting, and the
  excluded-path sidecar keeps the transformation auditable.
- **Verdict:** **superseded.** The production-only boundary still made the
  benchmark reinterpret a legitimate repository diff. S58 removes it.
- **Confidence:** **high** because mixed and test-only regressions assert the
  exact submitted patch, retained production paths, and recorded exclusions.

### S55 — The committed campaign subset is the E2B worker population

- **When:** hardening the E2B controller after the first restart-gate attempt.
- **The choice:** If a campaign names one or two `instanceIds`, the controller
  launches workers only for those tasks. An operator may pass `--instance` to
  run an even smaller shard, but cannot use it to add a task outside the frozen
  campaign. The stopped driver instead launched all 30 manifest tasks and let
  27 workers discover they had zero work after startup. The unbuilt alternative
  keeps treating the full manifest as the controller default and relies on the
  inner orchestrator to discard irrelevant workers.
- **The gap:** The local orchestrator honored the campaign subset, but the outer
  E2B capacity layer independently chose its default population from the full
  manifest.
- **The reach:** Focused gates now create only the sandboxes that can run model
  work; CLI sharding remains a narrowing operation and cannot silently change
  the committed experiment.
- **Verdict:** **sound.** The campaign spec already owns task selection, so the
  capacity layer must consume rather than re-derive it.
- **Confidence:** **high** because the regression reproduces the old 30-worker
  population and asserts the exact committed two-task order plus a rejected
  out-of-campaign request.

### S56 — Worker artifacts stage privately and publish completion last

- **When:** hardening the E2B controller after two same-campaign workers raced
  while extracting `campaign.json` into one host directory.
- **The choice:** Download and validate each worker archive in its own temporary
  directory. Install the shared `campaign.json` atomically; a later worker must
  match it byte-for-byte or fail. Copy each instance's immutable evidence with
  temporary filenames and atomic renames, publishing `status.json` last because
  that file means the attempt is complete. For example, two workers finishing
  together can install different instance trees without both trying to create
  the same provenance file through `tar`. The unbuilt alternative serializes
  every download behind one broad lock, which avoids the collision but discards
  useful network concurrency and still exposes partially copied attempts.
- **The gap:** Archive validation proved paths were safe, but the plan did not
  specify how multiple valid archives should merge into one immutable campaign
  tree.
- **The reach:** Concurrent collection retains all worker evidence, resumability
  never observes a completion marker before its files, and provenance drift is
  rejected instead of overwritten.
- **Verdict:** **sound.** Private staging plus atomic publication gives each
  artifact one clear lifecycle without reducing worker concurrency.
- **Confidence:** **high** because concurrent two-worker and conflicting-
  provenance regressions exercise the actual filesystem boundary in Docker.

### S57 — Unknown stopped work is reserved before the replacement gate

- **When:** freezing the v2 restart campaigns after stopping the exposure-
  invalid v1 attempt and falsifying the product lifecycle eval.
- **The choice:** Start from the previously reserved `$99.8513`, add the exact
  `$6.5853068` from 14 downloaded v1 gate attempts, and reserve five unreturned
  attempts at their full `$3.93` ceiling. Five covers the two additional
  completions observed before snapshot plus at most one in-flight attempt in
  each of the three sequential workers when they were killed. Add the exact
  `$0.0317247` falsification and `$0.3451325` restored live eval costs, then
  reserve another `$3.93` for the initial live eval whose completed process did
  not print recoverable usage. Round the resulting `$130.393464` upward to
  `$130.3935`. The GLM v2 gate gets a `$3.10` per-run emergency ceiling; the
  Kimi v2 gate starts from `$161.3935`, which additionally reserves all ten GLM
  runs at that ceiling so both campaigns may overlap safely. The unbuilt
  alternative guesses missing costs from neighboring runs or counts only
  downloaded artifacts, making the `$500` claim depend on lost evidence.
- **The gap:** Sandboxes were deliberately killed after a manual partial
  snapshot, so provider-side model work can exist without a returned telemetry
  file; the lifecycle eval also originally omitted terminal cost output.
- **The reach:** Both v2 campaigns can run concurrently while their combined
  worst case remains `$223.3935`. The full campaign is not frozen from that
  worst case: after the gate, its sunk value and uniform ceiling are recomputed
  from returned exact costs plus any new interrupted reserves.
- **Verdict:** **sound.** Unknown spend is bounded by the number of sequential
  attempts that could have existed and their enforced ceilings, never silently
  treated as zero.
- **Confidence:** **high** in the upper bound; it deliberately overstates spend
  because the missing attempts were likely far below their ceilings.

### S58 — The benchmark observes normal product behavior instead of prescribing it

- **When:** auditing the harness after the user rejected exact-one as an
  implementation-detail rule.
- **The choice:** Give Duet the canonical dataset `problem_statement` directly
  and keep only the minimal system fact that the run is unattended. Remove the
  benchmark's inspection/test workflow wrapper, `--incognito`, and
  `--no-system-prompt-files`. A fresh per-rollout `HOME` isolates runs while
  preserving default observational memory and compaction; normal repository
  `AGENTS.md` discovery remains part of the product. Submit the exact
  baseline-relative agent diff, including test and `.duet`-looking paths, and
  let the official scorer judge it. The replaced design stripped selected
  paths and disabled normal product features in pursuit of benchmark policy.
- **The gap:** Advisor call counts were not the only harness-owned behavior.
  The prompt prescribed a coding workflow, incognito disabled the default
  memory pipeline, system-prompt-file suppression bypassed repository context,
  and path filtering changed the candidate patch after the agent finished.
- **The reach:** ON/OFF arms now differ only in advisor availability while both
  exercise the same ordinary product lifecycle. Patch artifacts are simpler:
  one complete diff and one complete path list, with no excluded-path sidecar.
  The focused gate also no longer requires any minimum number of consultations;
  zero calls is a valid product outcome. Historical campaigns remain historical
  and are not resumed under the new prompt hash. Zero calls are not rejected by
  themselves, but a pure-resolved/enabled-unresolved pair fails regardless of
  how many consultations occurred.
- **Verdict:** **sound.** Clean state, finite resources, provenance, and paired
  assignment belong to the experiment; workflow, memory policy, repo
  instructions, and patch interpretation belong to the product and official
  scorer.
- **Confidence:** **high** from the exact argv, prompt pass-through, complete
  diff, and round-trip tests; live gate evidence remains required before the
  final campaign.

### S59 — Compiled memory assets and worker provenance are artifact invariants

- **When:** validating the first unconstrained E2B restart after removing
  `--incognito`.
- **The choice:** Package PGlite's data archive, both WASM modules, and vector
  extension beside the compiled Duet executable. The product loads these
  sidecars only when they are present, while source and npm installs retain
  PGlite's upstream import-relative behavior. Capacity admission opens default
  memory with the compiled x86 binary and hashes every sidecar on two fresh
  workers. Concurrent campaign files compare their immutable input hash and
  frozen inputs rather than their worker-local `startedAt`. An RPC process that
  closes without a protocol terminal is recorded as infrastructure failure,
  not a completed model cutoff.
- **The gap:** V2 reached no model. Bun embedded PGlite URLs under `$bunfs`,
  where PGlite's filesystem loader could not read them; ten Kimi attempts from
  one worker were also rejected because independently created but otherwise
  identical provenance records had different timestamps. The old client then
  mislabeled process exit as a killed completion.
- **The reach:** A fresh campaign cannot spend model budget until the exact
  compiled artifact proves normal memory startup. All workers can merge
  byte-different timestamps for the same frozen experiment, but still reject
  real input drift. V2 remains immutable zero-model-spend infrastructure
  evidence; V3 uses new ids.
- **Verdict:** **sound.** These checks validate the executable environment and
  artifact identity without prescribing model workflow.
- **Confidence:** **high** from 77 benchmark tests, the full Docker product
  suite, and a real Linux x86 compiled-memory smoke returning an empty JSON row
  array.

### S60 — Advisor admission means zero pure-only regressions, then broader diagnostics

- **When:** correcting the v3 restart gate after the user clarified that an
  advisor must never regress an executor that would otherwise resolve a task.
- **The choice:** Treat both-resolved as a pass, enabled-only as improvement,
  neither-resolved as neutral for the advisor comparison, and pure-only as an
  immediate gate failure. On a pure-only result, stop remaining paid work,
  preserve and compare the exact transcripts, advisor outputs, events, patches,
  and scorer logs, make a generic product fix, and restart under a new frozen
  diagnostic id. When a diagnostic batch has zero pure-only results, expand to
  more distinct tasks rather than declaring victory from the small sample.
  Zero, one, or multiple advisor calls are recorded but never decide admission.
- **The gap:** S49 incorrectly treated at least one successful consultation as
  sufficient even if another advised mate lost. V3 then produced the exact
  counterexample: Kimi resolved `facebook__docusaurus-8927`, while Kimi plus
  Fable failed after Fable endorsed a narrow, locally green regex fix that the
  official scorer disproved on spaced-local and HTTPS-link cases.
- **Operational stop:** All three active v3 workers were killed immediately.
  Remote status showed 15 finalized rollouts costing `$12.6315597` and three
  in-flight attempts, conservatively bounded at another `$9.30`. The sandboxes
  ended before their archives reached the host, so v3 is immutable
  lost-artifact evidence and cannot be resumed without duplicating paid work.
- **The reach:** Repeat-until-clean gates are deliberately adaptive engineering
  diagnostics and cannot be published as an unbiased advisor lift estimate.
  Once a broad diagnostic set is clean, freeze the product and run one fresh
  30×4 campaign exactly once, retaining every assigned row.
- **Verdict:** **user-settled.** Non-regression is the product invariant; clean
  evidence expands the test surface, while a single pure-only pair returns the
  work to diagnosis.
- **Confidence:** **high** in the rule; finite stochastic testing can increase
  confidence but cannot prove a universal guarantee.

### S61 — Completion advice is an independent, evidence-first falsification review

- **When:** diagnosing the Kimi/Fable pure-only result on
  `facebook__docusaurus-8927`.
- **The choice:** Keep the existing advisor lifecycle and evidence-rich context transport,
  because they delivered three successful, untruncated consultations. Change
  the advisor's product prompt instead: it must independently challenge the
  executor's conclusion, seek authoritative implementations or repository
  history before approving a hand-designed approximation, and try to disprove a
  finished change against neighboring behavior. Executor-written tests prove
  only their covered examples. The response is capped at 250 words so the
  highest-signal verdict and next check arrive before the model's output limit.
  The executor now treats advice as a hypothesis to verify, not authority to
  follow until contrary proof appears.
- **The gap:** The user required a generic harness/product correction but did
  not prescribe which prompt surface or whether consultation scheduling should
  change.
- **The reach:** Every product advisor call becomes more adversarial, not just
  SWE-bench calls. It may reject more apparently complete work, trading some
  extra executor verification for lower risk of an advisor anchoring the
  executor on a locally green point fix.
- **Verdict:** **sound.** The failure came from review judgment, not missing
  context or too few calls; changing scheduling would repeat the same bad
  anchor, while task-specific benchmark instructions would contaminate the
  measurement.
- **Confidence:** **medium-high.** The long-context Fable eval failed on the old
  evidence priority and passed after the correction; both benchmark advisor
  models now reject the narrow fix, but only expanded paired tasks can measure
  downstream non-regression.

### S62 — A clean known-case gate expands to five new four-arm tasks

- **When:** turning the user's instruction to expand testing after zero
  pure-only outcomes into a bounded next campaign.
- **The choice:** First rerun the three known loss cases five times per relevant
  pair (30 rollouts). If all 15 pairs avoid a pure-only result, sample five
  additional committed-manifest tasks that were not used for prompt tuning and
  run all four arms once on each (20 rollouts, ten more pairs). Any pure-only
  result in either stage stops immediately under S60. The later final 30×4 run
  remains a fresh, one-shot measurement and does not reuse these rollout
  artifacts; diagnostic task ids may also belong to the committed final
  manifest.
- **The gap:** The user required more tests after a clean batch but did not set
  the expansion size.
- **The reach:** The product must survive repeated known regressions and a small
  diversity check before the expensive final campaign. The five-task expansion
  is large enough to add new repositories/languages while leaving room under
  the `$500` envelope after actual diagnostic spend is reconciled.
- **Verdict:** **sound provisional call.** It materially expands evidence while
  preserving the clean final estimate; recalculate the budget before freezing
  the expansion id rather than silently shrinking coverage after outcomes.
- **Confidence:** **medium** because five versus ten new tasks is a cost and
  confidence tradeoff, not a statistically unique threshold.

### S63 — E2B shards repeated campaigns by instance and trial

- **When:** the first clean non-regression pairs showed that three known issues
  occupied only three of sixteen E2B slots while later trials waited serially.
- **The choice:** Run each `(instance, trial)` as one isolated E2B shard. Keep
  all campaign arms serial inside that shard, publish only that trial's
  artifact roots, and give worker records and metadata an explicit trial
  identity. The CLI accepts a runtime-only `--trial` selection while committed
  campaign provenance remains unchanged.
- **The gap:** `workerConcurrency: 16` previously meant “up to the number of
  distinct instances,” so a five-trial diagnostic over three known issues used
  only three workers and delayed pair-level fail-fast scoring.
- **The reach:** Repetitions now use real E2B concurrency without running a
  pair's two arms on different workers. Concurrent shards for the same issue
  merge disjoint trial directories under the same immutable provenance.
- **Verdict:** **sound.** Trial repetitions are independent experiment units;
  preserving pair locality retains the comparison while making the configured
  concurrency truthful.
- **Confidence:** **high** from type-checking and 79 Docker benchmark tests,
  including concurrent same-issue/different-trial artifact integration.

### S64 — The diversity gate is deterministic and blind to task contents

- **When:** expanding after the known-case gate reached zero pure-only pairs.
- **The choice:** Exclude the three tuned issue ids and their two repositories,
  hash each remaining committed-manifest id with the fixed
  `advisor-expansion-20260721` seed, retain the lowest hash per language, then
  take the five lowest language winners. This selects Nushell 13605, Caddy
  4943, Laravel 53206, Gson 2061, and Vue 11915: five tasks from five
  repositories and five languages. Selection reads only manifest ids and
  language labels, never problem statements, gold patches, or tests. Run the
  GLM/Kimi-advisor and Kimi/Fable-advisor comparisons as separate frozen
  campaigns so ten pair-local E2B workers can run concurrently.
- **The gap:** S62 required five broader tasks but did not freeze a sampling
  rule or say whether the two comparisons should occupy five or ten workers.
- **The reach:** The diagnostic adds ten independent pair outcomes without
  selecting tasks for expected advisor wins. Its two conservative sunk values
  reserve every earlier diagnostic rollout and then reserve the full GLM
  expansion before admitting the Kimi expansion, bounding both concurrent
  campaigns at `$355.1395` under the shared `$500` envelope.
- **Verdict:** **sound.** The sample is reproducible, diverse, content-blind,
  and uses the concurrency already paid for without separating either pair
  across sandboxes.
- **Confidence:** **high** in provenance and budget admission; outcome evidence
  remains pending until the official scorer evaluates all ten pairs.

### S65 — Advisor history is compacted before the model's hard window

- **When:** after the 15 known pairs established a 15/15 advisor-resolve quality
  baseline but showed consultations carrying as many as roughly 43k estimated
  input tokens.
- **The choice:** Treat the advisor model's advertised context window as a hard
  safety ceiling, not the desired request size. Keep the executor's resolved
  system prompt, exact tool definitions, first user task, and a generous recent
  wire-faithful tail. Represent older complete messages through the same local
  observational-memory semantics used by normal compaction. Tune the policy
  envelope against the 15 known pairs: zero pure-only outcomes and 15/15
  advisor resolves are hard quality gates; measured advisor input tokens choose
  among passing candidates. Use offline captured-transcript and live fidelity
  checks before each paid paired campaign.
- **The gap:** The user rejected both the old fixed 10k limit and the replacement
  policy that filled almost the entire advisor window. They did not prescribe a
  single token number because the right boundary must balance evidence quality
  against repeated-call cost.
- **The reach:** Advisor calls become bounded even for million-token models,
  while older work remains available as observations instead of disappearing at
  a raw-message cutoff. The policy is generic product behavior, not a SWE-bench
  rule. Changing it invalidates pending diagnostic namespaces, so the stopped
  `advisor-nonregression-expansion-*-20260721-v1` campaigns cannot be resumed or
  scored and fresh ids are required after the policy freezes.
- **Verdict:** **sound; the 32k/16k policy is frozen from measured evidence.**
  The pre-change 34 calls carried 1,410,521 estimated advisor input tokens and
  1,648,243 exact provider-reported advisor tokens. The frozen candidate made
  36 successful calls while reducing those totals to 657,259 (53.4% lower) and
  731,889 (55.6% lower). Advisor spend fell from $15.13 to $7.65; the normal
  observer added $0.89, leaving combined advisor-plus-observer spend at $8.54,
  43.6% below the old advisor spend alone. Official scoring kept advisor quality
  at 15/15 resolves against 10/15 pure resolves: five advisor-only improvements,
  ten ties, and zero regressions. The provisional 10% threshold and 15% stretch
  target are superseded by this substantially stronger observed result.
- **Confidence:** **high.** Unit tests, falsified live evals, 36 successful
  consultations, zero unrepresented omissions, and the complete 15-pair paid
  gate agree on both fidelity and efficiency.

### S66 — The newest complete tool interaction outranks the soft token target

- **When:** the first live compaction eval showed that whole-message eviction
  could summarize away one oversized latest test result while retaining only
  the assistant's subsequent `ask_advisor` call.
- **The choice:** Protect the newest tool call, its complete tool result, and
  every following message from advisor-only eviction. The 32k target remains a
  soft efficiency target; if that protected interaction is larger, send it and
  expose the overage in telemetry. Continue compacting all older eligible work
  into observations.
- **The gap:** Normal actor compaction guarantees only a one-message recent tail.
  That is provider-valid, but it is not enough for an advisor whose central job
  is to review the executor's freshest evidence.
- **The reach:** Final test output, diffs, and inspection results remain
  wire-faithful even when unusually large. A pathological latest result can
  exceed the target, so aggregate token efficiency must be measured rather than
  inferred from the constant.
- **Verdict:** **sound.** Quality evidence is the reason to consult an advisor;
  dropping the freshest evidence to hit a soft budget would optimize the wrong
  objective.
- **Confidence:** **high** from a deterministic oversized-result regression and
  a live eval that compacted older work while preserving the newest complete
  call/result pair.

### S67 — A memory-disabled advisor keeps raw history instead of silently dropping it

- **When:** composing the soft context target with incognito and explicitly
  memory-disabled runners.
- **The choice:** Compact only when a durable memory session exists to receive
  the normal observation drain. If memory is disabled or unavailable, retain
  the raw transcript up to the advisor model's hard window and report any
  hard-window omission through the existing truncation telemetry. The unbuilt
  alternative would hit 32k by deleting old messages with no observation that
  represents them.
- **The gap:** The user required observation-based compaction but did not specify
  what to do when the observation system is intentionally absent.
- **The reach:** Incognito and memory-disabled product use can cost more advisor
  tokens, but it does not pretend that deleted history was summarized. Benchmark
  runs use the default durable memory path, so they exercise the efficient path.
- **Verdict:** **sound.** Fidelity should degrade only at the real model limit
  when the mechanism that makes soft compaction information-preserving is absent.
- **Confidence:** **high** because silent lossy compaction would violate the
  user's stated design more directly than a documented soft-target miss.

### S68 — Advisor compaction drains observations on demand without moving the executor horizon

- **When:** deciding how older work from one still-active executor turn becomes
  visible as observations before an advisor call.
- **The choice:** When the raw advisor request first crosses the 32k target, run
  the existing default memory observer immediately, refresh the same frozen
  memory pack normal compaction uses, and advance a separate advisor-only
  horizon. Do not move the executor's horizon or add a second summarizer. At the
  end of the turn, normal memory processing sees only the still-unobserved suffix,
  although this can split one large observer pass into two smaller passes.
- **The gap:** Reusing only the previously frozen pack would miss all older work
  produced during the current active turn; applying normal `/compact` would also
  change what the executor sees next.
- **The reach:** Advisor calls can add observer latency before generation and can
  alter when durable observations are written, but they use the default memory
  model and their usage remains in the turn's normal per-model ledger. The 15-pair
  efficiency gate must verify that advisor savings are not erased by extra
  auxiliary work.
- **Verdict:** **sound.** It is the only existing product path that makes current
  older work observable without inventing a parallel summary format or changing
  the executor's continuation context.
- **Confidence:** **high.** The fresh paired campaign measured 36 successful
  consultations, 55.6% fewer exact advisor tokens, and $8.54 combined
  advisor-plus-observer spend versus $15.13 of old advisor spend alone, while
  retaining 15/15 advisor resolves.

### S69 — Advisor preview uses frozen observations but never creates new ones

- **When:** keeping `duet route advisor-preview` aligned with the new runtime
  context policy.
- **The choice:** Load the normal durable memory pack and apply the same 32k
  projection for a stored-session preview, but disable the on-demand observer
  drain. A preview may show observations already written by completed turns; it
  never calls a model or writes memory merely because someone inspected it. If
  memory is unavailable, the preview stays raw.
- **The gap:** Calling the exact runtime capture path would make a command labeled
  read-only spend tokens and mutate memory, while leaving preview raw would make
  its token and cost estimates disagree with real advisor calls.
- **The reach:** Stored-session estimates track production whenever the frozen
  pack covers the session, without surprising side effects. A transcript whose
  newest long turn was never observed can still preview larger than production's
  eventual on-demand projection.
- **Verdict:** **sound.** Read-only inspection must not trigger paid generation or
  durable writes; reusing the frozen pack is the closest side-effect-free view.
- **Confidence:** **high** because the command's existing read-only contract rules
  out the mutating alternative.

### S70 — Optimize evidence representation before shrinking evidence

- **When:** the 32k/16k candidate preserved all 15 known advisor resolves but
  the user asked to optimize both quality and token efficiency before the
  untouched campaign.
- **The choice:** Keep the 32k threshold that decides when paying for an
  observer is worthwhile, but reduce the post-observation ordinary raw tail to
  8k. The newest complete tool interaction remains protected even when larger.
  Serialize only the transcript fields another model can actually see: roles,
  visible text/reasoning, tool calls, complete tool-result content and error
  state. Remove local timestamps, provider/model identity, usage/cost objects,
  diagnostics, tool-result UI details, and opaque provider replay signatures.
  Test medium advisor effort as a separate optimization; the adversarial
  narrow-fix live eval passed at both medium and high. Confirm the combined
  candidate by rerunning only the 15 advised known cases and comparing them with
  the immutable pure baseline. The paid run falsified a uniform reduction:
  Fable at medium conditionally approved a hand-designed regex in one of five
  Docusaurus 8927 trials, while the high-effort baseline drove the executor to
  the authoritative upstream fix. Keep Kimi at medium, where all five known
  trials remained resolved, and restore Fable to high.
- **The gap:** Lowering the 32k trigger would cause more observer calls and can
  spend more total tokens than it saves. The earlier serializer also called
  runtime bookkeeping “wire-faithful” even though the executor provider never
  exposes those fields to the model. The paid failure now supplies a measured
  quality reason for Fable's high effort; it does not justify discarding the
  independent serialization and raw-tail savings.
- **The reach:** The advisor keeps all decision evidence and exact tool
  definitions/results while paying for less irrelevant JSON, less redundant
  recent history after observation, and less private deliberation. Benchmark
  configs explicitly retain the same model-specific effort in each pure/advised
  pair, so advisor availability remains the pair's only treatment difference.
- **Verdict:** **partially falsified twice, lifecycle correction pending.** The
  uniform-medium v2 run scored 14/15. Exact advisor tokens improved 18.7%
  (731,889 to 595,251), but combined advisor-plus-observer tokens worsened 2.3%
  (1,543,369 to 1,578,537). The model-specific v3 run restored Fable high and
  improved combined tokens 15.3% to 1,306,951, but still scored 14/15 because
  its final diff never received the re-review that the product guidance intended.
  Reject both paid candidates. Freeze the 8k/model-visible policy only after the
  lifecycle-corrected run restores 15/15 and re-measures the combined token total.
- **Confidence:** **high** that uniform medium is unsafe for Fable; **medium**
  until the lifecycle-corrected paid confirmation completes.

### S71 — Re-arm completion review when real work follows an early checkpoint

- **When:** the model-specific-effort v3 gate scored 14/15 even though Fable was
  restored to high effort and the context projection beat the token baseline.
- **The choice:** Treat a completion checkpoint as spent only for the evidence it
  actually reviewed. The first candidate re-armed it after any later
  non-advisor tool so a subsequent completion could review the resulting diff or
  test evidence.
- **The gap:** An executor completion is only a protocol stop, not proof that the
  task is semantically finished. In the failed trace it happened after diagnosis,
  before any edit. Fable rejected the proposed approximation and named the hidden
  boundary risks, but the old one-shot flag prevented a review after the executor
  implemented that same approximation. Prompt strength and context size cannot
  recover evidence that is never sent.
- **The reach:** This is product advisor scheduling, not a SWE-bench call-count
  rule. Voluntary consultations remain executor-controlled, the ordinary cooldown
  and in-flight reservation still apply, and new final reviews occur only after
  observable tool work makes earlier advice stale. Because this may add calls,
  the five high-risk 8927 repeats run before the full 15-case token gate.
- **Verdict:** **partially falsified and narrowed.** The focused v4 run proved the
  missing final review was real, but unrestricted re-arming produced 3–7 Fable
  calls per recovered run and two cost-cap interruptions. Keep the second-review
  capability only for the early-first-consultation shape described in S72.
- **Confidence:** **high** in the trace diagnosis and local scheduling fix;
  **high** that unrestricted re-arming is too broad.

### S72 — Separate an early missed final review from recursive approval checking

- **When:** the v4 focused correction restored access to the final diff but made
  every advisor-requested verification command eligible to mandate another
  completion review.
- **The choice:** A completion checkpoint may automatically re-arm once only when
  it was issued before any successful consultation. This preserves the failed v3
  shape—diagnosis, first consultation, implementation, final review—while a turn
  that already had orientation and completion reviews does not recursively
  mandate more. Voluntary consultations and ordinary cooldown behavior remain
  unchanged. At the same time, an advisor with sufficient evidence must approve
  and stop instead of inventing the residual risk and check previously required
  by its output format.
- **The gap:** “Any new tool evidence makes advice stale” ignored review phase.
  Verification requested by the completion advisor is not evidence that the
  earlier orientation was stale; treating it that way created the five-review
  trial and spent executor tokens chasing diminishing, sometimes optional checks.
- **The reach:** Complex turns still receive normal early and final consultations.
  A turn whose first consultation happened prematurely can still receive the
  missing evidence-backed final review. Further re-review is model-controlled,
  not benchmark-controlled or recursively mandatory.
- **Verdict:** **sound, paid confirmation pending.** The outer runner regression
  test proves the early first consultation re-arms exactly once, and a live eval
  was red when a fully verified edit manufactured commit/stash work and green
  when approval ended without further review.
- **Confidence:** **high.** The fresh v5 focused gate officially resolved all
  five Docusaurus 8927 trials with 2–3 advisor calls each. Advisor plus observer
  usage was 402,590 tokens, 12.1% below the same five-case v3 subset, with no
  cost-cap interruptions. The full 15-case gate remains the broader check.

### S73 — Keep the 32k trigger after measuring the 64k alternative

- **When:** the lifecycle-corrected v6 policy restored 15/15 official resolves
  and exposed the exact split between advisor and observer usage.
- **The choice:** Retain the 32k advisor soft input target and the 8k
  recent-message target. Optimize observation work directly instead of sending
  substantially larger raw transcripts to every later consultation.
- **The gap:** Across the 15 v6 runs, advisor models consumed 494,436 tokens but
  the observer consumed 841,440. Replay of all 31 consultation boundaries puts
  their complete raw requests at roughly 64k or less. That made deferred
  compaction plausible, but the aggregate alone could not establish whether
  larger repeated advisor inputs would be cheaper than one observer pass.
- **The reach:** V7's five paid repeats remained 5/5 officially resolved, but
  used 622,697 combined tokens versus v6's 470,574. Observer usage fell from
  291,206 to 196,094, while advisor usage rose from 179,368 to 426,603. The
  larger raw payload therefore cost 152,123 net tokens, or 32.3%. The 88k live
  fixture must continue to compact and recover both old observations and recent
  raw evidence.
- **Verdict:** **64k rejected; 32k restored.** The experiment preserved quality
  but failed the efficiency gate.
- **Confidence:** **high.** The decision is based on five official resolves and
  exact per-model usage telemetry from both settings.

### S74 — Each isolated rollout declares one normal memory session

- **When:** tracing repeated observer work after the rejected 64k compaction
  experiment.
- **The choice:** Launch benchmark RPC with `--session swebench`. In ordinary
  product use, a session id tells memory which observations belong to the
  conversation currently in progress. The benchmark already gives every
  rollout a brand-new HOME directory and database, so the same readable id is
  isolated per rollout. The unbuilt alternative leaves the id absent; then an
  observation is treated as cross-session background, and its message-range
  marker cannot tell the next observer pass where the previous pass stopped.
- **The gap:** The spec required default product memory but did not state that
  the RPC caller must supply the session identity that the interactive product
  normally owns.
- **The reach:** Later advisor and end-of-turn observation passes process only
  the new transcript suffix while retaining prior local observations as
  context. V6 had 17 later passes restart at the first user message, consuming
  459,712 observer tokens. This change uses the existing range-marker contract;
  it adds no benchmark prompt, model override, cache, or skipped final pass.
- **Verdict:** **sound.** The harness now supplies the normal caller-owned
  identity instead of accidentally selecting global-memory semantics.
- **Confidence:** **high.** The CLI already documents one RPC process as one
  logical session, product tests cover session attribution and range progress,
  and the rollout test was red without the flag and green with it.

### S75 — Budget concurrency by active shards, not the whole pending population

- **When:** admitting the final 120-arm campaign under the remaining global
  model-spend envelope.
- **The choice:** Hold the full per-arm ceiling only for shards currently doing
  model work. A completed shard replaces that temporary reservation with its
  measured artifact cost before another shard may start. The configured 16
  workers remain an upper bound; available budget can admit fewer. Each active
  reservation is persisted before its sandbox starts and removed only after
  terminal artifacts are integrated, so controller loss stays conservative.
- **The gap:** The old preflight multiplied every unfinished arm by its emergency
  ceiling. That is safe but treats sequential future work as simultaneous
  liability, preventing a campaign even when measured shard costs can fit.
- **The reach:** Accounted spend plus active reservations never exceeds `$500`.
  A worker failure stops further admission, while already-running workers
  settle. If no next shard fits, it remains explicitly unstarted rather than
  weakening the per-rollout cap or silently exceeding the global budget.
- **Verdict:** **sound.** This changes scheduling, not models, prompts, tasks, or
  scoring, and preserves the original hard-budget invariant.
- **Confidence:** **high.** Unit tests prove exact-cost reconciliation admits
  later cheap shards, budget exhaustion leaves work unstarted, partial shards
  reserve only unfinished arms, and the first worker failure stops admission.

### S76 — Validate the memory-session repair in the final population

- **When:** deciding whether to buy another 15-case adaptive gate after adding
  the benchmark's missing RPC session id.
- **The choice:** Freeze the already accepted 32k advisor policy and proceed to
  the fresh 30-task paired campaign. Do not spend the remaining hard-budget
  headroom replaying the same adaptive cases first.
- **The gap:** V6 proved the advisor policy at 15/15 before the session repair,
  while the repair itself changes memory attribution: prior observations remain
  available, but later observer passes process only the new transcript suffix.
- **The reach:** The final population supplies a broader live test and preserves
  the budget for the only rows eligible for the effect estimate. Product memory
  tests and the benchmark RPC regression test cover the repaired range-marker
  contract. Any pure-only final outcome remains visible in paired reporting.
- **Verdict:** **sound under the hard budget.** A second adaptive run would not
  contribute to the requested benchmark estimate and could prevent its
  completion.
- **Confidence:** **medium.** The semantic repair uses ordinary product session
  behavior and has strong deterministic coverage, but its first post-repair
  paid evidence will be the final population itself.

### S77 — Retry E2B transport only outside the model command

- **When:** the first final launch lost one worker during idle setup and lost a
  second worker's archive after all four arms had completed.
- **The choice:** Retry idempotent E2B requests at 2, 5, and 15 seconds: template
  lookup, environment upload, resume upload/extraction, and result download.
  Record whether the campaign command may have started. Never retry that command
  itself. A failure proven to precede it releases its active budget reservation;
  later or ambiguous failures retain the reservation.
- **The gap:** Sandbox creation already retried safely, but every request after
  creation was single-shot. The first v5 launch therefore lost Apache Druid
  before model work and lost Carbon's completed patches during one archive-read
  connection failure.
- **The reach:** Transient controller outages no longer destroy completed model
  evidence or consume a full shard reserve before generation. Non-idempotent
  model work is still at-most-once, and uncertain work cannot be retried as if it
  were free.
- **Verdict:** **sound.** The retry boundary follows the external side effect
  rather than the E2B API method name.
- **Confidence:** **high.** The retry helper is covered for bounded delays and
  no cleanup side effects; the first campaign supplied direct failure evidence
  on both sides of the model-command boundary.

### S78 — Reference evidence cannot expand the requested contract

- **When:** the first officially scored pair in the final v5 campaign resolved
  with pure GLM but failed with GLM plus Kimi on Caddy's cookie-log issue.
- **The choice:** The advisor first identifies the user's narrow requested
  behavior and the repository's existing passing contracts, then prefers the
  smallest sufficient change. A newer or broader upstream implementation is
  evidence about possible solutions, not a list of changes to copy. It must be
  matched to the checkout's version and reduced to the relevant behavior. If an
  executor changes an existing passing test expectation, the advisor treats
  that as a likely regression unless separate task or history evidence proves
  the old behavior must change. Compacted observations count as evidence that a
  reference lookup happened, so normal context compaction does not force the
  executor to repeat a lookup whose literal tool result aged out.
- **The gap:** Earlier policy demanded authoritative reference evidence but did
  not say that current upstream can contain later, unrelated behavior. In the
  failing trace, that made a cookie-only issue grow from a 65-line historical
  fix into a 625-line multi-filter refactor. The executor changed QueryFilter's
  hash result and its test simply because current upstream did; Kimi approved,
  while the official untouched test rejected exactly that change.
- **The reach:** Orientation and final-review consultations keep their normal
  timing, and reference research remains required for nontrivial work. The new
  rule applies to every repository and version, not only SWE-bench: an advisor
  can use newer code to learn, but cannot silently turn a local bug fix into a
  compatibility change. The Mac diagnostic reserves an extra `$1` in its sunk
  ledger for the live prompt-eval calls because provider billing is shared and
  cannot attribute them more precisely.
- **Verdict:** **sound.** It restores the ordinary meaning of task scope and
  passing tests without weakening evidence gathering or special-casing the
  benchmark.
- **Confidence:** **high.** The exact old prompt reproduced the erroneous Kimi
  approval in a live eval; the corrected prompt rejected it and preserved the
  focused orientation path.

### S79 — A coding benchmark must require a repository solution

- **When:** the corrected-policy Caddy Mac rerun found the exact historical fix
  but returned an upgrade recommendation and an empty patch.
- **The choice:** Keep the canonical dataset problem statement byte-for-byte as
  the user message, and make the shared system contract explicit about the
  scored outcome: resolve the task in the repository and leave the working tree
  with the complete solution. Keep unattended execution. Do not mention an
  advisor, tool calls, test schedules, step counts, paths, or a prescribed
  workflow. Apply this same prompt to every arm.
- **The gap:** The previous sentence, “Complete the task unattended,” did not
  distinguish completing an advice request from implementing its repository
  fix. Caddy 4943 literally ends with “Please advise,” so a technically correct
  prose answer satisfied that wording while producing nothing the patch scorer
  could evaluate.
- **The reach:** This defines the benchmark role rather than helping either
  treatment. Because prompt bytes are a paired input, the old pure artifact and
  the one-arm v1 diagnostic cannot be compared with new output. The v2 Mac gate
  therefore reruns both GLM arms under a fresh id. Its sunk ledger includes the
  v1 run's exact `$0.302353` cost.
- **Verdict:** **sound and paid-confirmed.** The prompt regression test was red
  on the ambiguous wording and green on the outcome contract while continuing
  to reject advisor and workflow prescriptions. Both fresh arms produced
  scoreable patches; the advisor arm resolved and the pure arm did not.
- **Confidence:** **high.** The official scorer recorded one enabled-only pair
  and zero pure-only outcomes under the fresh prompt hash.

### S80 — Spend the remaining envelope on complete Mac blocks

- **When:** the paid Caddy confirmation reconciled the conservative ledger to
  `$467.938068`, leaving `$32.061932` under the user-set `$500` cap.
- **The choice:** Run a fresh seed-20260722 two-language core sample—Laravel
  53206 and Lombok 3697—with all four arms, one trial, serially on this Mac. Keep
  the calibrated `$3.10` emergency ceiling. The eight worst-case reservations
  total `$24.80`, so every assigned arm can finish without relying on average
  cost. After exact costs return, admit another complete seeded block only if
  four more full reservations still fit.
- **The gap:** Reusing the old 30-task E2B artifacts would mix prompt hashes.
  Scheduling all 30 fresh tasks would claim an estimate the remaining hard
  budget cannot finish. Lowering the per-rollout ceiling would silently change
  treatment quality after the user explicitly rejected the old small cap.
- **The reach:** The core result is an n=2 signal-seeking estimate and must be
  labeled accordingly. Historical 15-case diagnostics and Caddy remain
  engineering evidence, not rows silently pooled into the core estimate.
  Budget-only expansion may add disjoint fresh rows because its admission does
  not depend on their outcomes.
- **Verdict:** **sound under the hard budget; paid-confirmed and expanded.** All
  eight core predictions officially resolved, so each comparison recorded two
  both-resolve outcomes and zero pure-only outcomes. Exact core spend was
  `$13.3802222`, reconciling the conservative ledger to `$481.3182902`. One
  further four-arm block for the next predeclared seed row, Prometheus 10633,
  retained the same models, prompt, limits, and scorer while reserving `$12.40`.
  The first v7 launch was rejected before paid work because its manifest
  incorrectly used the whole-prefix seed assertion; after correcting the
  explicit disjoint row, immutable provenance required the fresh v8 id. A
  Prometheus produced an enabled-only result in both comparisons and cost
  `$2.2010546`, reconciling the ledger to `$483.5193448`. That returned spend
  admits Fastlane 20975, the fourth row of the same seeded population, under a
  fresh v9 id with four full `$3.10` reservations. Further rows remain
  conditional only on exact returned spend, not observed outcomes.
  Fastlane cost `$1.7418539` and produced a both-resolve result in both
  comparisons, reconciling the ledger to `$485.2611987`. The remaining
  `$14.7388013` admits Vue 11915, the fifth seeded-population row, under v10
  with the same four full reservations.
- **Confidence:** **high** in the accounting and pairing guarantee; **low** in
  the statistical precision of the small sample, which the report must state
  plainly.

## Compressed trivial discretion

Eight cosmetic or local choices were not expanded into separate entries: helper
names, test fixture names, where individual tests sit within existing files,
the exact dummy credential strings, comment wording, and formatter-driven line
wrapping. None changes a public contract or constrains later architecture.
