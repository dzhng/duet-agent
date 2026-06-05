---
name: write-eval
description: Write a live eval for new or changed runner/agent behavior using red/green TDD plus a falsification check that proves the eval fails when the behavior is broken. Use whenever you add or modify behavior that should be covered by an eval, when asked to "write an eval", "add an eval", "cover this with an eval", or after landing a feature that needs end-to-end proof it works.
allowed-tools: Read Grep Glob Bash Edit Write
---

# Write an Eval

An eval is only trustworthy if you have seen it both **fail for the right reason** and **pass for the right reason**. Writing the assertions, watching them go green once, and moving on is how you ship an eval that passes whether or not the feature works. The standard operating procedure is: pick the outermost entry point, design the assertion so it can only hold when the behavior is present, watch it go green, then **falsify** — break the production code, confirm the eval goes red with a diagnostic that points at the real path, and restore.

This is the flow used to land `evals/state-machine-slash-skill-expansion.eval.ts`; read it as the reference implementation for a **deterministic wiring** eval (the feature either injects the right context or it doesn't).

When the behavior under test is a **model tendency** rather than deterministic wiring — "the planner doesn't over-reach into implementation", "the sub-agent doesn't drift into chat mode", anything a prompt layer nudges but cannot guarantee — the single-run flow is not enough, because one run is a coin flip. Read `evals/state-machine-agent-stays-in-state-scope.eval.ts` as the reference for that shape, and follow §6 below in addition to §1–5.

## 1. Drive the outermost entry point

Per AGENTS.md and the review skill (§13): test behavior through the surface a user actually hits, not internal helpers.

- A unit test on the pure function (e.g. `test/skill-context-resolve.test.ts` for `resolveSlashSkillPrompt`) proves the helper is correct. The **eval** proves the live wiring invokes it. Write the eval at the layer the unit test cannot reach — the real `TurnRunner` + `startTurn` flow, the CLI binary in JSONL mode, or a real `complete()` call.
- For state-machine behavior, drive a real `TurnRunner` with a `mode` definition and `startTurn` from `test/helpers/turn-runner-protocol.js`. `evals/state-machine-agent-cwd.eval.ts` and `evals/state-machine-slash-skill-expansion.eval.ts` are the templates.
- For CLI behavior, spawn `bun src/cli.ts` in JSONL mode and inspect the emitted events the same way a production subscriber would. `evals/inline-slash-commands.eval.ts` is the template.
- Collect tool calls and assistant text off `runner.subscribe` `step` events: `step.type === "tool_call" && step.status === "running"` for calls, `step.type === "text"` for text. Sub-agent (state) events carry `event.origin.kind === "state_machine_agent"`; parent events have no `origin`. Filter on `origin` to attribute a tool call to the right agent.

## 2. Design an assertion that can ONLY hold when the behavior is present

This is the part that makes the falsification check meaningful. A weak assertion ("the turn completed") passes regardless of the feature. Engineer the scenario so the only path to the asserted outcome runs through the behavior under test.

The slash-skill eval is the worked example:

- The skill body carries a **random token** (`HANDSHAKE-9Q4Z7K`) that appears **nowhere** in the skill's name or description — only in the body that expansion injects.
- The state prompt references the skill solely as `/secret-handshake` and **forbids tool use**.
- It asserts **both** that the output contains the token **and** that the sub-agent made **zero tool calls**.
- That conjunction is only satisfiable if expansion injected the body into the prompt. If expansion were broken, the only way to recover the token is a `read` of the SKILL.md — a tool call the assertion rejects.

Patterns for "only-if" assertions:

- **Unguessable sentinel in the place the behavior populates.** A random token the model cannot infer, planted only where the feature would put it. Assert it surfaces downstream.
- **Negative tool-call assertion.** When the feature should let the model answer _without_ doing work, assert the work (the tool call, the file read, the extra turn) did **not** happen. A feature that injects context up front shows up as the absence of the lookup that the broken path would need.
- **Distinguish the feature path from a plausible fallback.** Ask: "if the feature were silently disabled, could the model still pass by some other route?" If yes, close that route (forbid tools, scope skills, strip the fallback data) so the only remaining path is the feature.

## 3. Write it, run it GREEN

- Wrap the body in `testIfDocker` from `test/helpers/docker-only.js` — every eval that spawns a runner, writes files, or touches `$HOME` must use it.
- Pick the model with `const model = process.env.EVAL_MODEL ?? "sonnet-4.6"` so it can be re-routed without code edits.
- Disable skill discovery unless the eval needs it: `skillDiscovery: { includeDefaults: false }`. Pass only the skills the scenario requires via `skills: [...]`.
- Give the model a `systemInstructions` block that tells it this is a live eval and exactly which transitions to make, so the eval exercises the path deterministically.
- Set a generous timeout (120_000–150_000 for a planning/single-tool turn).
- Typecheck and lint, then run the single file inside the same container `bun run eval` uses, forwarding `DUET_API_KEY`:

  ```bash
  bunx tsc --noEmit && bunx oxlint evals/<name>.eval.ts
  docker run --rm -v "$PWD:/src:ro" -w /work \
    -e HOME=/tmp/home -e DUET_TEST_IN_DOCKER=1 -e DUET_API_KEY="$DUET_API_KEY" \
    oven/bun:1.3.11 sh -lc \
    'cp -R /src/. /work && bun install --frozen-lockfile >/dev/null 2>&1 && bun test ./evals/<name>.eval.ts'
  ```

  `bun run eval` runs _every_ eval and is wrong for fast iteration — target the one file.

## 4. Falsify — prove the eval goes RED when the behavior is broken

A green eval against working code proves nothing on its own. Break the production path, re-run, and confirm the eval fails — and that it fails _because of the behavior_, not some unrelated assertion.

```bash
# Back up the file you're about to break.
cp src/turn-runner/turn-runner.ts /tmp/tr-backup.ts
# Revert just the behavior under test — e.g. ship the un-expanded prompt.
sed -i.bak 's/await agent.prompt(expandedPrompt);/await agent.prompt(input.prompt);/' \
  src/turn-runner/turn-runner.ts
# Re-run the eval in docker. It MUST go red.
docker run --rm ... 'bun test ./evals/<name>.eval.ts'
```

Confirm the failure diagnostic implicates the real path. In the slash-skill case the broken run failed with `subAgentToolCalls` equal to `["recall_memory", "read"]` — the model was forced to hunt for the token exactly as predicted. That specificity is the signal the eval is wired to the behavior, not to a coincidence.

**Always dump the model's full output, never debug from the assertion message alone.** An `expect(...)` failure tells you _that_ a run was wrong, not _why_ — and the "why" is almost always in the parts of the transcript the assertion never inspected: the model's reasoning, its assistant text, and the exact arguments of every tool call. Before forming any theory about a red (or surprisingly green) run, log the whole transcript for each agent in the turn: every `step.type === "reasoning"` / `"text"` block and every tool call's full `step.input` (the parent's and each sub-agent's, separated by `event.origin.kind`). A throwaway harness that dumps this (see `scripts/debug-sm.ts`) earns its keep — it is how you discover the root cause is structural rather than probabilistic. The `firstState`-required fix came directly from this: the assertion only said "an extra select happened on the ack turn," but dumping the tool-call inputs showed GLM was nesting `firstState` _inside_ `definition`, so the runner's fallback silently ran the wrong first state. No amount of staring at the assertion message would have surfaced that — the malformed argument shape was only visible in the raw tool input. Treat the assertion as the tripwire and the dumped transcript as the evidence.

If the eval still passes with the behavior broken, the assertion is too weak — go back to step 2 and close the fallback path. Do not keep an eval that survives its own falsification.

Then restore and re-confirm green:

```bash
mv /tmp/tr-backup.ts src/turn-runner/turn-runner.ts && rm -f src/turn-runner/turn-runner.ts.bak
docker run --rm ... 'bun test ./evals/<name>.eval.ts'   # green again
```

For a behavior best falsified at the code level, an inline `sed` revert is fastest. When the break is in a fixture or prompt, edit that instead. Either way: red, diagnose, restore, green.

## 5. Leave the tree clean

- The only lasting change is the new eval file (plus whatever production code the eval covers). Confirm `git status` shows no stray `.bak` files or reverted production edits.
- If the eval covers a just-landed feature, this is also the moment to confirm the unit test and the eval are complementary, not redundant: the unit test pins the helper's output shape; the eval pins the live wiring. Keep both.

## 6. Model-tendency evals: find the edge, then loop

A prompt-layer fix ("don't over-reach", "stay in your state", "don't drift into chat mode") changes a _probability_, not a guarantee. A single run can pass on broken code (the bug didn't fire that time) or fail on fixed code (the nudge lost that time), so the §4 falsification is unreliable until you engineer the scenario to be both reproducible and decisive. Hard-won procedure:

- **Calibrate the bait against the BROKEN code first, before you trust the fix.** Disable the fix (the §4 `sed` revert) and run the scenario several times. You are hunting for a prompt that sits _on the edge of misinterpretation_: the broken path must over-reach a meaningful fraction of runs (aim ~40–60%), not 0% and not 100%.
  - **0% (no repro):** the prompt is too well-behaved — the verbatim real-world prompt often plans correctly in an isolated harness because there's no surrounding pressure. The eval would pass on broken code, so it proves nothing. Add a little more pull toward the bad behavior.
  - **100% AND the fix can't flip it:** you over-corrected into an _explicit order_ ("use the edit tool to change the file now"). That is no longer the bug under test — a prompt that literally commands the wrong action is a bad orchestrator prompt, and the layer neither can nor should override it. Back off to ambiguity.
  - **The edge** is genuine ambiguity: a prompt whose primary ask is correct (produce a spec/plan) but whose tail blurs into the next step ("…then implement it and confirm the edit is done — pass through to implementing"). The model resolves that tension the wrong way only sometimes. That "sometimes" is exactly the bug a context layer should eliminate. Note that a trailing handoff phrase alone ("pass through to implementing") often _reduces_ over-reach by giving the model an out — the bait needs wording that implies _this_ agent owns the result.
- **Loop the scenario and require EVERY run to be correct.** Once you have an edge prompt, run it `ITERATIONS` times (5 is a good default) in a `for` loop inside one `testIfDocker` body, collect each run's outcome, and assert the aggregate is clean (e.g. `expect(overReaches).toEqual([])`). With ~50% per-run failure, 5 runs catch a regression ~97% of the time. Set the test timeout to `ITERATIONS * per_run_ms`. Have each iteration use a fresh temp `cwd`/runner so runs don't contaminate each other, and log every iteration's tool calls so a red run names which iterations broke.
- **Lock the eval the moment it reliably reproduces, then switch to the fix.** Do not co-evolve the eval and the production fix — that way you can't tell which one moved. Order: tune the bait against broken code → confirm it goes red across the loop → freeze the eval file → restore/iterate the system fix until the _unchanged_ eval goes green. If you find yourself editing the eval after starting the fix, you've lost the falsification guarantee; stop and re-lock.
- **Keep the eval's comments honest about the bait.** If you tuned the closing line away from the verbatim prompt to sit on the edge, say so — don't claim it's "used verbatim". Document _why_ the wording is what it is (it implies this agent owns the result while also naming a handoff), so a future reader doesn't "simplify" it back off the edge.

Gotcha: editing the eval file while the read-only docker mount (`-v "$PWD:/src:ro"`) is mid-copy can surface a transient `Unexpected end of file` parse error. It's a race, not a real syntax error — re-run.
