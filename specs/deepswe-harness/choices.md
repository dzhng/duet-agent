# DeepSWE choices ledger

## Needs user

### $10 soft stop per rollout

- **When:** Six-arm five-task tranche.
- **The choice:** Each of the thirty model rollouts is asked to stop after its
  recorded cost reaches $10. The controller also reserves a $20 in-flight
  request cushion per rollout, so the tranche requires $900 of the authorized
  $1,000. A long Opus or Fable attempt may therefore stop before it finishes.
  The alternative is a higher per-rollout stop, which requires fewer tasks or a
  larger total authorization.
- **The gap:** The user fixed the task count and total budget but did not choose
  how to distribute spend across rollouts.
- **The reach:** This trades some expensive-model completion probability for
  $100 of campaign-level overrun headroom.
- **Verdict:** Needs user; provisionally sound for the first tranche because it
  preserves equal limits across arms and is reversible by starting a new
  campaign with a different stop.
- **Confidence:** Medium.

## Sound

### Use the first five frozen tasks

- **When:** Six-arm five-task tranche.
- **The choice:** “Five each” means every arm receives the same first five task
  IDs in the already-frozen seed order. The alternative is choosing tasks after
  seeing their contents or results, which could make one model family look
  better by accident.
- **The gap:** The user specified the count but not which five tasks.
- **The reach:** Later expansion can append the remaining five without changing
  or cherry-picking the first tranche.
- **Verdict:** Sound; it preserves the original random selection.
- **Confidence:** High.

### Treat Opus and Fable as standalone pure baselines

- **When:** Six-arm five-task tranche.
- **The choice:** Opus 5 pure and Fable 5 pure appear in the model comparison
  table, while advisor regression categories remain limited to the two real
  pure/advised pairs. The alternative would invent an advisor treatment the
  user did not request.
- **The gap:** The existing DeepSWE spec contained only the two advisor pairs.
- **The reach:** Reports can compare all model families without confusing a
  model baseline with evidence about advisor effectiveness.
- **Verdict:** Sound; it matches the requested additions and keeps the
  experiment honest.
- **Confidence:** High.

### Use Opus 5 at xhigh and Fable 5 at high

- **When:** Six-arm five-task tranche.
- **The choice:** The Opus baseline uses the current `opus-5` product shorthand
  at xhigh reasoning; Fable uses `fable-5` at high. Both keep advisor disabled,
  the product classifier, default memory, and the common Kimi vision fallback.
  The alternative would change unrelated harness behavior or retain obsolete
  Opus 4.8.
- **The gap:** The user named the models but not their effort levels.
- **The reach:** These settings become the model-family baseline for later
  DeepSWE expansions.
- **Verdict:** Sound; they match the established SWE-bench model-family
  settings while honoring the requested Opus upgrade.
- **Confidence:** High.

### Run five task workers in parallel and six arms sequentially

- **When:** Six-arm five-task tranche.
- **The choice:** E2B starts one sandbox for each selected task. Inside a
  sandbox, Pier runs one model arm at a time. Running arms together would make
  two 8 GiB task/verifier environments compete inside a 16 GiB worker.
- **The gap:** The user requested five runs per arm but did not specify inner
  scheduling.
- **The reach:** Pairing remains task-local, while wall-clock time falls through
  safe outer concurrency.
- **Verdict:** Sound; it uses the available parallelism without introducing
  memory contention between arms.
- **Confidence:** High.

### Support every product gateway credential at the Pier boundary

- **When:** Six-arm five-task tranche.
- **The choice:** Benchmark workers forward whichever of the product-supported
  Duet, Vercel AI Gateway, or OpenRouter credentials are present, and Pier
  allows egress only to those three gateway domains. The alternative would make
  the benchmark depend on a Duet-only key even though normal product model
  resolution supports the other gateways.
- **The gap:** The initial adapter handled only `DUET_API_KEY`, while this
  machine has a Vercel AI Gateway key.
- **The reach:** DeepSWE and SWE-bench now share one provider-credential owner
  and cannot drift on which gateway keys are supported.
- **Verdict:** Sound; it restores the normal product routing contract without
  changing model behavior.
- **Confidence:** High.

### Require all six outcomes before publishing a complete report

- **When:** Six-arm five-task tranche.
- **The choice:** A report fails its completeness gate if any selected task is
  missing any configured arm, including standalone Opus or Fable. The
  alternative would let the paired advisor table look complete while a
  standalone baseline silently used fewer tasks.
- **The gap:** The earlier completion gate only understood advisor pairs.
- **The reach:** Resolve and cost comparisons always use the same task
  denominator.
- **Verdict:** Sound; it prevents partial data from becoming a headline.
- **Confidence:** High.
