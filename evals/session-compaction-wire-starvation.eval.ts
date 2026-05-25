import { describe, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { testIfDocker } from "../test/helpers/docker-only.js";
import { capturedWirePayload } from "./helpers/capture-wire-payload.js";

/**
 * Real-data regression for session_VO5yjfS1vV6_.
 *
 * That session ended on a cold "I'm here \u2014 what would you like to work
 * on next?" greeting after ~90 turns of grep/read work through
 * `apiProviderRegistry` / model-resolution code. The diagnosis in
 * `evals/fixtures/session_VO5yjfS1vV6_/reproduce_and_diagnose.txt`
 * traces it to three stacking bugs in wire-shaping + observational
 * memory: a steer with an out-of-order timestamp was evicted, the
 * orphan-head skip collapsed the entire post-horizon tail because no
 * `user` role survived, and the single local observation only covered
 * the early phase of the session.
 *
 * The eval reproduces the exact wire payload pi-agent would have
 * dispatched for the next turn by replaying the session state +
 * full memory dump through the production
 * `createObservationalContextTransform`. It asserts the
 * starvation shape directly:
 *
 *   - eviction horizon evicts ALL real `user` messages,
 *   - retained transcript collapses to zero messages,
 *   - dispatched payload contains only the two synthetic memory
 *     prepends, neither of which is a real user turn,
 *   - the observations block is non-trivially large (so the model is
 *     reading durable memory, not nothing).
 *
 * Any fix that lands here \u2014 pinning the last array-position user
 * message as un-evictable, refusing to advance the horizon past an
 * un-summarized range, or refusing to dispatch with no real user
 * turn \u2014 should flip the `retainedMessageCount > 0` and
 * `dispatchedHasRealUser === true` assertions green.
 */
describe("session_VO5yjfS1vV6_ wire starvation after compaction", () => {
  testIfDocker(
    "the dispatched payload for the next turn carries zero in-session transcript",
    async () => {
      const fixtureDir = join(import.meta.dir, "fixtures", "session_VO5yjfS1vV6_");
      const turnState = JSON.parse(await readFile(join(fixtureDir, "state.json"), "utf8"));
      const memoryDump = JSON.parse(await readFile(join(fixtureDir, "memory-dump.json"), "utf8"));

      const { payload, dispose } = await capturedWirePayload({
        turnState,
        memoryDump,
        sessionId: "session_VO5yjfS1vV6_",
      });

      try {
        // Sanity: the state we shipped really does have the horizon
        // past every real user message and the recent tool chain.
        expect(payload.rawMessageCount).toBeGreaterThan(170);
        expect(payload.horizonBefore).toBeGreaterThan(0);

        // The bug shape: the wire-shaping eviction wipes out every
        // real message. Anything > 0 here means a fix landed.
        expect(payload.retainedMessageCount).toBe(0);

        // The dispatch is non-empty (transform prepends synthetic
        // user messages from the durable memory pack) but carries no
        // real user turn from this session's transcript.
        expect(payload.dispatched.length).toBeGreaterThan(0);
        expect(payload.dispatchedHasRealUser).toBe(false);

        // Exactly the two synthetic prepends: observations + hint.
        expect(payload.syntheticPrepends).toHaveLength(2);
        const kinds = payload.syntheticPrepends.map((p) => p.kind).sort();
        expect(kinds).toEqual(["continuation-hint", "observation-context"]);

        const observationsBlock = payload.syntheticPrepends.find(
          (p) => p.kind === "observation-context",
        );
        expect(observationsBlock).toBeDefined();
        // Memory pack is non-trivially large \u2014 the model IS getting
        // user-shaped content, just no actual session transcript.
        // 4KB lower bound is comfortably under the actual size (tens
        // of KB) and high enough to fail loudly if the pack is empty.
        expect(observationsBlock!.bytes).toBeGreaterThan(4_000);

        // The local pack still mentions the EARLY thinking-traces
        // investigation, which is the misleading signal the model
        // anchors to when it generates "what would you like to work
        // on next?" \u2014 it sees a green \u2705 on completed work and no
        // recent transcript.
        expect(observationsBlock!.preview.length).toBeGreaterThan(0);
      } finally {
        await dispose();
      }
    },
    60_000,
  );
});
