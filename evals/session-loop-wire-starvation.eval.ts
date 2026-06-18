import { describe, expect } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { testIfDocker } from "../test/helpers/docker-only.js";
import { capturedWirePayload } from "./helpers/capture-wire-payload.js";

/**
 * Real-data regression for session_rUjMi_pUNzhB.
 *
 * That session ran away into a tight infinite loop: from message 334 on,
 * the assistant re-issued the SAME "let me check the current state / pick
 * up where we left off" orientation 242 times — git status, re-read
 * `packages/backend/convex/domains/kanban/definitions.ts`, re-run the
 * (already green) typecheck — never editing, never finishing, until the
 * user killed it. Full write-up in
 * `evals/fixtures/session_rUjMi_pUNzhB/reproduce_and_diagnose.txt`.
 *
 * Root cause is wire starvation. The eviction horizon advanced to
 * EXACTLY the timestamp of the last user turn (message 208, the literal
 * text "continue"). `applyEvictionHorizon` drops messages with
 * `timestamp <= horizon`, so that user turn is itself evicted, and every
 * one of the 1090 messages after it is the agent's own autonomous loop —
 * zero user-role survivors. The broken orphan-head skip then walked the
 * entire tail looking for a `user` message, found none, and collapsed
 * the wire to zero real messages. The model saw only the durable
 * observation block + the continuation hint, both static, so it
 * reconstructed the identical plan every turn, emitted only
 * assistant/tool messages (never a new user anchor), and the horizon
 * could never recover — a permanent loop.
 *
 * The fix keeps a recent, budget-bounded tail anchored on a
 * provider-valid head when no user turn survives, so the model sees its
 * own recent work and breaks out. This eval is the regression guard: it
 * is GREEN with the fix (a large post-horizon tail is never dispatched
 * as an empty transcript) and RED if applyEvictionHorizon regresses to
 * skipping to a user turn that does not exist — `retainedMessageCount`
 * collapses back to 0 and the `toBeGreaterThan(0)` assertion fails, which
 * IS the reproduction.
 *
 * Run via the docker eval harness so the path matches `bun run eval`:
 *
 *   docker run --rm -v "$PWD:/src:ro" -w /work -e HOME=/tmp/home \
 *     -e DUET_TEST_IN_DOCKER=1 \
 *     oven/bun:1.3.11 sh -lc 'cp -R /src/. /work && \
 *     bun install --frozen-lockfile >/dev/null 2>&1 && \
 *     bun test ./evals/session-loop-wire-starvation.eval.ts'
 */

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "session_rUjMi_pUNzhB");
const SESSION_ID = "session_rUjMi_pUNzhB";

function postHorizonUserCount(messages: AgentMessage[], horizon: number): number {
  return messages.filter(
    (m) => m.role === "user" && ((m as { timestamp?: number }).timestamp ?? 0) > horizon,
  ).length;
}

describe("session_rUjMi_pUNzhB infinite loop from wire starvation", () => {
  testIfDocker(
    "keeps a bounded, provider-valid recent tail on the wire instead of collapsing a huge post-horizon tail to empty",
    async () => {
      const [stateJson, dumpJson] = await Promise.all([
        readFile(join(FIXTURE_DIR, "state.json"), "utf8"),
        readFile(join(FIXTURE_DIR, "memory-dump.json"), "utf8"),
      ]);
      const turnState = JSON.parse(stateJson);
      const memoryDump = JSON.parse(dumpJson);

      const { payload, dispose } = await capturedWirePayload({
        turnState,
        memoryDump,
        sessionId: SESSION_ID,
      });

      try {
        const messages: AgentMessage[] = turnState.state.agent.messages;
        const horizon: number = turnState.state.wireGuardHorizon.evictionHorizon;

        // Fixture sanity: the runaway transcript is real and large — the
        // loop appended ~1090 autonomous turns, and not one of them is a
        // user turn. That zero-user tail is the structural trigger: the
        // horizon sits on the last user message, so `applyEvictionHorizon`'s
        // orphan-head skip has nothing to anchor on past it. These two are
        // properties of the captured data, not the code under test.
        expect(payload.rawMessageCount).toBe(1299);
        expect(postHorizonUserCount(messages, horizon)).toBe(0);

        // The invariant the runner must hold: a session with this much
        // post-horizon history must NOT be dispatched an empty transcript.
        // Against the broken code the transform collapsed all 1090 tail
        // messages to zero real messages and shipped only the two static
        // synthetic prepends, so the model re-planned identically every
        // turn and looped forever. The fix keeps a recent, budget-bounded
        // tail anchored on a provider-valid head, so the model sees its
        // own recent work and can break the loop.
        //
        // Not starved: real transcript messages ride the wire.
        expect(
          payload.retainedMessageCount,
          "wire starved: post-horizon messages collapsed to an empty dispatch",
        ).toBeGreaterThan(0);
        expect(payload.dispatched.length).toBeGreaterThan(2);

        // The retained head is provider-valid: never a leading orphan tool
        // result (a `toolResult` whose matching tool call was evicted). The
        // autonomous tail carries no user turn, so anchoring on an assistant
        // message is correct — the two synthetic prepends already give the
        // wire its user-role head.
        const firstReal = payload.dispatched[payload.syntheticPrepends.length];
        expect(firstReal?.role).not.toBe("toolResult");

        // Not overflowing: the budget walk still evicts the bulk of the
        // 1090-message tail, so the dispatch stays far under the effective
        // context window. Retaining a tail does NOT reintroduce unbounded
        // growth — it is bounded by the same `messageTokens` budget that
        // drove eviction in the first place.
        expect(payload.retainedMessageCount).toBeLessThan(payload.rawMessageCount);
        expect(payload.dispatchedTokens).toBeLessThan(120_000);
      } finally {
        await dispose();
      }
    },
    60_000,
  );
});
