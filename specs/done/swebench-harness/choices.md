# SWE-bench advisor harness — final choices ledger

This ledger records the load-bearing choices that remain in the shipped
product and harness. It is consolidated from the implementation passes: choices
that were reverted, superseded, or only named temporary campaigns are omitted.

No unsound or unresolved choices remain. The least-certain surviving decision
is S17, the benchmark's JavaScript/TypeScript sampling split.

## Needs user

None.

## Unsound

None remain. Earlier fixed-step, exactly-once-advisor, full-window-context,
reroute-prompt, test-path-exclusion, and per-arm budget choices were removed or
replaced before closure.

## Sound

### S17 — JavaScript and TypeScript are separate sampling buckets

- **When:** multilingual manifest design.
- **The choice:** The official SWE-bench harness runs JavaScript and TypeScript
  repositories through one combined environment family. The committed sampler
  instead labels each repository by its primary language: for example,
  `preactjs/preact` is JavaScript and `vuejs/core` is TypeScript. The alternative
  is one combined JavaScript/TypeScript bucket, which mirrors the scorer more
  literally but cannot produce the requested nine-language sample.
- **The gap:** The benchmark publishes nine language names while its runtime
  groups two of them together; the task did not say which definition should own
  stratification.
- **The reach:** This changes which repositories represent those two language
  labels. It does not change official images, task tests, or scoring.
- **Verdict:** **sound.** Primary repository language is deterministic,
  content-blind, and preserves all nine published labels; the README records the
  divergence so it is not mistaken for an official runtime distinction. To
  reverse it, merge the labels, advance the manifest algorithm version,
  regenerate the manifest, and use new campaign ids.
- **Confidence:** **medium** because literal runtime-bucket parity is also a
  reasonable sampling taxonomy.

### S1 — The reported effect is a five-task signal, not a general benchmark score

- **When:** final Mac campaign expansion.
- **The choice:** After the clean two-task core showed no advisor regression,
  the run added one complete four-arm task at a time until another four-arm
  `$3.10`-threshold block no longer fit the `$500` envelope. That produced five
  tasks with one trial each. The unbuilt alternative was to start a sixth task
  with only enough reserve for some arms, which would make the comparison
  incomplete.
- **The gap:** The user required expansion after zero regressions and set a
  budget, but did not prescribe a final sample size.
- **The reach:** The 80% versus 100% rates are signal-seeking evidence only; the
  harness must not present them as a leaderboard estimate or a precise
  population effect.
- **Verdict:** **sound.** Complete paired blocks preserve the comparison, and
  exact measured spend stayed within the budget rather than starting an
  incompletely reserved sample.
- **Confidence:** **medium** because a different earlier engineering-spend path
  could have left room for more fresh tasks.

### S2 — The fresh estimate pools four immutable campaign namespaces

- **When:** v6 core through v10 expansion.
- **The choice:** The five rows come from four sequential campaign ids. Their
  task-prompt hashes match across the four arms of each task, while routing,
  manifest, environment, and system-prompt hashes match across campaigns. Their
  Git and binary hashes differ only because each expansion was committed before
  the next paid block. The unbuilt alternative was to rerun already scored rows
  under one final namespace, spending budget without changing the treatment.
- **The gap:** Immutable provenance correctly forbids appending changed inputs,
  but the task did not say whether documentation-only commit changes require
  discarding otherwise identical paid outcomes.
- **The reach:** Published reports must name all four namespaces and must not
  pool adaptive diagnostics or superseded prompt/product hashes with them.
- **Verdict:** **sound.** The treatment-bearing inputs match and the intervening
  diffs do not change product runtime source.
- **Confidence:** **medium-high** because the provenance boundary is explicit,
  though a single namespace would be simpler to explain.

### S3 — Raw evidence stays local; a compact result record is committed

- **When:** final closeout.
- **The choice:** Full transcripts, patches, scorer trees, and frozen run
  records remain in ignored `runs/` and `.cache/` directories. A small versioned
  JSON record preserves task identities, paired outcomes, costs, call counts,
  context-token totals, and campaign ids. The alternative is committing hundreds
  of large, provider-bearing debug artifacts.
- **The gap:** The plan made paid artifacts immutable locally but did not define
  the durable repository-sized evidence boundary.
