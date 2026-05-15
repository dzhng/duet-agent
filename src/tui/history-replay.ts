import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextRenderable } from "@opentui/core";
import type { TranscriptEntry } from "./transcript-log.js";
import {
  type HistoryBlockKind,
  type HistoryDisplayBlock,
  historyDisplayBlocks,
  limitHistoryDisplayMessages,
} from "./history.js";
import { COLORS } from "./theme.js";

/**
 * Inputs to the resume replay step. Pulled out so the closures inside `runTui`
 * stay short and the (stateless) coordinator is testable in isolation.
 */
export interface HistoryReplayDeps {
  appendLine(content: string, fg: string): void;
  appendBlock(label: string | null, body: string, fg: string): TextRenderable[];
  recordTranscriptEntry(kind: TranscriptEntry["kind"], text: string): void;
  /** Capture the rendered lines of the most recently replayed user block
   *  so the sticky banner watcher can track its viewport visibility. */
  setLatestUserBlock(lines: readonly TextRenderable[]): void;
}

/**
 * Subset of `RunTuiInput` consumed by the replay coordinator. Kept structural
 * so callers can pass `RunTuiInput` directly without an adapter.
 */
export interface HistoryReplayInput {
  history?: AgentMessage[];
  /**
   * Trailing user-turn exchanges to surface in the visible transcript.
   * Undefined means "render everything"; `0` disables visible replay but
   * still seeds the copy-out log below.
   */
  resumeHistoryMessages?: number;
}

/**
 * Paints the trimmed display slice into the transcript ScrollBox and seeds
 * the copy-out log from the full history so `/copy all` and `/copy <N>` can
 * reach back further than what is actually rendered on resume.
 */
export function replayResumeHistory(deps: HistoryReplayDeps, input: HistoryReplayInput): void {
  const messages = input.resumeHistoryMessages ?? Number.POSITIVE_INFINITY;
  if (messages > 0 && input.history && input.history.length > 0) {
    const limited = limitHistoryDisplayMessages(historyDisplayBlocks(input.history), messages);
    if (limited.omittedBlocks > 0) {
      deps.appendLine(
        `[resume] showing last ${messages} message${messages === 1 ? "" : "s"} of prior session history`,
        COLORS.hint,
      );
    }
    for (const block of limited.blocks) {
      const lines = deps.appendBlock(null, block.content, colorForHistoryBlock(block.kind));
      if (block.kind === "user") deps.setLatestUserBlock(lines);
    }
  }

  // Seed the copy-out log from full resumed history (not the trimmed display
  // slice) so `/copy all` and `/copy <N>` can reach back further than what is
  // actually rendered in the transcript on resume.
  if (input.history && input.history.length > 0) {
    for (const block of historyDisplayBlocks(input.history)) {
      if (block.kind === "user") {
        // History blocks for users are formatted as `you:\n<text>`; strip the
        // label so the clipboard text matches what the user originally typed.
        const stripped = block.content.replace(/^you:\n?/, "");
        deps.recordTranscriptEntry("user", stripped);
      } else if (block.kind === "agent") {
        deps.recordTranscriptEntry("agent", block.content);
      }
    }
  }
}

function colorForHistoryBlock(kind: HistoryBlockKind): string {
  if (kind === "user") return COLORS.user;
  if (kind === "reasoning") return COLORS.reasoning;
  if (kind === "tool") return COLORS.tool;
  if (kind === "error") return COLORS.error;
  return COLORS.agent;
}

export type { HistoryDisplayBlock };
