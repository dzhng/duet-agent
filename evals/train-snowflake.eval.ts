import { describe, expect } from "bun:test";
import path from "node:path";

import { testIfDocker } from "../test/helpers/docker-only.js";
import { runTrainEval } from "./helpers/train.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";
const fixtureDir = path.join(import.meta.dir, "fixtures", "train-corpus-snowflake");
const slug = "snowflake-eval";

/**
 * Real-data train eval: drives `runTrainCommand` end-to-end against the
 * Snowflake corpus and proves the synthesized observation is grounded
 * in the actual fixture content (i.e. the agent really read the files
 * instead of producing a generic blurb).
 */
describe("train snowflake", () => {
  testIfDocker(
    "synthesizes a grounded observation from the Snowflake corpus",
    async () => {
      const result = await runTrainEval({ fixtureDir, slug, model });

      // Row was persisted with the right shape.
      expect(result.observation.priority).toBe("high");
      expect(result.observation.tags).toContain("train");
      expect(result.observation.tags).toContain(`train:${slug}`);
      expect(result.observation.content.length).toBeGreaterThan(200);

      // Headline came back via the archive manifest.
      expect(result.headline.length).toBeGreaterThan(0);
      expect(result.headline.length).toBeLessThan(200);

      // Keyword grounding — these are concepts the model could not
      // produce without actually reading the Snowflake fixture.
      const haystack = result.observation.content.toLowerCase();
      const keywords = [
        "snowflake",
        "horizon catalog",
        "iceberg",
        "warehouse",
        "cortex",
        "unistore",
      ];
      const hits = keywords.filter((kw) => haystack.includes(kw));
      expect(hits.length).toBeGreaterThanOrEqual(2);
    },
    300_000,
  );
});
