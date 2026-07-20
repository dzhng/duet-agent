# 08 — The measurement campaign: two advisor comparisons, 30×4 (LAST)

**Status (2026-07-21): STOP during the v3 restart gates.** V4 completed 25 four-arm
instance blocks (100 rollouts, $72.2112 recorded model spend); the remaining
five blocks did not enter measurement. Official scoring reached 12 GLM pairs
and 11 Kimi pairs. All three apparent pure-only wins in that subset were advised
runs that made zero advisor calls: `fluent__fluentd-3616` for GLM/Kimi and
`facebook__docusaurus-8927` plus `facebook__docusaurus-9897` for Kimi/Fable.
One other GLM run called twice. V4 therefore diagnoses unstable compliance with
the custom exactly-once protocol; it does not show that received advice caused
those losses.

The context, lifecycle, prompt, telemetry, repeated-trial identity, compiled
memory packaging, and E2B collection corrections are now implemented and
locally green. The replacement gate ran as two pair-specific campaigns:
`advisor-restart-gate-glm-20260720-v3` (10 rollouts) and
`advisor-restart-gate-kimi-20260720-v3` (20 rollouts). V2 made no model calls:
the compiled Duet process exited while loading PGlite assets, and concurrent
workers exposed a provenance merge mismatch. Their v1 predecessor was stopped
after six complete pairs: Kimi made zero calls in three enabled runs,
while GLM skipped one of four and called only after substantial work in the
others. Partial official scoring found all seven generated GLM patches
resolved; the three scored Kimi pairs were two pure-only and one both-resolved.
Zero calls are valid product behavior, but these rows do not measure the
current lifecycle because the product and benchmark inputs changed afterward.
The run also exposed E2B target-selection and concurrent artifact-integration
races. V3 was stopped immediately after a scored Kimi/Fable pair on
`facebook__docusaurus-8927` resolved without the advisor but failed with it.
The advisor saw the complete transcript yet endorsed a narrow regex fix after
self-selected tests passed; official hidden tests disproved it with a spaced
local link and an HTTPS link. That pure-only outcome rejects the current
advisor review behavior regardless of call count.

At the user's fail-fast instruction, all three v3 workers and their controllers
were terminated. Fifteen of 30 rollouts had finalized remotely for
`$12.6315597`; three more were in flight, so conservative v3 spend is bounded
at `$21.9315597`. The remote sandboxes ended before their instance archives
were copied home. V3 is therefore frozen as lost-artifact diagnostic evidence
and must never be resumed or scored. Its surviving trace-level diagnosis comes
from the already-preserved v1/v4 runs of the same failing patch family and the
live status/consultation output captured before termination.

The next full measurement namespace is
`multilingual-30-four-arm-e2b-20260720-v5`. Create it only after the product,
prompt, and restart gates below are frozen. Every earlier namespace remains
immutable historical evidence and none contributes outcomes to v5.

## What remains invariant

- The committed 30-instance manifest, four model renders, official scorer,
  fresh official containers, one binary per campaign, E2B instance-block
  scheduling, artifact isolation, and $500 global model-spend envelope remain
  unchanged.
- Pure and enabled arms within a pair still differ only in
  `advisor.enabled`. The user message is the canonical dataset problem
  statement with no benchmark workflow wrapper. The shared minimal system
  prompt only says the task is unattended; shipped product policy decides how
  to work and whether and when to consult.
- Every rollout gets a fresh `HOME`, but the benchmark does not disable normal
  memory, compaction, or repository `AGENTS.md` discovery. The complete agent
  diff, including tests, goes to the official scorer.
