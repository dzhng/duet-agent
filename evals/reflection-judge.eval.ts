import { describe, expect } from "bun:test";
import { testIfDocker } from "../test/helpers/docker-only.js";
import {
  judgeAlternativesConsidered,
  judgeConcreteIdentifiers,
  judgeDecisionAttribution,
  judgeDistinctInsights,
  judgeNarrativeShape,
  judgeProjectContext,
  judgeUserSteersPreserved,
} from "./helpers/reflection-judge.js";

/**
 * Judge-the-judge eval.
 *
 * Before `evals/memory-reflect-units.eval.ts` consumes the reflection
 * judges to grade live LLM reflector output, this eval drives each
 * judge against HAND-CRAFTED fixtures with known answers. If a judge
 * starts saying "fine" on a clearly-bare-headline set or "broken" on
 * a clearly-narrative set, we catch it here rather than seeing a
 * downstream eval false-pass / false-fail with no way to tell whether
 * the reflector or the judge is at fault.
 *
 * Each judge must be exercised by at least one positive (valid=true
 * expected) and one negative (valid=false expected) fixture. When a
 * judge prompt is tightened or loosened, add new fixtures here that
 * lock in the new boundary BEFORE wiring it into the unit eval.
 */

const BARE_HEADLINE_ROWS = [
  "2026-05-15: Released v0.1.131 on `main`.",
  "2026-05-15: CI passed twice on staging at commit `fc197bdff`.",
  "2026-05-15: Vitest upgrade was committed and pushed.",
  "2026-05-15: The `metadata.json` race was resolved.",
  "2026-05-16: Released v0.1.133, v0.1.134, and v0.1.135 on `main`.",
];

const NARRATIVE_ROWS = [
  // 1. Cause → investigation → fix → lesson — in the duet-agent monorepo.
  "2026-05-15: In the duet-agent monorepo, an `/answer` 400 surfaced on staging because requests were occasionally reading `metadata.json` while a different write was in progress, yielding truncated JSON that parsed as `null` and was mistaken for `Session not found`. Investigation traced it to `packages/agent-gateway/src/session-store.ts`, where `SessionStore.save()` wrote in place and `load()` swallowed every parse error. The fix made `save()` atomic via a temp file + `rename()` and narrowed `load()` to swallowing `ENOENT` only, after which two consecutive green staging runs (commit `fc197bdff`) closed the loop. The durable lesson: any concurrently-read JSON file must be written via rename-on-close, and loaders should never swallow errors broadly enough to hide a half-written file.",
  // 2. Trigger → tried-and-rejected paths → decision → rationale — duet-agent CLI.
  "2026-05-15: In duet-agent, Anthropic streams started ending before `message_stop` often enough to terminate sessions, and an earlier gateway-side reset was considered but rejected because it lost too much in-flight state. Instead the CLI's `src/turn-runner/transient-error.ts` was widened to classify the literal `stream ended` substring as transient, so `TurnRunner.retryTransientServerErrors` could call `agent.continue()` and resume in-place. The fix shipped in `@duetso/agent` v0.1.131 along with a regression test pinning the exact `Anthropic stream ended before message_stop` error string, on the principle that transient classification belongs as close to the streaming boundary as possible.",
  // 3. Migration story with multiple breakage classes and lesson — duet-web monorepo.
  "2026-05-15: The duet-web (Turborepo) monorepo's Vitest 4 upgrade began as a single workspace-wide bump from `^1.6.0` to `^4.1.6` across eight packages, but verification immediately exposed three separate breakage classes: `apps/web` JSX parse failures under rolldown-vite (fixed by bumping `@vitejs/plugin-react` to `^6.0.2` and renaming three JSX-bearing `.test.ts` files to `.test.tsx`), `packages/ui` using unresolved `NodeJS.Timeout` (switched to `ReturnType<typeof setTimeout>`), and `packages/backend` still on the removed `environmentMatchGlobs` API (migrated to `test.projects`). The work shipped as commit `885746567` to `staging`. The durable takeaway is that major test-runner upgrades are iterative migrations per workspace, not one bump, because each workspace can fail for a different reason even when `bun install` resolves cleanly.",
  // 4. Tool-validation narrative — duet-agent CLI.
  "2026-05-15: For the duet-agent CLI, bundled ripgrep support was confirmed by checking that `rg` resolved to `node_modules/@vscode/ripgrep-darwin-arm64/bin/rg` rather than the system binary, which mattered because the alternative was carrying a postinstall script just to materialize a platform binary. Because `@vscode/ripgrep` ships as an optional platform-specific dependency, the package manager handled the right binary automatically and `duet upgrade` keeps working without lifecycle scripts. This validated the choice in v0.1.132 (commit `ad046b8`) and the broader principle that platform-specific optional deps are preferable to install hooks whenever the upstream package supports them.",
  // 5. Review finding with rationale — duet-agent CLI.
  "2026-05-16: A review of duet-agent's `src/turn-runner/built-in-skills.ts` flagged the JSDoc on `BUILTIN_PATH_PREFIX` as misleading because it implied the prefix was the detection mechanism, when detection actually happens via the `BUILT_IN_BY_PATH` map. The comment was rewritten to describe the prefix as a virtual sentinel for built-in `filePath`/`baseDir` values, and `bunx tsc --noEmit` confirmed cleanly afterward. The broader lesson logged: when a refactor moves the source-of-truth check, the surrounding JSDoc must be updated in the same commit or it silently rots into a misleading guide.",
];