- **The reach:** A fresh checkout can verify the reported arithmetic and locate
  every campaign input, while deep trace review still requires the retained
  local artifact store.
- **Verdict:** **sound.** The summary keeps the stable evidence without turning
  generated traces into source-controlled product data.
- **Confidence:** **medium-high** because long-term external artifact storage
  could provide stronger trace reproducibility later.

### S4 — Each comparison changes only advisor availability

- **When:** four-arm routing configuration.
- **The choice:** Each pair uses one benchmark `general` route with a fixed
  executor, effort, vision fallback, built-in Luna classifier, default memory,
  and the same named advisor target in both renders. The pure render disables
  that target; the advised render enables it. The alternative is using the
  multi-route product table, which would let classifier-selected executor
  changes become another treatment.
- **The gap:** The user named executor/advisor pairs but did not specify how to
  isolate them from normal executor routing.
- **The reach:** A paired difference can be attributed to advisor availability,
  not to a different classifier, memory worker, executor route, or environment.
- **Verdict:** **sound.** It is the smallest custom definition that tests the
  requested model pairs while keeping auxiliary product behavior intact.
- **Confidence:** **high** because the user explicitly limited model changes to
  executor and advisor and required the default classifier and memory.

### S5 — Advisor behavior is product-owned, not benchmark-scripted

- **When:** removal of the exactly-once consultation rule.
- **The choice:** The benchmark prompt says only to leave a complete repository
  solution. Normal product guidance decides whether to consult early, after new
  evidence, and during final review. The alternative tells the model when or
  exactly how often to call the advisor, which measures obedience to the
  benchmark rather than advisor policy.
- **The gap:** A controlled experiment needs equal prompts, but the first harness
  confused treatment assignment with forcing one exposure.
- **The reach:** Advisor call count remains descriptive telemetry; zero-call and
  failed-call outcomes stay in intention-to-treat results.
- **Verdict:** **sound.** Advisor enabled versus disabled is the treatment the
  product actually exposes.
- **Confidence:** **high** because the user explicitly rejected implementation-
  aware benchmark rules.

### S6 — Advisor history has a 32k soft target with normal compaction

- **When:** advisor context-efficiency passes.
- **The choice:** Recent complete messages and the newest complete tool
  interaction remain raw, older history is normally represented by
  observational memory, and the real model window is only the hard safety
  ceiling. The executor system prompt, tools, and first task remain represented.
  The rejected alternatives were a fixed 10k view, which hid evidence, and
  filling the full advisor window, which spent tokens without improving the
  known cases.
- **The gap:** The user wanted both advisor quality and token efficiency but did
  not set a numeric soft target or retention order.
- **The reach:** This policy governs every product advisor call, including
  behavior when memory is disabled or an observation drain fails.
- **Verdict:** **sound.** The 32k policy preserved the known-case resolve result
  while restoring ordinary compaction and protecting the evidence nearest the
  current decision.
- **Confidence:** **high** from the context falsification evals and the final
  successful consultations, while acknowledging that future models may justify
  retuning the soft target.

### S7 — Model switches continue the same transcript

- **When:** router and TurnRunner correction.
- **The choice:** Automatic routing changes the model on the existing parent
  agent without a handoff or reroute prompt, exactly like using `/model` between
  turns. A successful advisor call starts a step-based cooldown and requests
  classification; an actual route switch and the distinct completion-review
  phase clear that cooldown. The alternative creates a synthetic summary or
  special new-model prompt that changes what the replacement model sees.
- **The gap:** The earlier router special-cased a mid-turn transfer even though
  the user expected seamless continuation.
- **The reach:** Executor models, state-machine agents, and ordinary subagents
  share transcript semantics instead of maintaining parallel transfer systems.
- **Verdict:** **sound.** One live transcript is the direct product contract and
  removes context-transfer regressions.
- **Confidence:** **high** because the user explicitly equated rerouting with
  `/model` behavior.

### S8 — Usage stays one flat cumulative ledger plus a per-model breakdown

- **When:** RPC and usage-protocol correction.
- **The choice:** `turnUsage` contains cumulative token/cost totals and
  `usageByModel` attributes those same successfully converted records to
  executor, classifier, advisor, memory, and child models. There is no
  `parentContext` protocol. The alternative adds nested usage contexts that
  callers must understand and risks double counting.