- The primary report includes every assigned pair. A secondary per-protocol
  table describes successful consultations but makes no causal claim from that
  selected subgroup. The [measurement claims](../README.md#measurement-claims)
  define both views.

## Restart gate

No full campaign starts until all of these are true:

1. **Full-context fidelity (implemented):** a deterministic captured-call fixture proves that
   the advisor receives the executor's full available system prompt, tool
   definitions, prior messages, tool calls/results, and current-turn text in
   order. For a transcript that fits the advisor model's context window, no
   text-preview projection, elision marker, or configured token truncation is
   allowed. Focused live artifacts record whether any call was truncated.
2. **Product lifecycle (implemented):** the benchmark contains no advisor call
   schedule. The shipped product owns orientation and completion-review
   consultations for substantive work. Deterministic tests cover both phases,
   cooldown reset, final-evidence deduplication, and short work; disabling the
   lifecycle made the live eval produce zero calls, while restoration produced
   successful early and final calls.
3. **Non-regression diagnostics (next):** the product review correction is
   implemented and live-falsified. Under fresh campaign ids, first repeat five
   paired trials on each of the three known loss cases (30 rollouts). If that
   batch has zero pure-only outcomes, expand once to five newly sampled manifest
   tasks, running both comparisons once on each (20 rollouts). More clean pairs
   increase confidence; they do not prove that a stochastic model can never
   regress.
   Trial 1 under the v1 inputs produced zero pure-only regressions: GLM/Fluentd
   was both-resolved, Kimi/Fable on Docusaurus 8927 was enabled-only, and
   Kimi/Fable on Docusaurus 9897 was both-resolved. The serial workers were
   stopped after those pairs because E2B sharded only by instance and therefore
   used three of sixteen available slots. The v2 inputs run the remaining four
   repetitions as independent instance-trial shards. Their conservative sunk
   values reserve every completed v1 rollout plus each interrupted trial-2 arm
   at the full `$3.10` cap. The Kimi v2 gate also reserves all eight GLM v2
   rollouts so both controllers may execute concurrently without exceeding the
   shared envelope.
4. **Fail-fast admission:** score pairs as they complete. Both-resolved and
   enabled-only pairs pass the non-regression gate. Neither-resolved is neutral
   for the advisor comparison. Any pure-resolved/enabled-unresolved pair fails
   immediately: stop the remaining work, preserve the exact artifacts, compare
   the full transcripts, advisor outputs, events, patches, and scorer logs,
   make a generic product fix, then restart diagnostics under a new frozen
   campaign id. Zero, one, or multiple advisor calls remain valid telemetry;
   call count is never the admission rule.
5. **Budget:** add v4's $72.2112 to the prior $27.64 reserve, making cumulative
   sunk spend at least $99.8513 before the focused repeats. Add their spend,
   reserve unknown interrupted attempts at their full cap, then recompute one
   uniform v5 rollout ceiling. The frozen worst-case projection must remain
   within $500 before launching any of v5's 120 rollouts.

These repeat-until-clean diagnostics are adaptively selected engineering
evidence, not an effect estimate. Any product, prompt, context, or attribution
change invalidates the current diagnostic namespace and requires a new id.
After a sufficiently broad clean diagnostic set, freeze the product and launch
one fresh 30×4 campaign. Do not tune or restart that final campaign based on its
observed outcomes, and never pool diagnostic/retry rows into its estimate.

## V5 campaign and reporting contract

- `e2b/run.ts` launches the new committed v5 campaign over all 30 manifest
  instances and all four configs, one trial each, in seeded instance-trial
  order. Sixteen E2B sandboxes may process disjoint shards concurrently; each
  shard keeps all campaign arms serial and each arm gets a fresh official
  container. Repeated diagnostic trials are separate shards, so the configured
  concurrency is not artificially limited by the number of distinct issues.
- `campaign.json` records the product commit and binary hash, prompt and config
  contents, manifest and dataset revisions, environment lock, limits, budget,
  and dates. Returned archives preserve only their requested instance subtree.
- Official scoring and `report.json` cross-foot all 120 scheduled outcomes.
  Failures and cutoffs stay in denominators. Pure-arm silence, call counts,
  advisor identity, context truncation, and cost attribution are executable
  assertions.
- The primary product-policy table reports paired resolve outcomes, discordant
  pairs, effect size, and uncertainty for every assignment. The secondary
  per-protocol table shows the same outcomes by observed consultation count and
  timing, clearly labeled descriptive and selection-prone.
- The report leads with the n=30 × 1 limitation: one task moves the rate by
  3.33 points, stochastic model variance is unaveraged, and the design cannot
  reliably detect Anthropic-sized modest effects.

## Historical E2B evidence

| Namespace | Durable evidence                                                                                                                | Why it is excluded from the final estimate                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| v1        | One four-arm Druid block generated and scored for $1.4304                                                                       | Workers compiled byte-different binaries.                                                              |
| v2        | Security admission reached its first arm                                                                                        | A provider credential appeared in Docker argv; unknown spend was reserved.                             |
| v3        | One four-arm Druid block completed for $1.2233                                                                                  | Conflicting prompt layers let Kimi skip its required Fable call.                                       |
| v4        | 25 four-arm blocks completed for $72.2112; partial official scoring exposed three zero-call apparent losses and one double call | Mandatory exact-one assignment was unstable and is not shipped product policy or Anthropic's protocol. |

The earlier Mac namespaces and focused compliance runs also remain immutable
admission evidence. They may inform engineering and budget accounting, never
v5 outcomes.

## Playable checkpoint

V5's `report.md` contains the primary product-policy comparison, secondary
per-protocol diagnostics, paired outcomes, costs, call behavior, context
fidelity, failures, and provenance. After it cross-foots, close the spec while
leaving the harness available for larger repeated campaigns.
