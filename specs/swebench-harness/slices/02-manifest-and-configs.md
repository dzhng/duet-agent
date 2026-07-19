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
- `config-override.ts`: `renderModelsJson({tier: "balanced", advisorEnabled})
→ RoutingTable` — imports `BUILT_IN_ROUTING_TABLE` and
  `validateRoutingTable` from `src/model-routing/table.ts`. Committed outputs:
  `benchmarks/swebench/configs/balanced-advisor-{on,off}.models.json`. The
  schema requires the `advisor` object with an `enabled` field — OFF flips
  `enabled: false`, never deletes the object.

## Seam

Pure functions over data; the fetch is isolated in its own module. The
manifest file path is the pairing contract: campaigns reference it by path
and never re-sample.

## Verification

- Unit (fixture rows, no network): same seed → byte-identical manifest; all
  9 languages represented, proportions within ±1; revision recorded; unknown
  tier throws.
- Config: deep-diff of ON vs OFF renders is exactly the one boolean; both
  pass `validateRoutingTable`; serialization matches `duet config export`
  formatting.

## Playable checkpoint

`bun benchmarks/swebench/cli.ts manifest show` prints the per-language table
of the 30 chosen instances; `... config render --advisor off` prints the JSON
and its one-line diff against the built-in table.

## What would change this slice

Gold-gate failures in slice 04 may force substituting instances — legal only
before any measurement runs, via a new seed and re-commit, never by hand-
editing entries.
