# SWE-bench Multilingual harness

Measure duet-agent's router-tier and `ask_advisor` deltas on SWE-bench
Multilingual with the official evaluation harness — Anthropic's
[advisor-strategy post](https://claude.com/blog/the-advisor-strategy)
methodology at signal scale, not leaderboard scale. Anthropic published the
numbers (Sonnet 4.6: 72.1% → 74.8% with an Opus advisor, −11.9% cost/task) but
not the scaffold; this spec builds our own scaffold so the numbers we get are
about _our_ harness.

## Next Agent Prompt

**Status:** planned, no slices started. Last updated 2026-07-19.

You are implementing this spec. Read this README fully, then start at
[slice 01](slices/01-rpc-config-and-telemetry.md) — it is pure product work in
`src/` (no cloud box needed) and everything measurement-shaped depends on it.
Slice 02 (manifest + configs, local) may proceed in parallel with 01; slice 04
(box provision) can start as soon as David has rented the box (see Blockers).
Follow the dependency graph below; never spend campaign-scale money before the
slice 07 admission gate says ADMIT.

Blockers / user-owned inputs:

- **x86_64 Linux box** (≥8 cores, 16GB RAM, ≥150GB disk; Hetzner/EC2 class).
  David rents it; slice 04 provisions it. Until then, slices 01–03 proceed.
- **A revocable, budget-capped gateway key** for the box (`AI_GATEWAY_API_KEY`).
  Never copy personal `~/.duet/.env` credentials to the box.

Global TODO (owner slice in parens):

- [ ] RPC loads project routing table; advisor+classifier usage metered; tool
      details forwarded (01)
- [ ] Committed 30-instance manifest + both routing-table renders (02)
- [ ] duet-client (RPC transport + limits) + telemetry derivation, fixture-tested (03)
- [ ] Box provisioned; gold gate 30/30; mini-swe-agent replication; scorer
      fixture captured (04)
- [ ] Duet packaged into instance containers; 9-language smoke; patch
      round-trip integrity (05)
- [ ] Rollout pipeline + resumable campaign orchestrator + predictions,
      verified at n=2 (06)
- [ ] Comparison report; 3-instance paired pilot; limits recalibrated;
      ADMIT/STOP decision (07)
- [ ] 30×2 paired campaign + final report (08)

Update this section before ending every pass.

## Decisions (user-settled — do not relitigate)

- **Dataset:** `princeton-nlp/SWE-bench_Multilingual` (300 instances, 9
  languages). Official scorer only: `python -m swebench.harness.run_evaluation`.
- **Infra:** rented x86_64 Linux box runs rollouts AND scoring, campaign
  executes box-local under tmux; the Mac only SSHes in to watch. Local Mac
  Docker is not used for the campaign.
- **Replication spike first:** mini-swe-agent proves images+scoring end-to-end
  before duet is wired in (slice 04).
- **First campaign:** balanced tier advisor-ON vs advisor-OFF, one fixed
  30-instance subset, 1 trial per config, paired. Budget envelope **$50–100**
  total including box rent. Economy-vs-balanced, frontier ceiling, and
  trials>1 are future campaigns the seams must accommodate but this build
  does not run.
- Greenfield tooling: no backward compat, no migrations.

## Architecture

Code home: **`benchmarks/swebench/`** (follows the `benchmarks/longmemeval/`
precedent). TypeScript/bun orchestration; python exists only as the pinned
`swebench` venv the provision script installs on the box. Spec home:
`specs/swebench-harness/`.

Single-owner concepts (refactor-clean invariants — every slice must preserve
these ownerships; no parallel abstractions):

| Concept                                      | Owner module (under `benchmarks/swebench/src/`)                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instance manifest (the pairing contract)     | `manifest.ts` — seeded, language-stratified, dataset-revision-pinned; materialized as a committed JSON file every campaign references by path           |
| Routing-table renders (the one-boolean arms) | `config-override.ts` — imports `BUILT_IN_ROUTING_TABLE` + `validateRoutingTable` from `src/model-routing/table.ts`; never hand-copies routing knowledge |
| Duet invocation + limit enforcement          | `duet-client.ts` — RPC NDJSON over an injected `ExecTransport`; the only module that speaks the wire protocol                                           |
| Container execution                          | `container.ts` — injected `Cmd` (production: local `docker` CLI); the only module that constructs docker argv                                           |
| Duet-into-container packaging                | `packaging.ts` — compile-vs-tarball decision confined here                                                                                              |
| Rollout telemetry                            | `telemetry.ts` — pure `deriveTelemetry(TurnEvent[])`; raw `events.ndjson` is ground truth, every number re-derivable                                    |
| Run artifact + resumability                  | `artifacts.ts` — filesystem is the state; `status.json` + `specHash`; orchestrator holds no state of its own                                            |
| Patch extraction + integrity                 | `patch.ts` — staged-index extraction, round-trip verification, pollution scan                                                                           |
| Predictions + scorer quarantine              | `predictions.ts` + `box/score.sh` + `swebench-report.ts` (narrow parser); nothing else reads harness output                                             |
| Comparison report                            | `report.ts` — pure over artifact trees + parsed scores                                                                                                  |

Cross-cutting rules:

- **Protocol types are imported, never redeclared.** `benchmarks/swebench`
  depends on `src/types/protocol.ts` and `src/model-routing/table.ts`; product
  drift breaks the bench at compile time, not at 2am on the box.
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
- **Both arms get an explicit rendered `models.json`** (ON is not "absence of
  override"), placed in the container `HOME`'s `.duet/`, differing in exactly
  one boolean: `tiers.balanced.advisor.enabled`. It can never appear in the
  measured patch because it never enters `/testbed`.
- **The official scorer is invoked, never ported or approximated.**

## Slice graph

```
01 product: RPC config + telemetry (src/, Mac)
02 manifest + config renders (local, pure)
03 duet-client + telemetry derivation (local; final asserts need 01)
04 box provision + gold gate + mini-swe-agent spike (box; needs 02 manifest)
05 duet-in-container packaging + smoke + patch integrity (box; needs 03, 04)
06 rollout pipeline + resume + predictions (needs 02, 03, 05)
07 report + 3-instance pilot + admission gate (needs 04 fixture, 06)
08 30×2 campaign + final report (LAST; needs 07 ADMIT)

01 ──► 03 ──┬──► 05 ──► 06 ──► 07 ──► 08
02 ──┬──────┘         ▲       ▲
     └──► 04 ─────────┴───────┘ (images, scorer fixture)
```

Parallel lanes: {01, 02} immediately; 03 and 04 concurrently after their
parents; 05+ serial on the box. Live-model spend before slice 07: a few
dollars. The 30-instance campaign is the last slice, gated by an explicit
ADMIT decision.

## Limits (initial; slice 07 pilot recalibrates before the campaign)

Per rollout: 20 min wall clock, 60 parent assistant steps, $1.50 model spend,
5 MiB patch — enforced at the duet-client seam from the event stream (RPC
`interrupt`, 90 s grace, then kill; partial patch still extracted). Campaign
breaker: stop launching rollouts once cumulative spend + box cost approaches
the envelope. 60 rollouts × $1.50 caps bound worst-case inside $50–100.

## Firewalls & invariants

- Pairing validity: one committed manifest, one committed prompt template
  (`prompt.ts` — frozen input for campaign 1; prompt tuning is out of scope),
  one duet binary hash, explicit renders for both arms, seeded interleaved
  ON/OFF schedule per instance. The only varying bit is `advisor.enabled`.
- Isolation: fresh official image + fresh `HOME` per rollout; `--incognito`
  (no memory-db carryover), `--no-system-prompt-files` (no stray AGENTS.md in
  target repos). Scoring applies the patch in the harness's own pristine
  container.
- Contamination: runtime files, config, credentials, and logs live outside
  `/testbed`; the report's patch-lint flags test-file edits, `.duet/` paths,
  empty and oversized patches. Failures are artifacts, never dropped from
  denominators; infra failures are separated from agent timeouts and mark the
  campaign invalid if unrecovered.
- Security: the box holds only a revocable budget-capped gateway key; no Mac
  SSH keys, no cloud credentials, no Docker socket mounted into instance
  containers.
- Version pinning: `swebench` venv version, dataset revision, duet commit +
  binary sha256, both renders, manifest hash — all recorded in the campaign's
  `campaign.json` so every run is self-describing.
- Scope firewall: economy/frontier campaigns, trials>1, HTML dashboards,
  prompt tuning, and any duet-core executor seam are out of scope. Slice 01's
  product changes are generic RPC/config/accounting corrections, not
  bench-specific policy.

## Known unknowns (owner slice)

- Prebuilt x86_64 Multilingual instance images: pullable vs built locally;
  disk/time cost (04).
- `bun build --compile` viability for duet (dynamic imports, sqlite); musl
  images; CA bundles for gateway egress (05).
- Real per-rollout cost/duration on balanced tier → final limit values (07).
- Advisor call frequency on real SWE tasks under the default guidance — too
  low a rate makes campaign 1 inconclusive on the advisor question; the pilot
  reports it before the campaign spends (07).
- n=30, 1 trial is signal-seeking, not leaderboard-stable; the report states
  this and leads with discordant pairs, not the raw delta (07/08).

## Dead ends (recorded so nobody re-walks them)

- **sb-cli cloud scoring** — supports only `swe-bench-m`/`lite`/`verified`;
  no Multilingual. Local scorer on the box is required.
- **Host-side duet with a bash proxy into the container** — bash, read,
  write, and edit are all host-FS-bound in `src/turn-runner/tools.ts`; a
  proxy splits bash's filesystem view from the file tools'. Rejected.
- **Advisor-OFF as "no override file"** — unpinned: built-in-table drift
  would silently change the control arm. Both arms are explicit renders.
- **Trusting terminal cost as-is** — `callAdvisor` drops `result.usage`
  (`src/model-routing/advisor.ts`) and the classifier's usage is likewise
  unmetered, so pre-slice-01 terminal cost undercounts exactly the arm under
  test. Verified 2026-07-19; fixed by slice 01, not worked around in the
  bench.

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
