import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { assembleToolBlock, formatToolBlock } from "./tool-formatters.js";

/**
 * Visual category for a transcript block. The TUI uses this to pick a color
 * when replaying history on resume; live events use their own color paths.
 */
export type HistoryBlockKind = "user" | "agent" | "reasoning" | "tool" | "error";

/** A single rendered transcript entry derived from a persisted agent message. */
export interface HistoryDisplayBlock {
  kind: HistoryBlockKind;
  /** Already-formatted multi-line content; no further processing in the renderer. */
  content: string;
}

/** Result of trimming history to fit a maximum line budget on resume. */
export interface LimitedHistory {
  /** The trailing blocks that fit inside the budget, in original order. */
  blocks: HistoryDisplayBlock[];
  /** Total number of lines that were dropped from the head of the history. */
  omittedLines: number;
}

/** Minimal field set needed to render the duet startup banner. */
export interface StartupHeaderInput {
  packageVersion: string;
  workDir: string;
  sessionId: string;
  modelName: string;
  modelSource?: string;
  memoryModelName: string;
  memoryModelSource?: string;
}

/**
 * Convert a persisted agent transcript into transcript-ready blocks.
 *
 * Tool calls and their tool results are stitched back together by id and run
 * through the shared per-tool formatter, so the resumed view matches what
 * the live runner renders during a turn — same header, same body, same
 * truncated result. Tools that hide themselves live (e.g. ask_user_question)
 * still surface in history because the terminal event that mirrored them
 * does not replay on resume.
 */
export function historyDisplayBlocks(history: readonly AgentMessage[]): HistoryDisplayBlock[] {
  const blocks: HistoryDisplayBlock[] = [];

  // Pending tool_call calls keyed by id. We store the assistant-side data
  // until the matching toolResult arrives so the formatter can run once with
  // both halves and produce a single combined block.
  interface PendingToolCall {
    /** Index in `blocks` if we already pushed a placeholder; -1 means no
     *  placeholder yet (the formatter would have hidden it live, but for
     *  history we still want to render it once the result arrives). */
    placeholderIndex: number;
    toolName: string;
    input: unknown;
  }
  const pending = new Map<string, PendingToolCall>();

  for (const message of history) {
    if (!("role" in message)) continue;
    if (message.role === "user") {
      const text = userMessageText(message.content);
      if (text) blocks.push({ kind: "user", content: `you:\n${text}` });
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text") {
          blocks.push({ kind: "agent", content: block.text });
        } else if (block.type === "thinking") {
          const trimmed = block.thinking.trim();
          if (trimmed) blocks.push({ kind: "reasoning", content: `[reasoning]\n${trimmed}` });
        } else if (block.type === "toolCall") {
          // Render a "still running" placeholder using the shared formatter so
          // the look matches what the live transcript shows mid-call. If the
          // matching toolResult never arrives (truncated history), the
          // placeholder remains as the final visible block.
          const formatted = formatToolBlock({
            toolName: block.name,
            status: "running",
            input: block.arguments,
            mode: "history",
          });
          if (formatted.hidden) {
            // Tools hidden live still get a block in history once the result
            // arrives; record the call without pushing a placeholder.
            pending.set(block.id, {
              placeholderIndex: -1,
              toolName: block.name,
              input: block.arguments,
            });
            continue;
          }
          const content = assembleToolBlock(formatted, "⏳");
          const placeholderIndex = blocks.length;
          blocks.push({ kind: "tool", content });
          pending.set(block.id, { placeholderIndex, toolName: block.name, input: block.arguments });
        }
      }
      if (message.errorMessage) {
        blocks.push({ kind: "error", content: `[error]\n${message.errorMessage}` });
      }
    } else if (message.role === "toolResult") {
      const text = textFromHistoryContent(message.content);
      const call = pending.get(message.toolCallId);
      const toolName = call?.toolName ?? message.toolName;
      const input = call?.input;
      const formatted = formatToolBlock({
        toolName,
        status: message.isError ? "error" : "completed",
        input,
        output: text ? [{ type: "text", text }] : [],
        mode: "history",
      });
      const marker = message.isError ? "✗" : "✓";
      const content = assembleToolBlock(formatted, marker);
      const kind: HistoryBlockKind = message.isError ? "error" : "tool";
      if (call && call.placeholderIndex >= 0) {
        const existing = blocks[call.placeholderIndex]!;
        existing.kind = kind;
        existing.content = content;
      } else {
        blocks.push({ kind, content });
      }
      pending.delete(message.toolCallId);
    }
  }
  return blocks;
}

