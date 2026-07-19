# 06 — Rollout pipeline, resumable orchestrator, predictions

Needs 02, 03, 05. The whole measurement machine, verified at n=2 before any
campaign money.

## Contract

- `prompt.ts`: `buildRolloutPrompt(entry) → string` — problem statement,
  "work in /testbed", do not modify tests, do not commit; adapted from
  mini-swe-agent's template (slice 04 notes). **Frozen input for campaign 1** —
  prompt tuning is out of scope.
- `rollout.ts`: `runRollout(deps, spec) → artifact dir`: container up →
  install duet + arm's models.json (slice 05 recipe) → `runDuetTurn` →
  extract patch (`patch.ts`) → write artifacts → teardown in `finally`.
  Auto-answer up to 2 `ask` terminals with a "proceed unattended" follow-up,
  then interrupt.
- `artifacts.ts`: layout
  `benchmarks/swebench/runs/<campaign>/<config>/<instanceId>-t<trial>/
{spec.json, events.ndjson, patch.diff, telemetry.json, status.json}`.
  `status.json` carries phase + `specHash`; final status atomically renamed
  into place; attempt dirs immutable.
- `orchestrator.ts`: `CampaignSpec` (committed file: manifest path, config
  ids, trials, concurrency, limits) → pending = manifest × configs × trials
  minus completed-with-matching-specHash; bounded concurrency (default 3);
  `--retry-failed`; stale `running` treated as crashed; **seeded interleaved
  ON/OFF schedule per instance** to neutralize provider drift. Stateless —
  kill anytime, rerun the same command.
- `predictions.ts`: artifact tree → predictions JSONL
  (`model_name_or_path` = config id, e.g. `duet-balanced-advisor-on`).

## Verification

- Unit (FakeContainer + scripted transport, temp artifact trees): call
  order; per-arm models.json content; artifact completeness on success AND
  failure (container still stopped); idempotent re-run plans zero work;
  crash-on-instance-3 simulation resumes exactly the remainder; specHash
  mismatch refuses to mix; concurrency respected.
- Live (box, ≤$5): 2 manifest instances (different languages) under
  advisor-ON — artifacts complete; `telemetry.json` cost equals terminal
  `usageByModel` sum; advisor cadence plausible against `minStepsBetween`;
  kill mid-campaign → resume skips the finished one; the 2 predictions score
  cleanly through the official harness (slice 04's proven invocation). One
  advisor-OFF rollout shows zero advisor tool calls in `events.ndjson`.
  Measured cost/duration feeds slice 07's limit recalibration.

## Playable checkpoint

`bun benchmarks/swebench/cli.ts rollout run --instance <id> --config
balanced-advisor-on`, watchable live over SSH; `campaign status` prints the
instance × config grid with cost so far.
