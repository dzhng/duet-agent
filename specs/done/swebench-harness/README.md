# SWE-bench advisor harness

## Purpose

This harness measures whether Duet's normal advisor policy changes real
repository-task resolution, while keeping the executor, task, environment, and
scorer paired. It exists because tool-call counts, locally green tests, and
model-written completion claims are not substitutes for the official
SWE-bench result.

The [final choices ledger](choices.md) records the architectural decisions the
implementation made where the original task left room for judgment.

The shipped comparison covers two product configurations:

- GLM-5.2 as executor with the product classifier and no advisor versus the
  same executor with Kimi K3 advising.
- Kimi K3 as executor with the product classifier and no advisor versus the
  same executor with Fable advising.

The harness adds one shared repository-outcome system prompt, a single-route
`swebench` tier, fixed executor effort, and the official task image. Within
each pair, those inputs, the classifier configuration, memory and tool
implementation, limits, and routing topology are identical; advisor
enablement is the treatment.

## Result

The final fresh Mac sample contains five tasks from the predeclared
seed-20260722 SWE-bench Multilingual sequence across PHP, Java, Go, Ruby, and
TypeScript. A two-row seeded core and three explicit expansions materialize the
same size-five selection. Each task ran once in all four arms and was scored in
the official task image.

| Comparison                   |      Pure |    Advised | Enabled-only | Both resolve | Pure-only | Neither |
| ---------------------------- | --------: | ---------: | -----------: | -----------: | --------: | ------: |
| GLM-5.2 vs GLM-5.2 + Kimi K3 | 4/5 (80%) | 5/5 (100%) |            1 |            4 |         0 |       0 |
| Kimi K3 vs Kimi K3 + Fable   | 4/5 (80%) | 5/5 (100%) |            1 |            4 |         0 |       0 |

Prometheus was the enabled-only row in both comparisons. Laravel, Lombok,
Fastlane, and Vue were both-resolve rows. No pure-only regression occurred.
The observed lift is 20 percentage points in each comparison, but n=5 with one
trial per task is signal-seeking evidence, not a leaderboard estimate or a
precise population effect.

Fresh generation cost `$22.7102923`:

| Arm                  |         Cost | Advisor calls |
| -------------------- | -----------: | ------------: |
| GLM pure             | `$5.7996515` |             0 |
| GLM + Kimi advisor   | `$4.9566590` | 11 successful |
| Kimi pure            | `$4.2982086` |             0 |
| Kimi + Fable advisor | `$7.6557732` | 11 successful |

Across those calls, context telemetry estimated 167,323 Kimi-advisor input
tokens and 192,152 Fable-advisor input tokens. The provider usage ledgers
reported 135,552 and 249,057 total billed advisor tokens, respectively. These
totals make context cost visible without treating a larger transcript as a
quality metric.

Starting from the v6 campaign's declared conservative prior balance of
`$467.9380680`, exact fresh-run telemetry reconciles the accounted total to
`$490.6483603` under the user's `$500` budget. The remaining `$9.3516397`
cannot reserve another complete four-arm block at the unchanged `$3.10`
per-rollout interruption threshold.

The campaign specs are:

- `multilingual-four-arm-mac-20260721-v6-core` for Laravel and Lombok.
- `multilingual-four-arm-mac-20260721-v8-expansion` for Prometheus.
- `multilingual-four-arm-mac-20260721-v9-expansion` for Fastlane.
- `multilingual-four-arm-mac-20260721-v10-expansion` for Vue.

A compact durable result lives at
`benchmarks/swebench/results/mac-advisor-comparison-20260721.json`. Campaign
specs, routing inputs, the manifest, and the environment lock are committed in
their respective benchmark directories. Exact frozen provenance and telemetry
live under local `benchmarks/swebench/runs/<campaign-id>/` namespaces; reports
and official scorer artifacts live under matching ignored
`benchmarks/swebench/.cache/<campaign-id>/` namespaces.

The paid v6-v10 artifacts froze each official image's mutable `:latest`
reference, but did not retain its Docker image ID. The closed harness now stores
and launches rollouts by the resolved image ID and records the scorer image ID;
that improvement is not retroactive provenance for the published sample. The
durable result records this limitation alongside hashes of the retained local
reports and scorer summaries.

