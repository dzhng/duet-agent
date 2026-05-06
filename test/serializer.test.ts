import { describe, expect, test } from "bun:test";
import { assistantText } from "../src/core/serializer.js";
import { createAssistantMessage } from "./helpers/messages.js";

describe("assistantText", () => {
  test("returns only the latest assistant text", () => {
    expect(
      assistantText([
        createAssistantMessage({ text: "first", timestamp: 1 }),
        createAssistantMessage({ text: "second", timestamp: 1 }),
      ]),
    ).toBe("second");
  });
});
