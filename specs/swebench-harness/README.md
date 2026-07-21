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

**Status:** slices 01–07 are mechanically complete; slice 08 is using the
15-case known-loss suite for one more advisor-efficiency pass before the broader
non-regression gate.
Earlier gates exposed product lifecycle, E2B integration, binary-packaging,
and advisor-review defects. The decisive
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

The first efficient-context baseline uses a 32k total-input trigger,
roughly 16k recent raw-message tail, normal observational compaction for older
work, and a quality override that keeps the latest complete tool interaction
even when it exceeds the soft target. The executor's own horizon is unchanged.
A live falsification carried 88,780 estimated raw tokens and zero compacted
messages; the enabled path carried 8,759 estimated tokens, compacted two old
messages, retained the first task plus the newest complete tool call/result, and
recovered evidence from both observations and the raw tail. The product suite
passes 1161/1161 and the benchmark suite passes 79/79.

The immutable `4aa8791` E2B campaign then passed all 15 known pairs. Advisor
arms resolved 15/15 versus 10/15 for pure arms: five advisor-only improvements,
ten ties, and zero pure-only regressions. All 36 consultations succeeded.
Estimated advisor input fell from 1,410,521 to 657,259 tokens (53.4%); exact
provider-reported advisor tokens fell from 1,648,243 to 731,889 (55.6%); and
advisor spend fell from $15.13 to $7.65 (49.5%). The normal memory observer added
$0.89, so advisor plus observer still cost $8.54, 43.6% below the old advisor
spend alone. The projection compacted 1,129 old messages with zero unrepresented
omissions. This preserves the old 15/15 advisor quality baseline with two more
consultations and roughly half the context, so the former provisional 10%/15%
thresholds are superseded by measured evidence. Optimization is now reopened
against that exact quality baseline. The next candidate keeps the 32k observer
trigger and latest-complete-tool override, projects only model-visible message
fields (not timestamps, provider ids, accounting, diagnostics, or opaque replay
signatures), and reduces the ordinary recent raw tail to 8k. Its first paid run
lowered both advisors from high to medium, but scored only 14/15: one Fable run
conditionally approved a hand-designed Docusaurus regex instead of driving the
executor to the authoritative upstream fix. Exact advisor tokens fell 18.7% to
595,251, but advisor-plus-observer tokens rose 2.3% to 1,578,537. That candidate
is rejected on both gates. The next candidate kept the representation savings,
used medium effort for Kimi, and restored high effort for Fable. It reduced exact
advisor-plus-observer tokens 15.3%, from 1,543,369 to 1,306,951, but again scored
only 14/15. The failed trace exposed a lifecycle defect: a completion checkpoint
fired after diagnosis but before editing, Fable correctly rejected the
unimplemented hand-designed regex, and later tool work permanently consumed the
one-shot checkpoint. Fable therefore never saw the final diff containing the
exact boundary regressions it had warned about. The first focused correction
re-armed a spent completion checkpoint after every later non-advisor tool. That
restored final review, but four recovered runs used 3–7 Fable calls; two exceeded
the cost cap, and a fifth interrupted archive was lost. The traces showed a
recursive loop: an approving advisor was required to invent one residual risk,
the executor ran that check, and the check mandated another review. The revised
product policy allows one automatic re-arm only when the original completion
checkpoint was issued before any successful consultation. An advisor that has
enough evidence may now approve without manufacturing more work. Its fresh v5
focused gate officially resolved all five Docusaurus 8927 trials. It used 11
advisor calls total (2.2 per run), incurred no cost-cap interruptions, and
consumed 402,590 advisor-plus-observer tokens—12.1% below the same five-case v3
subset. The candidate now advances to the complete 15-case gate.

The v6 expansion officially resolved all 15/15 known cases. Its 31 successful
consultations used 494,436 advisor tokens. Luna used 841,440 tokens across both
observation and GLM classification; exact event-boundary reconstruction assigns
808,182 of those tokens to 32 observer calls, making exact advisor-plus-observer
usage 1,302,618. That split shows the remaining inefficiency is concentrated in
the observation pipeline.
A v7 experiment deferred compaction from 32k to 64k. It preserved quality at
5/5 official resolves, but consumed 622,697 advisor-plus-observer tokens versus
v6's 470,574 on the same five trials, a 32.3% regression. The observer saved
95,112 tokens while the advisor spent 247,235 more. The validated 32k trigger is
therefore restored; further optimization must reduce observation work without
inflating the advisor request.

V6's traces exposed a harness wiring defect rather than another model-policy
tuning knob: benchmark RPC omitted its caller-owned session id. Without a
session, observations were stored as global background and their message-range
markers could not advance progress on the next observer pass. Seventeen later
passes restarted from the first user message and consumed 459,712 observer
tokens. Each rollout already has a fresh HOME, so the harness now supplies the
stable `swebench` session id and lets normal product memory observe only the new
suffix. Keep the 32k trigger, 8k raw tail, complete-tool protection, and
wire-faithful advisor context. Any pure-only
result still stops immediately for exact-trace diagnosis. The stopped
`advisor-nonregression-expansion-*-20260721-v1` namespaces predate the policy
change, have no completed pairs, and must never be resumed or scored. The stopped v3 workers
finalized 15/30 rollouts for `$12.6315597`; reserve up to `$21.9315597`
including the three interrupted arms. Their remote artifacts were not
recovered, so never resume or score that namespace. Last updated 2026-07-21.

The stopped focused lifecycle gate is
`advisor-token-efficiency-kimi-20260721-v4`. Four recovered runs cost
`$10.2426636`; reserve `$3.28` for the interrupted archive and `$2.00` for the
live prompt falsification/confirmation calls. The completed v5 focus gate cost
`$5.871627`; reserve one additional `$3.10` cap for its archive-less initial E2B
connection failure. The fresh v6 full gate started from a conservative
`$439.2249` ledger. A later audit found that this carried a temporary 24-rollout
launch reservation after all 24 known-gate v2 artifacts had returned exact
costs. Replacing that stale `24 × $3.10` bound with `$28.9503838` of durable
telemetry releases `$45.4496162`. After v7, the corrected cumulative worst case
is `$422.8553023`, leaving `$77.1446977` under the hard `$500` model-spend
envelope. The E2B controller now reserves only genuinely concurrent work and
reconciles returned exact cost before admitting another shard. Its durable
per-shard reservation survives controller loss, and exhausted headroom leaves
the remaining shards unstarted. This preserves the hard cap without requiring
all 120 emergency per-rollout ceilings to fit simultaneously.

The final frozen generation namespace is
`multilingual-30-four-arm-e2b-20260721-v5`. It retains the full `$3.10`
per-rollout ceiling, all four paired configurations, 30 committed instances,
and 16-worker E2B maximum. The session-attribution repair is not followed by
another paid adaptive repeat: the unchanged advisor policy already passed its
15/15 gate, and the fresh 30-task paired campaign is both a broader live check
and the only evidence eligible for the requested effect estimate.

The first v5 launch returned four complete shards: 16 terminal artifacts costing
`$15.6848066`. One worker failed while its sandbox stayed at idle-template CPU
and memory levels, before any artifact existed. A second worker completed all
four model arms but lost its archive to one E2B connection error. The controller
now retries idempotent pre-model setup and post-model artifact recovery; it never
retries the campaign model command. Worker records persist whether that
non-idempotent boundary was reached, so a proven pre-command failure releases
its reservation while an ambiguous or post-command failure remains held.

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
