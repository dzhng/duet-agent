# DeepSWE v1.1 pilot

This folder is a self-contained adapter from Duet to the official
[DeepSWE](https://github.com/datacurve-ai/deep-swe) v1.1 tasks and
[Pier](https://github.com/datacurve-ai/pier) runner. Pier remains the owner of
task containers, patch transfer, separate verifier containers, and rewards.

The frozen population contains ten committed task IDs. The first paid tranche
runs the first five selected IDs across two advisor pairs and two standalone
pure baselines:

- `glm-pure` and `glm-kimi-advisor`
- `kimi-pure` and `kimi-fable-advisor`
- `opus-pure` on the current `opus-5` shorthand
- `fable-pure`

Within each pair, advisor availability is the only treatment. The classifier,
memory, task prompt, model effort, limits, and official verifier remain the
same. Opus and Fable provide pure-model cost and resolve-rate baselines; they
are not fabricated advisor pairs. There are no benchmark-only advisor timing
or call-count rules.

## Setup

Docker, Python 3.12 or 3.13, Bun 1.3.11, and Git are required. If the host
Python is older, setup can create Python 3.12 through `uv`.

```bash
bun benchmarks/deepswe/cli.ts setup
bun run test:deepswe
bun benchmarks/deepswe/cli.ts smoke
```

`setup` checks out the pinned DeepSWE commit under `.cache/`, installs the
pinned Pier source commit into `.venv/`, generates the four model configs, and
builds the exact Linux Duet payload. `verify` rechecks all pinned identities.
`smoke` runs Pier's no-op agent through one official task and its separate
verifier container. Its expected reward is zero; the gate proves environment,
artifact-transfer, and scoring mechanics without spending model tokens.

## Run

One official task across all arms is the paid acceptance gate:

```bash
bun benchmarks/deepswe/cli.ts run \
  --task true-myth-iterable-collection-combinators \
  --cost-limit-usd 20 \
  --budget-usd 240 \
  --concurrency 1
```

Remove `--task` for all ten tasks. The command loads `DUET_API_KEY` from the
repository `.env` when it is not already exported; Vercel AI Gateway and
OpenRouter keys are supported fallbacks. The minimum accepted budget is task
count × configured arms × (per-rollout soft stop + $20). The extra $20 covers
one maximum-size request under the pinned model context, output, and price
metadata. This is controller admission headroom, not a provider-side hard cap:
normal Duet subagents may have multiple requests in flight when an interrupt
arrives, so actual spend can exceed the authorization value. Expected spend is
normally much lower. Use a concurrency appropriate for the host's Docker
capacity.

For the planned E2B run, build the immutable worker after the branch commit is
pushed, then launch one task per sandbox. Each sandbox runs its configured arms
sequentially through Pier; the default outer concurrency is ten.

```bash
bun benchmarks/deepswe/e2b/template.ts
bun benchmarks/deepswe/e2b/run.ts \
  --task true-myth-iterable-collection-combinators \
  --task testem-per-launcher-reports \
  --task tengo-callable-instance-isolation \
  --task adaptix-name-mapping-aliases \
  --task igel-persist-feature-schema \
  --cost-limit-usd 10 \
  --budget-usd 1000 \
  --concurrency 5 \
  --campaign pilot-5-six-arm-v1
```

The controller rejects a budget smaller than the campaign admission minimum.
The campaign name is stable: rerunning it restores partial Pier jobs into fresh
sandboxes, skips finished arms, and resumes missing work after infrastructure
loss. Model or verifier outcomes with completed Pier records are never retried
into passes.

Raw Duet events, stderr, Pier trial records, official rewards, and generated
reports live under ignored `outputs/`. Summarize completed jobs with:

```bash
bun benchmarks/deepswe/cli.ts report \
  --campaign pilot-5-six-arm-v1 \
  --output benchmarks/deepswe/outputs/report.json
```

Omit `--campaign` to report a local Pier run under `outputs/jobs`, or pass
`--jobs` for an explicit result root.

Both-resolved is a successful tie. A pure-resolved/advised-unresolved row is an
advisor regression and remains in the report; it is never retried until it
passes.
