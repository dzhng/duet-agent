import { type CliRenderer, type ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { formatElapsed, runningMarker, StatusController } from "./status-controller.js";
import { SIDEBAR_WIDTH } from "./sidebar.js";
import { COLORS } from "./theme.js";
import { assembleToolBlock, formatToolBlock, truncateReasoningBody } from "./tool-formatters.js";
import { TranscriptWriter } from "./transcript-writer.js";
import type { TurnEvent, TurnStep, TurnTokenUsage } from "../types/protocol.js";

/** In-flight streaming text or reasoning block. Replaced in place as
 *  successive `*_delta` steps arrive and finalized when the matching
 *  non-delta `text`/`reasoning` step lands. */
interface StreamingBlock {
  line: TextRenderable;
  label: string | null;
  body: string;
  /** Optional truncation applied to the body before render. Used by
   *  reasoning streams to keep the block to 3 visual lines (label + 2). */
  truncate?: (text: string) => string;
}

/** Rendered tool-call row. Tool calls emit a `running` event followed by a
 *  terminal `completed`/`error` event; both events update the same line so
 *  the spinner swaps to ✓/✗ inline instead of pushing a separate block. */
interface ToolBlock {
  line: TextRenderable;
  /** Formatter-produced header line, e.g. "$ ls /" or "[question]". The
   *  renderer prepends the spinner / completion marker live. */
  header: string;
  /** Optional input body lines shown under the header. */
  body: string;
  /** Original tool input, retained so the finalize pass can re-run the
   *  formatter with the output and produce a custom `result` section. */
  input: unknown;
  /** Wall-clock start so the running header can show a live elapsed
   *  counter and the finalized header can report total tool duration.
   *  Undefined when the first event we saw was already terminal
   *  (cached/replayed history), in which case we have no real duration. */
  startedAt: number | undefined;
}

export interface StepRendererOptions {
  renderer: CliRenderer;
  transcript: ScrollBoxRenderable;
  transcriptWriter: TranscriptWriter;
  statusController: StatusController;
  /** Invoked at the start of `renderStep` so a stale question picker
   *  panel is dismissed before the next agent activity lands; the next
   *  step supersedes the open question. */
  onStepStart?: () => void;
}

/**
 * Renders the streaming surface of a turn: text deltas, reasoning deltas,
 * tool-call blocks (live spinner → ✓/✗), memory phase banners, and the
 * post-turn usage / elapsed / sleep lines.
 *
 * Owns the in-flight stream/tool-block bookkeeping so the StatusController
 * ticker can call `refreshActiveToolBlocks()` to advance spinners without
 * cracking open the renderer state.
 */
export class StepRenderer {
  private activeTextStream: StreamingBlock | undefined;
  private activeReasoningStream: StreamingBlock | undefined;
  // Tool calls fire twice (running → completed/error). Track the rendered
  // block by toolCallId so the second event updates the same line in place
  // instead of pushing a separate block.
  private readonly activeToolBlocks = new Map<string, ToolBlock>();

  constructor(private readonly opts: StepRendererOptions) {}

  renderStep(step: TurnStep): void {
    this.opts.onStepStart?.();

    if (step.type === "text_delta") {
      this.activeTextStream = this.renderDelta(
        this.activeTextStream,
        null,
        step.delta,
        COLORS.agent,
      );
    } else if (step.type === "reasoning_delta") {
      this.activeReasoningStream = this.renderDelta(
        this.activeReasoningStream,
        "[reasoning]",
        step.delta,
        COLORS.reasoning,
        truncateReasoningBody,
      );
    } else if (step.type === "text") {
      this.opts.transcriptWriter.recordEntry("agent", step.text);
      if (this.activeTextStream) {
        this.finalizeDelta(this.activeTextStream, step.text);
        this.activeTextStream = undefined;
        return;
      }
      this.opts.transcriptWriter.appendBlock(null, step.text, COLORS.agent);
    } else if (step.type === "reasoning") {
      const trimmed = step.text.trim();
      if (this.activeReasoningStream) {
        this.finalizeDelta(this.activeReasoningStream, trimmed);
        this.activeReasoningStream = undefined;
        return;
      }
      if (trimmed) {
        this.opts.transcriptWriter.appendBlock(
          "[reasoning]",
          truncateReasoningBody(trimmed),
          COLORS.reasoning,
        );
      }
    } else if (step.type === "tool_call") {
      this.renderToolCall(step);
    } else if (step.type === "system") {
      this.opts.transcriptWriter.appendBlock("[system]", step.message, COLORS.system);
    }
  }

  /** Repaint every in-flight tool block header with a fresh spinner +
   *  elapsed counter. Invoked from StatusController's 1 s ticker so the
   *  spinner column advances in step with the working-status line. */
  refreshActiveToolBlocks(): void {
    if (this.activeToolBlocks.size === 0) return;
    const columns = this.toolBlockColumns();
    for (const block of this.activeToolBlocks.values()) {
      if (block.startedAt === undefined) continue;
      block.line.content = assembleToolBlock(
        { header: block.header, body: block.body || undefined },
        runningMarker(Date.now() - block.startedAt),
        { columns },
      );
    }
  }

  renderUsage(usage?: TurnTokenUsage): void {
    if (!usage) return;
    // Cumulative cost is updated on the session when the terminal event is
    // handled; sidebar refreshes from `getSessionCostUsd()` via `refreshSidebar`.
    // Tokens stay terse (just in/out) since the cost breakdown below is
    // where the cache wins actually matter. Cost is split across all four
    // buckets (in / out / cache read / cache write) so prompt-cache hits and
    // writes are visible at a glance; zero buckets collapse out.
    const tokens = `Tokens: in=${usage.input} out=${usage.output}`;
    const costParts = [
      ["in", usage.cost.input],
      ["out", usage.cost.output],
      ["cr", usage.cost.cacheRead],
      ["cw", usage.cost.cacheWrite],
    ]
      .filter(([, value]) => (value as number) > 0)
      .map(([label, value]) => `${label}=$${(value as number).toFixed(4)}`);
    const cost =
      usage.cost.total === 0
        ? ""
        : ` · Cost: $${usage.cost.total.toFixed(4)}${costParts.length > 1 ? ` (${costParts.join(" ")})` : ""}`;
    this.opts.transcriptWriter.appendLine(`[usage] ${tokens}${cost}`, COLORS.hint);
  }

  renderTurnElapsed(): void {
    const startedAt = this.opts.statusController.getWorkingStartedAt();
    if (startedAt === undefined) return;
    this.opts.transcriptWriter.appendLine(
      `● turn finished in ${formatElapsed(Date.now() - startedAt)}`,
      COLORS.status,
    );
  }

  // Sleep terminals replace the usual "turn finished" line because the session
  // is going back to sleep, not wrapping up. When a turn ran before the sleep
  // (e.g. an injected prompt while waiting on a state machine), include its
  // duration so the user can still see how long the work took.
  renderSleeping(wakeAt: number): void {
    const wakeLabel = new Date(wakeAt).toLocaleTimeString();
    const startedAt = this.opts.statusController.getWorkingStartedAt();
    const turnDuration =
      startedAt === undefined ? "" : ` · turn took ${formatElapsed(Date.now() - startedAt)}`;
    this.opts.transcriptWriter.appendLine(
      `● sleeping until ${wakeLabel}${turnDuration}`,
      COLORS.status,
    );
  }

  renderMemoryStatus(event: Extract<TurnEvent, { type: "memory" }>): void {
    if (event.status === "running") {
      this.opts.statusController.setWorkingMessage(event.message);
      return;
    }
    const body = formatMemoryEventBody(event);
    if (body) {
      this.opts.transcriptWriter.appendBlock(`[memory:${event.phase}]`, body, COLORS.memory);
    }
    if (this.opts.statusController.isRunning()) {
      this.opts.statusController.setWorkingMessage("working…");
    }
  }

  private renderDelta(
    block: StreamingBlock | undefined,
    label: string | null,
    delta: string,
    fg: string,
    truncate?: (text: string) => string,
  ): StreamingBlock {
    const next =
      block ??
      ({
        line: new TextRenderable(this.opts.renderer, { content: "", fg }),
        label,
        body: "",
        truncate,
      } satisfies StreamingBlock);
    if (!block) {
      this.opts.transcriptWriter.beginBlock();
      this.opts.transcript.add(next.line);
    }
    next.body += delta;
    updateStreamingBlock(next);
    return next;
  }

  // Render a tool call as a single, self-updating block. The first event
  // (`status: "running"`) creates the block with a spinner; the second event
  // (`completed` or `error`) replaces the spinner with ✓/✗ and appends the
  // truncated result inline so the call and its outcome stay visually paired.
  // Per-tool formatters in `tool-formatters.ts` decide the header text and
  // whether the call should appear in the transcript at all (e.g.
  // ask_user_question hides itself live and lets the `ask` terminal event
  // own the question display).
  private renderToolCall(step: Extract<TurnStep, { type: "tool_call" }>): void {
    const existing = this.activeToolBlocks.get(step.toolCallId);
    if (existing) {
      this.finalizeToolCall(step, existing);
      return;
    }

    const isLive = step.status === "running" || step.status === "pending";
    const formatStatus = isLive ? "running" : step.status === "error" ? "error" : "completed";
    const formatted = formatToolBlock({
      toolName: step.toolName,
      status: formatStatus,
      input: step.input,
      output: step.output,
      mode: "live",
    });
    if (formatted.hidden) return;

    const startedAt = isLive ? Date.now() : undefined;
    const marker = "⏳";
    const fg = step.status === "error" ? COLORS.error : COLORS.tool;
    const columns = this.toolBlockColumns();
    const line = new TextRenderable(this.opts.renderer, {
      content: assembleToolBlock(formatted, marker, { columns }),
      fg,
    });
    this.opts.transcriptWriter.beginBlock();
    this.opts.transcript.add(line);
    const block: ToolBlock = {
      line,
      header: formatted.header,
      body: formatted.body ?? "",
      input: step.input,
      startedAt,
    };
    this.activeToolBlocks.set(step.toolCallId, block);
    // The same event may already carry a terminal status (cached/replayed
    // history). Fall through to finalize against the just-created block.
    if (!isLive) {
      this.finalizeToolCall(step, block);
    }
  }

  private finalizeToolCall(step: Extract<TurnStep, { type: "tool_call" }>, block: ToolBlock): void {
    const isError = step.status === "error";
    const glyph = isError ? "✗" : "✓";
    const elapsedMs = block.startedAt === undefined ? 0 : Date.now() - block.startedAt;
    // Sub-second runs drop the elapsed suffix so the transcript does not get
    // littered with "0s" markers from fast tools (read, ls, todo_write, …).
    const durationSuffix = elapsedMs >= 1000 ? ` ${formatElapsed(elapsedMs)}` : "";
    const formatted = formatToolBlock({
      toolName: step.toolName,
      status: isError ? "error" : "completed",
      input: block.input,
      output: step.output,
      mode: "live",
    });
    block.line.content = assembleToolBlock(formatted, `${glyph}${durationSuffix}`, {
      columns: this.toolBlockColumns(),
    });
    block.line.fg = isError ? COLORS.error : COLORS.tool;
    this.activeToolBlocks.delete(step.toolCallId);
  }

  private finalizeDelta(block: StreamingBlock, body: string): void {
    block.body = body;
    updateStreamingBlock(block);
  }

  // Width budget for a tool block: terminal width minus the fixed sidebar
  // column and the transcript chrome. The ScrollBox owns border (2) +
  // padding (2) + a 1-column scrollbar gutter on the right, so the real
  // content area is 5 columns narrower than the transcript pane. Off-by-one
  // here causes pre-wrapped lines exactly at the cap to spill a single
  // character onto a near-blank continuation row. Recomputed per render so a
  // resize after a tool block lands updates new blocks; existing blocks keep
  // the width they were rendered at, which is acceptable since the renderer
  // would otherwise re-wrap and could exceed the row cap.
  private toolBlockColumns(): number {
    const transcriptChromeColumns = 5;
    return Math.max(20, this.opts.renderer.terminalWidth - SIDEBAR_WIDTH - transcriptChromeColumns);
  }
}

function updateStreamingBlock(block: StreamingBlock): void {
  const body = block.truncate ? block.truncate(block.body) : block.body;
  block.line.content = block.label ? `${block.label}\n${body}` : body;
}

/**
 * Format the body of a memory phase event for display. Returns the empty
 * string when there are no observations or usage bumps to show, so the
 * caller can elide the block entirely. The actual observation text is
 * intentionally omitted from the transcript — the completion `message`
 * ("Memory observation recorded. Bumped last-use on N prior memories.")
 * is the only line shown under the `[memory:<phase>]` label.
 */
export function formatMemoryEventBody(event: Extract<TurnEvent, { type: "memory" }>): string {
  const hasObservations = Boolean(event.observations && event.observations.length > 0);
  const hasBumps = Boolean(
    event.usageBumpedObservations && event.usageBumpedObservations.length > 0,
  );
  if (!hasObservations && !hasBumps) {
    return "";
  }
  return event.message;
}
