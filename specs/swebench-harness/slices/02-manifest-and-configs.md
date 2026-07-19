# 02 — Instance manifest + routing-table renders

Local, pure, no Docker, no live model. Produces the two committed artifacts
every later slice and every future campaign consumes.

## Contract

- `benchmarks/swebench/src/fetch-dataset.ts` pulls
  `princeton-nlp/SWE-bench_Multilingual` rows via the HF datasets-server REST
  API (no python) into a git-ignored cache, recording the dataset revision.
- `manifest.ts`: `selectManifest(rows, {seed, size}) → InstanceManifest` —
  deterministic seeded PRNG over sorted instance ids, language-stratified
  (bucket counts differ by at most one across the 9 languages). Committed
  output: `benchmarks/swebench/manifests/multilingual-30.json` with
  `{datasetRevision, seed, algorithmVersion, entries: [{instanceId, language,
repo, baseCommit, imageKey}]}`.
- `config-override.ts`: `renderModelsJson({advisorEnabled}) → RoutingTable` —
  derives a complete table from `BUILT_IN_ROUTING_TABLE` and validates it with
  `validateRoutingTable`. Its only tier and `defaultTier` are
  `swebench-glm-kimi`. The tier has one `general` route: GLM-5.2 at high effort
  for execution and Kimi K3 at high effort for advice. The classifier, GLM
  image fallback, advisor cadence/transcript budget, and all other policy are
  copied unchanged from the product table; the benchmark does not select
  alternative models for those roles. Committed outputs:
  `benchmarks/swebench/configs/glm-kimi-advisor-{on,off}.models.json`. OFF flips
  only `advisor.enabled`; it never deletes the advisor definition. Rollout
  commands omit `--memory-model`, preserving the product default.

## Seam

Pure functions over data; the fetch is isolated in its own module. The
manifest file path is the pairing contract: campaigns reference it by path
and never re-sample.

## Verification

- Unit (fixture rows, no network): same seed → byte-identical manifest; all
  9 languages represented, proportions within ±1; revision recorded; unknown
  tier throws.
- Config: deep-diff of ON vs OFF renders is exactly the one boolean; both pass
  `validateRoutingTable`; assertions prove executor and advisor targets are the
  only model substitutions and every other policy equals the product default.

## Playable checkpoint

`bun benchmarks/swebench/cli.ts manifest show` prints the per-language table
of the 30 chosen instances; `... config render --advisor off` prints the JSON
and its one-line diff against the advisor-ON render.

## What would change this slice

Gold-gate failures in slice 04 may force substituting instances — legal only
before any measurement runs, via a new seed and re-commit, never by hand-
editing entries.
