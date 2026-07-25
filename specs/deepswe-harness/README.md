# DeepSWE advisor pilot

## Purpose

Measure whether Duet's normal advisor architecture improves long-horizon
repository work on DeepSWE v1.1, while preserving DeepSWE's official task
containers, pristine verifier containers, and reward files.

The pilot is a paired experiment over ten frozen tasks:

- GLM 5.2 pure versus GLM 5.2 with Kimi K3 advisor.
- Kimi K3 pure versus Kimi K3 with Fable 5 advisor.

Both arms in a pair use the same task, Duet commit, prompt, executor effort,
classifier, memory behavior, vision fallback, limits, and official verifier.
Advisor availability is the treatment. Both-resolved is a successful tie;
pure-resolved/advised-unresolved is a regression that remains in the result.

## Next Agent Prompt

Status: setup complete; the paid one-task acceptance gate is next, last updated
2026-07-25.

Implement the next unchecked slice in order. Keep Pier as the sole owner of
task containers and scoring. Preserve raw Duet RPC events before deriving
telemetry. Before ending a pass, update this section and the checklist.

- [x] [01 — Pin the official inputs](slices/01-pin-official-inputs.md)
- [x] [02 — Bridge Duet into Pier](slices/02-pier-duet-adapter.md)
- [ ] [03 — Execute and report the pilot](slices/03-execute-and-report.md)

The pinned checkout, generated configs, compiled artifact, benchmark-local
tests, inherited SWE-bench tests, Pier adapter seam, and official no-model
separate-verifier smoke all pass. The paid run needs an explicit total budget;
setup and no-model checks do not.

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

## Review map

The first useful checkpoint is a no-model Pier smoke proving that the pinned
task and separate verifier environment work. The second is one paid task across
all four arms. Only then should all ten task shards launch.

There is no visual surface or screenshot gate for this benchmark.