- **The gap:** Auxiliary model calls needed attribution, but the old 0.1.202
  protocol did not prescribe a new hierarchy.
- **The reach:** RPC consumers can cross-foot one total without knowing which
  agent role made a call. If advisor accounting conversion fails after valid
  advice returns, the tool still succeeds, logs the failure, and necessarily
  lacks that unconvertible ledger record.
- **Verdict:** **sound.** It makes the smallest protocol change and preserves
  useful advice when telemetry fails.
- **Confidence:** **high** because the user explicitly rejected `parentContext`
  and required classifier and advisor usage in the common ledger.

### S9 — Generic event origins cover parent, child, and state-machine work

- **When:** TurnRunner protocol simplification.
- **The choice:** State-machine agents do not get a one-off event family.
  Parent and child work use the same generic origin concept, with explicit
  metadata identifying the source when needed. The alternative special-cases a
  state-machine child while leaving an ordinary subagent implicit.
- **The gap:** The first protocol extension encoded one implementation path
  rather than the general ownership relationship.
- **The reach:** Future child-agent types can reuse the same wire contract and
  benchmark telemetry does not need state-machine-specific parsing.
- **Verdict:** **sound.** The abstraction follows who produced the work rather
  than which orchestration feature happened to launch it.
- **Confidence:** **high** because the user explicitly called out the asymmetry.

### S10 — Valid advice survives usage conversion and accounting failures

- **When:** advisor tool failure policy.
- **The choice:** If the model returned useful advice but conversion of its
  usage metadata or later usage accounting throws, the executor receives the
  advice or successful tool outcome and the product logs the telemetry problem.
  Parent cancellation still stops the call. The alternative fails the tool and
  discards useful guidance because an auxiliary ledger path broke.
- **The gap:** The harness initially treated observability failure as task
  failure.
- **The reach:** Benchmark and product tasks remain productive, while reports
  can distinguish successfully recorded usage from an accounting hole.
- **Verdict:** **sound.** Advice is the product outcome; telemetry is important
  but secondary.
- **Confidence:** **high** because the user explicitly required this behavior.

### S11 — Exact repository patches and the official scorer own outcomes

- **When:** rollout and reporting implementation.
- **The choice:** Each rollout starts from the official image's actual dirty or
  clean baseline, retains test files and runtime-looking paths, extracts the
  exact agent delta, and submits it to the official scorer. Empty patches,
  failed consultations, and cost/wall interruptions remain in the denominator;
  an interrupted run can resolve if its preserved patch passes. The alternative
  lets local path rules or terminal labels override what SWE-bench evaluates.
- **The gap:** Resource enforcement and local hygiene do not define whether a
  repository solution is correct.
- **The reach:** Resolution means the same thing for all four arms and remains
  comparable to SWE-bench rather than to a harness-specific proxy.
- **Verdict:** **sound.** Only completed scoreable artifacts receive scorer
  labels, and every scheduled failure still counts against its arm.
- **Confidence:** **high** from official image scoring and the resolved
  interrupted Vue patch.

### S12 — Paid blocks are immutable and reserve every pending arm up front

- **When:** campaign provenance, E2B concurrency, and final budget audit.
- **The choice:** A campaign id binds its commit, packaged artifact, config,
  manifest, environment, resolved task-image identity, and limits. Before an
  instance block starts model work, one local orchestrator reserves every
  pending arm's interruption threshold; each result reconciles to exact returned
  usage. E2B uses a global reservation pool across active instance/trial shards.
  The alternatives overwrite prior evidence or start a pair that the remaining
  budget cannot finish.
- **The gap:** Concurrency and retries make a simple “check current spend” race
  unsafe.
- **The reach:** Reservations prevent known work from being over-admitted inside
  one local process or the E2B controller. A provider request can exceed the
  threshold before completed usage is visible, and independently launched local
  orchestrators do not share a lock, so exact spend—not the threshold—is the
  final budget evidence.
- **Verdict:** **sound with explicit scope.** Write-once provenance and
  reserve-before-side-effect admission are direct guarantees; they are not a
  mathematical provider-side cap.
- **Confidence:** **high** from falsified regression tests and exact campaign
  reconciliation.

### S13 — The final run uses fresh local Docker containers and official x86 images