The estimate pools four sequential campaign namespaces. Their routing,
manifest, environment, and system-prompt hashes match. Their product binary
hashes and Git commits differ because each expansion was committed separately;
the intervening diffs change campaign/spec documentation, not product runtime
source.

## Why the harness has this shape

### Pair the product, not a benchmark-specific agent

The benchmark prompt states the repository outcome and stays silent about
advisor calls, schedules, step limits, test order, and workflow. Advisor-enabled
arms use normal product guidance, including early orientation and later review.
This keeps the treatment equal to "advisor policy enabled" rather than "model
obeys a benchmark consultation script."

The issue text is passed identically to every arm after surrounding whitespace
is trimmed. The small shared system prompt disambiguates that a repository
solution is required, because issue prose such as "please advise" otherwise
permits a valid prose-only interpretation and an empty patch.

### Preserve transcript meaning without filling the model window

Advisor input targets 32,000 tokens rather than the full model context window.
Complete recent messages and tool interactions stay raw; older history is
normally represented through observational memory. The executor system prompt,
tool definitions, first user task, and retained tool-call/result structure
remain represented. If the best-effort observer drain fails, projection may
omit older messages and logs a warning. The model's real context window is a
safety ceiling, not an invitation to spend it.

If advisor usage conversion or accounting fails after advice returns, the
executor's tool call still succeeds and the failure is logged. A usage record
that could not be converted cannot appear in the cumulative ledger;
successfully converted records are folded once. Advice is auxiliary product
behavior, so telemetry failure must not turn a repository action into a harness
failure.

### Let the official scorer decide patches

An interrupted rollout may still contain a complete solution. The harness
therefore extracts its patch and keeps it in the denominator instead of
rewriting a wall-clock or cost interruption as unresolved. Vue's pure-Kimi arm
demonstrated this invariant: it hit the 30-minute wall during final validation,
and its preserved patch officially resolved.

Repository tests, runtime-looking paths, and test-only patches are retained.
The benchmark does not impose a path policy that the official task does not
have.

### Make paid work immutable and budget-accounted

Campaign plus per-rollout provenance binds the product commit, packaged binary,
prompt, routing files, manifest, resolved task-image identity, limits, and
selection. A changed input requires a new campaign id. Every rollout receives a
fresh official container, and one local `runCampaign` process reserves the
configured interruption threshold for every pending arm before an instance
block starts model work. Each reservation reconciles to exact returned usage as
its rollout finishes. E2B owns a separate global reservation pool across its
shards; independent local `runCampaign` processes do not share a durable lock.

The threshold is admission control, not a provider-side spending limit: Duet
can interrupt only after a completed request reports usage, so one request may
overshoot `$3.10`. The campaign records exact returned spend and admits no later
block that fails the remaining-threshold check; if reported spend plus active
reservations exceeds the envelope, execution stops with completed artifacts
retained. The published run's exact total stayed below `$500`; the harness does
not claim a mathematical hard cap against single-request overshoot.

Model usage is cross-footed from the terminal cumulative ledger by model. Pure
arms assert zero advisor calls; advised arms record advisor identity, outcome,
call step, context representation, and position relative to the first explicit
repository mutation.

## Invariants

- Paired arms differ only in advisor enablement; each pair pins the same named
  advisor target in both renders.
- Classifier and memory stay at product defaults.
- Canonical issue text and pair-neutral system prompt bytes match within a
  comparison.
- Disabling the advisor removes its guidance and tool; report admission also
  requires pure-arm telemetry that proves zero calls.
- Advisor failure is observable but does not fail the executor tool.
- Every successfully converted executor, classifier, advisor, memory, and child
  usage record appears exactly once in `usageByModel` and `turnUsage`.
- Advisor input uses the soft target and observational compaction before hard
  window truncation. Context telemetry distinguishes raw included messages,
  messages projected out of raw history, and hard-window omissions; observer
  failure remains a logged best-effort path.
- Artifact status is finalized last, retries use new attempt directories, and
  provenance is never overwritten.
- New rollouts launch by the resolved Docker image ID, and resume refuses a
  different ID within the same campaign; scoring records its independently
  pulled image ID.
- Cost and wall interruptions preserve scoreable patches.
- Intention-to-treat reporting includes zero-call, failed-call, interrupted,
  and empty-patch outcomes.
