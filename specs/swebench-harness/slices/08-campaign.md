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
  prompt requires a complete repository solution and unattended work; shipped
  product policy decides how to work and whether and when to consult.
- Every rollout gets a fresh `HOME`, but the benchmark does not disable normal
  memory, compaction, or repository `AGENTS.md` discovery. The complete agent
  diff, including tests, goes to the official scorer.
- The primary report includes every assigned pair. A secondary per-protocol
  table describes successful consultations but makes no causal claim from that
  selected subgroup. The [measurement claims](../README.md#measurement-claims)
  define both views.

## Restart gate

No full campaign starts until all of these are true:

1. **Compacted-context fidelity (implemented and paid-gated):** a deterministic captured-call
   fixture proves that the advisor receives the executor's resolved system
   prompt, exact tool definitions, first user task, observational summary of
   older history, and a generous recent wire-faithful tail containing complete
   tool calls/results and current-turn text in order. The configured advisor
   envelope is intentionally smaller than the model's hard context window; the
   hard window remains a final safety ceiling. The latest complete tool
   interaction is protected even when it alone exceeds the soft target. Unit
   tests and a falsified live eval prove compaction, observation recovery,
   recent-result fidelity, and token accounting. The first 32k/16k baseline then
   preserved 15/15 advisor resolves across the paid known-case gate while
   cutting total exact advisor tokens by 55.6%. A second candidate retains the
   32k observation trigger but removes runtime-only message metadata and keeps
   an 8k ordinary raw tail. The latest complete tool interaction still overrides
   the soft tail. A uniform-medium paid candidate scored 14/15 and increased
   advisor-plus-observer tokens by 2.3%, so it is rejected. The next candidate
   keeps Kimi at medium but restores Fable to high after the failed trace showed
   medium conditionally approving a hand-designed regex instead of the exact
   upstream fix. Freeze only if the same 15 advised cases all resolve and
   advisor-plus-observer tokens improve.
2. **Product lifecycle (implemented):** the benchmark contains no advisor call
   schedule. The shipped product owns orientation and completion-review
   consultations for substantive work. Deterministic tests cover both phases,
   cooldown reset, final-evidence deduplication, and short work; disabling the
   lifecycle made the live eval produce zero calls, while restoration produced
   successful early and final calls.
3. **Non-regression diagnostics (in progress):** the product review correction is
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
   shared envelope. The completed known-case gate has 15/15 non-regressions:
   eight enabled-only improvements and seven both-resolved ties. The v2 GLM
   comparison is 2 enabled-only and 2 both-resolved; the v2 Kimi comparison is
   5 enabled-only and 3 both-resolved. Before broadening, use these 15 pairs as
   an adaptive tuning set for advisor-context efficiency. A candidate must keep
   zero pure-only outcomes and all 15 advisor resolves while reducing measured
   advisor input tokens. The first diversity namespaces were stopped before a
   pair completed when this product-policy change superseded them; new frozen
   ids are required after the context policy is fixed. The first 32k candidate
   uses `advisor-context-efficiency-kimi-20260721-v1` and
   `advisor-context-efficiency-glm-20260721-v1`: run the five Docusaurus 8927
   pairs first, then the other ten pairs if that high-risk wave is clean. That
   immutable `4aa8791` run completed 15/15 advisor resolves against 10/15 pure
   resolves: five enabled-only improvements, ten both-resolved ties, and zero
   pure-only regressions. Across 36 successful consultations, estimated input
   fell 53.4%, exact advisor tokens fell 55.6%, and advisor spend fell 49.5%
   from the earlier baseline. Normal observer work added $0.89; advisor plus
   observer still cost 43.6% less than the old advisor calls alone. The policy
   compacted 1,129 messages with zero unrepresented omissions. This is the
   fallback baseline. The model-visible/8k/uniform-medium v2 candidate reduced
   exact advisor tokens from 731,889 to 595,251, but scored 14/15 and increased
   combined advisor-plus-observer tokens from 1,543,369 to 1,578,537. Its single
   unresolved Docusaurus 8927 trace hand-designed an incomplete regex despite
   three successful consultations; the high-effort baseline found and applied
   the authoritative upstream patch. The model-specific-effort v3 rerun then
   reduced advisor-plus-observer tokens 15.3% (1,543,369 to 1,306,951) but also
   scored 14/15. In its failed 8927 trace, the completion checkpoint fired after
   diagnosis and before editing. Fable rejected the unimplemented regex and
   named the exact adjacent risks, but later tool work did not re-arm the
   checkpoint, so Fable never reviewed the final bad diff. A first generic fix
   re-armed after every later tool and over-corrected: four recovered focused
   runs used 3–7 Fable calls, two hit the cost cap, and one archive was lost when
   the campaign stopped. The exact traces showed recursive mandatory review of
   advisor-requested verification. Re-arm automatically once only when the early
   completion checkpoint was issued before any successful consultation, and allow complete
   evidence to receive an unconditional approval. Rerun the five 8927 cases
   under a fresh id and expand to all 15 only after 5/5. Frozen pure results
   remain the comparison and are not paid for again. The fresh v5 focus gate
   passed 5/5 official resolves with 11 total advisor calls, no cost-cap
   interruptions, and 402,590 combined advisor-plus-observer tokens—12.1%
   below the same five-case v3 subset. Expand this exact policy to all 15 known
   cases under the v6 namespaces before attempting another optimization.
   V6 then restored 15/15 official resolves. Its advisor models used 494,436
   tokens; event-boundary reconstruction assigns 808,182 Luna tokens to the
   observer and 33,258 to GLM classification. V7 tested a 64k soft compaction
   trigger on the five 8927 repeats. It remained 5/5 resolved but used 622,697
   advisor-plus-observer tokens versus v6's 470,574, a 32.3% regression. Restore
   32k and optimize observation work itself; do not expand the rejected setting.
   The next trace audit found benchmark RPC omitted `--session`, so every later
   observation restarted at the first user message. Supply the stable benchmark
   session inside each fresh HOME and let normal range markers process only the
   new suffix.
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

The v5 focus gate recorded `$5.871627` of accepted generation. Conservatively
reserve another `$3.10` for its initial E2B connection failure because no remote
archive survived to prove that generation had not started. Cumulative sunk was
recorded as `$439.2249`. A later audit proved `$45.4496162` of that lineage was
a temporary 24-arm overlap reservation whose completed attempts have exact
telemetry. The corrected post-v7 cumulative worst case is `$422.8553023`,
leaving `$77.1446977`. The E2B controller now reserves active concurrent shards,
persists each reservation before model work, and replaces it with returned
exact cost before admitting more. It may never spend past `$500`; a worker
failure stops admission, and an exhausted envelope leaves the remaining shards
unstarted as a denominator-visible stop.

Freeze the final population as
`multilingual-30-four-arm-e2b-20260721-v5`, with all four configurations, the
30-instance manifest, the `$3.10` rollout ceiling, and at most 16 E2B workers.
Validate the repaired session attribution in this population instead of buying
another adaptive 15-case replay; only the final rows are eligible for the effect
estimate.

The first v5 admission launched six shards. Four returned 16 terminal artifacts
for `$15.6848066`; one failed before model work, and one completed generation but
lost its archive on an E2B connection error. Retry only idempotent no-model E2B
setup and recovery requests. Persist the model-command stage, release reserves
only for proven pre-command failures, and never automatically replay ambiguous
model work.

Official scoring then found a pure-only result in its first pair and stopped:
pure GLM resolved `caddyserver__caddy-4943`, while GLM plus Kimi did not. The
enabled trace ported current upstream's broad array-filter refactor and changed
an unrelated existing QueryFilter expectation; the scorer's untouched test
caught that contract regression. The first consultation had no compaction and
already widened the task, and the second explicitly approved the expectation
change, so do not tune context or lifecycle for this failure. Correct general
advisor scope policy instead: version-match reference evidence, isolate the
requested behavior, prefer the smallest sufficient change, and presume an
edited passing expectation is a regression until independent task evidence
proves otherwise. The live Kimi review eval was red with the old policy and
green with the correction. Its first Mac-only rerun under
`advisor-scope-regression-glm-mac-20260721-v1` found the narrow historical fix
but returned only upgrade advice and an empty patch: the issue itself ends in
“Please advise,” while the old shared system prompt did not explicitly require
a repository change. Treat that artifact as an invalid task-definition probe,
not a scored advisor result. The minimal shared prompt now requires a complete
working-tree solution without prescribing workflow or advisor behavior. Since
that paired input changed, both pure GLM and GLM plus Kimi reran under
`advisor-scope-regression-glm-mac-20260721-v2` before broader generation.

The v2 pair officially scored enabled-only: GLM plus Kimi resolved and pure GLM
did not. It used two successful consultations, compacted 206 old messages with
zero omissions, and cost `$3.2956061`. Add that exact spend to the conservative
ledger, leaving `$32.061932`. Freeze the next Mac measurement as
`multilingual-four-arm-mac-20260721-v6-core`: the seed-20260722 two-language
subset (Laravel 53206 and Lombok 3697), four arms, one trial, serial local
execution. Eight `$3.10` emergency reservations fit the remaining budget. Score
each complete block and fail fast on a pure-only outcome. Expand only after
returned exact costs prove another complete four-arm block can retain the same
ceiling under `$500`.

These repeat-until-clean diagnostics are adaptively selected engineering
evidence, not an effect estimate. Any product, prompt, context, or attribution
change invalidates the current diagnostic namespace and requires a new id.
After a sufficiently broad clean diagnostic set, freeze the product and launch
one fresh four-arm population that fits the remaining hard budget. Do not tune
or restart that measurement based on its observed outcomes, and never pool
diagnostic/retry rows into its estimate.

## Superseded V5 campaign and reporting contract

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
