# 02 — Instance manifest + routing-table renders

Local, pure, no Docker, no live model. Produces the committed pairing and
routing artifacts every later slice consumes.

## Contract

- `benchmarks/swebench/src/fetch-dataset.ts` pulls
  `SWE-bench/SWE-bench_Multilingual` rows via the HF datasets-server REST API
  (no python) into a git-ignored cache, recording the pinned dataset revision.
  Rows do not contain a language field; `manifest.ts` owns a pinned repo-to-
  language map derived from the official harness rather than guessing.
- `manifest.ts`: `selectManifest(rows, {seed, size}) → InstanceManifest` —
  deterministic seeded PRNG over sorted instance ids, language-stratified
  (bucket counts differ by at most one across the 9 languages). Committed
  output: `benchmarks/swebench/manifests/multilingual-30.json` with
  `{datasetRevision, seed, algorithmVersion, entries: [{instanceId, language,
repo, baseCommit}]}`. The pinned Python harness remains the authority for
  official image keys; TypeScript does not duplicate its naming rules.
- `config-override.ts`: `renderModelsJson({executorModel, advisorModel,
advisorEnabled}) → RoutingTable` — derives a complete table from
  `BUILT_IN_ROUTING_TABLE` and validates it with `validateRoutingTable`.
  It materializes four configs in two pairs: `glm-pure` /
  `glm-kimi-advisor`, using GLM-5.2/high with Kimi K3/high as the retained
  advisor target, and `kimi-pure` / `kimi-fable-advisor`, using Kimi K3/high
  with Fable/high. The pure configs retain the advisor definition but set
  `advisor.enabled=false`. Classifier, GLM's Kimi vision fallback, advisor
  cadence/transcript budget, and all other product policy are copied unchanged.
  Rollout commands omit `--memory-model`, preserving the product default.

## Seam

Pure functions over data; the fetch is isolated in its own module. The
manifest file path is the pairing contract: campaigns reference it by path
and never re-sample.

## Verification

- Unit (fixture rows, no network): same seed → byte-identical manifest; all
  9 languages represented, proportions within ±1; revision recorded; unknown
  tier throws.
- Config: the deep diff within each ON/OFF pair is exactly one boolean; all
  four pass `validateRoutingTable`; assertions prove executor and advisor
  targets are the only model substitutions and every other applicable policy
  equals the product default.

## Playable checkpoint

`bun benchmarks/swebench/cli.ts manifest show` prints the per-language table
of the 30 chosen instances; `... config show` prints all four files and the
one-line diff inside each comparison pair.

## What would change this slice

Gold-gate failures in slice 04 may force substituting instances — legal only
before any measurement runs, via a new seed and re-commit, never by hand-
editing entries.
