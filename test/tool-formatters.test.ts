import { describe, expect, test } from "bun:test";
import {
  assembleToolBlock,
  formatToolBlock,
  truncateReasoningBody,
} from "../src/tui/tool-formatters.js";
import { historyDisplayBlocks } from "../src/tui/history.js";

describe("tool formatters > bash", () => {
  test("renders the command on the header line", () => {
    const formatted = formatToolBlock({
      toolName: "bash",
      status: "running",
      input: { command: "rg foo" },
      mode: "live",
    });
    expect(formatted.header).toBe("$ rg foo");
    expect(formatted.body).toBeUndefined();
    expect(formatted.hidden).toBeFalsy();
  });

  test("moves multi-line commands and timeout into the body", () => {
    const formatted = formatToolBlock({
      toolName: "bash",
      status: "running",
      input: { command: "set -e\ncargo build", timeout: 600 },
      mode: "live",
    });
    expect(formatted.header).toBe("$ set -e");
    expect(formatted.body).toBe("cargo build\n(timeout 600s)");
  });

  test("includes the truncated result on completion", () => {
    const formatted = formatToolBlock({
      toolName: "bash",
      status: "completed",
      input: { command: "echo hi" },
      output: [{ type: "text", text: "hi\n" }],
      mode: "live",
    });
    expect(formatted.result).toEqual({ label: "[result]", body: "hi\n" });
  });
});

describe("tool formatters > read / edit / write", () => {
  test("read shows path and line range when provided", () => {
    expect(
      formatToolBlock({
        toolName: "read",
        status: "running",
        input: { path: "src/foo.ts" },
        mode: "live",
      }).header,
    ).toBe("read src/foo.ts");

    expect(
      formatToolBlock({
        toolName: "read",
        status: "running",
        input: { path: "src/foo.ts", offset: 100, limit: 20 },
        mode: "live",
      }).header,
    ).toBe("read src/foo.ts (lines 100–119)");
  });

  test("edit summarizes the number of replacements", () => {
    expect(
      formatToolBlock({
        toolName: "edit",
        status: "running",
        input: {
          path: "src/foo.ts",
          edits: [
            { oldText: "a", newText: "b" },
            { oldText: "c", newText: "d" },
          ],
        },
        mode: "live",
      }).header,
    ).toBe("edit src/foo.ts (2 edits)");
  });

  test("write shows the byte size of the new content", () => {
    expect(
      formatToolBlock({
        toolName: "write",
        status: "running",
        input: { path: "src/foo.ts", content: "hello" },
        mode: "live",
      }).header,
    ).toBe("write src/foo.ts (5 bytes)");
  });
});

describe("tool formatters > ask_user_question", () => {
  const input = {
    questions: [
      {
        question: "Pick one",
        options: [{ label: "Yes" }, { label: "No" }],
      },
    ],
  };

  test("hides itself in live mode so the terminal `ask` event owns the picker", () => {
    const formatted = formatToolBlock({
      toolName: "ask_user_question",
      status: "completed",
      input,
      output: [{ type: "text", text: "<answers>Yes</answers>" }],
      mode: "live",
    });
    expect(formatted.hidden).toBe(true);
    expect(formatted.header).toBe("[question]");
  });

  test("history mode renders questions plus the chosen answer", () => {
    const formatted = formatToolBlock({
      toolName: "ask_user_question",
      status: "completed",
      input,
      output: [{ type: "text", text: "<answers><Pick one>Yes</Pick one></answers>" }],
      mode: "history",
    });
    expect(formatted.hidden).toBeFalsy();
    expect(formatted.header).toBe("[question]");
    expect(formatted.body).toContain("Pick one");
    expect(formatted.body).toContain("• Yes");
    expect(formatted.body).toContain("• No");
    expect(formatted.result).toEqual({ label: "→", body: "Yes" });
  });
});

describe("tool formatters > todo_write", () => {
  test("renders todos inline and suppresses the redundant result echo", () => {
    const formatted = formatToolBlock({
      toolName: "todo_write",
      status: "completed",
      input: {
        merge: true,
        todos: [
          { id: "a", content: "Do thing", status: "in_progress" },
          { id: "b", content: "Other", status: "completed" },
        ],
      },
      output: [{ type: "text", text: "ignored echo" }],
      mode: "live",
    });
    expect(formatted.header).toBe("todo update (2)");
    expect(formatted.body).toBe("▸ a: Do thing\n✓ b: Other");
    expect(formatted.result).toBeUndefined();
  });
});

