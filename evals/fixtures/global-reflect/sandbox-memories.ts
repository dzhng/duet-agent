/**
 * Real observations copied verbatim out of the running Duet sandbox's
 * `~/.duet/memory.db` global pool. Used as fixtures for the
 * `duet memory reflect` evals — see `evals/memory-reflect-*.eval.ts`.
 *
 * The shapes mirror what `appendObservation` accepts: id/createdAt/
 * lastUsedAt are filled in by the fixture helper, everything else
 * stays as it appears in the production store. Keep entries small and
 * representative; the goal is for an LLM reflector pass to recognize
 * duplicates, supersession chains, and durable signal — not to learn
 * the entire sandbox.
 */
import type { Observation } from "../../../src/types/memory.js";

export type SeedObservation = Omit<Observation, "id" | "createdAt" | "lastUsedAt"> & {
  /** Days before "now" the row was originally observed; used to seed created_at. */
  ageDays: number;
};

const SYSTEM_SOURCE = { kind: "system" } as const;

/**
 * 8 observations about Velgress shipping. Recorded across multiple
 * sessions over a single day, each restating "Velgress shipped to
 * https://velgress--team-aomni-com.duet.so/" with slightly different
 * phrasing. A good reflect pass should collapse this to one row.
 */
export const VELGRESS_DUPLICATES: SeedObservation[] = [
  {
    sessionId: "session_velgress_1",
    kind: "reflection",
    observedDate: "2026-05-17",
    timeOfDay: "06:25",
    priority: "high",
    source: SYSTEM_SOURCE,
    content:
      "✅ (2026-05-17 06:25) Velgress reached the deploy phase after a full state-machine build through research/design, scaffold, player physics, platform system, procgen, hazards/rising danger, powerups, juice/polish, audio, UI/screens/persistence, and QA pass.",
    tags: ["observational-memory", "reflection"],
    ageDays: 0.4,
  },
  {
    sessionId: "session_velgress_2",
    kind: "reflection",
    observedDate: "2026-05-17",
    timeOfDay: "06:27",
    priority: "high",
    source: SYSTEM_SOURCE,
    content:
      "(2026-05-17 06:27) Velgress shipped and deployed to the Duet gateway at https://velgress--team-aomni-com.duet.so/ with final commit `cac9bbc`; the game is now live as a static app under `~/public/velgress`.",
    tags: ["observational-memory", "reflection"],
    ageDays: 0.4,
  },
  {
    sessionId: "session_velgress_3",
    kind: "reflection",
    observedDate: "2026-05-17",
    timeOfDay: "06:28",
    priority: "high",
    source: SYSTEM_SOURCE,
    content:
      "✅ (2026-05-17 06:28) Velgress was built, QA'd, and deployed as a public Duet app at https://velgress--team-aomni-com.duet.so/ on branch/worktree `/home/app/dev/velgress`; final commit was `cac9bbc`.",
    tags: ["observational-memory", "reflection"],
    ageDays: 0.4,
  },
  {
    sessionId: "session_velgress_4",
    kind: "reflection",
    observedDate: "2026-05-17",
    timeOfDay: "07:36",
    priority: "medium",
    source: SYSTEM_SOURCE,
    content:
      "✅ (2026-05-17 07:36) Mobile polish was deployed as commit `0889436` on Velgress: real DOM touch controls replaced implicit zones, canvas fit was rewritten for coarse pointers and safe areas, touch-friendly state-screen buttons and top-right mute/pause icons were added.",
    tags: ["observational-memory", "reflection"],
    ageDays: 0.3,
  },
  {
    sessionId: "session_velgress_5",
    kind: "reflection",
    observedDate: "2026-05-17",
    timeOfDay: "06:28",
    priority: "low",
    source: SYSTEM_SOURCE,
    content:
      "(2026-05-17 06:28) QA found and fixed two issues before ship: missing glyphs in `PIXEL_FONT` that broke UI text, and a `BEST 351M` HUD pill overlapping the mute icon at 3-digit altitudes.",
    tags: ["observational-memory", "reflection"],
    ageDays: 0.4,
  },
  {
    sessionId: "session_velgress_6",
    kind: "reflection",
    observedDate: "2026-05-17",
    timeOfDay: "04:52",
    priority: "low",
    source: SYSTEM_SOURCE,
    content:
      "(2026-05-17 04:52) User requested Velgress (UFO 50) be built end-to-end via a state machine and made production-ready.",
    tags: ["observational-memory", "reflection"],
    ageDays: 0.5,
  },
  {
    sessionId: "session_velgress_7",
    kind: "reflection",
    observedDate: "2026-05-17",
    timeOfDay: "06:28",
    priority: "low",
    source: SYSTEM_SOURCE,
    content:
      "(2026-05-17 06:28) User indicated follow-up work could be started later, suggesting possible next business processes like leaderboard, daily-seed mode, more zones, or announcement post.",
    tags: ["observational-memory", "reflection"],
    ageDays: 0.4,
  },
  {
    sessionId: "session_velgress_8",
    kind: "reflection",
    observedDate: "2026-05-17",
    timeOfDay: "05:33",
    priority: "low",
    source: SYSTEM_SOURCE,
    content:
      "(2026-05-17 05:33) Current Velgress next state is `powerups` after platform-system completion.",
    tags: ["observational-memory", "reflection"],
    ageDays: 0.5,
  },
];

