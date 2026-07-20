# 07 — Two-comparison report, 3-instance four-arm pilot, admission gate

**Progress (2026-07-20): ADMIT.** The semantically corrected three-language
pilot completed for $9.4612 and officially scored every admissible patch. Its
only STOP findings were one missed Kimi consultation and one patch containing
generated test fixtures; both are now machine-visible admission failures. A
targeted Rust compliance rerun then made exactly one successful intended
advisor call in each treated arm, kept both patches production-only, and
officially resolved both outcomes for another $1.9072. The old $1.25 pilot
cutoff is retired: the full campaign reserves a deliberately non-binding $4
emergency ceiling per rollout and a 30-minute wall. The original Mac production
spec reserved `$20 + 120 × $4 = $500`. After $0.7933 of valid v2 generation was
recorded before the E2B pivot, the final clean E2B campaign conservatively uses
`$21 + 120 × $3.99 = $499.80`. Both treatment comparisons are admitted to slice 08.

Needs 04 (scorer fixture) and 06. The report is built and verified against
existing artifacts first — zero new spend — then a small pilot produces the
exact final artifact at 1/10 scale and decides ADMIT/STOP.

## Contract

- `swebench-report.ts`: `parseSwebenchReport(json) → {resolvedIds,
unresolvedIds, errorIds, emptyPatchIds}` — the narrow quarantine around the
  official harness's output schema, fixture-tested against slice 04's real
  capture.
- `report.ts`: pure over artifact trees + parsed scores → `report.md` (and
  `report.json` for machine checks): per-config resolve rate; **a paired
  per-instance table for each comparison with discordant pairs highlighted**
  (advisor-only wins vs pure-only wins — the honest n=30 statistic); cost/task
  total and actor-only (memory-observer split via `usageByModel`); advisor call
  distributions and a zero-advisor **assertion** for both pure arms — a
  failure, not a stat, if violated; router-switch histogram per arm;
  per-language breakdown; patch
  lint (test-file edits, `.duet/` leakage, empty/oversized); failure
  taxonomy with infra failures separated and never dropped from
  denominators.
- Pilot: sub-manifest of 3 instances (3 languages, drawn from the 30 by the
  same selector, seed recorded) × four arms × 1 trial in seeded instance-block
  order → score every arm → both comparison reports.

## Verification

- Unit on synthetic four-config fixture trees: paired math for both comparisons (hand-computed
  discordant count), zero-advisor assertion fires on a poisoned fixture,
  markdown golden snapshot.
- Pilot gates (≤$30): twelve complete artifact bundles + twelve official
  outcomes; zero patch-application/config/unrecovered-infra failures; cost
  reconciliation holds per rollout; both pure arms advisor-silent end-to-end;
  resource headroom held. Record the observed advisor call rate for both
  advisor targets — if either is near zero, flag that comparison as likely
  inconclusive **before** spending.
- **Recalibrate `RolloutLimits`** from pilot cost/duration; conservative
  projection (max pilot rollout cost × 120 + sunk spend) must fit the $500
  envelope, with the per-rollout reserve included before each launch.

## Playable checkpoint

The pilot `report.md` — the same artifact the campaign will produce — plus an
explicit `ADMIT` or `STOP` line with the projection arithmetic.

## STOP conditions

Any attribution/config/patch-integrity failure, projection above $500, unstable
container lifecycle, or an advisor call rate so low the corresponding
comparison cannot move. STOP loops back to the owning slice; it does not
proceed to 08.