/**
 * ASCII wordmark printed at the very top of the TUI on every startup.
 * Lines are returned individually so the renderer can color and append them
 * one-per-line without splitting; trailing whitespace is preserved verbatim.
 */
export const DUET_BANNER_LINES: readonly string[] = [
  "██████╗ ██╗   ██╗███████╗████████╗     █████╗  ██████╗ ███████╗███╗   ██╗████████╗",
  "██╔══██╗██║   ██║██╔════╝╚══██╔══╝    ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝",
  "██║  ██║██║   ██║█████╗     ██║       ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ",
  "██║  ██║██║   ██║██╔══╝     ██║       ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ",
  "██████╔╝╚██████╔╝███████╗   ██║       ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ",
  "╚═════╝  ╚═════╝ ╚══════╝   ╚═╝       ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ",
];

/**
 * 5-row compact wordmark for the boot screen. Built by taking the full
 * 6-row DUET_BANNER_LINES and dropping row 2 (the upper body), which
 * keeps the gap between the middle and bottom horizontals on letters
 * like `E` while preserving column alignment across `DUET AGENT`.
 */
export const DUET_BANNER_LINES_COMPACT: readonly string[] = [
  "██████╗ ██╗   ██╗███████╗████████╗     █████╗  ██████╗ ███████╗███╗   ██╗████████╗",
  "██║  ██║██║   ██║█████╗     ██║       ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ",
  "██║  ██║██║   ██║██╔══╝     ██║       ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ",
  "██████╔╝╚██████╔╝███████╗   ██║       ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ",
  "╚═════╝  ╚═════╝ ╚══════╝   ╚═╝       ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ",
];

/** Compose the duet startup banner for the TUI header. */
export function startupHeaderLines(input: StartupHeaderInput): string[] {
  const lines = [
    `[duet] v${input.packageVersion}`,
    `[cwd] ${input.workDir}`,
    `[session] ${input.sessionId}`,
    input.modelSource
      ? `[model] ${input.modelName} — ${input.modelSource}`
      : `[model] ${input.modelName}`,
    input.memoryModelSource
      ? `[memory model] ${input.memoryModelName} — ${input.memoryModelSource}`
      : `[memory model] ${input.memoryModelName}`,
  ];
  return lines;
}

/**
 * Trim a sequence of display blocks to fit `maxLines` total rendered lines.
 *
 * Walks back-to-front so the most recent context is kept; when the budget
 * lands mid-block, the trailing portion of that block is preserved and the
 * dropped line count is reported so the caller can render a "showing last N"
 * notice.
 */
export function limitHistoryDisplayBlocks(
  blocks: readonly HistoryDisplayBlock[],
  maxLines: number,
): LimitedHistory {
  if (maxLines <= 0) return { blocks: [], omittedLines: countHistoryLines(blocks) };

  const selected: HistoryDisplayBlock[] = [];
  let remaining = maxLines;
  let omittedLines = 0;

  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]!;
    const lines = block.content.split("\n");
    if (lines.length <= remaining) {
      selected.unshift(block);
      remaining -= lines.length;
      continue;
    }
    if (remaining > 0) {
      selected.unshift({ ...block, content: lines.slice(-remaining).join("\n") });
      omittedLines += lines.length - remaining;
      remaining = 0;
    } else {
      omittedLines += lines.length;
    }
  }

  return { blocks: selected, omittedLines };
}

function countHistoryLines(blocks: readonly HistoryDisplayBlock[]): number {
  return blocks.reduce((count, block) => count + block.content.split("\n").length, 0);
}

type UserHistoryContent = string | ReadonlyArray<{ type: string; text?: unknown }>;

function userMessageText(content: UserHistoryContent): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("");
}

function textFromHistoryContent(content: ReadonlyArray<TextContent | ImageContent>): string {
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
