# 05 — Duet in the instance container: packaging, smoke matrix, patch integrity

**Status (2026-07-20): complete.** The compiled artifact, container boundary,
dirty-baseline extraction, fresh-image round trip, and
`rollout smoke --instance|--all-languages` workflow are implemented and
fixture-tested. The paid sequential matrix passed 9/9 for $0.130053 total.

Mac-local; needs slices 03 (client) and 04 (images). The architecture's kill-shot
assumption gets falsified here for under a dollar, before the runner exists.

## Contract

- `packaging.ts`: `prepareDuetArtifact() → {localPath, installDir:
"/opt/duet"}`. Primary mode: cross-compile from the Mac with
  `bun build --compile --target=bun-linux-x64`
  single binary (sha256 recorded). Fallback behind the same interface: bun
  linux-x64 binary + packed `npm pack` tarball installed under `/opt/duet`.
  The compile-vs-tarball decision never leaks past this module.
- `container.ts`: `ContainerHandle.start` (`docker run -d <image> sleep
infinity`), `cpIn`, `exec`, `execStream → ExecTransport`, `stop` (always in
  `finally`) — over an injected `Cmd`; env passed per-exec, never baked in.
- Install recipe: binary + rendered models.json into a **fresh per-rollout
  `HOME` outside `/testbed`** (`HOME=/opt/duet/home`, config at
  `$HOME/.duet/models.json` — the loader's home fallback picks it up;
  `/testbed` stays pristine).
- Invocation passes the config's explicit benchmark tier and omits
  `--memory-model`.
  Only the executor and advisor are experiment-selected; memory retains the
  product default.
- `patch.ts`: `capturePatchBaseline` stages the official image's initial
  working tree into a private index and writes its tree object. This preserves
  intentional image modifications instead of resetting them. `extractPatch`
  stages the final tree over that index and emits `git diff --cached --binary
--full-index <baseline-tree> --`; `verifyPatchRoundTrip` applies it to a fresh
  image with the same baseline. Empty/malformed/oversized patches are explicit
  outcomes, never silently replaced.

## Verification

Progress 2026-07-20: the target-platform install plus Bun Linux-x64 compile
produced an ELF binary that booted in the official Druid image. The first smoke
falsified a compiled-entry bug that launched RPC twice; after fixing dispatcher
ownership, the same live GLM-5.2 RPC prompt produced exactly one start and one
terminal, wrote the sentinel in `/testbed`, retained the product-default Luna
memory model, and cost $0.0108392. Druid's official image starts with a modified
`pom.xml`; baseline-relative extraction omitted it, captured only the sentinel,
and round-tripped into a fresh image. The remaining acceptance work is the full
nine-language matrix then completed every language with only the product-default
Luna memory model and GLM-5.2 in its usage ledger, zero advisor calls, one exact
sentinel path, and a byte-identical fresh-container round trip. Total spend was
$0.130053; see `benchmarks/swebench/fixtures/container-smoke-9.json`. The
advisor-OFF injection contract remains pinned by the product tool-list test,
while the live telemetry proves silence end to end.

- Unit (FakeCmd, no docker): exact docker argv construction, timeout kill,
  teardown-on-error.
- **Smoke matrix (Mac, one manifest instance per language, 9 total):** duet
  boots over `docker exec -i` RPC, completes a trivial turn that writes a
  sentinel into `/testbed`, gateway egress works (real completion), sentinel
  visible in the diff, config never appears in it, container reaped. On the
  OFF render, assert `ask_advisor` is absent from the tool list.
- Patch integrity (one container): deterministic modified + deleted +
  renamed + untracked (incl. spaced filename) tree delta → extract →
  round-trip apply → byte-identical; pollution scan clean.

## Playable checkpoint

`bun benchmarks/swebench/cli.ts rollout smoke --instance <id>` runs one image;
`--all-languages` selects the first committed manifest entry in each language.
Each successful JSON line prints the terminal, cost, patch, and per-model usage.

## STOP conditions

Any of the 9 images cannot execute the binary, reach the gateway, or
terminate cleanly. Fallbacks in order: tarball mode, bun-musl target,
documented manifest re-selection (slice 02 rules). Do not proceed to slice 06
with a partial language allowlist and no recorded decision.
