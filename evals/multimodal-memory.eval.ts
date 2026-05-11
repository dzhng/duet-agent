import { describe, expect } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ImageContent } from "@earendil-works/pi-ai";
import {
  DEFAULT_EFFECTIVE_CONTEXT,
  updateObservationalMemory,
} from "../src/memory/observational.js";
import { DEFAULT_CLI_MEMORY_MODEL } from "../src/model-resolution/resolver.js";
import { createMemoryFixture } from "../test/helpers/memory-fixture.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const memoryModel = DEFAULT_CLI_MEMORY_MODEL;

describe("multimodal memory", () => {
  testIfDocker(
    "observes visual details from compacted image messages",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await updateObservationalMemory({
          db: fixture.db,
          memory: fixture.cache,
          sessionId: "session_eval",
          effectiveContext: DEFAULT_EFFECTIVE_CONTEXT,
          actorModel: memoryModel,
          settings: {
            observation: {
              instruction:
                "For this eval, preserve the visual color and shape from attached images when they are relevant.",
            },
          },
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Remember the visual details in the attached image under marker image-memory-472.",
                },
                redSquareImage,
              ],
              timestamp: Date.now(),
            } satisfies AgentMessage,
          ],
        });

        const snapshot = await fixture.snapshot("session_eval");
        const observations = snapshot.observations
          .map((observation) => observation.content)
          .join("\n");

        expect(observations).toContain("image-memory-472");
        expect(observations.toLowerCase()).toContain("red");
        expect(observations.toLowerCase()).toMatch(/square|rectangle/);
      } finally {
        await fixture.dispose();
      }
    },
    30_000,
  );
});

const redSquareImage: ImageContent = {
  type: "image",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC",
};
