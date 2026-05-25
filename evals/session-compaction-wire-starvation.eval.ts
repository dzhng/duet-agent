import { describe, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { testIfDocker } from "../test/helpers/docker-only.js";
import { capturedWirePayload } from "./helpers/capture-wire-payload.js";

/**
 * Real-data regression for session_VO5yjfS1vV6_.
 *
 * That session ended on a cold "I'm here \u2014 what would you like to work
 * on next?" greeting after ~90 turns of autonomous grep/read work
 * through `apiProviderRegistry` / model-resolution code. The diagnosis
 * in `evals/fixtures/session_VO5yjfS1vV6_/reproduce_and_diagnose.txt`
 * traced it to a stuck wire-shaping horizon: the post-horizon tail had
 * no user-role survivor, so `applyEvictionHorizon`'s orphan-head skip
 * collapsed the entire transcript.
 *
 * The production fix is forward-protective: `findEvictionHorizon` now
 * awaits a coverage hook before each eviction event so the unobserved
 * tail is drained into durable memory before any message leaves the
 * wire. Sessions stay healthy through compaction because the rendered
 * memory pack always covers what just got evicted.
 *
 * The fixture appends a fresh user follow-up at the end of the
 * captured state (`msg_user_fresh_followup`) to simulate the user
 * keeping the session alive after the cold-greeting moment. That is
 * the natural recovery path: any new user input pushes the wire back
 * into a healthy budget-walked shape \u2014 the stored horizon is below the
 * new message's timestamp, so the orphan-head skip lands on the
 * follow-up itself and the dispatch carries a real user turn for the
 * model to anchor against.
 */
describe("session_VO5yjfS1vV6_ wire starvation after compaction", () => {
  testIfDocker(
    "a fresh user follow-up dispatches the prompt alongside the durable memory pack",
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
        // Sanity: the captured fixture starts with the saved-on-disk
        // stuck horizon and the appended user follow-up at the tail.
        expect(payload.rawMessageCount).toBeGreaterThan(170);
        expect(payload.horizonBefore).toBeGreaterThan(0);

        // The fresh user follow-up is the only post-horizon survivor
        // after `applyEvictionHorizon`'s orphan-head skip lands on it,
        // so the dispatch carries exactly that one real user turn
        // alongside the synthetic memory prepends. The model anchors
        // to (a) the durable observation block describing the
        // thinking-traces fix and (b) the follow-up itself.
        expect(payload.retainedMessageCount).toBe(1);
        expect(payload.dispatchedHasRealUser).toBe(true);

        // Two synthetic prepends still ride the dispatch: durable
        // memory observations + the continuation hint.
        expect(payload.syntheticPrepends).toHaveLength(2);
        const kinds = payload.syntheticPrepends.map((p) => p.kind).sort();
        expect(kinds).toEqual(["continuation-hint", "observation-context"]);

        const observationsBlock = payload.syntheticPrepends.find(
          (p) => p.kind === "observation-context",
        );
        expect(observationsBlock).toBeDefined();
        // Memory pack remains non-trivially large \u2014 the model gets
        // both the durable thinking-traces summary AND the fresh
        // user follow-up to act on.
        expect(observationsBlock!.bytes).toBeGreaterThan(4_000);
        expect(observationsBlock!.preview.length).toBeGreaterThan(0);
      } finally {
        await dispose();
      }
    },
    60_000,
  );
});
