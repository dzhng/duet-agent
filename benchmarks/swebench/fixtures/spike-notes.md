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

Still pending:

- the full 30-instance gold gate;
- the 2–3-instance mini-swe-agent replication spike;
- the accepted mini-swe-agent prediction fixture and prompt reference;
- per-language image quirks.