// Project-specific rows that name files / packages but NEVER name
// the repo or product. These read fine inside the original session
// but become ambiguous when read from a different working directory
// because every monorepo has `apps/web` and `packages/backend`.
// User steers from a real session: explicit push-backs and approvals
// that overrode defaults. These are the precedent the reflection has
// to preserve.
const SOURCE_STEERS = [
  "I think this is overengineered, simplify.",
  "We should not treat them as legacy — reframe as splitting large reflections into smaller ones.",
  "The cwd should actually be included in observations.",
];

// Steers-preserved positive: each steer surfaces somewhere as a
// quote or clear paraphrase attributed to the user.
const STEER_PRESERVING_ROWS = [
  '2026-05-18: In duet-agent, the first pass of the bump-prefers-atomic work added a runtime classifier with `isLegacyBlobReflection`, `findAtomicCoverage`, and `extractAlphanumericRuns` heuristics on top of `applyUsageBumps`. The user pushed back — "I think this is overengineered, simplify" — so the classifier was stripped and the preference was moved entirely into the observer prompt\'s narrowest-row rule, on the lesson that prompt-level guidance should be tried before runtime heuristics.',
  '2026-05-18: In duet-agent, an earlier framing of the bumping fixture used "legacy blob" language for big reflection rows; the user explicitly redirected, "we should not treat them as legacy — reframe as splitting large reflections into smaller ones", so the fixture and prompts were renamed to broad-summary / narrow-row terminology with no `legacy` vocabulary anywhere. The durable rule: don\'t characterize prior decisions as broken; characterize the new split as finer-grained.',
  '2026-05-18: In duet-agent\'s memory subsystem, observations and reflections did not carry the cwd, which the user pointed out as a real gap ("the cwd should actually be included"). The fix added a `cwd="…"` attribute to every `<observation-group>` wrapper, threaded the cwd from the turn runner through `updateObservationalMemory`, and updated the observer and global reflector prompts to anchor every project-specific row in its repo. The lesson: structured XML attributes survive reflection better than content-prose conventions.',
];

// Steers-preserved negative: the OUTCOME of acting on each steer is
// captured, but the steer language and user-attribution are gone.
const STEER_LOSING_ROWS = [
  "2026-05-18: The bump-prefers-atomic implementation was simplified to a prompt-only narrowest-row rule, removing the `isLegacyBlobReflection`, `findAtomicCoverage`, and `extractAlphanumericRuns` runtime helpers from `applyUsageBumps`.",
  "2026-05-18: The bumping fixture was renamed from `BLOB_REFLECTION` / `ATOMIC_REFLECTIONS` to `SUMMARY_REFLECTION` / `ATOMIC_REFLECTIONS` and the prompt language switched from broad/narrow blob/atomic terminology.",
  '2026-05-18: A `cwd="…"` attribute was added to `<observation-group>` wrappers and the observer / reflector prompts were updated to anchor project-specific rows.',
];

// Alternatives-considered positive: each row records a path that was
// tried, dropped, or weighed.
const ALTERNATIVE_RICH_ROWS = [
  "2026-05-15: In duet-agent, Anthropic streams ending before `message_stop` were terminating sessions. A gateway-side reset was considered first but rejected because it lost too much in-flight state; instead the transient classifier in `src/turn-runner/transient-error.ts` was widened to treat `stream ended` as transient so `TurnRunner.retryTransientServerErrors` could resume in-place. Shipped in v0.1.131.",
  "2026-05-15: In duet-agent's CI loop on staging, an `/answer` 400 was first investigated as an EPIPE / async-stdin issue in `runner-manager.ts` (commit `05ad9a191`) and later as a terminal-race timeout (commit `beb774830`), but the real cause was a `metadata.json` mid-write race in `packages/agent-gateway/src/session-store.ts`. The two earlier suspects were ruled out before `SessionStore.save()` was made atomic via temp file + `rename()` in `fc197bdff`.",
  "2026-05-18: For the reflection-judge work in duet-agent, regex / n-gram heuristics were tried first for narrative-shape detection but dropped because they were brittle on real reflector output; the eval was switched to LLM-as-judge calls, validated by a separate judge-the-judge eval (six positive/negative fixtures) before being consumed by `evals/memory-reflect-units.eval.ts`.",
];

