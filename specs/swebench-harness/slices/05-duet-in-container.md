# 05 — Duet in the instance container: packaging, smoke matrix, patch integrity

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
- `patch.ts`: `assertCleanBaseline`, `extractPatch` (stage ephemeral index
  `git add -A`, emit `git diff --cached --binary --full-index HEAD --`),
  `verifyPatchRoundTrip` (apply to a fresh instance container, compare
  tracked trees byte-for-byte). Rejects empty/malformed/oversized patches
  explicitly; never silently substitutes an empty patch.

## Verification

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

`bun benchmarks/swebench/cli.ts rollout smoke --instance <id>` streams the
NDJSON events live and prints duet's version, terminal event, and cost.

## STOP conditions

Any of the 9 images cannot execute the binary, reach the gateway, or
terminate cleanly. Fallbacks in order: tarball mode, bun-musl target,
documented manifest re-selection (slice 02 rules). Do not proceed to slice 06
with a partial language allowlist and no recorded decision.
