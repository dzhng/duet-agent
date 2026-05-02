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

- The harness runtime should not own persistence policy.
- Persistence should hydrate the concrete runtime store before use, then subscribe to store events for future writes.
- Install scripts set up prerequisites; runtime commands handle runtime work.

## Tests Should Prove Values

- Tests for normalization, deduplication, or idempotency should assert stored values, not only collection sizes.
- A length assertion can hide the wrong value being stored or the right value being dropped.

## Keep Prompt Literals Aligned

- Use `dedent` for multi-line prompts, markdown fixtures, and tool instruction strings in code.
- Keep indentation in source readable without letting template indentation leak into the prompt or fixture content.

## Review Before Finishing

- Check for stale names, stale comments, intermediary artifacts, unnecessary wrappers, and redundant guards.
- Run the relevant build, lint, format, and tests for the change.
- The final code should read as if it was written from scratch by someone who already knew the current design.