/**
 * 6 observations about the same iOS safe-area bug fix on PR #1335.
 * Several restate the same root cause + fix; reflect should keep
 * exactly one canonical row that preserves the PR number, file path,
 * and the `bottomInset` dependency-array fix.
 */
export const IOS_SAFE_AREA_DUPLICATES: SeedObservation[] = [
  {
    sessionId: "session_ios_1",
    kind: "reflection",
    observedDate: "2026-05-17",
    timeOfDay: "07:23",
    priority: "medium",
    source: SYSTEM_SOURCE,
    content:
      "(2026-05-17 07:23) User reported an iOS chat bug: the bottom safe area is sometimes not honored, causing the send button to clip at the bottom.",
    tags: ["observational-memory", "reflection"],
    ageDays: 0.3,
  },
  {
    sessionId: "session_ios_2",
    kind: "reflection",
    observedDate: "2026-05-17",
    timeOfDay: "07:38",
    priority: "high",
    source: SYSTEM_SOURCE,
    content:
      '✅ (2026-05-17 07:38) Fixed and shipped as PR #1335, "fix: honor bottom safe area in mobile chat composer (iOS)"; root cause was `MessageComposer`\'s `useAnimatedStyle` capturing `insets.bottom` as a stale JS constant, and the fix was to pass `bottomInset` in the deps array so the worklet re-registers when the safe area resolves/changes.',
    tags: ["observational-memory", "reflection"],
    ageDays: 0.3,
  },
  {
    sessionId: "session_ios_3",
    kind: "reflection",
    observedDate: "2026-05-17",
    timeOfDay: "07:38",
    priority: "medium",
    source: SYSTEM_SOURCE,
    content:
      "✅ (2026-05-17 07:38) Validation passed (`bun format`, `bun run check-types` in apps/mobile), CI was green, and the only file changed was `apps/mobile/src/components/messages/composer/index.tsx`.",
    tags: ["observational-memory", "reflection"],
    ageDays: 0.3,
  },
  {
    sessionId: "session_ios_4",
    kind: "reflection",
    observedDate: "2026-05-17",
    timeOfDay: "07:23",
    priority: "low",
    source: SYSTEM_SOURCE,
    content:
      "(2026-05-17 07:23) User reported an iOS chat bug: the bottom safe area is sometimes not honored, so the send button clips at the bottom.",
    tags: ["observational-memory", "reflection"],
    ageDays: 0.3,
  },
  {
    sessionId: "session_ios_5",
    kind: "reflection",
    observedDate: "2026-05-17",
    timeOfDay: "07:38",
    priority: "low",
    source: SYSTEM_SOURCE,
    content: "Only file touched was `apps/mobile/src/components/messages/composer/index.tsx`.",
    tags: ["observational-memory", "reflection"],
    ageDays: 0.3,
  },
  {
    sessionId: "session_ios_6",
    kind: "reflection",
    observedDate: "2026-05-17",
    timeOfDay: "07:38",
    priority: "low",
    source: SYSTEM_SOURCE,
    content:
      "(2026-05-17 07:38) The iOS safe-area bug was fixed and shipped in PR #1335; validation passed: `bun format`, `bun run check-types` for `apps/mobile`, and CI on PR succeeded; no actionable review comments remained after the bot window.",
    tags: ["observational-memory", "reflection"],
    ageDays: 0.3,
  },
];

