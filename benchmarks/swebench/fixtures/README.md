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

`gold-30-summary.tsv` is the official sequential gold-gate result for the
committed Multilingual manifest on the pinned Mac environment. All 30 patches
resolve. The elapsed time, peak instance-container memory, and peak transient
host-disk columns come from `mac/run_with_metrics.py`; the ignored raw scorer
directories remain under `benchmarks/swebench/.cache/gold-30-20260720/`.

`mini-luna-2-report.json` is the official scorer output for mini-swe-agent's
untouched two-task `preds.json`. It proves that mini's dictionary of official
prediction rows is accepted directly and that both non-empty patches completed
without scorer errors; see `spike-notes.md` for the exact commands.
