/**
 * Bumping eval fixture: contrasts a single broad summary reflection
 * against the same content split into narrow, unit-sized reflection
 * rows. Captured from a real `duet memory reflect --min-age-days 1
 * --dry-run` run so the eval is grounded in production-shaped output
 * rather than synthetic data.
 *
 * The summary form (`SUMMARY_REFLECTION`) is one row covering many
 * facts; the atomic form (`ATOMIC_REFLECTIONS`) is the same facts
 * split out so each row can be bumped or evicted on its own merits.
 * The eval asserts the observer cites the narrowest row that carries
 * each fact, so freshness-decay ranking stays meaningful.
 */
import { GLOBAL_REFLECTION_SESSION_ID } from "../../../src/memory/observational.js";
import type { SeedObservation } from "../global-reflect/sandbox-memories.js";

const SHARED = {
  kind: "reflection",
  priority: "high",
  sessionId: GLOBAL_REFLECTION_SESSION_ID,
  source: { kind: "agent" },
  tags: ["observational-memory", "reflection", "global-prune"],
  observedDate: "2026-05-16",
  ageDays: 5,
} as const satisfies Partial<SeedObservation>;

const SUMMARY_CONTENT = `<observation-group id="88fb308d6a1a5b25" range="msg_user_1778852873403_8fd4ebc8:msg_assistant_gen_01KRRFS770JA8RHWAHGYEC1YSK" kind="reflection">
[2026-05-15]
- CI green loop on staging resolved a gateway race in \`packages/agent-gateway\`: \`SessionStore.save()\` now writes atomically via temp file + \`rename()\`, and \`load()\` only swallows \`ENOENT\`; this fixed mid-write \`metadata.json\` truncation causing \`/answer\` 400s. Commit/push sequence: \`fc197bdff\` to \`staging\`, then CI passed twice consecutively (run \`25922744180\`, rerun \`76196398843\`).
- Prior gateway work before that included async stdin EPIPE mitigation in \`runner-manager.ts\` (\`05ad9a191\`) and a 30s per-test timeout for a terminal-race integration test (\`beb774830\`), but the eventual blocker was the \`/answer\` persisted \`TurnState\` path.
- Memory-observation formatting was adjusted so completed memory events are skipped when both \`observation\` and \`usageBumped\` are empty; otherwise the visible message remains \`Memory observation recorded.\` with optional \`Reinforced N prior memor{y,ies}.\` suffix. This was released in v0.1.130.
- duets/Anthropic retry work: \`src/turn-runner/transient-error.ts\` now treats \`Anthropic stream ended before message_stop\` / \`stream ended\` as transient, triggering \`TurnRunner.retryTransientServerErrors\` / \`agent.continue()\` retries instead of falling through to a failed-terminal reset. Released in v0.1.131.
- Recovery behavior clarified: on failed \`complete\`, \`src/session-controller.ts\` wipes \`turnState\`/pending state and the next \`/prompt\` starts fresh, but a one-shot \`<session-recovery>\` block is injected into the next turn's system prompt when \`pendingRecoveryNote\` exists; it is not a chat message and is cleared after use. Muted failures skip the error/recovery-note path entirely.
- Bundled ripgrep support: the repo has no postinstall/install script; \`@vscode/ripgrep\` ships via optional platform-specific deps, \`duet upgrade\` installs \`@duetso/agent\` normally, and the runtime can fall back to system \`rg\` if optional deps are absent. Verified \`rg\` resolves to bundled ripgrep binaries (\`ripgrep 15.0.0\`) and \`withBundledRipgrep\` is wired in \`src/turn-runner/tools.ts\`.
- Released v0.1.132 including bundled-ripgrep support (\`ad046b8\`), then v0.1.133, v0.1.134, and v0.1.135 on \`main\`, each with clean \`check-types\`/\`lint\` verification; v0.1.134 also included an earlier doc-comment clarification commit \`966589d\` about \`BUILTIN_PATH_PREFIX\` in \`src/turn-runner/built-in-skills.ts\`.
- Vitest 4 upgrade across monorepo: bumped all 8 workspace packages from \`^1.6.0\` to \`^4.1.6\`, refreshed \`bun.lock\`, fixed \`apps/web\` rolldown JSX parsing by bumping \`@vitejs/plugin-react\` to \`^6.0.2\` and renaming 3 JSX-containing \`.test.ts\` files to \`.test.tsx\`, fixed \`packages/ui\` by replacing \`NodeJS.Timeout\` with \`ReturnType<typeof setTimeout>\`, and migrated \`packages/backend/vitest.config.ts\` from removed \`environmentMatchGlobs\` to \`test.projects\` with shared test options. Final state: repo checks green, commit \`885746567\` rebased and pushed to \`staging\`, then a follow-up comment cleanup \`e898c780e\` was also committed/pushed.
- Remaining non-blocking warnings mentioned during CI/review: Node.js 20 action deprecation plus existing lint warnings (\`unexpected any\`, \`unexpected await\`, \`new Array(singleArgument)\`, empty spread fallback). Also one pre-existing \`apps/web\` \`MarkdownMetadata\` overload error surfaced during vitest 4 work but was later fixed by updating \`vi.fn\` generics in markdown editor tests; repo root \`check-types\`, \`lint\`, and \`test\` all passed afterward.
- Review notes from 2026-05-16: commit \`5bdf48748\` (duet skills CLI) had cleanup suggestions only: remove deprecated \`includeDescriptions\` prop/JSDoc and either use or drop speculative \`skill.scope\` plumbing. Revert commit \`108863115\` was verified to correctly remove answer-path image plumbing; a stale narrative doc comment in backend actions was the only noted cleanup follow-up.

[2026-05-16]
- Reviewed merged commits \`ca315b6\` and \`1e2cf6c\`; only issue found was a stale JSDoc in \`src/turn-runner/built-in-skills.ts\` describing \`BUILTIN_PATH_PREFIX\` as the detection mechanism. It was clarified to describe the prefix as a virtual sentinel while detection is via \`BUILT_IN_BY_PATH\`, and \`bunx tsc --noEmit\` passed afterward.

[Release markers]
- v0.1.130 released on \`main\` after the memory-observation formatting change.
- v0.1.131 released on \`main\` after transient Anthropic stream truncation retry fix.
- v0.1.132 released on \`main\` including bundled-ripgrep support.
- v0.1.133 released on \`main\` with clean check-types/lint.
- v0.1.134 released on \`main\` after the built-in-skills JSDoc clarification commit.
- v0.1.135 released on \`main\` with clean check-types/lint.
</observation-group>`;

