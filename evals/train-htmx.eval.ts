import { describe, expect } from "bun:test";
import path from "node:path";

import { testIfDocker } from "../test/helpers/docker-only.js";
import { runTrainEval } from "./helpers/train.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";
const fixtureDir = path.join(import.meta.dir, "fixtures", "train-corpus-htmx");
const slug = "htmx-eval";

/**
 * Real-data train eval: drives `runTrainCommand` end-to-end against the
 * htmx corpus and proves the synthesized observation is grounded in
 * the actual fixture content.
 */
describe("train htmx", () => {
  testIfDocker(
    "synthesizes a grounded observation from the htmx corpus",
    async () => {
      const result = await runTrainEval({ fixtureDir, slug, model });

      expect(result.observation.priority).toBe("high");
      expect(result.observation.tags).toContain("train");
      expect(result.observation.kind).toBe("manual");
      expect(result.observation.sessionId).toBeUndefined();
      expect(result.observation.tags).toContain(`train:${slug}`);
      expect(result.observation.content.length).toBeGreaterThan(200);

      expect(result.headline.length).toBeGreaterThan(0);
      expect(result.headline.length).toBeLessThan(200);

      // Keyword grounding — concepts the model could not produce
      // without actually reading the htmx fixture.
      const haystack = result.observation.content.toLowerCase();
      const keywords = ["htmx", "hypermedia", "hx-", "swap", "ajax", "attribute"];
      const hits = keywords.filter((kw) => haystack.includes(kw));
      expect(hits.length).toBeGreaterThanOrEqual(2);
    },
    300_000,
  );
});
