import {
  BoxRenderable,
  type CliRenderer,
  fg,
  StyledText,
  type TextChunk,
  TextRenderable,
} from "@opentui/core";
import type {
  TurnContextWindowUsage,
  TurnContextUsageEvent,
  TurnFollowUpQueueEntry,
  TurnTodo,
} from "../types/protocol.js";
import type { StateMachineSession } from "../types/state-machine.js";
import { COLORS } from "./theme.js";

/**
 * Width of the context-usage bar in terminal cells. Each tracked segment
 * (system prompt, raw messages, local memory, global memory) plus an
 * "untracked" remainder is drawn as a colored run of `█` cells; `░`
 * fills the remaining headroom up to this width.
 */
const CONTEXT_BAR_WIDTH = 25;

const BAR_FILLED_CELL = "\u2588";
const BAR_EMPTY_CELL = "\u2591";

/**
 * Placeholder trailing run for the idle bar (before any usage event has
 * been received). Width must equal the live trailing `] _NN%` so the bar
 * does not visually jitter when the first usage arrives, and so the total
 * bar content (`[` + `CONTEXT_BAR_WIDTH` cells + trailing) fits inside the
 * sidebar's inner width without wrapping.
 */
const BAR_PLACEHOLDER_TRAILING = "]  --%";

/**
 * Visual breakdown of `TurnContextWindowUsage` for the sidebar bar and
 * legend. Order here is the order cells are drawn left-to-right and the
 * order labels appear in the legend row beneath the bar.
 */
const CONTEXT_SEGMENTS: ReadonlyArray<{
  key: keyof TurnContextWindowUsage;
  label: string;
  color: string;
}> = [
  { key: "systemPrompt", label: "sys", color: COLORS.system },
  { key: "messages", label: "msg", color: COLORS.user },
  { key: "localMemory", label: "loc", color: COLORS.tool },
  { key: "globalMemory", label: "glb", color: COLORS.status },
];

/**
 * Right-hand sidebar that surfaces the runner's todos, queued follow-ups,
 * active state machine, and most recent context-window usage. Stacked
 * panels share width and bordering so the column has a consistent visual
 * rhythm.
 */
export interface Sidebar {
  /** Outer container; caller adds this to the root row. */
  readonly view: BoxRenderable;
  /** Replace the rendered todo list with the runner's current todos. */
  setTodos(todos: readonly TurnTodo[]): void;
  /** Replace the rendered follow-up queue with the runner's pending entries. */
  setFollowUpQueue(entries: readonly TurnFollowUpQueueEntry[]): void;
  /** Mirror the active state-machine pipeline; pass undefined to clear. */
  setStateMachine(session: StateMachineSession | undefined): void;
  /** Render the latest context-usage progress bar; pass undefined to clear. */
  setContextUsage(usage: TurnContextUsageEvent | undefined): void;
  /** Cumulative USD cost across all turns in the current session. */
  setSessionCost(cost: number): void;
}

/**
 * Fixed sidebar column width in terminal cells. Exported so the transcript
 * column can compute the available width for tool-block clamping without
 * waiting on yoga layout.
 */
export const SIDEBAR_WIDTH = 36;

/**
 * Maximum body lines rendered inside the follow-ups panel. The panel never
 * grows past this height, so todos and the state machine keep their space
 * even when many follow-ups are queued.
 */
const FOLLOW_UP_MAX_BODY_LINES = 3;