- Among completed, scoreable artifacts, only the official SWE-bench scorer
  supplies resolved/unresolved status; missing and failed artifacts remain
  denominator failures.
- The published estimate is assembled only from the four named fresh campaign
  namespaces above; adaptive diagnostics and superseded prompt hashes are not
  pooled into it.

## Code and verification map

Product advisor behavior:

- `src/model-routing/advisor.ts` builds the advisor call.
- `src/turn-runner/turn-runner.ts` selects the 32k soft target and schedules
  consultations on the existing parent transcript.
- `src/memory/observational.ts` compacts older history into observations.
- `src/model-routing/advisor-context.ts` captures and serializes advisor input,
  fits the hard model window, and records context telemetry.
- `src/model-routing/prompts.ts` contains normal advisor guidance, including
  narrow fixes and version-matched reference handling.
- `src/turn-runner/tools.ts` converts advisor results and keeps conversion or
  accounting failures non-fatal.
- `src/turn-runner/turn-runner.ts` attributes usage and emits generic turn
  events.
- `src/types/protocol.ts` documents `TurnEventOrigin`, `turnUsage`, and
  `usageByModel`.

Benchmark mechanics:

- `benchmarks/swebench/cli.ts` is the command entry point.
- `benchmarks/swebench/src/orchestrator.ts` plans paired blocks, resumes safely,
  and enforces reserve-first budgeting.
- `benchmarks/swebench/src/rollout.ts` owns the fresh-container rollout.
- `benchmarks/swebench/src/patch.ts` owns exact patch extraction.
- `benchmarks/swebench/src/telemetry.ts` derives model cost, advisor-call, and
  context-fidelity evidence from wire events.
- `benchmarks/swebench/src/report.ts` builds intention-to-treat and descriptive
  consultation reports.
- `benchmarks/swebench/src/prompt.ts` holds the pair-neutral outcome prompt.
- `benchmarks/swebench/src/manifest.ts` owns reproducible multilingual task
  selection.
- `benchmarks/swebench/mac/score.sh` wraps the scorer entry point;
  `benchmarks/swebench/mac/score_predictions.py` owns official invocation and
  report caching.

The product test suite runs through `bun run test`. The self-contained
TypeScript harness suite runs through `bun run test:swebench`; its focused
owners include `swebench-orchestrator.test.ts`, `swebench-rollout.test.ts`,
`swebench-telemetry.test.ts`, and `swebench-campaign-report.test.ts`. Mac Python
helper behavior is separately pinned by
`benchmarks/swebench/mac/tests/test_mac_tools.py`, which the Mac provisioner
runs in its pinned Python environment.

## Rejected approaches and divergences

- A benchmark rule requiring exactly one advisor call was removed. It measured
  compliance with a harness invention and suppressed normal early/final review.
- Fixed 10k context and "fill the entire advisor window" policies were both
  rejected. The first hid useful raw evidence; the second was wasteful and
  displaced normal memory compaction.
- Reroute handoff prompts were removed. A route/model switch continues the same
  transcript, matching `/model`, and resets advisor cooldown. A successful
  consultation starts the step-based cooldown and requests classification;
  completion review also resets the cooldown.
- A broader protocol with parent-context usage was collapsed into cumulative
  turn usage plus per-model attribution. Benchmark accounting consumes the
  generic product ledger rather than a benchmark-only channel.
- Current-upstream reference code once widened a narrow Caddy fix and changed
  an unrelated passing contract. Advisor policy now treats references as
  version-matched evidence, prefers the smallest sufficient change, and treats
  changed passing expectations as suspected regressions.
- Early E2B and Mac campaigns used superseded binary or prompt hashes, rejected
  exact-one policy, or partial populations. They remain engineering and budget
  evidence but are excluded from the fresh five-task estimate.
- A one-row expansion initially claimed a whole-prefix seed assertion. The
  validator rejected it before paid work; immutable provenance then required a
  new campaign id. The final five rows equal the seed-20260722 size-five set,
  while v8-v10 use explicit ids because the campaign schema cannot express a
  seeded suffix.
- The official harness combines JavaScript and TypeScript into one runtime
  bucket. Manifest stratification deliberately separates its seven repositories
  by primary repository language so all nine published language labels remain
  observable. This affects sampling only; official image selection and scoring
  still come from the pinned Python harness.

There was no visual baseline or image-driven requirement for this backend
harness.
