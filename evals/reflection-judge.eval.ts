import { describe, expect } from "bun:test";
import { testIfDocker } from "../test/helpers/docker-only.js";
import {
  judgeConcreteIdentifiers,
  judgeDistinctInsights,
  judgeNarrativeShape,
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
  // 1. Cause → investigation → fix → lesson.
  "2026-05-15: An `/answer` 400 surfaced on staging because requests were occasionally reading `metadata.json` while a different write was in progress, yielding truncated JSON that parsed as `null` and was mistaken for `Session not found`. Investigation traced it to `packages/agent-gateway/src/session-store.ts`, where `SessionStore.save()` wrote in place and `load()` swallowed every parse error. The fix made `save()` atomic via a temp file + `rename()` and narrowed `load()` to swallowing `ENOENT` only, after which two consecutive green staging runs (commit `fc197bdff`) closed the loop. The durable lesson: any concurrently-read JSON file must be written via rename-on-close, and loaders should never swallow errors broadly enough to hide a half-written file.",
  // 2. Trigger → tried-and-rejected paths → decision → rationale.
  "2026-05-15: Anthropic streams started ending before `message_stop` often enough to terminate sessions, and an earlier gateway-side reset was considered but rejected because it lost too much in-flight state. Instead `src/turn-runner/transient-error.ts` was widened to classify the literal `stream ended` substring as transient, so `TurnRunner.retryTransientServerErrors` could call `agent.continue()` and resume in-place. The fix shipped in v0.1.131 along with a regression test pinning the exact `Anthropic stream ended before message_stop` error string, on the principle that transient classification belongs as close to the streaming boundary as possible.",
  // 3. Migration story with multiple breakage classes and lesson.
  "2026-05-15: The Vitest 4 upgrade began as a single monorepo-wide bump from `^1.6.0` to `^4.1.6` across eight workspace packages, but verification immediately exposed three separate breakage classes: `apps/web` JSX parse failures under rolldown-vite (fixed by bumping `@vitejs/plugin-react` to `^6.0.2` and renaming three JSX-bearing `.test.ts` files to `.test.tsx`), `packages/ui` using unresolved `NodeJS.Timeout` (switched to `ReturnType<typeof setTimeout>`), and `packages/backend` still on the removed `environmentMatchGlobs` API (migrated to `test.projects`). The work shipped as commit `885746567` to `staging`. The durable takeaway is that major test-runner upgrades are iterative migrations per workspace, not one bump, because each workspace can fail for a different reason even when `bun install` resolves cleanly.",
  // 4. Tool-validation narrative.
  "2026-05-15: Bundled ripgrep support was confirmed by checking that `rg` resolved to `node_modules/@vscode/ripgrep-darwin-arm64/bin/rg` rather than the system binary, which mattered because the alternative was carrying a postinstall script just to materialize a platform binary. Because `@vscode/ripgrep` ships as an optional platform-specific dependency, the package manager handled the right binary automatically and `duet upgrade` keeps working without lifecycle scripts. This validated the choice in v0.1.132 (commit `ad046b8`) and the broader principle that platform-specific optional deps are preferable to install hooks whenever the upstream package supports them.",
  // 5. Review finding with rationale.
  "2026-05-16: A review of `src/turn-runner/built-in-skills.ts` flagged the JSDoc on `BUILTIN_PATH_PREFIX` as misleading because it implied the prefix was the detection mechanism, when detection actually happens via the `BUILT_IN_BY_PATH` map. The comment was rewritten to describe the prefix as a virtual sentinel for built-in `filePath`/`baseDir` values, and `bunx tsc --noEmit` confirmed cleanly afterward. The broader lesson logged: when a refactor moves the source-of-truth check, the surrounding JSDoc must be updated in the same commit or it silently rots into a misleading guide.",
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
    "judgeDistinctInsights returns valid=false when two rows cover the same insight",
    async () => {
      const result = await judgeDistinctInsights(DUPLICATE_ROWS);
      expect(result.valid, result.reason).toBe(false);
    },
    180_000,
  );
});
