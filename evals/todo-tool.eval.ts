import { describe, expect } from "bun:test";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import dedent from "dedent";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnTodo } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

describe("todo tool", () => {
  testIfDocker(
    "live model creates and updates todos through todo_write",
    async () => {
      const runner = new TurnRunner({
        model,
        mode: "agent",
        skillDiscovery: { includeDefaults: false },
        systemInstructions: dedent`
          You are evaluating the todo_write tool.
          You must use todo_write exactly as requested by the user before answering.
          Do not use any file or shell tools.
        `,
      });
      const todoEvents: TurnTodo[][] = [];
      runner.subscribe((event) => {
        if (event.type === "todos") {
          todoEvents.push(event.todos);
        }
      });

      const terminal = await (
        await startTurn(runner, {
          mode: "agent",
          prompt: dedent`
          Exercise the todo_write tool with these exact steps:

          1. Call todo_write with merge=false and two todos:
             - id: "design", content: "Design todo protocol", status: "in_progress"
             - id: "verify", content: "Verify todo eval", status: "pending"

          2. Then call todo_write with merge=true and two todos:
             - id: "design", content: "Design todo protocol", status: "completed"
             - id: "verify", content: "Verify todo eval", status: "in_progress"

          After the tool calls, answer with exactly: todo eval complete
        `,
        })
      ).turn;

      expect(terminal.type).toBe("complete");
      expect(todoEvents.length).toBeGreaterThanOrEqual(2);
      expect(todoEvents.at(0)).toEqual([
        { id: "design", content: "Design todo protocol", status: "in_progress" },
        { id: "verify", content: "Verify todo eval", status: "pending" },
      ]);
      expect(todoEvents.at(-1)).toEqual([
        { id: "design", content: "Design todo protocol", status: "completed" },
        { id: "verify", content: "Verify todo eval", status: "in_progress" },
      ]);
      expect(terminal.type === "complete" ? terminal.result : "").toContain("todo eval complete");
    },
    60_000,
  );
});
