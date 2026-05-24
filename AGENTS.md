# Agent Guidelines

## Treat Types As Documentation

- Type files and exported type declarations are part of the public documentation surface.
- Add comments where a field is declared, especially for config options and callback contracts.
- Explain how the field is used, what values mean operationally, and what changes when it is set.
- Prefer comments that document why a field exists or how downstream code interprets it.
- Avoid comments that only restate the type, such as "string value" or "array of items".

## Keep Names Current

- Names should describe what code does now, not what it used to do.
- After refactors, search for old names, stale comments, abandoned feature flags, and dead detection logic.
- Do not preserve compatibility shims for unshipped scaffold code. Replace the scaffold outright.

## Keep Comments Useful

- Keep comments for non-obvious behavior, platform quirks, invariants, and downstream consequences.
- Remove narrative comments about previous attempts, renamed code, or abandoned approaches.
- Remove comments that simply repeat the implementation.

## Prefer Direct, Local Guarantees

- Detection and guard logic should check the one condition that actually matters.
- When a value becomes guaranteed, remove redundant fallback code and stale null checks downstream.
- Prefer `const` over `let` when reassignment is not needed.
- Do not suppress signals with `_` parameters, `as any`, `@ts-ignore`, or lint disables. Fix the source issue.

## Avoid Thin Wrappers

- Do not create modules that only re-export another package.
- Import upstream APIs directly unless this project adds real semantics at the boundary.
- A local helper should earn its place by centralizing project-specific behavior.

## Keep Runtime And Persistence Separate

- The turn runner runtime should not own persistence policy.
- Persistence should hydrate the concrete runtime store before use, then subscribe to store events for future writes.
- Install scripts set up prerequisites; runtime commands handle runtime work.

## Tests Should Prove Values

- Tests for normalization, deduplication, or idempotency should assert stored values, not only collection sizes.
- A length assertion can hide the wrong value being stored or the right value being dropped.

## Run File-Writing Tests And Evals In Docker

- Use `bun run test` for the test suite and `bun run eval` for live evals. Do not use raw `bun test` as the source of truth.
- Prefer CLI-backed evals when behavior can be exercised through `bun src/cli.ts`; the CLI path is closest to production and catches mode, event, env, persistence, and model-routing issues that lower-level runner calls can miss.
- Tests that write files, create databases, touch `.duet`, or depend on the home directory must use `testIfDocker` so host-only focused runs skip them.
- If a focused host run creates runtime artifacts, fix the test/eval boundary instead of committing or relying on cleanup.

## Writing Live Evals

- Live evals run a real model against the runner. The shorthand (e.g. `sonnet-4.6`, `opus-4.7`) resolves through `PROVIDER_ORDER`, picking whichever credential is present: `DUET_API_KEY` (duet-gateway), `AI_GATEWAY_API_KEY` (vercel-ai-gateway), `OPENROUTER_API_KEY`, or `ANTHROPIC_API_KEY` (anthropic-direct). Forward `DUET_API_KEY` into the docker container — it is the credential the docker eval path is set up for. The other keys are fallbacks for laptop runs and may be stale.
- To iterate on one eval file, run it directly inside the same container `bun run eval` uses, e.g. `docker run --rm -v "$PWD:/src:ro" -w /work -e HOME=/tmp/home -e DUET_TEST_IN_DOCKER=1 -e DUET_API_KEY="$DUET_API_KEY" oven/bun:1.3.11 sh -lc 'cp -R /src/. /work && bun install --frozen-lockfile >/dev/null 2>&1 && bun test ./evals/<file>.eval.ts'`. The repo-wide `bun run eval` script runs every eval and is wrong for fast iteration.
- Wrap each eval body in `testIfDocker` from `test/helpers/docker-only.js`. Set a generous timeout (60–120s for planning-only evals, longer for evals that actually run tool calls).
- Pick the model with `const model = process.env.EVAL_MODEL ?? "sonnet-4.6"` so the same eval can be reroutered to opus / haiku / a custom shorthand without code edits.
- Disable skill discovery in evals that don't need it (`skillDiscovery: { includeDefaults: false }`) — it keeps the prompt cheap and stops local user skills from drifting the result.
- For planning-only evals, give the model an escape hatch: a terminal state named `eval_done` it can wire as the relay's `firstState`, plus a system instruction explaining the eval is planning-only and listing exactly which planning tools are allowed (`create_state_machine_definition`, `todo_write`). Without this the model can refuse the request or run real bash/edit calls.
- Routing evals ("did the model pick the right tool / field / shape?") subscribe to `runner.subscribe` and collect tool calls off the `step` events with `step.type === "tool_call"` and `step.status === "running"`. Assistant text comes through `step.type === "text"` (not `"assistant"`).
- A relay that wires the timer/poll as its `firstState` ends the turn in `terminal.type === "sleep"`, not `"complete"`. Assert `expect(["complete", "sleep"]).toContain(terminal.type)` for any eval that exercises a real wait — the same shape `evals/promised-wait-needs-state-machine.eval.ts` uses.
- When an eval fails because the model produced no tool calls and no text in 2–3 seconds, suspect an auth error before suspecting the prompt: inspect `terminal.state.agent.messages` for a `stopReason: "error"` and the provider response. Real model runs against `sonnet-4.6` are 5–20s for a single planning turn.

## Keep Prompt Literals Aligned

- Use `dedent` for multi-line prompts, markdown fixtures, and tool instruction strings in code.
- Keep indentation in source readable without letting template indentation leak into the prompt or fixture content.

## Reproduce Memory Bugs With Real Dumps

- When observational memory misbehaves (reflection, recall, observer extraction, freshness, eviction), dump the live store and reproduce in an eval. Do not debug against the user's running `~/.duet/memory.db` directly.
- `bun run scripts/dump-memory.ts` is the canonical dump tool. Filter with `--kind`, `--since`, `--until`, `--session`, `--priority`, `--tag`, and `--limit` to capture the smallest slice that reproduces the bug.
- Save the JSON under `evals/fixtures/` and load it with `seedObservations` from `evals/fixtures/global-reflect/seed.ts`. Write the failing eval first; tune prompts/code until it goes green.
- See `.agents/skills/debug-memory/SKILL.md` for the full playbook.

## Review Before Finishing

- Check for stale names, stale comments, intermediary artifacts, unnecessary wrappers, and redundant guards.
- Run the relevant build, lint, format, and tests for the change.
- The final code should read as if it was written from scratch by someone who already knew the current design.
