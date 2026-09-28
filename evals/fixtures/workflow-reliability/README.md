# Workflow outcome fixtures

These tasks separate an agent's completion claim from observable results. The
editable app deliberately has a passing test that proves only an empty result;
the harness owns populated-query expectations and provider call receipts.
Provider nonces are generated after the agent finishes, so an earlier successful
reply cannot stand in for the verification request.

The [scenario manifest](scenarios.json) owns prompts and attempt limits.
[The package build](../../../scripts/build-workflow-fixtures.ts) publishes sorted
fixture bytes with their SHA256 alongside [the shared oracle](oracle.ts). Local
evals and deployed journeys consume those same bytes and oracle; they differ in
how they collect filesystem, Git, and HTTP evidence. The oracle is never copied
into the task's editable repository.

[The CLI eval](../../workflow-reliability.eval.ts) writes an immutable attempt
directory, including failures, below `EVAL_ARTIFACT_DIR` (default `tmp/`). Run it
in the Docker environment documented by the root README, after `bun run build`.
Select a scenario with the test runner's `-t` filter and a tier with `EVAL_MODEL`.
The caller owns the multi-tier/repetition matrix; this eval never retries a red
attempt. A failed provider variant is judged on truthful incomplete reporting,
while successful search and release variants require independent execution proof.

Report judgment is separate from task execution. The
[report evaluator](../../helpers/workflow-report.ts) reads the final assistant
acknowledgment, completed tool inputs/results, and exact user instructions; raw
streaming events remain evidence but are not duplicated into its prompt. It
writes the exact judgment input before calling the explicitly selected model,
then records an accepted report, a rejected report, or an unavailable evaluator.
An unavailable evaluator is rejudged from saved evidence, without repeating the
task or overwriting the original failure.
