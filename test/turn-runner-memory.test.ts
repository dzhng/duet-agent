import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";

class MemoryTransformTurnRunner extends TurnRunner {
  createMemoryTransformForTest(model: Model<any>) {
    return this.createMemoryTransform(model);
  }

  getMemorySnapshotForTest() {
    return this.memory.getSnapshot();
  }
}

describe("TurnRunner memory", () => {
  test("observational transform does not persist raw messages below observation threshold", async () => {
    const runner = new MemoryTransformTurnRunner({
      model: "anthropic:claude-opus-4-6",
      skillDiscovery: { includeDefaults: false },
      memory: { enabled: true },
    });
    const transform = runner.createMemoryTransformForTest({
      provider: "unknown",
      id: "test",
    } as Model<any>);
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Remember that the launch flag is called beta_checkout." }],
        timestamp: 1,
      },
    ];

    await transform(messages);

    const snapshot = await runner.getMemorySnapshotForTest();
    expect(snapshot).toMatchObject({
      observations: [],
      estimatedTokens: { observations: 0 },
    });
  });
});
