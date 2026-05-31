---
name: write-eval
description: Write a live eval for new or changed runner/agent behavior using red/green TDD plus a falsification check that proves the eval fails when the behavior is broken. Use whenever you add or modify behavior that should be covered by an eval, when asked to "write an eval", "add an eval", "cover this with an eval", or after landing a feature that needs end-to-end proof it works.
allowed-tools: Read Grep Glob Bash Edit Write
---

# Write an Eval

An eval is only trustworthy if you have seen it both **fail for the right reason** and **pass for the right reason**. Writing the assertions, watching them go green once, and moving on is how you ship an eval that passes whether or not the feature works. The standard operating procedure is: pick the outermost entry point, design the assertion so it can only hold when the behavior is present, watch it go green, then **falsify** — break the production code, confirm the eval goes red with a diagnostic that points at the real path, and restore.

This is the flow used to land `evals/state-machine-slash-skill-expansion.eval.ts`; read it as the reference implementation.

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