/**
 * Durable user-identity fact: David's editing/coding preferences.
 * Should always survive a reflect pass even when the rest of the pool
 * is dominated by ephemeral task chatter.
 */
export const DURABLE_USER_FACTS: SeedObservation[] = [
  {
    sessionId: "session_user_facts_1",
    kind: "reflection",
    observedDate: "2026-05-01",
    timeOfDay: "10:00",
    priority: "high",
    source: SYSTEM_SOURCE,
    content:
      "🔴 User (David) prefers concise, opinionated answers and dislikes throat-clearing openers like 'Great question!' or 'Absolutely!'. Direct answers only.",
    tags: ["observational-memory", "reflection", "user-preference"],
    ageDays: 16,
  },
  {
    sessionId: "session_user_facts_2",
    kind: "reflection",
    observedDate: "2026-04-15",
    timeOfDay: "14:00",
    priority: "high",
    source: SYSTEM_SOURCE,
    content:
      "🔴 User (David) is the founder/CEO of Duet. PR titles must include author first name in `[name] type: description` format. Always run `bun format` before opening a PR.",
    tags: ["observational-memory", "reflection", "user-preference"],
    ageDays: 32,
  },
];

/**
 * Inbox-triage cron observations — every run that found 0 unread mail
 * recorded the same "nothing to do" line. Pure noise. Reflect should
 * collapse the entire run into at most one entry (or drop it).
 */
export const INBOX_NO_OP_DUPLICATES: SeedObservation[] = Array.from({ length: 8 }, (_, i) => ({
  sessionId: `session_inbox_${i}`,
  kind: "reflection" as const,
  observedDate: "2026-05-17",
  timeOfDay: `${String(i).padStart(2, "0")}:00`,
  priority: "low" as const,
  source: SYSTEM_SOURCE,
  content: `✅ (2026-05-17 ${String(i).padStart(2, "0")}:00) Ran the duet-email unread check; inbox was empty, so no mail needed triage, marking read, unsubscribe handling, or channel posting.`,
  tags: ["observational-memory", "reflection", "cron"],
  ageDays: 0.5 - i * 0.05,
}));

/**
 * Supersession chain: the same task ("/use-cases hero illustrations")
 * goes through five rounds. Only the final state should survive the
 * reflect pass; intermediate "round 1 shipped", "round 2 shipped" etc.
 * are stale and should be dropped (or summarized in a single line).
 */