- **When:** Mac execution pivot.
- **The choice:** Each arm runs in a fresh container from the official task
  image on the user's Apple-Silicon Mac, with one local instance block active at
  a time. E2B remains an optional capacity backend around the same rollout and
  scoring contracts but is not part of the published five-task result. The
  alternative reuses a repository or mixes E2B and local environments in the
  final estimate.
- **The gap:** The user first offered E2B concurrency, then explicitly chose the
  Mac for the actual benchmark.
- **The reach:** Filesystem state cannot leak between arms, and the published
  environment is unambiguous.
- **Verdict:** **sound.** It follows the final execution instruction and keeps
  official scorer compatibility.
- **Confidence:** **high**.

### S14 — Reference material cannot widen the requested fix

- **When:** Caddy advisor-regression correction.
- **The choice:** Advisor guidance treats newer upstream code as evidence, not
  as permission to import broader semantics. It prefers version-matched
  references and the smallest sufficient change, and treats changes to passing
  expectations as suspected regressions. The alternative copies a current
  upstream refactor into an older task and can break contracts the issue never
  asked to change.
- **The gap:** “Use a reference” did not define whether reference scope outranks
  the repository's requested scope.
- **The reach:** The policy applies to normal product advice, not only the one
  benchmark repository that exposed it.
- **Verdict:** **sound.** Requested behavior and the checked-out version remain
  authoritative.
- **Confidence:** **high** from the red/green live reference eval and the
  advisor-only resolved diagnostic.

### S15 — Benchmark code and tests are self-contained

- **When:** benchmark ownership cleanup.
- **The choice:** Harness implementation, fixtures, Mac helpers, campaigns,
  results, and tests live under `benchmarks/swebench/`; the TypeScript harness
  suite runs separately through `bun run test:swebench`. The Mac provisioner
  owns its pinned Python helper tests. The alternative mixes paid-evaluation
  infrastructure into the product `test/` tree.
- **The gap:** Early harness tests followed the repository's existing test
  location before ownership was clarified.
- **The reach:** Product CI and benchmark maintenance have explicit, separate
  boundaries without losing benchmark coverage.
- **Verdict:** **sound.** It matches the user's requested repository structure.
- **Confidence:** **high**.

### S16 — Zero pure-only regressions is the advisor admission rule

- **When:** restart-gate interpretation.
- **The choice:** “Both resolve” is success for both arms, not a failed advisor
  lift. The disqualifying paired outcome is only “no advisor resolves, advisor
  does not.” Once a clean set has zero such rows, the harness expands the sample
  while budget permits. The alternative incorrectly demands advisor-only wins
  on every task or counts ties as failures.
- **The gap:** “Advisor should always improve” was initially interpreted as
  strict task-by-task lift rather than non-regression.
- **The reach:** Reports separate enabled-only wins, ties, pure-only regressions,
  and neither-resolves outcomes without hiding any scheduled row.
- **Verdict:** **sound.** This is the user's explicit interpretation of the
  product invariant.
- **Confidence:** **high**.

### S18 — Original paid-run commit identities remain reachable after the final rebase

- **When:** final closeout after pulling the latest `origin/main`.
- **The choice:** The paid run records name the exact commits that produced their
  packaged Duet binaries. Pulling upstream required replaying the local campaign
  and runtime changes onto the updated upstream tree, which gave those replayed
  changes new commit ids. The closeout keeps the original paid-run commit chain
  reachable through a tree-preserving merge, while the current branch retains the
  rebased source. The alternative leaves the ids recorded in the result artifact
  dangling and eventually unresolvable from a fresh clone.
- **The gap:** Immutable campaign records specified exact Git identities, but the
  plan did not say how to preserve those identities when upstream advanced before
  the results were pushed.
- **The reach:** Anyone auditing the compact result can resolve its recorded Git
  commits and inspect the exact historical trees without changing the current
  shipped files.
- **Verdict:** **sound.** A tree-preserving ancestry merge retains provenance
  without reintroducing superseded files or changing runtime behavior.
- **Confidence:** **high** because rewriting or discarding an identity already
  embedded in paid evidence would weaken reproducibility.

## Compressed trivial discretion

Internal variable names, campaign-id suffixes after immutable-input rejection,
fixture labels, and log wording do not constrain product behavior and are not
retained as user-owned architecture choices.
