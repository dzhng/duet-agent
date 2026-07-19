# Local scorer evidence

The capacity probe used the pinned `swebench==4.1.0` environment and this
official invocation, restricted to `apache__druid-13704`:

```sh
python -m swebench.harness.run_evaluation \
  --dataset_name SWE-bench/SWE-bench_Multilingual \
  --split test \
  --instance_ids apache__druid-13704 \
  --predictions_path gold \
  --max_workers 1 \
  --cache_level none \
  --clean true \
  --run_id multilingual-gold-smoke-2
```

An unqualified pull failed on Apple Silicon. Pre-pulling the image selected by
the pinned harness with `docker pull --platform linux/amd64` allowed the
unchanged scorer command to complete. The first result was 1/1 resolved in 168
seconds. A second 1/1 run through `mac/gold-check.sh` took 167 seconds while
sampling 2.41 GB peak instance-container memory, 205 MB peak scorer-process-tree
RSS, and 164 MB peak transient host-disk consumption. Docker inspected the
image as `linux/amd64`, size 1,082,081,711 bytes. The sanitized official summary
and capacity sample are `capacity-gold-report.json` and `capacity-metrics.json`.

This proves scorer and image compatibility for one Java instance at worker
count one. It does not prove headroom for parallel workers.

The corrected 30-instance manifest then resolved 30/30 sequentially. Its
resource table is `gold-30-summary.tsv`; the only pre-selection incompatibility
and replacement are documented in the manifest and slice 04.

## mini-swe-agent replication

The pinned mini-swe-agent 2.4.5 runner used two manifest tasks from distinct
languages (Java and PHP), one worker, and the Vercel gateway's small Luna
model. The exact successful invocation was:

```sh
export VERCEL_AI_GATEWAY_API_KEY="$AI_GATEWAY_API_KEY"
export MSWEA_COST_TRACKING=ignore_errors
mini-extra swebench \
  --subset multilingual \
  --split test \
  --filter '^(apache__druid-16875|briannesbitt__carbon-2981)$' \
  --workers 1 \
  --model vercel_ai_gateway/openai/gpt-5.6-luna \
  --config swebench.yaml \
  --config agent.cost_limit=0 \
  --config agent.step_limit=40 \
  --output benchmarks/swebench/.cache/mini-spike-luna-2-v2
```

LiteLLM can call this gateway model but does not yet have a local price-table
entry for its provider-qualified name. The first attempt reached both providers
and then raised during local cost calculation. The successful replication used
mini's documented `ignore_errors` mode and a 40-action ceiling solely to bound
this non-measurement spike. The gateway response metadata in the saved
trajectories reports $0.128210 for the successful 27 calls; the campaign's Duet
client does not use this workaround and remains bounded by streamed dollar cost
with no step limit.

Both tasks exited `Submitted` after 2m54s. Mini emitted an untouched `preds.json`
dictionary keyed by instance id; every value had the official
`instance_id`/`model_patch`/`model_name_or_path` fields. Druid's patch was 2,333
bytes and Carbon's was 707 bytes. That file was passed directly—without JSONL
conversion or hand editing—to:

```sh
python -m swebench.harness.run_evaluation \
  --dataset_name SWE-bench/SWE-bench_Multilingual \
  --split test \
  --instance_ids apache__druid-16875 briannesbitt__carbon-2981 \
  --predictions_path benchmarks/swebench/.cache/mini-spike-luna-2-v2/preds.json \
  --max_workers 1 \
  --cache_level none \
  --clean true \
  --run_id mini-luna-2-v2
```

The official scorer accepted both rows and resolved 2/2 with zero empty patches
or errors; its sanitized result is `mini-luna-2-report.json`. The bundled
reference prompt is the installed
`minisweagent/config/benchmarks/swebench.yaml`: it presents the issue text,
requires work in `/testbed`, forbids test/config edits, and submits a source-only
Git patch. No Java- or PHP-specific image workaround was needed beyond the
shared explicit amd64 pre-pull already captured by the Mac harness.
