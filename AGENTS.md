# Working in this repo

Read [`README.md`](README.md) first: what the product is, how the repo fits together, and how to build and check it. Active plans live with their specs, and each one says what to do next. If a folder you're working in has a readme, read it before continuing. The readmes are written for you.

These are the principles. Commands, flags and paths live with the code that owns them: the readmes, the manifests, and each tool's own usage text.

## Talking to the user

The user is very technical but doesn't read the code day to day. Pointing at code is fine; introduce a variable, function or module briefly the first time you mention it.

Lead with contracts. When work touches an interface between components (a command or the events it emits, the protocol a host speaks to the runner, a config field, a saved state shape, a module boundary), say what the contract looks like and how it changed before anything else.

Answer routine questions from the evidence. Ask the user only when the answer changes a decision that matters and can't be settled any other way.

## Proving a change

Optimize for iteration speed. The measure is the time to feedback you can trust, not the amount of process you ran.

Run the narrowest check that answers your question: one test, then one file, then one eval. That is the proof for everyday work, including a commit, a merge and a push.

**The full gates are for milestones only.** Running everything is slow and saturates the machine, so it happens at a milestone the plan names in advance (a spec's stated checkpoint, a release) and once when a spec is closed. It is not a step before each commit, merge or push, and never a feedback loop. An agent working on one piece of a plan does not run it; whoever integrates the plan does, at the milestone.

Between milestones, a change is checked by what it can move: its own tests and the output it touches. A failure found later at a milestone is fixed then; that is cheaper than gating every step.

Every expensive run must answer a question a cheaper one can't. Live evals, which call real models and cost money, and the whole suite in its container are the expensive runs here; do only the ones a change can move. Iterate on one eval, never the whole set. Reuse a result that is still valid, and rerun only what a change could have invalidated. Docs and data that no code reads need no run at all.

Write the test first. Before changing behaviour or fixing a bug, invoke [`write-tests`](.agents/skills/write-tests/SKILL.md) and follow its red/green workflow. Test what the product does and how it fails, not how the code is shaped.

An eval counts only once you have seen it fail for the right reason. Before writing or changing a live eval, invoke [`write-eval`](.agents/skills/write-eval/SKILL.md).

Prove behaviour through the command line when it can be reached there. It is the path users run, and it catches faults a lower-level call misses.

Tests and evals that write files, create databases or touch the home directory run in the disposable container, never on the host. If a focused host run leaves artifacts behind, fix the boundary; don't clean up after it or commit them.

When memory misbehaves, reproduce it in an eval from a dump of the real store. Never debug against a user's live store. Invoke [`debug-memory`](.agents/skills/debug-memory/SKILL.md).

A change that shouldn't alter behaviour (a refactor, a performance change) must leave the output unchanged, or be a named decision.

Never loosen a requirement to make a check pass. A narrow pass proves a narrow claim: say what you verified, what you assumed and what is unfinished.

Don't wait on a long run. Start it in the background and keep working. Give it a visible sign of progress and a point where you stop, and never repeat a failure unchanged.

## What the user sees

Look at the actual output. Run the command and read what a person at the terminal would see; a passing check is not evidence that it reads well.

For any visual change:

- get an unprimed second opinion with [`screenshot-critique`](.agents/skills/screenshot-critique/SKILL.md);
- judge before against after with [`compare-screenshots`](.agents/skills/compare-screenshots/SKILL.md);
- show the user with [`preview-shots`](.agents/skills/preview-shots/SKILL.md).

## How the harness is built

The runtime does not own persistence policy. Persistence fills the runtime's store before use, then listens for its changes.

Install scripts set up prerequisites. Runtime commands do runtime work.

The readme's design principles decide what belongs in the harness. Read them before adding a capability.

## Code that explains itself

Exported types and config fields are public documentation. Comment a field where it is declared: how it is used, what its values mean in operation, and what changes when it is set. Don't restate the type.

Never silence a signal from the compiler or the linter. Fix its cause.

Keep prompt and fixture text readable in source without letting source indentation leak into the content.

The finished code reads as if it was written from scratch by someone who already knew the current design: no stale names, no comments about earlier attempts, no leftover scaffolding. Before calling work done, invoke [`review`](.agents/skills/review/SKILL.md).

## One owner per concept

Use what the repo already chose before writing your own. Find the existing owner of a concept before creating another.

Import an upstream API directly. A local helper earns its place by adding this project's behaviour, not by re-exporting someone else's.

Check the one condition that matters. When a value becomes guaranteed, remove the fallbacks and null checks downstream of it. Unshipped scaffolding is replaced outright, with no compatibility shim.

Prefer one general rule to a special case, and a simple structure to an abstraction nobody needs yet. When something replaces an old mechanism, delete the old one. When a change exposes a duplicate or a stale owner, invoke [`refactor-clean`](.agents/skills/refactor-clean/SKILL.md).

## Parallel work stays cheap

Every parallel checkout is a full copy, and installed dependencies and build output multiply with each one.

- Share what doesn't change between checkouts. Don't make another copy.
- Never share build output between checkouts whose sources differ. They overwrite each other's builds, and the symptom is an error from someone else's change.
- Remove a checkout and its build output when its branch is merged.

## Skills

Skills hold the procedures behind these principles. Load the one that covers your work before you start. Keep them current: when a pass learns a lesson (a gotcha, a pattern that paid off, a rejected approach), add it to the owning skill in the same commit, following [`write-skills`](.agents/skills/write-skills/SKILL.md).

Before changing this file, invoke [`audit-agents`](.agents/skills/audit-agents/SKILL.md).
