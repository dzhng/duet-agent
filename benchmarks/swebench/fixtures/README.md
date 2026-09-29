# RPC telemetry fixtures

`kimi-advisor.ndjson` and `fable-advisor.ndjson` are hand-built protocol
streams covering the generic `ask_advisor` detail shapes and router-switch
histogram. Telemetry derives call positions from these raw canonical steps and
tolerates older result details that lack newer context-fidelity metadata. They
intentionally contain no provider transcript.

`gold-30-summary.tsv` is the official sequential gold-gate result for the
committed Multilingual manifest on the pinned Mac environment. All 30 patches
resolve. The elapsed time, peak instance-container memory, and peak transient
host-disk columns come from `mac/run_with_metrics.py`; the ignored raw scorer
directories remain under `benchmarks/swebench/.cache/gold-30-20260720/`.

`mini-luna-2-report.json` is the official scorer output for mini-swe-agent's
untouched two-task `preds.json`. It proves that mini's dictionary of official
prediction rows is accepted directly and that both non-empty patches completed
without scorer errors; see `spike-notes.md` for the exact commands.

`container-smoke-9.json` cross-foots the live packaging matrix over one
committed task per language. Every pure-GLM turn completed, used only GLM-5.2
plus the product-default Luna memory model, made zero advisor calls, changed one
sentinel path, and reproduced its patch in a fresh official container.