export const SUPERSEDED_CHAIN: SeedObservation[] = [
  {
    sessionId: "session_uc_1",
    kind: "reflection",
    observedDate: "2026-05-17",
    timeOfDay: "04:38",
    priority: "medium",
    source: SYSTEM_SOURCE,
    content:
      "✅ (2026-05-17 04:38) Round 1: 6 use-cases hero PNGs generated in blog-cover style, wired into hub + 5 persona pages, leftover `*-hero.png` files cleaned up, commit `92e7387a` pushed.",
    tags: ["observational-memory", "reflection"],
    ageDays: 0.5,
  },
  {
    sessionId: "session_uc_2",
    kind: "reflection",
    observedDate: "2026-05-17",
    timeOfDay: "05:08",
    priority: "medium",
    source: SYSTEM_SOURCE,
    content:
      "✅ (2026-05-17 05:08) Round 2: Heroes regenerated with canonical Duet bean+cap mascot lock and action-driven poses; commit `a06b59aee` pushed to PR #1334.",
    tags: ["observational-memory", "reflection"],
    ageDays: 0.5,
  },
  {
    sessionId: "session_uc_3",
    kind: "reflection",
    observedDate: "2026-05-17",
    timeOfDay: "06:01",
    priority: "medium",
    source: SYSTEM_SOURCE,
    content:
      "✅ (2026-05-17 06:01) Round 3 shipped as commit `f3133f674`: all 6 heroes pushed harder into true ASCII / monospace-glyph art on PR #1334.",
    tags: ["observational-memory", "reflection"],
    ageDays: 0.4,
  },
  {
    sessionId: "session_uc_4",
    kind: "reflection",
    observedDate: "2026-05-17",
    timeOfDay: "07:05",
    priority: "medium",
    source: SYSTEM_SOURCE,
    content:
      "✅ (2026-05-17 07:05) Round 4: `small-businesses.png` and `operations.png` palette-normalized to white-on-black ASCII family; commit `42b829cd8`.",
    tags: ["observational-memory", "reflection"],
    ageDays: 0.3,
  },
  {
    sessionId: "session_uc_5",
    kind: "reflection",
    observedDate: "2026-05-17",
    timeOfDay: "07:29",
    priority: "high",
    source: SYSTEM_SOURCE,
    content:
      "✅ (2026-05-17 07:29) Final state: /use-cases hero set is consistent white-on-black ASCII across all 6 personas (hub, small-businesses, agencies, founders, sales-teams, operations); `small-businesses.png` is a distinct cafe storefront (commit `69d2f0d4f`) and `operations.png` is a conductor-with-gears scene (commit `3ff200578`). PR #1334 remains open and mergeable.",
    tags: ["observational-memory", "reflection"],
    ageDays: 0.3,
  },
];

/**
 * Strategic / durable decisions that must survive any prune. These
 * encode lasting cross-session policy the agent relies on.
 */
export const STRATEGIC_DECISIONS: SeedObservation[] = [
  {
    sessionId: "session_strat_1",
    kind: "reflection",
    observedDate: "2026-04-26",
    timeOfDay: "12:00",
    priority: "high",
    source: SYSTEM_SOURCE,
    content:
      "🔴 (2026-04-26) Confirmed decision: switch from Remotion to `github.com/heygen-com/hyperframes` for video/animation work. Use Hyperframes for any new video generation work.",
    tags: ["observational-memory", "reflection", "decision"],
    ageDays: 21,
  },
  {
    sessionId: "session_strat_2",
    kind: "reflection",
    observedDate: "2026-05-01",
    timeOfDay: "10:00",
    priority: "high",
    source: SYSTEM_SOURCE,
    content:
      "🔴 (2026-05-01) Plan mode removed: Plan mode feature is being deleted from runners, schema, and RPC protocol entirely. Do not reference, implement, or restore plan mode.",
    tags: ["observational-memory", "reflection", "decision"],
    ageDays: 16,
  },
];

/**
 * Tentative / speculative 🟢 chatter that the reflector is encouraged
 * to drop aggressively. Carries low signal even before stacking up.
 */
export const TENTATIVE_LOW_SIGNAL: SeedObservation[] = [
  {
    sessionId: "session_tent_1",
    kind: "reflection",
    observedDate: "2026-05-10",
    timeOfDay: "12:00",
    priority: "low",
    source: SYSTEM_SOURCE,
    content:
      "🟢 (2026-05-10) David exploring what to call the persistent state-machine concept — likes 'loops' but finds it incomplete. Also considering 'job'. Open discussion.",
    tags: ["observational-memory", "reflection"],
    ageDays: 7,
  },
  {
    sessionId: "session_tent_2",
    kind: "reflection",
    observedDate: "2026-05-08",
    timeOfDay: "12:00",
    priority: "low",
    source: SYSTEM_SOURCE,
    content: "🟢 (2026-05-08) Walter exploring live app build previews in chat. Architecture TBD.",
    tags: ["observational-memory", "reflection"],
    ageDays: 9,
  },
  {
    sessionId: "session_tent_3",
    kind: "reflection",
    observedDate: "2026-05-09",
    timeOfDay: "12:00",
    priority: "low",
    source: SYSTEM_SOURCE,
    content:
      "🟢 (2026-05-09) AI gateway proxy may have a ~4.5MB max request body limit. Unverified/unresolved — needs investigation.",
    tags: ["observational-memory", "reflection"],
    ageDays: 8,
  },
];