export function createSidebar(renderer: CliRenderer): Sidebar {
  // Fixed width keeps the sidebar legible on narrow terminals without
  // squashing the transcript. The three panels stack vertically inside.
  const view = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: SIDEBAR_WIDTH,
    height: "100%",
    flexShrink: 0,
  });

  const { panel: todoPanel, body: todoBody } = createPanel(renderer, "todos", "(none)");
  const { panel: followUpPanel, body: followUpBody } = createPanel(
    renderer,
    "follow-ups",
    "(none)",
    { maxBodyLines: FOLLOW_UP_MAX_BODY_LINES, grow: false },
  );
  const { panel: smPanel, body: smBody } = createPanel(renderer, "state machine", "(inactive)");

  // The context panel is hand-rolled rather than going through createPanel
  // because the body is a horizontal colored bar plus a legend row, not a
  // single text node. Mirrors createPanel's border + title styling so it
  // sits flush with the other sidebar panels.
  //
  // Height budget (5 cells): border(2) + title+usage(1) + bar(1) +
  // legend(1). Tokens and cost ride on the title row, right-aligned, so
  // the panel stays the same height as the other sidebar panels.
  const contextPanel = new BoxRenderable(renderer, {
    flexDirection: "column",
    border: true,
    borderColor: COLORS.border,
    paddingLeft: 1,
    paddingRight: 1,
    height: 5,
    flexShrink: 0,
  });
  // Title row: "context" label on the left, tokens + cost right-aligned
  // so the bar/legend rows below get the full inner width.
  const titleRow = new BoxRenderable(renderer, {
    flexDirection: "row",
    height: 1,
    flexShrink: 0,
  });
  const contextTitle = new TextRenderable(renderer, {
    content: "context",
    fg: COLORS.status,
    flexGrow: 1,
    flexShrink: 0,
  });
  // Tokens + cost share the right side of the title row, rendered in
  // white so the readout reads as primary data; overflow flips tokens
  // to error red.
  const tokensLabel = new TextRenderable(renderer, {
    content: "",
    fg: COLORS.agent,
    flexShrink: 0,
  });
  const costLabel = new TextRenderable(renderer, {
    content: "",
    fg: COLORS.agent,
    flexShrink: 0,
  });
  titleRow.add(contextTitle);
  titleRow.add(tokensLabel);
  titleRow.add(costLabel);
  contextPanel.add(titleRow);

  // The whole bar is a single TextRenderable with a StyledText payload so
  // an empty segment contributes zero cells. Splitting the bar across
  // sibling TextRenderables looks tempting, but OpenTUI's TextRenderable
  // measure function clamps the layout width to `max(1, ...)` even for
  // content "", which turned every zero-token segment into a phantom
  // 1-cell gap mid-bar.
  const barRow = new TextRenderable(renderer, {
    content: makeBarContent({
      segmentCells: CONTEXT_SEGMENTS.map(() => 0),
      untrackedCells: 0,
      emptyCells: CONTEXT_BAR_WIDTH,
      trailing: BAR_PLACEHOLDER_TRAILING,
      trailingFg: COLORS.hint,
    }),
    flexShrink: 0,
  });
  contextPanel.add(barRow);

  // Legend row: a colored square plus a hint-colored label per segment,
  // matching the bar order. Lets users decode the bar at a glance without
  // needing a tooltip surface.
  const legendRow = new BoxRenderable(renderer, {
    flexDirection: "row",
    height: 1,
    flexShrink: 0,
  });
  CONTEXT_SEGMENTS.forEach((segment, index) => {
    const dot = new TextRenderable(renderer, {
      content: "\u25A0",
      fg: segment.color,
      flexShrink: 0,
    });
    legendRow.add(dot);
    const trailing = index < CONTEXT_SEGMENTS.length - 1 ? "  " : "";
    const label = new TextRenderable(renderer, {
      content: ` ${segment.label}${trailing}`,
      fg: COLORS.hint,
      flexShrink: 0,
    });
    legendRow.add(label);
  });
  contextPanel.add(legendRow);

  view.add(todoPanel);
  view.add(followUpPanel);
  view.add(smPanel);
  view.add(contextPanel);

  return {
    view,
    setTodos(todos) {
      if (todos.length === 0) {
        todoBody.content = "(none)";
        todoBody.fg = COLORS.hint;
        return;
      }
      todoBody.content = todos
        .map((todo) => `${todoStatusGlyph(todo.status)} ${todo.content}`)
        .join("\n");
      todoBody.fg = COLORS.agent;
    },
    setFollowUpQueue(entries) {
      if (entries.length === 0) {
        followUpBody.content = "(none)";
        followUpBody.fg = COLORS.hint;
        return;
      }
      // Hard-cap to FOLLOW_UP_MAX_BODY_LINES so the panel never pushes the
      // todos or state-machine panels off-screen. Each entry collapses to a
      // single line; if more entries exist than fit, the last visible line
      // becomes a "+N more" summary instead of a real entry.
      const maxLines = FOLLOW_UP_MAX_BODY_LINES;
      const showSummary = entries.length > maxLines;
      const visibleCount = showSummary ? maxLines - 1 : entries.length;
      const lines = entries.slice(0, visibleCount).map((entry, index) => {
        const attachments = entry.images?.length ? ` 📎${entry.images.length}` : "";
        return collapseToLine(`${index + 1}. ${entry.message}${attachments}`);
      });
      if (showSummary) {
        lines.push(`+${entries.length - visibleCount} more`);
      }
      followUpBody.content = lines.join("\n");
      followUpBody.fg = COLORS.agent;
    },
    setStateMachine(session) {
      if (!session) {
        smBody.content = "(inactive)";
        smBody.fg = COLORS.hint;
        return;
      }
      const current = session.currentState;
      const lines = session.definition.states.map((state) => {
        const marker = state.name === current ? "▶" : " ";
        return `${marker} ${state.name}`;
      });
      if (session.terminal) {
        lines.push("", `terminal: ${session.terminal.status}`);
      }
      smBody.content = lines.join("\n");
      smBody.fg = COLORS.agent;
    },
    setContextUsage(usage) {
      if (!usage) {
        barRow.content = makeBarContent({
          segmentCells: CONTEXT_SEGMENTS.map(() => 0),
          untrackedCells: 0,
          emptyCells: CONTEXT_BAR_WIDTH,
          trailing: BAR_PLACEHOLDER_TRAILING,
          trailingFg: COLORS.hint,
        });
        tokensLabel.content = "";
        return;
      }
      const cap = usage.effectiveContextWindow;
      const breakdown = usage.contextWindowUsage;
      const usedTokens = usage.usage.totalTokens;
      const overflow = usedTokens >= cap;

      const { segmentCells, untrackedCells, emptyCells } = allocateContextBarCells(
        breakdown,
        usedTokens,
        cap,
        CONTEXT_BAR_WIDTH,
      );

      const percent = Math.min(100, Math.round((usedTokens / cap) * 100));
      barRow.content = makeBarContent({
        segmentCells,
        untrackedCells,
        emptyCells,
        trailing: `] ${String(percent).padStart(3)}%`,
        trailingFg: overflow ? COLORS.error : COLORS.hint,
      });
      tokensLabel.content = `${formatTokenCount(usedTokens)} / ${formatTokenCount(cap)}`;
      tokensLabel.fg = overflow ? COLORS.error : COLORS.agent;
    },
    setSessionCost(cost) {
      // Prefix with a space so cost sits visibly apart from the tokens
      // label that shares the same right-aligned slot on the title row.
      costLabel.content = cost > 0 ? ` $${cost.toFixed(4)}` : "";
    },
  };
}

