# 04 — Box provisioning, gold gate, mini-swe-agent replication spike

Box track; needs the rented x86_64 box and slice 02's manifest. No duet code.
This slice kills the plan cheaply if the external world is broken.

## Contract

- `benchmarks/swebench/box/provision.sh`: idempotent — docker, bun, python
  venv with pinned `swebench` + `mini-swe-agent`, disk/RAM/arch preflight.
  Produces `environment.lock.json` (OS, resources, docker version, pinned
  revisions; never credentials). Box driving pattern documented in
  `benchmarks/swebench/README.md`: campaign runs box-local under tmux, Mac
  SSHes in as a viewer only.
- **Gold gate:** `python -m swebench.harness.run_evaluation
--predictions_path gold` restricted to the 30 manifest ids → require
  30/30 resolved. Record image sizes, peak disk/RSS, and elapsed time;
  demand ≥25% disk headroom.
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

Gold 30/30 on the box; spike scored end-to-end; lock file and fixtures
committed. Cost: box rental + <$5 spike spend.

## Playable checkpoint

`ssh box 'bash benchmarks/swebench/box/gold-check.sh'` prints the 30/30
table; the spike's scorer report is readable on the box and its fixture is
in-repo.

## STOP conditions

Persistent gold failure (fix environment or re-select manifest per slice 02
before any measurement), missing/broken images for a manifest language, or
resource ceilings breached with one worker.
