# 06 — Rollout pipeline, resumable orchestrator, predictions

**Status (2026-07-20): locally complete, live gate pending.** The container
rollout, immutable filesystem attempts, spec-hash resume checks, reserve-first
$500 breaker, deterministic arm order, official predictions/scoring path, and
paired report core are implemented and fixture-tested. The required two-instance
four-arm live run and kill/resume exercise remain before this slice is complete.

Needs 02, 03, 05. The whole measurement machine, verified at n=2 before any
campaign money.

## Contract

- `prompt.ts`: `buildRolloutPrompt(entry) → string` — problem statement,
  "work in /testbed", do not modify tests, do not commit, and one controlled
  advisor consultation when the tool is available; adapted from
  mini-swe-agent's template (slice 04 notes). The exact prompt hash is frozen
  within each campaign id; changing it after a STOP requires a new id.
- `rollout.ts`: `runRollout(deps, spec) → artifact dir`: container up →
  install duet + arm's models.json (slice 05 recipe) → `runDuetTurn` →
  extract patch (`patch.ts`) → write artifacts → teardown in `finally`.
  An unexpected `ask` terminal is an unresolved agent outcome; the frozen
  prompt tells the agent to proceed unattended instead of asking questions.
- `artifacts.ts`: layout
  `benchmarks/swebench/runs/<campaign>/<config>/<instanceId>-t<trial>/
{spec.json, events.ndjson, patch.diff, telemetry.json, status.json}`.
  `status.json` carries phase + `specHash`; final status atomically renamed
  into place; attempt dirs immutable.
- `orchestrator.ts`: `CampaignSpec` (committed file: manifest path, virtual
  tier, config ids, trials, concurrency, limits) →
  pending = manifest × four configs × trials
  minus completed-with-matching-specHash; bounded concurrency (default 1 on
  this Mac); `--retry-failed`; stale `running` treated as crashed; **seeded arm
  order inside each instance block** to neutralize provider drift. Once an
  instance's four arms are scored, cleanup may remove only benchmark-owned
  instance images. Stateless — kill anytime, rerun the same command.
- `predictions.ts`: artifact tree → predictions JSONL
  (`model_name_or_path` = config id, e.g. `duet-glm-kimi-advisor`).

## Verification

- Unit (FakeContainer + scripted transport, temp artifact trees): call
  order; per-arm models.json content; artifact completeness on success AND
  failure (container still stopped); idempotent re-run plans zero work;
  crash-on-instance-3 simulation resumes exactly the remainder; specHash
  mismatch refuses to mix; concurrency respected.
- Live (Mac, ≤$10): 2 manifest instances (different languages) across all four
  arms — artifacts complete; `telemetry.json` cost equals terminal
  `usageByModel` sum; advisor cadence plausible against `minStepsBetween`;
  kill mid-campaign → resume skips finished work; all 8 predictions score
  cleanly through the official harness (slice 04's proven invocation). Both
  advisor-OFF configs show zero advisor tool calls in `events.ndjson`.
  Measured cost/duration feeds slice 07's limit recalibration.
  The emitted turn state records the product-default memory model actually
  resolved for provenance.

## Playable checkpoint

`bun benchmarks/swebench/cli.ts rollout run --instance <id> --config
glm-kimi-advisor`, watchable locally; `campaign status` prints the
instance × config grid with cost so far.
