# Slice 02 — Bridge Duet into Pier

## Contract

Pier can load Duet through its supported custom-agent import seam, run the
exact compiled repository commit inside an official task container, preserve
the RPC ledger and costs, then expose the committed patch to DeepSWE's official
verifier.

## Seam

- `benchmarks/shared/duet-packaging.ts` owns the Linux Duet artifact.
- `benchmarks/shared/duet-rpc-client.ts` owns bounded RPC driving.
- `benchmarks/shared/rollout-telemetry.ts` owns cumulative wire accounting.
- `benchmarks/deepswe/src/agent-driver.ts` runs that RPC client inside the task.
- `benchmarks/deepswe/pier_agent.py` is the external Pier adapter boundary.

The adapter must not reproduce DeepSWE scoring or patch extraction.

## Verification

- A fake Pier environment observes the exact artifact/config uploads and `/app`
  workdir.
- A synthetic RPC ledger proves final cumulative usage, per-model attribution,
  unknown-event retention, and interruption reporting.
- A temporary Git repository proves uncommitted work becomes visible in
  `BASE..HEAD` only after the adapter's final commit.
- Removing the final commit or a PGlite sidecar makes the focused test fail.

## Delegated choices

Temporary container paths and private helper names are delegated. The raw event
contract, official working directory, artifact identity, and final commit are
not.
