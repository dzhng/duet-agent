import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { formatCompactJson } from "../lib/compact-json.js";

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
  newVersionNotice?: string;
}

/**
 * Convert a persisted agent transcript into transcript-ready blocks.
 *
 * Tool calls and their tool results are stitched back together by id so the
 * resumed view matches what the live runner renders during a turn — running
 * spinner first, then `✓`/`✗` plus result body once the result arrives.
 */
export function historyDisplayBlocks(history: readonly AgentMessage[]): HistoryDisplayBlock[] {
  const blocks: HistoryDisplayBlock[] = [];
  const activeToolBlockIndexes = new Map<string, number>();
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
          const input =
            block.arguments === undefined ? "" : `\n${formatCompactJson(block.arguments)}`;
          activeToolBlockIndexes.set(block.id, blocks.length);
          blocks.push({ kind: "tool", content: `[tool ${block.name}] ⏳${input}` });
        }
      }
      if (message.errorMessage) {
        blocks.push({ kind: "error", content: `[error]\n${message.errorMessage}` });
      }
    } else if (message.role === "toolResult") {
      const text = textFromHistoryContent(message.content);
      const existingIndex = activeToolBlockIndexes.get(message.toolCallId);
      const marker = message.isError ? "✗" : "✓";
      const label = message.isError ? "[error]" : "[result]";
      if (existingIndex !== undefined) {
        const existing = blocks[existingIndex]!;
        const [, ...inputLines] = existing.content.split("\n");
        const input = inputLines.length > 0 ? `\n${inputLines.join("\n")}` : "";
        existing.kind = message.isError ? "error" : "tool";
        existing.content = text
          ? `[tool ${message.toolName}] ${marker}${input}\n${label}\n${text}`
          : `[tool ${message.toolName}] ${marker}${input}`;
        activeToolBlockIndexes.delete(message.toolCallId);
      } else {
        const content = text
          ? `[tool ${message.toolName}] ${marker}\n${label}\n${text}`
          : `[tool ${message.toolName}] ${marker}`;
        blocks.push({ kind: message.isError ? "error" : "tool", content });
      }
    }
  }
  return blocks;
}

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
  if (input.newVersionNotice) lines.push(input.newVersionNotice);
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
