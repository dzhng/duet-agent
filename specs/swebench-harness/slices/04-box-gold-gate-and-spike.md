# 04 — Mac environment, x86 gold gate, mini-swe-agent replication spike

**Status (2026-07-20): partially complete.** The idempotent provisioner,
environment lock, official image-key/pre-pull helper, sequential gold runner,
and one-instance capacity gate are complete. The capacity instance resolved
1/1 in 167 seconds with 2.41 GB peak container memory. The 30/30 manifest gate
and mini-swe-agent replication spike remain pending; this slice is not done.

Mac-local track; needs slice 02's manifest. No duet code. This slice kills the
plan cheaply if official x86 images cannot run under Docker emulation or the
local resource ceiling is untenable.

## Contract

- `benchmarks/swebench/mac/provision.sh`: idempotent preflight plus a pinned
  `uv` venv containing `swebench==4.1.0` and mini-swe-agent. Produces
  `environment.lock.json` (host and Docker OS/arch/resources, Docker version,
  emulation mode, pinned revisions; never credentials).
- **Capacity gate:** run one official gold instance with `--max_workers 1
--cache_level none --clean true`. It must resolve under the official x86_64
  image through amd64 emulation. Record peak disk/RSS and elapsed time before
  attempting the manifest.
- **Gold gate:** the same official command restricted to the 30 manifest ids →
  require 30/30 resolved. Process sequentially and clean benchmark-owned
  instance images between work units. Never broadly prune unrelated Docker
  state.
- **Replication spike (fixed decision):** mini-swe-agent
  (`mini-extra swebench --subset multilingual`) on 2–3 manifest instances
  from distinct languages with a cheap model. Gate is pipeline integrity —
  predictions JSONL accepted by the scorer without hand-editing, per-instance
  results produced — not resolution.
- Captured into `benchmarks/swebench/fixtures/`: a real scorer report JSON
  (feeds slice 07's parser) and `spike-notes.md` (exact scorer invocation,
  accepted predictions shape, mini-swe-agent's prompt template as reference
  for `prompt.ts`, per-language image quirks).

## Verification

The capacity instance and gold manifest resolve officially; the spike scores
end-to-end; lock file and fixtures are committed. Cost: <$5 model spend.

Current evidence: `apache__druid-13704` resolves with the pinned official
amd64 image under Docker Desktop emulation. See
`benchmarks/swebench/fixtures/capacity-gold-report.json` and
`capacity-metrics.json`. This is capacity evidence only, not a substitute for
the remaining 30/30 and replication gates.

## Playable checkpoint

`bash benchmarks/swebench/mac/gold-check.sh` prints the 30/30 table; the
spike's scorer report is readable locally and its fixture is in-repo.

## STOP conditions

Persistent gold failure (fix environment or re-select manifest per slice 02
before any measurement), missing/broken images for a manifest language, or a
resource ceiling breached with one worker. Do not silently change scorer,
architecture, manifest size, or comparison count.
