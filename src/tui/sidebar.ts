import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import type { TurnContextUsageEvent, TurnTodo } from "../types/protocol.js";
import type { StateMachineSession } from "../types/state-machine.js";
import { COLORS } from "./theme.js";

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
  /** Replace the rendered follow-up queue with the runner's pending prompts. */
  setFollowUpQueue(prompts: readonly string[]): void;
  /** Mirror the active state-machine pipeline; pass undefined to clear. */
  setStateMachine(session: StateMachineSession | undefined): void;
  /** Render the latest context-usage progress bar; pass undefined to clear. */
  setContextUsage(usage: TurnContextUsageEvent | undefined): void;
}

export function createSidebar(renderer: CliRenderer): Sidebar {
  // Fixed width keeps the sidebar legible on narrow terminals without
  // squashing the transcript. The three panels stack vertically inside.
  const view = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: 36,
    height: "100%",
    flexShrink: 0,
  });

  const { panel: todoPanel, body: todoBody } = createPanel(renderer, "todos", "(none)");
  const { panel: followUpPanel, body: followUpBody } = createPanel(
    renderer,
    "follow-ups",
    "(none)",
  );
  const { panel: smPanel, body: smBody } = createPanel(renderer, "state machine", "(inactive)");
  const { panel: contextPanel, body: contextBody } = createPanel(
    renderer,
    "context",
    "(waiting for usage)",
    { fixedHeight: 5, grow: false },
  );

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
    setFollowUpQueue(prompts) {
      if (prompts.length === 0) {
        followUpBody.content = "(none)";
        followUpBody.fg = COLORS.hint;
        return;
      }
      followUpBody.content = prompts.map((prompt, index) => `${index + 1}. ${prompt}`).join("\n");
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
        contextBody.content = "(waiting for usage)";
        contextBody.fg = COLORS.hint;
        return;
      }
      const usedTokens = usage.usage.totalTokens;
      const percent = Math.min(1, usedTokens / usage.contextWindow);
      contextBody.content = [
        progressBar(percent, 25),
        `${formatTokenCount(usedTokens)} / ${formatTokenCount(usage.contextWindow)}`,
      ].join("\n");
      contextBody.fg = usedTokens >= usage.contextWindow ? COLORS.error : COLORS.agent;
    },
  };
}

interface PanelOptions {
  fixedHeight?: number;
  grow?: boolean;
}

function createPanel(
  renderer: CliRenderer,
  title: string,
  initialBody: string,
  options: PanelOptions = {},
): { panel: BoxRenderable; body: TextRenderable } {
  const grow = options.grow ?? true;
  const panel = new BoxRenderable(renderer, {
    flexDirection: "column",
    border: true,
    borderColor: COLORS.border,
    paddingLeft: 1,
    paddingRight: 1,
    padding: options.fixedHeight ? undefined : 1,
    ...(options.fixedHeight ? { height: options.fixedHeight } : {}),
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

function todoStatusGlyph(status: TurnTodo["status"]): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "●";
  if (status === "failed") return "✗";
  return "○";
}

function progressBar(value: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, value));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${`${Math.round(clamped * 100)}%`.padStart(4)}`;
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
