# 08 — The measurement campaign: two advisor comparisons, 30×4 (LAST)

**Status (2026-07-20): in progress on E2B.** The Mac-local v1 failed before
model work on RPC-envelope drift and is preserved; v2 produced two valid Druid
arms for $0.7933 before being intentionally stopped when the user supplied E2B
capacity. Neither namespace contributes outcomes to the final E2B campaign.
The first E2B namespace completed and officially scored a four-arm Druid
admission block for $1.4304, then refused expansion because independently
compiled worker binaries had different hashes. Those results remain admission
evidence. A v2 security admission was stopped during its first arm after its
Docker process arguments exposed a provider credential; no v2 outcome is used.
The v3 admission then completed all four arms, but Kimi skipped its mandatory
Fable consultation because later general advisor guidance said routine work
could skip advice. Those v3 outcomes remain admission evidence only. The clean
final E2B v4 namespace makes general guidance yield explicitly to stricter
workflow rules, uses one template-built binary, and passes provider values
through process environments rather than command arguments.

Needs slice 07's explicit ADMIT. The deliverable.

## Contract

- `e2b/run.ts` launches `campaign run` on `manifests/multilingual-30.json`,
  configs `glm-pure`,
  `glm-kimi-advisor`, `kimi-pure`, and `kimi-fable-advisor`, explicit virtual
  tiers, product-default memory model, 1 trial, limits from the pilot
  recalibration, and seeded per-instance arm order. Sixteen E2B sandboxes process
  disjoint instance blocks concurrently; each sandbox keeps local campaign
  concurrency at one and runs the four arms sequentially in fresh nested
  official Docker containers.
- The immutable E2B template name derives from the pushed duet commit. It pins
  Bun 1.3.11, SWE-bench 4.1.0, mini-swe-agent 2.4.5, Docker, the repository SHA,
  one precompiled Duet binary, one pinned dataset cache, 8 vCPU, and 16 GiB
  RAM. A no-model capacity probe writes one stable
  `environment.lock.json` shared byte-for-byte across workers and rejects any
  mismatch before generation.
- E2B workers receive supported model-gateway credentials only, never the E2B
  control key. Each worker downloads only resume artifacts for its instance and
  uploads only that instance subtree. The driver kills only sandboxes it owns;
  unrelated E2B resources are out of scope.
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
  cumulative model spend inside the envelope. The clean v4 committed bound is
  `$27.64 sunk + 120 × $3.93 = $499.24`; E2B compute charges are separate from
  model-gateway spend.
- A pre-model gate proves two fresh workers hash the same template-built Duet
  artifact. Sandbox creation and pinned dataset download retry only transient
  infrastructure failures; neither retry can issue a model request.
- The E2B capacity record proves exact commit, x86_64 architecture, CPU, RAM,
  Docker client/server, Python, and SWE-bench versions before the first model
  call. Returned archives reject absolute paths, traversal, and files outside
  the requested instance subtree.
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
