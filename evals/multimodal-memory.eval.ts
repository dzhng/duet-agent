import { describe, expect } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ImageContent } from "@earendil-works/pi-ai";
import { createObservationalMemoryTransform } from "../src/memory/observational.js";
import { MemoryStore } from "../src/memory/store.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

describe("multimodal memory", () => {
  testIfDocker(
    "observes visual details from compacted image messages",
    async () => {
      const memory = new MemoryStore();
      const transform = createObservationalMemoryTransform({
        memory,
        actorModel: model,
        settings: {
          observation: {
            messageTokens: 5,
            maxTokensPerBatch: 200,
            bufferActivation: 1,
            instruction:
              "For this eval, preserve the visual color and shape from attached images when they are relevant.",
          },
          reflection: {
            observationTokens: 1_000,
            bufferActivation: 500,
          },
        },
      });

      await transform([
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
      ]);

      const snapshot = await memory.getSnapshot();
      const observations = snapshot.observations
        .map((observation) => observation.content)
        .join("\n");

      expect(observations).toContain("image-memory-472");
      expect(observations.toLowerCase()).toContain("red");
      expect(observations.toLowerCase()).toMatch(/square|rectangle/);
    },
    30_000,
  );
});

const redSquareImage: ImageContent = {
  type: "image",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC",
};
