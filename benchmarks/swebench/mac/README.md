# Mac-local SWE-bench environment

These scripts keep the official SWE-bench scorer and its x86_64 instance
images authoritative while running on Apple Silicon. Docker Desktop performs
amd64 emulation; the harness starts with one worker because this Mac's Docker
VM is below the scorer's recommended memory allocation.

Provision the pinned Python 3.12 environment:

```sh
bash benchmarks/swebench/mac/provision.sh
```

The provisioner installs `swebench==4.1.0` and
`mini-swe-agent==2.4.5`, verifies the local helpers, and writes
`environment.lock.json`. The lock contains host, Docker, and package metadata;
it never reads `.env` or records credentials.

Before the 30-instance gate, run one capacity instance:

```sh
bash benchmarks/swebench/mac/gold-check.sh \
  --instance-id apache__druid-13704 \
  --output-dir benchmarks/swebench/.cache/gold-capacity
```

`official_image.py` asks the pinned SWE-bench package for the instance image
key and then pulls that exact key with `--platform linux/amd64`. This pre-pull
is required on Apple Silicon; an unqualified Docker pull selects the wrong
platform before the scorer gets a chance to run. The scorer invocation itself
is unchanged and uses `--max_workers 1 --cache_level none --clean true`.

After checking the capacity metrics, run the committed manifest:

```sh
bash benchmarks/swebench/mac/gold-check.sh
```

The script prints one row per instance and exits nonzero unless every instance
resolves. Runtime output stays under `benchmarks/swebench/.cache/`. After each
row it removes only the exact official instance image it just resolved and
pulled. It never calls a broad Docker prune and never removes unrelated images
or containers. Pass `--keep-images` only when intentionally trading disk for a
faster rerun.

The one-instance proof captured in `../fixtures/capacity-gold-report.json` and
`../fixtures/capacity-metrics.json` establishes that the official x86_64 image
can resolve under emulation with one worker. It does not establish the pending
30/30 gold gate or mini-swe-agent replication spike.