describe("tool formatters > state machine", () => {
  test("create_state_machine_definition renders a per-state roster", () => {
    const formatted = formatToolBlock({
      toolName: "create_state_machine_definition",
      status: "completed",
      input: {
        definition: {
          name: "release-pipeline",
          states: [
            { name: "verify", kind: "agent", prompt: "Run pre-publish checks." },
            { name: "wait-for-ci", kind: "poll", intervalMs: 900_000, command: "gh run list" },
            { name: "done", kind: "terminal", status: "completed", reason: "shipped" },
          ],
        },
        firstState: "verify",
      },
      output: [{ type: "text", text: "echoed definition" }],
      mode: "live",
    });
    expect(formatted.header).toBe("relay defined: release-pipeline");
    expect(formatted.body).toContain("firstState: verify");
    expect(formatted.body).toContain("◆ verify");
    expect(formatted.body).toContain("⟳ wait-for-ci");
    expect(formatted.body).toContain("every 15m");
    expect(formatted.body).toContain("■ done");
    expect(formatted.body).toContain("completed — shipped");
    // The roster body already shows everything; the result echo is suppressed.
    expect(formatted.result).toBeUndefined();
    expect(formatted.clamp).toBe(false);
  });

  test("select_state_machine_state renders verb, target, reason, and input", () => {
    const formatted = formatToolBlock({
      toolName: "select_state_machine_state",
      status: "completed",
      input: {
        decision: {
          kind: "run_state",
          state: "wait-for-ci",
          reason: "verify completed; polling CI",
          input: { runId: "12345" },
        },
      },
      output: [{ type: "text", text: "echo" }],
      mode: "live",
    });
    expect(formatted.header).toBe("→ run: wait-for-ci");
    expect(formatted.body).toContain("reason: verify completed; polling CI");
    expect(formatted.body).toContain("input:");
    expect(formatted.body).toContain("runId");
    expect(formatted.result).toBeUndefined();
  });

  test("select_state_machine_state maps terminal and fail kinds to friendly verbs", () => {
    const finalize = formatToolBlock({
      toolName: "select_state_machine_state",
      status: "completed",
      input: { decision: { kind: "terminal", state: "done" } },
      mode: "live",
    });
    expect(finalize.header).toBe("→ finalize: done");

    const fail = formatToolBlock({
      toolName: "select_state_machine_state",
      status: "completed",
      input: { decision: { kind: "fail", reason: "unrecoverable" } },
      mode: "live",
    });
    expect(fail.header).toBe("→ fail");
    expect(fail.body).toContain("reason: unrecoverable");
  });

  test("get_current_state_machine_state parses the JSON result", () => {
    const formatted = formatToolBlock({
      toolName: "get_current_state_machine_state",
      status: "completed",
      input: {},
      output: [
        {
          type: "text",
          text: JSON.stringify({
            currentState: "wait-for-ci",
            progress: { verify: 1, "wait-for-ci": 2 },
            historyCount: 5,
            history: [
              { type: "state_entered", state: "verify" },
              { type: "state_completed", state: "verify", status: "ok" },
              { type: "state_entered", state: "wait-for-ci" },
            ],
          }),
        },
      ],
      mode: "live",
    });
    expect(formatted.header).toBe("relay status — current: wait-for-ci");
    expect(formatted.body).toContain("progress: verify=1 wait-for-ci=2");
    expect(formatted.body).toContain("history (+2 earlier):");
    expect(formatted.body).toContain("state_completed verify (ok)");
    expect(formatted.result).toBeUndefined();
  });

  test("get_current_state_machine_state reports terminal status when present", () => {
    const formatted = formatToolBlock({
      toolName: "get_current_state_machine_state",
      status: "completed",
      input: {},
      output: [
        {
          type: "text",
          text: JSON.stringify({
            terminal: { status: "completed", reason: "release published" },
            historyCount: 0,
            history: [],
          }),
        },
      ],
      mode: "live",
    });
    expect(formatted.header).toBe("relay status — terminal: completed");
    expect(formatted.body).toContain("reason: release published");
  });
});

describe("tool formatters > unknown tools", () => {
  test("falls back to a generic [tool name] block with compact JSON input", () => {
    const formatted = formatToolBlock({
      toolName: "mystery",
      status: "running",
      input: { foo: "bar" },
      mode: "live",
    });
    expect(formatted.header).toBe("[tool mystery]");
    expect(formatted.body).toContain("foo");
    expect(formatted.body).toContain("bar");
  });
});

describe("truncateReasoningBody", () => {
  test("keeps short reasoning verbatim", () => {
    expect(truncateReasoningBody("a\nb")).toBe("a\nb");
  });

  test("collapses long reasoning to a single head line plus tail count", () => {
    const text = ["a", "b", "c", "d"].join("\n");
    expect(truncateReasoningBody(text)).toBe("a\n… (+3 more lines)");
  });
});

describe("historyDisplayBlocks > shared formatter parity", () => {
  test("bash tool_call + tool_result resume to the same shape as the live block", () => {
    const blocks = historyDisplayBlocks([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "bash",
            arguments: { command: "ls /tmp" },
          },
        ],
      } as never,
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: "file.txt" }],
      } as never,
    ]);

    expect(blocks).toHaveLength(1);
    const composed = assembleToolBlock(
      formatToolBlock({
        toolName: "bash",
        status: "completed",
        input: { command: "ls /tmp" },
        output: [{ type: "text", text: "file.txt" }],
        mode: "history",
      }),
      "✓",
    );
    expect(blocks[0]?.content).toBe(composed);
    expect(blocks[0]?.kind).toBe("tool");
  });

  test("ask_user_question tool_call + result render a [question] block in history", () => {
    const blocks = historyDisplayBlocks([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "ask-1",
            name: "ask_user_question",
            arguments: {
              questions: [
                {
                  question: "Pick one",
                  options: [{ label: "Yes" }, { label: "No" }],
                },
              ],
            },
          },
        ],
      } as never,
      {
        role: "toolResult",
        toolCallId: "ask-1",
        toolName: "ask_user_question",
        isError: false,
        content: [{ type: "text", text: "<answers><Pick one>Yes</Pick one></answers>" }],
      } as never,
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("tool");
    expect(blocks[0]?.content).toContain("[question]");
    expect(blocks[0]?.content).toContain("Pick one");
    expect(blocks[0]?.content).toContain("→\nYes");
  });
});
