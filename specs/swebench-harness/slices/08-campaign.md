# 08 — The measurement campaign: two advisor comparisons, 30×4 (LAST)

Needs slice 07's explicit ADMIT. The deliverable.

## Contract

- `campaign run` on `manifests/multilingual-30.json`, configs `glm-pure`,
  `glm-kimi-advisor`, `kimi-pure`, and `kimi-fable-advisor`, explicit virtual
  tiers, product-default memory model, 1 trial, limits from the pilot
  recalibration, seeded per-instance arm order, Mac-local concurrency 1 unless
  the capacity gate proves a higher safe value.
- `campaign.json` records duet git SHA + binary sha256, all four render
  contents, manifest hash, dataset revision, `swebench` version, limits, and
  dates — the run is self-describing.
- Score all four arms with the official harness; `report.md` + `report.json`
  published; per-instance `telemetry.json` summaries committed; bulky
  `events.ndjson` archived locally as a tarball with its path + hash in
  `campaign.json` (not in git).

## Verification

- Exactly 120 scheduled rollouts; retries only for missing/failed infra
  attempts (never cherry-picking completed outcomes); campaign breaker keeps
  cumulative model spend inside the envelope.
- Report cross-foots: 30 paired rows for each of the two comparisons, cost
  totals equal summed telemetry, both pure arms have zero advisor calls, and
  hashes match across all runs.
- Agent timeouts and spend caps count as unresolved; unrecovered infra
  failures mark the report invalid rather than being excluded.
- The report states plainly that n=30 × 1 trial is signal-seeking, not a
  leaderboard estimate, and leads with discordant pairs.

## Playable checkpoint

`report.md`: two resolve deltas, two sets of discordant pairs, cost deltas
(actor-split), advisor behavior, router switches, per-language tables,
failures, and provenance.

## After this slice

Close the spec (close-spec): fold divergences and measured results into the
record; the harness remains live product surface under `benchmarks/swebench/`
for future campaigns (economy vs balanced, frontier ceiling, trials>1 — all
expressible as new committed CampaignSpec files with zero orchestration
changes).
