# Slice 03 — Execute and report the pilot

## Contract

One command can run every configured arm over any frozen task subset through
official Pier scoring, resume infrastructure failures, and report paired
resolution plus cost/task and cost/resolved.

## Seam

The campaign expands into one outer shard per task. On E2B, the workers run
concurrently; each worker runs its task's arms sequentially so DeepSWE's 8 GiB
agent/verifier requirements do not compete inside a 16 GiB worker.

The in-container driver derives usage from Duet's retained raw RPC ledger and
Pier embeds that accounting in each trial `result.json`. The reporter consumes
those official trial records; it never infers correctness from terminal text
or locally run tests. Missing accounting blocks cost headlines instead of
being treated as free.

Paid-run admission requires the per-rollout soft stop plus one additional
maximum-size request cushion. That cushion is derived from the context, output,
and price ceilings of the pinned pilot models. It is not represented as a hard
provider cap: normal product subagents can have several model requests in
flight when interruption starts.

## Verification

- Pair validation rejects changed classifier, memory, fallback, effort, prompt,
  task image, or Duet artifact within a pair.
- Sharding produces one task shard per selected task and one outcome per
  configured arm.
- A missing arm or infrastructure failure blocks a headline paired comparison.
- Synthetic results cover both-resolved, advisor-only, pure-only, and neither.
- The first paid tranche runs the first five frozen tasks across six arms.
- A pure-only regression stops the tranche before unrelated model-family spend;
  the preserved trace must drive a general product fix and a fresh campaign.
- DeepSWE passes `/app` as its repository root when deriving mutation-relative
  advisor timing; SWE-bench retains its `/testbed` root.

## Delegated choices

Report formatting and seeded within-task arm order are delegated. Denominator
rules, paired categories, official reward ownership, and explicit budget
admission are not.
