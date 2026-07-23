# SWE-bench benchmark

This directory owns the complete SWE-bench Multilingual benchmark surface:
campaign inputs, orchestration, E2B and Mac execution, fixtures, runtime
artifacts, and tests. It is intentionally separate from the product test tree.

The [closed advisor-harness rationale](../../specs/done/swebench-harness/README.md)
records the benchmark invariants and tradeoffs. The final Mac comparison is
preserved in the [compact result record](results/mac-advisor-comparison-20260721.json).
The corrected 50-task Opus/GLM E2B comparison is preserved separately in its
[model result record](results/e2b-opus-glm-comparison-20260723.json). The
fixed-panel model and advisor cost comparison lives in the
[eight-arm E2B result record](results/e2b-eight-arm-cost-panels-20260723.json).

Run its Dockerized TypeScript suite independently:

```sh
bun run test:swebench
```

The Mac scorer helpers keep their Python tests under `mac/tests/`; the pinned
Mac provisioner runs those tests after installing its environment. Product
tests remain under the repository's root `test/` directory and run with
`bun run test`.

The final campaign's E2B template and driver live under `e2b/`. Both require a
clean pushed commit so the worker template, provenance lock, and source tree
cannot drift. The template compiles Duet and uses the source-controlled dataset
snapshot under `dataset/`; datasets-server only serves its moving current
revision, so workers must never refetch campaign inputs during a build.

```sh
bun benchmarks/swebench/e2b/template.ts
bun benchmarks/swebench/e2b/run.ts --capacity-only
bun benchmarks/swebench/e2b/run.ts
```

Use repeated `--instance <id>` flags for a final-environment live gate or a
targeted resume. Add `--retry-failed` only after the driver's global budget
calculation admits the extra reservations.