// Alternatives-considered negative: rows describe only the chosen
// path, no rejected alternative.
const OUTCOME_ONLY_ROWS = [
  "2026-05-15: `src/turn-runner/transient-error.ts` widened transient classification to include `stream ended`, shipped in v0.1.131.",
  "2026-05-15: `SessionStore.save()` was made atomic via temp file + `rename()` in commit `fc197bdff` on staging.",
  "2026-05-18: Reflection-judge evals were added under `evals/helpers/reflection-judge.ts` and `evals/reflection-judge.eval.ts`.",
];

// Decision-attribution positive: every decision row attributes the
// decision to a concrete source.
const ATTRIBUTED_ROWS = [
  "2026-05-15: In duet-agent, the `metadata.json` mid-write race was traced from a recurring staging `/answer` 400 — the observed symptom forced the path. `SessionStore.save()` was made atomic via temp file + `rename()` in `fc197bdff` after the symptom narrowed the suspect to in-place writes.",
  '2026-05-18: The user redirected the bump-prefers-atomic work — "I think this is overengineered" — so the runtime classifier was stripped and the preference was implemented as a prompt rule. Per-user-steer attribution: the decision came from the user, not the agent.',
  '2026-05-18: Per AGENTS.md\'s "Prefer Direct, Local Guarantees", the redundant null check after `getOrCreateMemorySession()` was removed in `src/memory/observational.ts`. The convention was the explicit source.',
];

// Decision-attribution negative: decisions stated in passive voice,
// no source attribution.
const UNATTRIBUTED_ROWS = [
  "2026-05-15: `metadata.json` was made atomic via temp file + `rename()` in commit `fc197bdff`.",
  "2026-05-18: The bump-prefers-atomic runtime classifier was removed in favor of a prompt rule.",
  "2026-05-18: A redundant null check after `getOrCreateMemorySession()` was removed.",
];

const PROJECT_AMBIGUOUS_ROWS = [
  "2026-05-15: An `/answer` 400 was traced to `packages/agent-gateway/src/session-store.ts`, where `SessionStore.save()` wrote `metadata.json` in place and races with concurrent reads produced truncated JSON. The fix made `save()` atomic via temp file + `rename()` (commit `fc197bdff`).",
  "2026-05-15: Vitest was upgraded from `^1.6.0` to `^4.1.6` across eight workspace packages; `apps/web` needed `@vitejs/plugin-react` bumped to `^6.0.2` and three `.test.ts` files renamed to `.test.tsx`, `packages/ui` switched `NodeJS.Timeout` to `ReturnType<typeof setTimeout>`, and `packages/backend` migrated to `test.projects` (commit `885746567`).",
  "2026-05-16: `src/turn-runner/built-in-skills.ts` had its `BUILTIN_PATH_PREFIX` JSDoc rewritten to describe the prefix as a virtual sentinel rather than the detection mechanism (detection lives in the `BUILT_IN_BY_PATH` map).",
];

const IDENTIFIER_FREE_ROWS = [
  "The recent gateway work resolved a race condition that was causing some failures, and the team learned that atomic writes are important.",
  "A retry behavior was added to make stream truncation recoverable, because losing the session was felt to be too aggressive a response.",
  "The big test-runner upgrade revealed that different packages can fail in different ways, which is now treated as a normal expectation for major upgrades.",
];

const IDENTIFIED_ROWS = [
  "2026-05-15: `SessionStore.save()` was made atomic via temp file + `rename()` to close a race with concurrent reads in `packages/agent-gateway/src/session-store.ts`; the fix went out on commit `fc197bdff`.",
  "2026-05-15: `src/turn-runner/transient-error.ts` widened the transient classification to include the `stream ended` substring; shipped in v0.1.131 with a regression test covering `Anthropic stream ended before message_stop`.",
  "2026-05-15: `@vitejs/plugin-react` was bumped to `^6.0.2` to fix `apps/web` JSX parsing under rolldown-vite after the Vitest 4 upgrade; commit `885746567`.",
];

const DUPLICATE_ROWS = [
  "2026-05-15: The `metadata.json` mid-write race was closed by making `SessionStore.save()` atomic (temp file + `rename()`) and narrowing `load()` to swallow only `ENOENT`; the fix is commit `fc197bdff` on `staging`.",
  // Duplicate of #1: same cause→fix story, different wording.
  "2026-05-15: To fix the `/answer` 400 caused by reading `metadata.json` during a write, the SessionStore save path was changed to write a temp file then rename it, and the loader stopped swallowing non-ENOENT errors. Resolved in `fc197bdff`.",
  "2026-05-15: Anthropic stream truncation before `message_stop` was reclassified as transient in `src/turn-runner/transient-error.ts` so `TurnRunner.retryTransientServerErrors` could resume the stream; shipped in v0.1.131.",
];

