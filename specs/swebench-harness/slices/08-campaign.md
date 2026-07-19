# 08 — The measurement campaign: GLM/Kimi advisor-ON vs OFF, 30×2 (LAST)

Needs slice 07's explicit ADMIT. The deliverable.

## Contract

- `campaign run` on `manifests/multilingual-30.json`, configs
  `glm-kimi-advisor-on` / `glm-kimi-advisor-off`, explicit virtual tier
  `swebench-glm-kimi`, product-default memory model, 1 trial, limits from the
  pilot recalibration, seeded interleaved schedule, concurrency per pilot
  decision (≤3), box-local under tmux.
- `campaign.json` records duet git SHA + binary sha256, both render
  contents, manifest hash, dataset revision, `swebench` version, limits, and
  dates — the run is self-describing.
- Score both arms with the official harness; `report.md` + `report.json`
  published; per-instance `telemetry.json` summaries committed; bulky
  `events.ndjson` archived as a tarball on the box with its path + hash in
  `campaign.json` (not in git).

## Verification

- Exactly 60 scheduled rollouts; retries only for missing/failed infra
  attempts (never cherry-picking completed outcomes); campaign breaker keeps
  cumulative spend + box cost inside the envelope.
- Report cross-foots: 30 paired rows, cost totals equal summed telemetry,
  OFF arm zero advisor calls, matching hashes across all runs.
- Agent timeouts and spend caps count as unresolved; unrecovered infra
  failures mark the report invalid rather than being excluded.
- The report states plainly that n=30 × 1 trial is signal-seeking, not a
  leaderboard estimate, and leads with discordant pairs.

## Playable checkpoint

`report.md`: resolve delta, discordant pairs, cost delta (actor-split),
advisor behavior, router switches, per-language table, failures, provenance.

## After this slice

Close the spec (close-spec): fold divergences and measured results into the
record; the harness remains live product surface under `benchmarks/swebench/`
for future campaigns (economy vs balanced, frontier ceiling, trials>1 — all
expressible as new committed CampaignSpec files with zero orchestration
changes).
