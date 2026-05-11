import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import type {
  TurnContextUsageEvent,
  TurnContextWindowUsage,
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

  // Colored bar row: open bracket, one TextRenderable per tracked segment
  // (its `content` length controls how many cells it occupies in the flex
  // row), an "untracked" run for provider-reported tokens our segment
  // breakdown does not attribute, the empty remainder, and a close bracket
  // with percentage. Updating widths is just rewriting `content`.
  const barRow = new BoxRenderable(renderer, {
    flexDirection: "row",
    height: 1,
    flexShrink: 0,
  });
  const barOpen = new TextRenderable(renderer, {
    content: "[",
    fg: COLORS.hint,
    flexShrink: 0,
  });
  barRow.add(barOpen);
  const segmentNodes = CONTEXT_SEGMENTS.map((segment) => {
    const node = new TextRenderable(renderer, {
      content: "",
      fg: segment.color,
      flexShrink: 0,
    });
    barRow.add(node);
    return node;
  });
  // Cells used by the provider-reported total beyond what the four tracked
  // segments add up to (e.g. tool definitions, reasoning, or overhead the
  // runner does not model explicitly). Rendered in `reasoning` grey so it
  // reads as "used but unattributed."
  const untrackedNode = new TextRenderable(renderer, {
    content: "",
    fg: COLORS.reasoning,
    flexShrink: 0,
  });
  barRow.add(untrackedNode);
  const emptyNode = new TextRenderable(renderer, {
    content: "\u2591".repeat(CONTEXT_BAR_WIDTH),
    fg: COLORS.hint,
    flexShrink: 0,
  });
  barRow.add(emptyNode);
  const barClose = new TextRenderable(renderer, {
    content: "]   --%",
    fg: COLORS.hint,
    flexShrink: 0,
  });
  barRow.add(barClose);
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
        for (const node of segmentNodes) node.content = "";
        untrackedNode.content = "";
        emptyNode.content = "\u2591".repeat(CONTEXT_BAR_WIDTH);
        barClose.content = "]   --%";
        barClose.fg = COLORS.hint;
        tokensLabel.content = "";
        return;
      }
      const cap = usage.effectiveContextWindow;
      const breakdown = usage.contextWindowUsage;
      const usedTokens = usage.usage.totalTokens;
      const overflow = usedTokens >= cap;

      // Cells per tracked segment, proportional to the effective cap so
      // empty headroom is visible even when usage is light. Any segment
      // with non-zero tokens shows at least one cell so a tiny but
      // present slice does not vanish at low usage.
      const segmentCells = CONTEXT_SEGMENTS.map((segment) => {
        const tokens = breakdown[segment.key] ?? 0;
        if (tokens <= 0) return 0;
        return Math.max(1, Math.round((tokens / cap) * CONTEXT_BAR_WIDTH));
      });
      const trackedSum = CONTEXT_SEGMENTS.reduce(
        (acc, segment) => acc + (breakdown[segment.key] ?? 0),
        0,
      );
      const untrackedTokens = Math.max(0, usedTokens - trackedSum);
      let untrackedCells =
        untrackedTokens > 0
          ? Math.max(1, Math.round((untrackedTokens / cap) * CONTEXT_BAR_WIDTH))
          : 0;

      // Clamp so the colored runs never exceed CONTEXT_BAR_WIDTH. Shave
      // overflow off the untracked tail first (least informative), then
      // peel from the rightmost tracked segments so users still see the
      // dominant segment that is filling the bar.
      let usedCells = segmentCells.reduce((a, b) => a + b, 0) + untrackedCells;
      if (usedCells > CONTEXT_BAR_WIDTH) {
        let excess = usedCells - CONTEXT_BAR_WIDTH;
        const shave = Math.min(untrackedCells, excess);
        untrackedCells -= shave;
        excess -= shave;
        for (let i = segmentCells.length - 1; i >= 0 && excess > 0; i--) {
          const take = Math.min(segmentCells[i], excess);
          segmentCells[i] -= take;
          excess -= take;
        }
        usedCells = segmentCells.reduce((a, b) => a + b, 0) + untrackedCells;
      }
      const emptyCells = Math.max(0, CONTEXT_BAR_WIDTH - usedCells);

      segmentNodes.forEach((node, i) => {
        node.content = "\u2588".repeat(segmentCells[i]);
      });
      untrackedNode.content = "\u2588".repeat(untrackedCells);
      emptyNode.content = "\u2591".repeat(emptyCells);

      const percent = Math.min(100, Math.round((usedTokens / cap) * 100));
      barClose.content = `] ${String(percent).padStart(3)}%`;
      barClose.fg = overflow ? COLORS.error : COLORS.hint;
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

function todoStatusGlyph(status: TurnTodo["status"]): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "●";
  if (status === "failed") return "✗";
  return "○";
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