const DISTINCT_ROWS = [
  "2026-05-15: `SessionStore.save()` was made atomic via temp file + `rename()` (commit `fc197bdff`) to close the `metadata.json` mid-write race.",
  "2026-05-15: Anthropic `stream ended` was reclassified as transient in `src/turn-runner/transient-error.ts` and shipped in v0.1.131 so streams can resume instead of resetting the session.",
  "2026-05-15: Vitest was upgraded monorepo-wide to `^4.1.6` (commit `885746567`), which surfaced three separate breakage classes across `apps/web`, `packages/ui`, and `packages/backend`.",
];

describe("reflection judges — judge the judge", () => {
  testIfDocker(
    "judgeNarrativeShape returns valid=true on narrative rows",
    async () => {
      const result = await judgeNarrativeShape(NARRATIVE_ROWS);
      expect(result.valid, result.reason).toBe(true);
    },
    180_000,
  );

  testIfDocker(
    "judgeNarrativeShape returns valid=false on bare-headline rows",
    async () => {
      const result = await judgeNarrativeShape(BARE_HEADLINE_ROWS);
      expect(result.valid, result.reason).toBe(false);
    },
    180_000,
  );

  testIfDocker(
    "judgeConcreteIdentifiers returns valid=true when every row has an identifier",
    async () => {
      const result = await judgeConcreteIdentifiers(IDENTIFIED_ROWS);
      expect(result.valid, result.reason).toBe(true);
    },
    180_000,
  );

  testIfDocker(
    "judgeConcreteIdentifiers returns valid=false on identifier-free rows",
    async () => {
      const result = await judgeConcreteIdentifiers(IDENTIFIER_FREE_ROWS);
      expect(result.valid, result.reason).toBe(false);
    },
    180_000,
  );

  testIfDocker(
    "judgeDistinctInsights returns valid=true on a set with no duplicates",
    async () => {
      const result = await judgeDistinctInsights(DISTINCT_ROWS);
      expect(result.valid, result.reason).toBe(true);
    },
    180_000,
  );

  testIfDocker(
    "judgeProjectContext returns valid=true when project-specific rows name their project",
    async () => {
      const result = await judgeProjectContext(NARRATIVE_ROWS);
      expect(result.valid, result.reason).toBe(true);
    },
    180_000,
  );

  testIfDocker(
    "judgeProjectContext returns valid=false on project-ambiguous rows",
    async () => {
      const result = await judgeProjectContext(PROJECT_AMBIGUOUS_ROWS);
      expect(result.valid, result.reason).toBe(false);
    },
    180_000,
  );

  testIfDocker(
    "judgeUserSteersPreserved returns valid=true when each steer is preserved",
    async () => {
      const result = await judgeUserSteersPreserved(STEER_PRESERVING_ROWS, SOURCE_STEERS);
      expect(result.valid, result.reason).toBe(true);
    },
    180_000,
  );

  testIfDocker(
    "judgeUserSteersPreserved returns valid=false when only outcomes survive",
    async () => {
      const result = await judgeUserSteersPreserved(STEER_LOSING_ROWS, SOURCE_STEERS);
      expect(result.valid, result.reason).toBe(false);
    },
    180_000,
  );

  testIfDocker(
    "judgeAlternativesConsidered returns valid=true on rows that record rejected paths",
    async () => {
      const result = await judgeAlternativesConsidered(ALTERNATIVE_RICH_ROWS);
      expect(result.valid, result.reason).toBe(true);
    },
    180_000,
  );

  testIfDocker(
    "judgeAlternativesConsidered returns valid=false on outcome-only rows",
    async () => {
      const result = await judgeAlternativesConsidered(OUTCOME_ONLY_ROWS);
      expect(result.valid, result.reason).toBe(false);
    },
    180_000,
  );

  testIfDocker(
    "judgeDecisionAttribution returns valid=true when every decision names its source",
    async () => {
      const result = await judgeDecisionAttribution(ATTRIBUTED_ROWS);
      expect(result.valid, result.reason).toBe(true);
    },
    180_000,
  );

  testIfDocker(
    "judgeDecisionAttribution returns valid=false on unattributed passive-voice decisions",
    async () => {
      const result = await judgeDecisionAttribution(UNATTRIBUTED_ROWS);
      expect(result.valid, result.reason).toBe(false);
    },
    180_000,
  );

  testIfDocker(
    "judgeDistinctInsights returns valid=false when two rows cover the same insight",
    async () => {
      const result = await judgeDistinctInsights(DUPLICATE_ROWS);
      expect(result.valid, result.reason).toBe(false);
    },
    180_000,
  );
});
