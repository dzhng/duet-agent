# SWE-bench Multilingual harness

Measure duet-agent's router-tier and `ask_advisor` deltas on SWE-bench
Multilingual with the official evaluation harness — Anthropic's
[advisor-strategy post](https://claude.com/blog/the-advisor-strategy)
methodology at signal scale, not leaderboard scale. Anthropic published the
numbers (Sonnet 4.6: 72.1% → 74.8% with an Opus advisor, −11.9% cost/task) but
not the scaffold; this spec builds our own scaffold so the numbers we get are
about _our_ harness.

## Next Agent Prompt

**Status:** slices 01–07 are complete. The paid three-language pilot and targeted
advisor-compliance rerun admitted both comparisons. Slice 08's first Mac-local
campaign was superseded after measuring one-worker throughput; the final clean
campaign runs one four-arm instance block per E2B sandbox with sixteen sandboxes
in flight. Each arm still runs in its own fresh official SWE-bench Docker
container, and the official scorer remains authoritative. The first E2B
admission block passed rollout and scoring but exposed per-sandbox binary
nondeterminism before expansion. Build the immutable E2B template with its
single precompiled Duet artifact and pinned dataset cache, pass the no-model
capacity probe, then run the committed
`multilingual-30-four-arm-e2b-v4.json` campaign. The v2 admission was stopped
because provider credentials appeared in Docker process arguments; v3 proved
that boundary fixed, then stopped because Kimi skipped its required Fable
consultation. V4 makes the normal optional-advisor guidance yield to the
benchmark's stricter exactly-once rule. V1–v3 remain admission evidence only
and must not enter the final estimate.
Last updated 2026-07-20.

You are implementing this spec. Read this README fully, then continue the E2B
campaign in [slice 08](slices/08-campaign.md). Preserve Mac-local pilot artifacts
as historical evidence; never mix them into the E2B campaign namespace.

Local constraints to prove rather than assume:

- The Mac-local path remains the scorer and fallback execution path. Its Docker
  VM admitted only one rollout worker. Final generation uses a commit-derived
  E2B x86_64 template with Docker-in-sandbox, 8 vCPU and 16 GiB per worker. A
  no-model probe must prove the exact commit, resources, Docker daemon, Python,
  and pinned SWE-bench version before any rollout starts.
- Every worker uses the byte-identical Duet binary compiled once into the
  immutable E2B template. Workers never compile their own campaign artifact or
  fetch the pinned dataset snapshot at launch.
- A Vercel AI Gateway credential is present in the project `.env`. The harness
  enforces a $500 cumulative model-spend breaker, but that local breaker is not
  a substitute for an external provider-side hard cap.

Global TODO (owner slice in parens):

- [x] RPC loads project routing table and exits cleanly; advisor+classifier
      usage metered; tool details forwarded; live provider smoke passes (01)
- [x] Committed 30-instance manifest + all four routing-table renders (02)
- [x] duet-client (RPC transport + limits) + telemetry derivation, fixture-tested (03)
- [x] Mac environment captured; x86 capacity, gold 30/30, and mini-swe-agent
      2/2 replication gates green; scorer fixtures captured (04)
- [x] Duet packaged into instance containers; 9-language smoke; patch
      round-trip integrity (05)
- [x] Rollout pipeline + resumable campaign orchestrator + predictions; paid
      live verification and resume semantics complete (06)
- [x] Two-comparison report; 3-instance four-arm pilot; limits recalibrated;
      both comparisons admitted after targeted compliance proof (07)
- [ ] 30×4 campaign + two paired comparisons in the final report (08)

Update this section before ending every pass.

## Decisions (user-settled — do not relitigate)

The [choices ledger](choices.md) records the prerequisite decisions and their
rationale.

- **Dataset:** `SWE-bench/SWE-bench_Multilingual` (300 instances, 9
  languages). Official scorer only: `python -m swebench.harness.run_evaluation`.
- **Infra:** the Mac runs official scoring and remains the one-worker fallback.
  The final generation campaign uses sixteen independent E2B x86_64 sandboxes;
  each sandbox processes one instance's four arms sequentially and each arm
  remains a fresh nested official Docker container. Cleanup targets only
  benchmark-owned sandboxes, images, and containers.
- **Replication spike first:** mini-swe-agent proves images+scoring end-to-end
  before duet is wired in (slice 04).
- **First campaign:** four arms over one fixed 30-instance subset, 1 trial per
  arm, reported as two paired comparisons: pure GLM-5.2 vs GLM-5.2 with Kimi K3
  advisor, and pure Kimi K3 vs Kimi K3 with Fable advisor. “Pure” means the
  advisor tool is disabled; product-default memory still runs. Every complete
  render derives classifier, memory, cadence, and transcript policy from the
  built-in table. The campaign fixes the executor and advisor targets and uses
  Kimi K3 as its vision fallback, including for the text-only GLM executor.
  Within each pair ON/OFF differs only in `advisor.enabled`. The shared model-
  spend envelope is **$500**, including prerequisite live smoke and pilots.
  Economy-vs-balanced, frontier ceiling, and trials>1 remain future campaigns.
- Greenfield tooling: no backward compat, no migrations.

## Architecture

Code home: **`benchmarks/swebench/`** (follows the `benchmarks/longmemeval/`
precedent). It owns its TypeScript tests, Mac Python tests, Docker test runner,
E2B template/driver, orchestration, fixtures, and campaign inputs. The root
`test/` directory is product-only. Python exists in the pinned Mac and E2B
environments. Spec home:
`specs/swebench-harness/`.

Single-owner concepts (refactor-clean invariants — every slice must preserve
these ownerships; no parallel abstractions):

| Concept                                       | Owner module (under `benchmarks/swebench/src/`)                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instance manifest (the pairing contract)      | `manifest.ts` — seeded, language-stratified, dataset-revision-pinned; materialized as a committed JSON file every campaign references by path                                               |
| Routing-table renders (two one-boolean pairs) | `config-override.ts` — derives complete tables from product defaults, installs the fixed Kimi vision fallback plus executor/advisor targets, and validates them with `validateRoutingTable` |
| Duet invocation + limit enforcement           | `duet-client.ts` — RPC NDJSON over an injected `ExecTransport`; the only module that speaks the wire protocol                                                                               |
| Container execution                           | `container.ts` — injected `Cmd` (production: local `docker` CLI); the only module that constructs docker argv                                                                               |
| Duet-into-container packaging                 | `packaging.ts` — compile-vs-tarball decision confined here                                                                                                                                  |
| Rollout telemetry                             | `telemetry.ts` — pure `deriveTelemetry(TurnEvent[])`; raw `events.ndjson` is ground truth, every number re-derivable                                                                        |
| Run artifact + resumability                   | `artifacts.ts` — filesystem is the state; `status.json` + `specHash`; orchestrator holds no state of its own                                                                                |
| Patch extraction + integrity                  | `patch.ts` — staged-index extraction, round-trip verification, pollution scan                                                                                                               |
| Predictions + scorer quarantine               | `predictions.ts` + `mac/score.sh` + `swebench-report.ts` (narrow parser); nothing else reads harness output                                                                                 |
| Comparison report                             | `report.ts` — pure over artifact trees + parsed scores                                                                                                                                      |

Cross-cutting rules:

- **Protocol types are imported, never redeclared.** `benchmarks/swebench`
  depends on `src/types/protocol.ts` and `src/model-routing/table.ts`; product
  drift breaks the bench at compile time, not midway through a local campaign.
- **Only `container.ts` and `duet-client.ts` touch a process boundary.**
  Everything else is pure data → unit-testable from committed fixtures with no
  Docker and no live model.
- **Duet runs inside each instance container** as a standalone Linux binary at
  `/opt/duet`, with a fresh per-rollout `HOME` outside `/testbed`. Rationale:
  duet's bash AND file tools are host-process-bound
  (`createLocalBashOperations` in `src/turn-runner/tools.ts` — no executor
  seam), so the only place all tools see both `/testbed` and the pinned
  language toolchain is inside the container. Rejected: (b) host-side duet
  with bash proxied via `docker exec` — file tools would still hit the wrong
  filesystem; (c) sidecar — lacks the language toolchains.
- **All four arms get an explicit rendered `models.json`** (OFF is not
  “absence of override”), placed in the container `HOME`'s `.duet/`. The GLM
  pair uses a GLM-5.2 executor and Kimi K3 advisor; the Kimi pair uses a Kimi K3
  executor and Fable advisor. Classifier, memory, cadence, and transcript are
  copied unchanged from product policy; Kimi K3 is the fixed campaign vision
  fallback. Files within a pair differ in exactly the advisor-enabled boolean
  and never enter `/testbed`.
- **The official scorer is invoked, never ported or approximated.**
- **E2B is an outer capacity layer, not a replacement harness.** A worker
  receives only gateway credentials, the stable environment lock, and any
  matching resume artifacts. The host E2B credential is never forwarded. The
  worker returns only its instance's immutable artifact subtree.

## Slice graph

```
01 product: RPC config + telemetry (src/, Mac)
02 manifest + config renders (local, pure)
03 duet-client + telemetry derivation (local; final asserts need 01)
04 Mac preflight + x86 gold gate + mini-swe-agent spike (needs 02 manifest)
05 duet-in-container packaging + smoke + patch integrity (needs 03, 04)
06 rollout pipeline + resume + predictions (needs 02, 03, 05)
07 report + 3-instance pilot + admission gate (needs 04 fixture, 06)
08 30×4 campaign + two-comparison final report (LAST; needs 07 ADMIT)

01 ──► 03 ──┬──► 05 ──► 06 ──► 07 ──► 08
02 ──┬──────┘         ▲       ▲
     └──► 04 ─────────┴───────┘ (images, scorer fixture)
```

Parallel lanes: {01, 02} immediately; 03 and 04 concurrently after their
parents; 05+ serial on the Mac. Live-model spend before slice 07 is small. The
30-instance four-arm campaign is the last slice, gated by an explicit ADMIT
decision.

Slice plans: [01](slices/01-rpc-config-and-telemetry.md),
[02](slices/02-manifest-and-configs.md),
[03](slices/03-duet-client-and-telemetry.md),
[04](slices/04-box-gold-gate-and-spike.md),
[05](slices/05-duet-in-container.md),
[06](slices/06-rollout-pipeline-and-resume.md),
[07](slices/07-report-and-pilot.md), and [08](slices/08-campaign.md).

## Limits (initial; slice 07 pilot recalibrates before the campaign)

Per-rollout wall-clock, model-spend, and patch-size limits are explicit campaign
inputs enforced at the duet-client seam. There is no assistant-step limit: step
counts are a poor proxy for time, spend, or useful work. Slice 07 calibrates the
time and spend values from the pilot. On breach the client sends RPC
`interrupt`, waits a bounded grace, then kills the process; partial patches are
still extracted. A campaign breaker reserves the configured per-rollout cap
before starting another rollout and stops before cumulative model spend can
knowingly exceed $500.

## Firewalls & invariants

- Pairing validity: one committed manifest, one committed prompt template
  (`prompt.ts` — frozen by hash within a campaign id; a STOP requires a new id),
  one duet binary hash, explicit renders for all four arms, seeded per-instance
  arm order, and explicit benchmark-tier invocations. Within each comparison
  the only varying bit is `advisor.enabled`. All arms use product defaults for
  classifier, memory model, and every non-advisor policy, plus the same fixed
  Kimi vision fallback.
- Isolation: fresh official image + fresh `HOME` per rollout; `--incognito`
  (no memory-db carryover), `--no-system-prompt-files` (no stray AGENTS.md in
  target repos). Scoring applies the patch in the harness's own pristine
  container.
- Contamination: runtime files, config, credentials, and logs live outside
  `/testbed`; the report's patch-lint flags test-file edits, `.duet/` paths,
  empty and oversized patches. Failures are artifacts, never dropped from
  denominators; infra failures are separated from agent timeouts and mark the
  campaign invalid if unrecovered.
- Security: credentials are passed per exec, never baked into images or
  artifacts, and no Docker socket is mounted into instance containers.
- Version pinning: `swebench` venv version, dataset revision, duet commit +
  binary sha256, all four renders, manifest hash — all recorded in the campaign's
  `campaign.json` so every run is self-describing.
- Scope firewall: economy/frontier campaigns, trials>1, HTML dashboards,
  prompt tuning, and any duet-core executor seam are out of scope. Slice 01's
  product changes are generic RPC/config/accounting corrections, not
  bench-specific policy.

## Known unknowns (owner slice)

- Official x86_64 Multilingual image compatibility and peak disk/RAM under
  Apple-Silicon emulation (04).
- `bun build --compile` viability for duet (dynamic imports, sqlite); musl
  images; CA bundles for gateway egress (05).
- Real per-rollout cost/duration across both pairs → final limits (07).
- Advisor call frequency for both advisor targets on real SWE tasks — too low a
  rate makes the corresponding comparison inconclusive; the pilot reports it
  before the campaign spends (07).
- n=30, 1 trial is signal-seeking, not leaderboard-stable; the report states
  this and leads with discordant pairs, not the raw delta (07/08).

## Dead ends (recorded so nobody re-walks them)

- **sb-cli cloud scoring** — supports only `swe-bench-m`/`lite`/`verified`;
  no Multilingual. The official scorer runs locally on this Mac.
- **Host-side duet with a bash proxy into the container** — bash, read,
  write, and edit are all host-FS-bound in `src/turn-runner/tools.ts`; a
  proxy splits bash's filesystem view from the file tools'. Rejected.
- **Advisor-OFF as "no override file"** — unpinned: built-in-table drift
  would silently change the control arm. Both arms are explicit renders.
- **Trusting pre-slice-01 terminal cost as-is** — advisor and classifier
  completions were not both attributed to the turn, so terminal cost
  undercounted exactly the arm under test. Slice 01 fixes the generic
  accounting boundary; the bench consumes that protocol instead of
  reconstructing provider cost.
- **Resetting official images to a clean Git `HEAD`** — some images deliberately
  modify build files to make their pinned toolchain work. Patch extraction
  snapshots that starting tree and submits only the agent's later delta.

## References

- Anthropic advisor strategy post: https://claude.com/blog/the-advisor-strategy
  (methodology footnotes: 5×300 trials, suggested coding system prompt,
  thinking off for advisor arms) and advisor tool docs:
  https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool
- SWE-bench harness: https://github.com/swe-bench/SWE-bench — quickstart,
  docker setup (x86_64, ~120GB, gold `--predictions_path gold`).
- mini-swe-agent SWE-bench runner: https://mini-swe-agent.com/latest/usage/swebench/
  (`mini-extra swebench --subset multilingual --split test -m <litellm-model>`).
- Product seams this spec binds to: `src/cli/rpc.ts`, `src/types/protocol.ts`,
  `src/model-routing/table.ts` (`advisor.enabled`), `src/model-routing/loader.ts`
  (models.json discovery), `src/turn-runner/tools.ts` (`ask_advisor` details,
  host-bound tools), `benchmarks/longmemeval/` (benchmark precedent).