interface PanelOptions {
  fixedHeight?: number;
  /**
   * Cap on body lines, used to derive the panel's `maxHeight` so the panel
   * shrinks to fit short content but refuses to grow past the cap. Mutually
   * exclusive with `fixedHeight`.
   */
  maxBodyLines?: number;
  grow?: boolean;
}

function createPanel(
  renderer: CliRenderer,
  title: string,
  initialBody: string,
  options: PanelOptions = {},
): { panel: BoxRenderable; body: TextRenderable } {
  const grow = options.grow ?? true;
  const compact = options.fixedHeight !== undefined || options.maxBodyLines !== undefined;
  // Compact panels (fixed or capped height) drop top/bottom padding so the
  // budget is spent on body lines rather than whitespace; border (2) + title
  // (1) + body lines = total panel height.
  const maxHeight = options.maxBodyLines !== undefined ? options.maxBodyLines + 3 : undefined;
  const panel = new BoxRenderable(renderer, {
    flexDirection: "column",
    border: true,
    borderColor: COLORS.border,
    paddingLeft: 1,
    paddingRight: 1,
    padding: compact ? undefined : 1,
    ...(options.fixedHeight ? { height: options.fixedHeight } : {}),
    ...(maxHeight ? { maxHeight } : {}),
    ...(grow ? { flexGrow: 1, flexShrink: 1 } : { flexShrink: 0 }),
  });
  const titleNode = new TextRenderable(renderer, {
    content: title,
    fg: COLORS.status,
    height: 1,
    flexShrink: 0,
  });
  const body = new TextRenderable(renderer, {
    content: initialBody,
    fg: COLORS.hint,
    flexGrow: grow ? 1 : 0,
    flexShrink: 1,
  });
  panel.add(titleNode);
  panel.add(body);
  return { panel, body };
}

// Inner text width = sidebar width (36) - border (2) - padding (2).
const SIDEBAR_BODY_WIDTH = SIDEBAR_WIDTH - 4;

function collapseToLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= SIDEBAR_BODY_WIDTH) return flat;
  return `${flat.slice(0, Math.max(1, SIDEBAR_BODY_WIDTH - 1))}…`;
}

