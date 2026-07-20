# SWE-bench Multilingual harness

Measure duet-agent's router-tier and `ask_advisor` deltas on SWE-bench
Multilingual with the official evaluation harness. Anthropic's
[advisor-strategy post](https://claude.com/blog/the-advisor-strategy) motivates
the question, but this is a Duet product evaluation, not a reproduction of
Anthropic's protocol. Anthropic used its server-side advisor, a full executor
transcript, suggested coding guidance, thinking off, and five trials of all 300
tasks; this harness uses different executors and advisors and a signal-seeking
30-task sample.

## Next Agent Prompt

**Status:** slices 01–07 are mechanically complete; slice 08 is optimizing the
advisor context policy before the broader non-regression gate. Earlier gates exposed product lifecycle,
E2B integration, binary-packaging, and advisor-review defects. The decisive
pure-only failure was Kimi resolving `facebook__docusaurus-8927` while Fable
endorsed an advised narrow regex fix that official adjacent cases rejected.
The shipped advisor now reviews independently, seeks authoritative evidence,
tries to falsify completion against neighboring behavior, and keeps its verdict
compact; the executor treats advice as a hypothesis to verify. A wire-faithful
live eval falsified the old prompt and passed with the correction.

The fresh known-case diagnostic is now fully scored: 15/15 pairs avoid
regression, with eight advisor-only improvements and seven both-resolved ties.
GLM plus Kimi resolved 4/4 v2 trials versus 2/4 for pure GLM; Kimi plus Fable
resolved 8/8 versus 3/8 for pure Kimi. Every successful consultation retained
the complete available transcript with zero omitted messages. These adaptive
repeats validate the quality baseline but also show that the current advisor
request grows with raw executor history. They are not an unbiased lift estimate.

The first efficient-context candidate is implemented: a 32k total-input target,
roughly 16k recent raw-message tail, normal observational compaction for older
work, and a quality override that keeps the latest complete tool interaction
even when it exceeds the soft target. The executor's own horizon is unchanged.
A live falsification carried 88,780 estimated raw tokens and zero compacted
messages; the enabled path carried 8,759 estimated tokens, compacted two old
messages, retained the first task plus the newest complete tool call/result, and
recovered evidence from both observations and the raw tail. The product suite
passes 1160/1160 and the benchmark suite passes 79/79.

Next, build an immutable E2B template from this checkpoint and run
`advisor-context-efficiency-kimi-20260721-v1` on the five highest-risk
Docusaurus 8927 pairs first. If none is pure-only, run its Docusaurus 9897
pairs alongside `advisor-context-efficiency-glm-20260721-v1`, completing all
15 pairs. The hard
gates are zero pure-only outcomes and 15/15 advisor resolves, matching the known
quality baseline. The efficiency gate requires at least 10% reduction from
1,410,521 estimated and 1,648,243 exact provider advisor tokens; 15% is the
stretch target. Also verify that extra memory-observer work does not erase the
overall auxiliary-token savings. Any pure-only result stops immediately for
exact-trace diagnosis. Only after freezing this policy may new diversity
campaigns be created. The stopped
`advisor-nonregression-expansion-*-20260721-v1` namespaces predate the policy
change, have no completed pairs, and must never be resumed or scored. The stopped v3 workers
finalized 15/30 rollouts for `$12.6315597`; reserve up to `$21.9315597`
including the three interrupted arms. Their remote artifacts were not
recovered, so never resume or score that namespace. Last updated 2026-07-21.

Local constraints to prove rather than assume:

- The Mac-local path remains the scorer and fallback execution path. Its Docker
  VM admitted only one rollout worker. Final generation uses a commit-derived
  E2B x86_64 template with Docker-in-sandbox, 8 vCPU and 16 GiB per worker. A
  no-model probe must prove the exact commit, resources, Docker daemon, Python,
  and pinned SWE-bench version before any rollout starts.
- Every worker uses the byte-identical Duet binary compiled once into the
  immutable E2B template. Workers never compile their own campaign artifact or
  fetch the pinned dataset snapshot at launch.
- Every successful call records its real model window, policy input target,
  conservative safety margin, estimated input, raw and compacted message
  counts, images, and whether compaction occurred. The hard model window is a
  safety ceiling, not an input target. The newest complete tool interaction may
  exceed the soft target and must be reported honestly in telemetry. Text-only
  advisors remain usable for text transcripts; an
  image-bearing consultation they cannot inspect is logged as failed without
  failing the executor tool. The deterministic fixture and live GLM/Kimi eval
  prove complete tool results survive the old projection boundary; focused
  repeats must retain that evidence.
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
- [x] Two-comparison report and 3-instance four-arm pilot; historical limits
      calibrated and reporting gates implemented (07)
- [ ] Full-context fidelity + repeated restart gate; new 30×4 product-policy
      campaign + product and per-protocol reports (08)

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
- **Measurement design:** four arms over one fixed 30-instance subset, 1 trial per
  arm, reported as two paired comparisons: pure GLM-5.2 vs GLM-5.2 with Kimi K3
  advisor, and pure Kimi K3 vs Kimi K3 with Fable advisor. “Pure” means the
  advisor tool is disabled; product-default memory still runs. Every complete
  render derives classifier, memory, and cadence policy from the
  built-in table. The campaign fixes the executor and advisor targets and uses
  Kimi K3 as its vision fallback, including for the text-only GLM executor.
  Within each pair ON/OFF differs only in `advisor.enabled`. The shared model-
  spend envelope is **$500**, including prerequisite live smoke and pilots.
  Economy-vs-balanced, frontier ceiling, and trials>1 remain future campaigns.
- Greenfield tooling: no backward compat, no migrations.

## Measurement claims

- **Product-policy estimate (primary):** compare every pure rollout with its
  advisor-enabled mate, whether the executor calls zero, one, or several times.
  This answers “what happens when the shipped advisor policy is enabled?” Call
  rate and timing are part of the product behavior, not failed rows to discard.
- **Per-protocol view (secondary, descriptive):** separately show pairs where
  the configured advisor actually returned advice, along with call count,
  timing, and context fidelity. Conditioning on a model's decision to call can
  select harder tasks, so this subgroup must not be presented as a causal
  advisor delta.
- **Controlled-exposure history:** the old exactly-once prompt tested a custom
  mandatory-call protocol. Anthropic's own tool lets the executor choose when
  to call and its coding guidance targets roughly two to three calls, including
  early and completion-time review. Exact-one compliance is therefore neither
  shipped Duet behavior nor an Anthropic reproduction.
- **Power:** n=30 × 1 trial can find large directional signals, not a modest
  effect like Anthropic's published 2.7 percentage points. One resolved task is
  3.33 points; an exact paired two-sided test needs at least six unopposed
  discordant wins even to cross 0.05. Report paired outcomes and uncertainty,
  but do not turn a null or small delta into evidence of no effect.

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
| Patch extraction + integrity                  | `patch.ts` — staged-index extraction of the agent's complete diff plus round-trip verification                                                                                              |
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
07 report + 3-instance pilot + historical admission gate (needs 04 fixture, 06)
08 context/restart gate + 30×4 final report (LAST; needs 07 artifacts)

01 ──► 03 ──┬──► 05 ──► 06 ──► 07 ──► 08
02 ──┬──────┘         ▲       ▲
     └──► 04 ─────────┴───────┘ (images, scorer fixture)
```

Parallel lanes: {01, 02} immediately; 03 and 04 concurrently after their
parents; 05+ serial on the Mac. Live-model spend before slice 07 is small. The
30-instance four-arm campaign is the last slice, gated by slice 08's focused
repeated admission decision.

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
  Kimi vision fallback. The shared task prompt must not force an advisor call;
  treatment assignment is tool availability under the shipped product policy.
- Isolation: fresh official image + fresh `HOME` per rollout. Duet otherwise
  runs normally: default observational memory, compaction, and repository
  `AGENTS.md` discovery stay enabled. Scoring applies the patch in the
  harness's own pristine container.
- Contamination: runtime files, config, credentials, and logs live outside
  `/testbed`. Patch extraction submits the complete baseline-relative agent
  diff, including tests; the benchmark does not second-guess which repository
  paths belong to a valid fix. Empty and oversized predictions remain visible.
  Failures are artifacts, never dropped from denominators; infra failures are
  separated from agent timeouts and mark the campaign invalid if unrecovered.
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
- Advisor non-regression across paired tasks under the shipped policy. The
  repeated diagnostic gate stops on any pure-only outcome and expands to more
  distinct tasks after a clean batch; call frequency remains telemetry (08).
- n=30, 1 trial is signal-seeking and underpowered for modest effects; the
  report leads with discordant pairs and never treats a small or null delta as
  proof of equivalence (08).

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
  thinking off for advisor arms) and
  [advisor tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool)
  (executor-selected calls, full-transcript context, and coding call-timing
  guidance).
- SWE-bench harness: https://github.com/swe-bench/SWE-bench — quickstart,
  docker setup (x86_64, ~120GB, gold `--predictions_path gold`).
- mini-swe-agent SWE-bench runner: https://mini-swe-agent.com/latest/usage/swebench/
  (`mini-extra swebench --subset multilingual --split test -m <litellm-model>`).
- Product seams this spec binds to: `src/cli/rpc.ts`, `src/types/protocol.ts`,
  `src/model-routing/table.ts` (`advisor.enabled`), `src/model-routing/loader.ts`
  (models.json discovery), `src/turn-runner/tools.ts` (`ask_advisor` details,
  host-bound tools), `benchmarks/longmemeval/` (benchmark precedent).
