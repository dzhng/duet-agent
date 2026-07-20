# 08 — The measurement campaign: two advisor comparisons, 30×4 (LAST)

**Status (2026-07-20): STOP after E2B v4.** V4 completed 25 four-arm
instance blocks (100 rollouts, $72.2112 recorded model spend); the remaining
five blocks did not enter measurement. Official scoring reached 12 GLM pairs
and 11 Kimi pairs. All three apparent pure-only wins in that subset were advised
runs that made zero advisor calls: `fluent__fluentd-3616` for GLM/Kimi and
`facebook__docusaurus-8927` plus `facebook__docusaurus-9897` for Kimi/Fable.
One other GLM run called twice. V4 therefore diagnoses unstable compliance with
the custom exactly-once protocol; it does not show that received advice caused
those losses.

The context, prompt, telemetry, and repeated-trial identity corrections are now
implemented and locally green. The restart gate is frozen as two committed
campaigns so each report contains only its actual pair:
`advisor-restart-gate-glm-20260720-v1` (10 rollouts) and
`advisor-restart-gate-kimi-20260720-v1` (20 rollouts). They have not yet run.

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
  `advisor.enabled`. For v5, the shared task prompt must not prescribe call
  count or timing; the shipped product policy decides whether and when to
  consult.
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
2. **Product prompt (implemented):** remove the benchmark's mandatory exactly-once language
   from both prompt layers. Pin the resulting product commit, binary, prompt
   hash, and rendered configs before paid repeats.
3. **Focused repetition (next):** under separate restart-gate campaign ids, run five
   fresh paired pure/enabled trials on each of the three v4 zero-call loss
   instances. This is 30 rollouts: five GLM pairs on Fluentd and five Kimi pairs
   on each Docusaurus task. Do not reuse, discard, or replace stochastic
   outcomes.
4. **Admission:** every pure trial remains advisor-silent; provider identity,
   context fidelity, costs, patches, and official scores reconcile; neither
   executor/advisor pairing has zero successful consultations across all its
   enabled repeats; and no infrastructure or provenance failure remains. Zero
   or multiple calls in an individual enabled rollout are reported as product
   behavior, not patched into exact-one compliance.
5. **Budget:** add v4's $72.2112 to the prior $27.64 reserve, making cumulative
   sunk spend at least $99.8513 before the focused repeats. Add their spend,
   reserve unknown interrupted attempts at their full cap, then recompute one
   uniform v5 rollout ceiling. The frozen worst-case projection must remain
   within $500 before launching any of v5's 120 rollouts.

Any product, prompt, context, or attribution change after this gate invalidates
it and requires another campaign id plus another focused gate. A single green
rerun is not admission evidence.

## V5 campaign and reporting contract

- `e2b/run.ts` launches the new committed v5 campaign over all 30 manifest
  instances and all four configs, one trial each, in seeded instance-block
  order. Sixteen E2B sandboxes may process disjoint blocks concurrently; each
  block keeps its four arms serial and each arm gets a fresh official container.
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