/**
 * How many `█` cells each slice gets vs the context-window cap. Weights are
 * `(tokens / cap) * barWidth` so each segment reads as its share of the
 * budget on the same scale as the `NNk / cap` title. When the sum of those
 * weights exceeds `barWidth` (usage over cap), we scale all slices down
 * proportionally instead of shaving from the right, which used to erase
 * small segments while the bar stayed full.
 */
export function allocateContextBarCells(
  breakdown: TurnContextWindowUsage,
  usedTokens: number,
  cap: number,
  barWidth: number,
): { segmentCells: number[]; untrackedCells: number; emptyCells: number } {
  const safeCap = Math.max(1, cap);
  const trackedSum = CONTEXT_SEGMENTS.reduce(
    (acc, segment) => acc + (breakdown[segment.key] ?? 0),
    0,
  );
  const untrackedTokens = Math.max(0, usedTokens - trackedSum);

  const weights: number[] = CONTEXT_SEGMENTS.map((segment) => {
    const tokens = breakdown[segment.key] ?? 0;
    return tokens > 0 ? (tokens / safeCap) * barWidth : 0;
  });
  const untrackedWeight = untrackedTokens > 0 ? (untrackedTokens / safeCap) * barWidth : 0;
  const allWeights = [...weights, untrackedWeight];
  const sumWeights = allWeights.reduce((a, b) => a + b, 0);

  if (sumWeights <= 0) {
    return {
      segmentCells: CONTEXT_SEGMENTS.map(() => 0),
      untrackedCells: 0,
      emptyCells: barWidth,
    };
  }

  const filledTarget = Math.min(barWidth, Math.max(usedTokens > 0 ? 1 : 0, Math.round(sumWeights)));
  const allocated =
    filledTarget > 0 ? distributeProportional(allWeights, filledTarget) : allWeights.map(() => 0);
  const segmentCells = allocated.slice(0, CONTEXT_SEGMENTS.length);
  const untrackedCells = allocated[CONTEXT_SEGMENTS.length] ?? 0;
  const emptyCells = barWidth - filledTarget;

  return { segmentCells, untrackedCells, emptyCells };
}

/** Split `slotCount` integer slots across `weights` in proportion (largest remainder). */
function distributeProportional(weights: readonly number[], slotCount: number): number[] {
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0 || slotCount <= 0) return weights.map(() => 0);
  const floats = weights.map((w) => (w / sumW) * slotCount);
  const floors = floats.map((f) => Math.floor(f));
  let remainder = slotCount - floors.reduce((a, b) => a + b, 0);
  const fracs = floats.map((f, i) => ({ i, frac: f - floors[i]! }));
  fracs.sort((a, b) => b.frac - a.frac);
  const out = [...floors];
  for (let r = 0; r < remainder; r++) {
    out[fracs[r]!.i]! += 1;
  }
  return out;
}

function todoStatusGlyph(status: TurnTodo["status"]): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "●";
  if (status === "failed") return "✗";
  return "○";
}

/**
 * Build the single-line context bar as styled chunks so an empty segment
 * contributes zero cells. Order matches `CONTEXT_SEGMENTS` for the
 * tracked runs, with the untracked-remainder run drawn after the last
 * tracked segment and empty headroom drawn last before the trailing
 * `] NN%`.
 */
function makeBarContent(params: {
  segmentCells: readonly number[];
  untrackedCells: number;
  emptyCells: number;
  trailing: string;
  trailingFg: string;
}): StyledText {
  const chunks: TextChunk[] = [fg(COLORS.hint)("[")];
  CONTEXT_SEGMENTS.forEach((segment, i) => {
    const cells = params.segmentCells[i];
    if (cells > 0) {
      chunks.push(fg(segment.color)(BAR_FILLED_CELL.repeat(cells)));
    }
  });
  if (params.untrackedCells > 0) {
    chunks.push(fg(COLORS.reasoning)(BAR_FILLED_CELL.repeat(params.untrackedCells)));
  }
  if (params.emptyCells > 0) {
    chunks.push(fg(COLORS.hint)(BAR_EMPTY_CELL.repeat(params.emptyCells)));
  }
  chunks.push(fg(params.trailingFg)(params.trailing));
  return new StyledText(chunks);
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${formatCompactNumber(tokens / 1_000_000)}m`;
  if (tokens >= 1_000) return `${formatCompactNumber(tokens / 1_000)}k`;
  return String(tokens);
}

function formatCompactNumber(value: number): string {
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
