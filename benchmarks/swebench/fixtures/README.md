# RPC telemetry fixtures

`economy-rpc.sanitized.ndjson` is a sanitized subset of a real Mac-local
`economy` RPC turn captured on 2026-07-20 with:

```bash
bun benchmarks/swebench/cli.ts rollout local \
  --prompt "Reply with only the number that is two plus two."
```

The transcript identifiers, timestamps, signatures, and full state were
removed. The terminal's usage values and resolved model id are unchanged, so
the fixture retains the accounting contract it exists to test.

`kimi-advisor.ndjson` and `fable-advisor.ndjson` are hand-built protocol
streams covering the generic `ask_advisor` detail shapes and router-switch
histogram. They intentionally contain no provider transcript.