/**
 * The broad single-row form: many facts inside one observation. If
 * the observer cites this row, every fact it covers gets refreshed
 * uniformly — even the ones the current turn never touched.
 */
export const SUMMARY_REFLECTION: SeedObservation = {
  ...SHARED,
  content: SUMMARY_CONTENT,
};

const ATOMIC_CONTENTS: string[] = [
  `[2026-05-15] CI green loop on staging resolved a gateway race in \`packages/agent-gateway\`: \`SessionStore.save()\` now writes atomically via temp file + \`rename()\`, and \`load()\` only swallows \`ENOENT\`; this fixed mid-write \`metadata.json\` truncation causing \`/answer\` 400s. Pushed as \`fc197bdff\` to \`staging\`; CI passed twice (run \`25922744180\`, rerun \`76196398843\`).`,
  `[2026-05-15] Earlier gateway fixes leading up to the CI-green loop: async stdin EPIPE mitigation in \`runner-manager.ts\` (commit \`05ad9a191\`) and a 30s per-test timeout for a terminal-race integration test (commit \`beb774830\`). The eventual blocker was the \`/answer\` persisted \`TurnState\` path.`,
  `[2026-05-15] Memory-observation formatting: completed memory events are now skipped when both \`observation\` and \`usageBumped\` are empty; otherwise the visible message stays \`Memory observation recorded.\` with optional \`Reinforced N prior memor{y,ies}.\` suffix. Released in v0.1.130.`,
  `[2026-05-15] Anthropic retry fix released in v0.1.131: \`src/turn-runner/transient-error.ts\` now treats \`Anthropic stream ended before message_stop\` and \`stream ended\` as transient, so \`TurnRunner.retryTransientServerErrors\` / \`agent.continue()\` retries instead of falling through to a failed-terminal reset.`,
  `[2026-05-15] Recovery behavior: on failed \`complete\`, \`src/session-controller.ts\` wipes \`turnState\`/pending state and the next \`/prompt\` starts fresh, but a one-shot \`<session-recovery>\` block is injected into the next turn's system prompt when \`pendingRecoveryNote\` exists. It is not a chat message and is cleared after use; muted failures skip the error/recovery-note path entirely.`,
  `[2026-05-15] Bundled ripgrep support: repo has no postinstall/install script; \`@vscode/ripgrep\` ships via optional platform-specific deps and \`duet upgrade\` installs \`@duetso/agent\` normally, with fallback to system \`rg\` if optional deps are absent. Verified \`rg\` resolves to bundled \`ripgrep 15.0.0\` and \`withBundledRipgrep\` is wired in \`src/turn-runner/tools.ts\`.`,
  `[2026-05-15] Release train on \`main\`: v0.1.132 included bundled-ripgrep support (commit \`ad046b8\`), followed by v0.1.133, v0.1.134, and v0.1.135 — each verified with clean \`check-types\`/\`lint\`. v0.1.134 also bundled doc-comment clarification commit \`966589d\` about \`BUILTIN_PATH_PREFIX\` in \`src/turn-runner/built-in-skills.ts\`.`,
  `[2026-05-15] Vitest 4 upgrade across the monorepo: bumped all 8 workspace packages from \`^1.6.0\` to \`^4.1.6\`, refreshed \`bun.lock\`, fixed \`apps/web\` rolldown JSX parsing by bumping \`@vitejs/plugin-react\` to \`^6.0.2\` and renaming 3 JSX-containing \`.test.ts\` files to \`.test.tsx\`, replaced \`NodeJS.Timeout\` with \`ReturnType<typeof setTimeout>\` in \`packages/ui\`, and migrated \`packages/backend/vitest.config.ts\` from removed \`environmentMatchGlobs\` to \`test.projects\`. Pushed as commit \`885746567\` with follow-up comment cleanup \`e898c780e\`.`,
  `[2026-05-15] Remaining non-blocking warnings: Node.js 20 action deprecation plus pre-existing lint warnings (\`unexpected any\`, \`unexpected await\`, \`new Array(singleArgument)\`, empty spread fallback). A pre-existing \`apps/web\` \`MarkdownMetadata\` overload error surfaced during the vitest 4 work and was fixed by updating \`vi.fn\` generics in markdown editor tests; repo-root \`check-types\`, \`lint\`, and \`test\` all passed afterward.`,
  `[2026-05-16] Review of commit \`5bdf48748\` (duet skills CLI): cleanup suggestions only — remove the deprecated \`includeDescriptions\` prop/JSDoc, and either use or drop the speculative \`skill.scope\` plumbing. Revert commit \`108863115\` was verified to correctly remove answer-path image plumbing; only follow-up was a stale narrative doc comment in backend actions.`,
  `[2026-05-16] Reviewed merged commits \`ca315b6\` and \`1e2cf6c\`: only issue was a stale JSDoc in \`src/turn-runner/built-in-skills.ts\` describing \`BUILTIN_PATH_PREFIX\` as the detection mechanism. Clarified to describe the prefix as a virtual sentinel while detection happens via \`BUILT_IN_BY_PATH\`; \`bunx tsc --noEmit\` passed afterward.`,
  `[Release markers] v0.1.130 (memory-observation formatting), v0.1.131 (transient Anthropic stream truncation retry fix), v0.1.132 (bundled-ripgrep support), v0.1.133 (clean check-types/lint), v0.1.134 (built-in-skills JSDoc clarification), and v0.1.135 (clean check-types/lint) all released on \`main\`.`,
];

/**
 * The atomic form: same insights as `SUMMARY_REFLECTION`, but
 * each unit-sized fact is its own row so the bumping eval can verify
 * that only the rows actually touched by a turn get bumped — not the
 * whole group.
 */
export const ATOMIC_REFLECTIONS: SeedObservation[] = ATOMIC_CONTENTS.map((content) => ({
  ...SHARED,
  content,
}));
