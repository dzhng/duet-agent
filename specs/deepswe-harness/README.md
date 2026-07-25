# DeepSWE advisor pilot

## Purpose

Measure whether Duet's normal advisor architecture improves long-horizon
repository work on DeepSWE v1.1, while preserving DeepSWE's official task
containers, pristine verifier containers, and reward files.

The frozen population contains ten tasks. Its first paid tranche runs the first
five selected tasks across two advisor pairs:

- GLM 5.2 pure versus GLM 5.2 with Kimi K3 advisor.
- Kimi K3 pure versus Kimi K3 with Fable 5 advisor.

Opus 5 pure and Fable 5 pure run on those same tasks as standalone model-family
cost and resolve-rate baselines. They do not create artificial advisor pairs.

Both arms in a pair use the same task, Duet commit, prompt, executor effort,
classifier, memory behavior, vision fallback, limits, and official verifier.
Advisor availability is the treatment. Both-resolved is a successful tie;
pure-resolved/advised-unresolved is a regression that remains in the result.

## Next Agent Prompt

Status: the first paid campaign was stopped after its complete five-task GLM
pair exposed one pure-only regression. The exact trace led to a product-level
advisor review fix that is green 5/5 on the frozen regression eval; rebuild and
rerun the five-task campaign from a new clean commit, last updated 2026-07-25.

Implement the next unchecked slice in order. Keep Pier as the sole owner of
task containers and scoring. Preserve raw Duet RPC events before deriving
telemetry. Before ending a pass, update this section and the checklist.

- [x] [01 — Pin the official inputs](slices/01-pin-official-inputs.md)
- [x] [02 — Bridge Duet into Pier](slices/02-pier-duet-adapter.md)
- [ ] [03 — Execute and report the pilot](slices/03-execute-and-report.md)

The user authorized a $1,000 campaign budget. At the chosen $10 per-rollout
soft stop, five tasks across six arms require $900 of admission headroom.
Decisions made while implementing the tranche are recorded in the
[choices ledger](choices.md).

The stopped campaign completed all five GLM pairs before interruption:

- GLM pure: 2/5 resolved, $4.87/task, $12.18/resolved.
- GLM + Kimi advisor: 2/5 resolved, $4.65/task, $11.63/resolved.
- Paired outcomes: one advisor-only lift, one pure-only regression, one
  both-resolved tie, and two neither-resolved ties.

The regression was `testem-per-launcher-reports`: pure resolved, advised
missed one of 65 new tests because it emitted bare TAP summary lines instead
of `# `-prefixed comments. The advisor made three successful consultations but
approved executor-written tests that encoded the same wire-format defect.
`evals/advisor-validates-wire-format.eval.ts` reproduced the miss in 3/5 runs
and now passes 5/5 after the generic protocol-review prompt correction.

## Ownership

- DeepSWE owns task instructions, images, `pre_artifacts.sh`, held-out tests,
  and verifier rewards.
- Pier owns task discovery, Docker lifecycle, the separate verifier
  environment, artifact transfer, and official result records.
- The Duet adapter owns only installing the exact Duet artifact, driving its
  existing RPC protocol, committing the resulting working tree for
  `pre_artifacts.sh`, and preserving the raw event stream.
- E2B owns only outer concurrency and result transport. Pier remains the
  scorer inside every worker.

Benchmark-wide command execution, Linux artifact packaging, RPC control, and
wire telemetry live under `benchmarks/shared`; neither SWE-bench nor DeepSWE
owns duplicate versions.

## Frozen inputs

- DeepSWE repository:
  `https://github.com/datacurve-ai/deep-swe.git`
- DeepSWE v1.1 commit:
  `e016041a6ccf8da29906afc9a3f5a8df940a1f78`
- Pier version: `0.3.0`
- Pier source commit:
  `fefa7475a32bb05271abdea378e8083c83eb5c35`
- Population: ten explicit task IDs selected by sorting the 113 task IDs,
  applying Python's MT19937 shuffle with seed `0`, and taking the first ten.

Pier's built-in seeded selection is not the population contract because it
shuffles unsorted filesystem enumeration. The committed IDs are the authority;
the seed and algorithm explain how they were chosen.

## Invariants

- No benchmark-specific advisor timing, exact-call count, reroute prompt, or
  step limit.
- The official instruction is passed verbatim. One neutral system sentence
  asks Duet to finish the repository task unattended.
- Every run uses the exact clean, pushed Duet commit recorded in provenance.
- Raw RPC NDJSON is retained even when a later event is unknown or malformed.
- Cost comes from the final cumulative `turnUsage`; `usageByModel` remains the
  attribution ledger. No benchmark-only product protocol fields are added.
- DeepSWE only captures committed work, so the adapter commits all agent changes
  without filtering paths before Pier invokes `pre_artifacts.sh`.
- Generated jobs, runtime builds, caches, and reports live in ignored output
  directories. Compact final result records may be committed separately.
- Infrastructure failures may be resumed. Model or verifier failures are
  outcomes, not silently retried until they pass.
- A pure-only advisor regression stops expansion. Preserve its traces, fix the
  general product behavior that caused it, and start a fresh comparable
  campaign rather than retrying the failed outcome until it passes.

## Review map

The no-model Pier smoke proved that the pinned task and separate verifier
environment work. The next checkpoint is the first five frozen tasks across all
six arms. The remaining five tasks stay available as an expansion tranche.

There is no visual surface or screenshot gate for this benchmark.
