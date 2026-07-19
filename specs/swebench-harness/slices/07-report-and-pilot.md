# 07 — Comparison report, 3-instance paired pilot, admission gate

Needs 04 (scorer fixture) and 06. The report is built and verified against
existing artifacts first — zero new spend — then a small pilot produces the
exact final artifact at 1/10 scale and decides ADMIT/STOP.

## Contract

- `swebench-report.ts`: `parseSwebenchReport(json) → {resolvedIds,
unresolvedIds, errorIds, emptyPatchIds}` — the narrow quarantine around the
  official harness's output schema, fixture-tested against slice 04's real
  capture.
- `report.ts`: pure over artifact trees + parsed scores → `report.md` (and
  `report.json` for machine checks): per-config resolve rate; **paired
  per-instance table with discordant pairs highlighted** (ON-only wins vs
  OFF-only wins — the honest n=30 statistic); cost/task total and actor-only
  (memory-observer split via `usageByModel`); advisor call distribution (ON)
  and a zero-advisor **assertion** (OFF — a failure, not a stat, if
  violated); router-switch histogram per arm; per-language breakdown; patch
  lint (test-file edits, `.duet/` leakage, empty/oversized); failure
  taxonomy with infra failures separated and never dropped from
  denominators.
- Pilot: sub-manifest of 3 instances (3 languages, drawn from the 30 by the
  same selector, seed recorded) × ON/OFF × 1 trial in seeded paired order →
  score both arms → report.

## Verification

- Unit on synthetic two-config fixture trees: paired math (hand-computed
  discordant count), zero-advisor assertion fires on a poisoned fixture,
  markdown golden snapshot.
- Pilot gates (≤$10): six complete artifact bundles + six official
  outcomes; zero patch-application/config/unrecovered-infra failures; cost
  reconciliation holds per rollout; OFF arm advisor-silent end-to-end;
  resource headroom held. Record the observed advisor call rate on the ON
  arm — if it is near zero, flag that campaign 1 may be inconclusive on the
  advisor question **before** spending.
- **Recalibrate `RolloutLimits`** from pilot cost/duration; conservative
  projection (max pilot rollout cost × 60 + sunk spend + box cost) must fit
  the $100 envelope.

## Playable checkpoint

The pilot `report.md` — the same artifact the campaign will produce — plus an
explicit `ADMIT` or `STOP` line with the projection arithmetic.

## STOP conditions

Any attribution/config/patch failure, projection above $100, unstable
container lifecycle, or an advisor call rate so low the comparison cannot
move. STOP loops back to the owning slice; it does not proceed to 08.
