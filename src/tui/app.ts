import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  BoxRenderable,
  createCliRenderer,
  fg,
  type KeyEvent,
  ScrollBoxRenderable,
  t,
  TextRenderable,
  TextareaRenderable,
} from "@opentui/core";
import { formatCompactJson } from "../lib/compact-json.js";
import type { Session } from "../session/session.js";
import type {
  TurnAgentFile,
  TurnContextUsageEvent,
  TurnEvent,
  TurnQuestion,
  TurnStep,
  TurnTerminalEvent,
  TurnTodo,
  TurnTokenUsage,
} from "../types/protocol.js";
import type { StateMachineSession } from "../types/state-machine.js";

export interface RunTuiInput {
  session: Session;
  initialPrompt?: string;
  /** Current working directory shown in the startup header. */
  workDir: string;
  /** Session id shown in the startup header and resume context. */
  sessionId: string;
  /** Installed package version shown in the startup header. */
  packageVersion: string;
  /** User-facing model name used for this CLI session. */
  modelName: string;
  /** Human-readable provenance for modelName, e.g. "inferred from ANTHROPIC_API_KEY in .env". */
  modelSource?: string;
  /** User-facing model name used for observational memory work. */
  memoryModelName: string;
  /** Human-readable provenance for memoryModelName. */
  memoryModelSource?: string;
  /** Best-effort package update notice, shown in-TUI because stderr is hidden. */
  newVersionNotice?: string;
  /** Past messages to replay into the transcript on resume. */
  history?: AgentMessage[];
  /** Maximum prior-session display lines to replay on resume; 0 disables replay. */
  resumeHistoryLines?: number;
}

type HistoryBlockKind = "user" | "agent" | "reasoning" | "tool" | "error";

export interface HistoryDisplayBlock {
  kind: HistoryBlockKind;
  content: string;
}

export interface LimitedHistory {
  blocks: HistoryDisplayBlock[];
  omittedLines: number;
}

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

export interface SkillAutocompleteItem {
  name: string;
  description?: string;
  path?: string;
}

export interface SkillAutocompleteToken {
  start: number;
  end: number;
  query: string;
}

export interface SkillAutocompleteReplacement {
  text: string;
  cursorOffset: number;
}

const COLORS = {
  user: "#7DD3FC",
  agent: "#FFFFFF",
  reasoning: "#9CA3AF",
  tool: "#A78BFA",
  system: "#FBBF24",
  error: "#F87171",
  hint: "#6B7280",
  memory: "#6B7280",
  status: "#34D399",
  border: "#374151",
} as const;

const HINT_IDLE = "Enter: send · Esc: quit · Ctrl+C: force quit";
const HINT_RUNNING =
  "Enter: steer · Shift+Enter: queue follow-up · Esc: interrupt and quit · Ctrl+C: force quit";
const SKILL_AUTOCOMPLETE_LIMIT = 8;
const SKILL_AUTOCOMPLETE_TOKEN = /^\/([A-Za-z0-9_.-]*)$/;
const SKILL_AUTOCOMPLETE_DESCRIPTION_WIDTH = 72;
const SKILL_AUTOCOMPLETE_DESCRIPTION_LINES = 2;
const QUESTION_OPTION_LIMIT = 8;
const QUESTION_OPTION_DESCRIPTION_WIDTH = 72;

interface InternalKeyHandlerLike {
  onInternal(event: "keypress", handler: (key: KeyEvent) => void): void;
}

/**
 * Runs the interactive TUI for a session. Resolves with the most recent
 * terminal event (if any) when the user exits the UI.
 *
 * Differentiating Enter vs Shift+Enter requires the terminal to report
 * modifier keys with Enter, which most terminals only do when the Kitty
 * keyboard protocol is enabled. We opt into it via `useKittyKeyboard`.
 */
export async function runTui(input: RunTuiInput): Promise<TurnTerminalEvent | undefined> {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useKittyKeyboard: {},
    targetFps: 60,
  });
  restoreWindowGlobal(previousWindow);

  // Outer row wraps the main column and a right-side sidebar that surfaces
  // the runner's current todo list and state-machine progress.
  const root = new BoxRenderable(renderer, {
    flexDirection: "row",
    width: "100%",
    height: "100%",
  });

  const layout = new BoxRenderable(renderer, {
    flexDirection: "column",
    flexGrow: 1,
    flexShrink: 1,
    height: "100%",
  });

  // Fixed width keeps the sidebar legible on narrow terminals without
  // squashing the transcript. The two panels stack vertically inside.
  const sidebar = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: 36,
    height: "100%",
    flexShrink: 0,
  });

  const todoPanel = new BoxRenderable(renderer, {
    flexDirection: "column",
    border: true,
    borderColor: COLORS.border,
    padding: 1,
    flexGrow: 1,
    flexShrink: 1,
  });
  const todoTitle = new TextRenderable(renderer, {
    content: "todos",
    fg: COLORS.status,
    height: 1,
    flexShrink: 0,
  });
  const todoBody = new TextRenderable(renderer, {
    content: "(none)",
    fg: COLORS.hint,
    flexGrow: 1,
    flexShrink: 1,
  });
  todoPanel.add(todoTitle);
  todoPanel.add(todoBody);

  const smPanel = new BoxRenderable(renderer, {
    flexDirection: "column",
    border: true,
    borderColor: COLORS.border,
    padding: 1,
    flexGrow: 1,
    flexShrink: 1,
  });
  const smTitle = new TextRenderable(renderer, {
    content: "state machine",
    fg: COLORS.status,
    height: 1,
    flexShrink: 0,
  });
  const smBody = new TextRenderable(renderer, {
    content: "(inactive)",
    fg: COLORS.hint,
    flexGrow: 1,
    flexShrink: 1,
  });
  smPanel.add(smTitle);
  smPanel.add(smBody);

  const contextPanel = new BoxRenderable(renderer, {
    flexDirection: "column",
    border: true,
    borderColor: COLORS.border,
    paddingLeft: 1,
    paddingRight: 1,
    height: 5,
    flexShrink: 0,
  });
  const contextTitle = new TextRenderable(renderer, {
    content: "context",
    fg: COLORS.status,
    height: 1,
    flexShrink: 0,
  });
  const contextBody = new TextRenderable(renderer, {
    content: "(waiting for usage)",
    fg: COLORS.hint,
    flexGrow: 1,
    flexShrink: 1,
  });
  contextPanel.add(contextTitle);
  contextPanel.add(contextBody);

  sidebar.add(todoPanel);
  sidebar.add(smPanel);
  sidebar.add(contextPanel);

  const transcript = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    flexShrink: 1,
    scrollY: true,
    border: true,
    borderColor: COLORS.border,
    padding: 1,
  });

  const status = new TextRenderable(renderer, {
    content: "",
    fg: COLORS.status,
    height: 1,
    flexShrink: 0,
  });

  const hint = new TextRenderable(renderer, {
    content: HINT_IDLE,
    fg: COLORS.hint,
    height: 1,
    flexShrink: 0,
  });

  const skillAutocompletePanel = new BoxRenderable(renderer, {
    flexDirection: "column",
    border: true,
    borderColor: COLORS.border,
    paddingLeft: 1,
    paddingRight: 1,
    flexShrink: 0,
  });
  skillAutocompletePanel.visible = false;

  const skillAutocompleteTitle = new TextRenderable(renderer, {
    content: "skills",
    fg: COLORS.status,
    height: 1,
    flexShrink: 0,
  });
  const skillAutocompleteRows = Array.from({ length: SKILL_AUTOCOMPLETE_LIMIT }, () => {
    const row = new TextRenderable(renderer, {
      content: "",
      fg: COLORS.hint,
      height: 3,
      flexShrink: 0,
    });
    row.visible = false;
    return row;
  });
  skillAutocompletePanel.add(skillAutocompleteTitle);
  for (const row of skillAutocompleteRows) {
    skillAutocompletePanel.add(row);
  }

  const questionPanel = new BoxRenderable(renderer, {
    flexDirection: "column",
    border: true,
    borderColor: COLORS.border,
    paddingLeft: 1,
    paddingRight: 1,
    flexShrink: 0,
  });
  questionPanel.visible = false;

  const questionTitle = new TextRenderable(renderer, {
    content: "question",
    fg: COLORS.agent,
    wrapMode: "word",
    flexShrink: 0,
  });
  const questionSpacer = new TextRenderable(renderer, {
    content: "",
    height: 1,
    flexShrink: 0,
  });
  const questionRows = Array.from({ length: QUESTION_OPTION_LIMIT }, () => {
    const row = new TextRenderable(renderer, {
      content: "",
      fg: COLORS.hint,
      wrapMode: "word",
      flexShrink: 0,
    });
    row.visible = false;
    return row;
  });
  questionPanel.add(questionTitle);
  questionPanel.add(questionSpacer);
  for (const row of questionRows) {
    questionPanel.add(row);
  }

  const inputBox = new BoxRenderable(renderer, {
    flexDirection: "row",
    border: true,
    borderColor: COLORS.border,
    paddingLeft: 1,
    paddingRight: 1,
    flexShrink: 0,
  });

  const prompt = new TextRenderable(renderer, {
    content: "> ",
    fg: COLORS.user,
    width: 2,
  });

  // Textarea (rather than Input) so long messages soft-wrap visually. Enter
  // is intercepted in onKeyDown below to submit instead of inserting a newline.
  const inputField = new TextareaRenderable(renderer, {
    placeholder: "Type a message and press Enter…",
    flexGrow: 1,
    minHeight: 1,
    maxHeight: 10,
    wrapMode: "word",
  });

  inputBox.add(prompt);
  inputBox.add(inputField);

  layout.add(transcript);
  layout.add(status);
  layout.add(hint);
  layout.add(skillAutocompletePanel);
  layout.add(questionPanel);
  layout.add(inputBox);
  root.add(layout);
  root.add(sidebar);
  renderer.root.add(root);
  inputField.focus();

  // ---- transcript helpers ----------------------------------------------------

  // ScrollBox.scrollHeight is only refreshed after the next layout pass, so
  // setting scrollTop synchronously right after adding a child reads stale
  // dimensions and leaves the view a few lines short of the bottom. Coalesce
  // scroll-to-bottom requests onto a single deferred tick instead.
  let scrollPending = false;
  function scrollToBottomSoon(): void {
    if (scrollPending) return;
    scrollPending = true;
    setTimeout(() => {
      scrollPending = false;
      transcript.scrollTop = transcript.scrollHeight;
    }, 0);
  }

  function appendLine(content: string, fg: string): void {
    if (!content) return;
    // ScrollBox children stack vertically; one Text per logical line keeps wrapping simple.
    const line = new TextRenderable(renderer, { content, fg });
    transcript.add(line);
    scrollToBottomSoon();
  }

  // Tool results can be huge (file dumps, search output). Show only the head
  // in the transcript so the conversation flow stays readable; the full
  // payload remains in session history for the model.
  const TOOL_RESULT_MAX_LINES = 3;
  function truncateToolResult(text: string): string {
    const lines = text.split("\n");
    if (lines.length <= TOOL_RESULT_MAX_LINES) return text;
    const head = lines.slice(0, TOOL_RESULT_MAX_LINES).join("\n");
    const remaining = lines.length - TOOL_RESULT_MAX_LINES;
    return `${head}\n… (+${remaining} more line${remaining === 1 ? "" : "s"})`;
  }

  function appendBlock(label: string | null, body: string, fg: string): void {
    beginBlock();
    const text = label ? `${label}\n${body}` : body;
    for (const line of text.split("\n")) appendLine(line, fg);
  }

  // Insert a blank separator before each new logical block so distinct steps
  // (text, reasoning, tool calls, system messages) are easy to tell apart.
  // The first block in the transcript skips the separator.
  let hasRenderedAnyBlock = false;
  function beginBlock(): void {
    if (hasRenderedAnyBlock) appendLine(" ", COLORS.hint);
    hasRenderedAnyBlock = true;
  }

  function setStatus(text: string): void {
    status.content = text;
  }

  function setHint(running: boolean): void {
    hint.content = running ? HINT_RUNNING : HINT_IDLE;
  }

  // ---- runtime state ---------------------------------------------------------

  let running = false;
  let lastTerminal: TurnTerminalEvent | undefined;
  let latestContextUsage: TurnContextUsageEvent | undefined;
  let activeTextStream: StreamingBlock | undefined;
  let activeReasoningStream: StreamingBlock | undefined;
  // Tool calls fire twice (running → completed/error). Track the rendered
  // block by toolCallId so the second event updates the same line in place
  // — swapping the spinner for a check/cross and appending the result —
  // instead of pushing a separate block.
  const activeToolBlocks = new Map<string, ToolBlock>();

  interface StreamingBlock {
    line: TextRenderable;
    label: string | null;
    body: string;
    /** Cap rendered output to TOOL_RESULT_MAX_LINES for noisy streams (e.g. reasoning). */
    truncate: boolean;
  }

  interface ToolBlock {
    line: TextRenderable;
    toolName: string;
    inputBody: string;
    // Wall-clock start so the running header can show a live elapsed counter
    // and the finalized header can report total tool duration. Undefined when
    // the first event we saw was already terminal (cached/replayed history),
    // in which case we have no real duration to report.
    startedAt: number | undefined;
  }

  // Tracks the wall-clock start of the current turn so the status line can
  // surface a live "Ns" / "Nm Ns" elapsed counter while work is in flight.
  let workingStartedAt: number | undefined;
  let workingTicker: ReturnType<typeof setInterval> | undefined;
  // Swapped out by memory events so the ticker can keep refreshing while the
  // human-readable phase ("recalling memories…", etc.) stays accurate.
  let workingMessage = "working…";

  function formatElapsed(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
  }

  function refreshWorkingStatus(): void {
    refreshActiveToolBlocks();
    if (workingStartedAt === undefined) return;
    const elapsed = formatElapsed(Date.now() - workingStartedAt);
    setStatus(`● ${workingMessage} (${elapsed} · Esc to interrupt, Ctrl+C to force quit)`);
  }

  // Sub-second precision for short tool calls keeps fast operations honest;
  // longer calls fall back to the coarser m/s formatter shared with the
  // working-status counter.
  function formatToolDuration(ms: number): string {
    if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
    return formatElapsed(ms);
  }

  function refreshActiveToolBlocks(): void {
    if (activeToolBlocks.size === 0) return;
    for (const block of activeToolBlocks.values()) {
      if (block.startedAt === undefined) continue;
      const elapsed = formatToolDuration(Date.now() - block.startedAt);
      const header = `[tool ${block.toolName}] ⏳ ${elapsed}`;
      block.line.content = block.inputBody ? `${header}\n${block.inputBody}` : header;
    }
  }

  function startWorkingTicker(): void {
    if (workingTicker !== undefined) return;
    workingTicker = setInterval(refreshWorkingStatus, 1000);
  }

  function stopWorkingTicker(): void {
    if (workingTicker !== undefined) {
      clearInterval(workingTicker);
      workingTicker = undefined;
    }
  }

  function markRunning(): void {
    running = true;
    setHint(true);
    workingMessage = "working…";
    workingStartedAt = Date.now();
    refreshWorkingStatus();
    startWorkingTicker();
  }

  function markIdle(): void {
    running = false;
    setHint(false);
    stopWorkingTicker();
    workingStartedAt = undefined;
    workingMessage = "working…";
    setStatus("");
  }

  function reportError(error: unknown): void {
    appendBlock("[error]", error instanceof Error ? error.message : String(error), COLORS.error);
    markIdle();
  }

  // ---- session subscription --------------------------------------------------

  function refreshSidebar(): void {
    const state = input.session.getState();
    renderTodoSidebar(state?.todos ?? []);
    renderStateMachineSidebar(state?.stateMachine);
    renderContextUsageSidebar(latestContextUsage);
  }

  function renderTodoSidebar(todos: readonly TurnTodo[]): void {
    if (todos.length === 0) {
      todoBody.content = "(none)";
      todoBody.fg = COLORS.hint;
      return;
    }
    const lines = todos.map((todo) => `${todoStatusGlyph(todo.status)} ${todo.content}`);
    todoBody.content = lines.join("\n");
    todoBody.fg = COLORS.agent;
  }

  function todoStatusGlyph(status: TurnTodo["status"]): string {
    if (status === "completed") return "✓";
    if (status === "in_progress") return "●";
    if (status === "failed") return "✗";
    return "○";
  }

  function renderStateMachineSidebar(session: StateMachineSession | undefined): void {
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
  }

  function renderContextUsageSidebar(usage: TurnContextUsageEvent | undefined): void {
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

  const unsubscribe = input.session.subscribe((event: TurnEvent) => {
    // Sidebar mirrors the runner's authoritative state, so refresh it on
    // every event rather than threading specific updates through each branch.
    refreshSidebar();
    if (event.type === "step") {
      renderStep(event.step);
    } else if (event.type === "todos") {
      renderTodos(event.todos);
    } else if (event.type === "follow_up_queue") {
      renderFollowUpQueue(event.prompts);
    } else if (event.type === "memory") {
      renderMemoryStatus(event);
    } else if (event.type === "context_usage") {
      latestContextUsage = event;
      renderContextUsageSidebar(event);
    } else if (event.type === "system") {
      appendBlock("[system]", event.message, COLORS.system);
      if (event.level === "error") markIdle();
    } else if (event.type === "ask") {
      appendBlock("[question]", event.questions.map((q) => q.question).join("\n"), COLORS.system);
      showQuestions(event.questions);
      renderUsage(event.usage);
      lastTerminal = event;
      markIdle();
    } else if (event.type === "complete") {
      if (event.error) {
        appendBlock("[error]", event.error, COLORS.error);
      } else if (event.result) {
        // Result is also normally streamed via text steps; only show if no streaming happened
        // for this turn (cheap heuristic: empty transcript-since-last-prompt).
        // Always-append is fine too — duplicate text is harmless and clearer for short turns.
      }
      renderUsage(event.usage);
      lastTerminal = event;
      markIdle();
    } else if (event.type === "interrupted") {
      appendLine("[interrupted]", COLORS.system);
      renderUsage(event.usage);
      lastTerminal = event;
      markIdle();
    } else if (event.type === "sleep") {
      appendLine(`[sleeping until ${new Date(event.wakeAt).toLocaleTimeString()}]`, COLORS.system);
      renderUsage(event.usage);
      lastTerminal = event;
      markIdle();
    }
  });

  function renderSetupIntro(
    skills: ReadonlyArray<{ name: string }>,
    agentFiles: readonly TurnAgentFile[],
  ): void {
    const [title, ...details] = startupHeaderLines(input);
    appendLine(title ?? "[duet]", COLORS.status);
    for (const line of details) {
      appendLine(line, line === input.newVersionNotice ? COLORS.system : COLORS.hint);
    }

    if (agentFiles.length === 0) {
      appendLine("[agent file] none", COLORS.hint);
    } else {
      appendLine(`[agent file] ${agentFiles.map((file) => file.name).join(", ")}`, COLORS.hint);
    }

    if (skills.length === 0) {
      appendLine("[skills] none", COLORS.hint);
    } else {
      const names = skills.map((skill) => skill.name).join(", ");
      appendLine(`[skills] ${skills.length} loaded: ${names}`, COLORS.hint);
    }
  }

  function renderUsage(usage?: TurnTokenUsage): void {
    if (!usage) return;
    const parts = [`in=${usage.input}`, `out=${usage.output}`];
    if (usage.cacheRead > 0) parts.push(`cached=${usage.cacheRead}`);
    const cost = usage.cost.total === 0 ? "" : ` · Cost: $${usage.cost.total.toFixed(4)}`;
    appendLine(`[usage] Tokens: ${parts.join(" ")}${cost}`, COLORS.hint);
  }

  function renderTodos(todos: TurnTodo[]): void {
    if (todos.length === 0) {
      appendBlock("[todos]", "No todos", COLORS.hint);
      return;
    }
    appendBlock(
      "[todos]",
      todos.map((todo) => `${todo.status} ${todo.id}: ${todo.content}`).join("\n"),
      COLORS.status,
    );
  }

  function renderFollowUpQueue(prompts: string[]): void {
    if (prompts.length === 0) {
      if (running) refreshWorkingStatus();
      else setStatus("");
      return;
    }
    setStatus(`queued follow-ups: ${prompts.length}`);
    appendBlock(
      "[follow-up queue]",
      prompts.map((prompt, index) => `${index + 1}. ${prompt}`).join("\n"),
      COLORS.hint,
    );
  }

  function renderStep(step: TurnStep): void {
    if (questionPickerIsOpen()) hideQuestions();

    if (step.type === "text_delta") {
      activeTextStream = renderDelta(activeTextStream, null, step.delta, COLORS.agent);
    } else if (step.type === "reasoning_delta") {
      activeReasoningStream = renderDelta(
        activeReasoningStream,
        "[reasoning]",
        step.delta,
        COLORS.reasoning,
        true,
      );
    } else if (step.type === "text") {
      if (activeTextStream) {
        finalizeDelta(activeTextStream, step.text);
        activeTextStream = undefined;
        return;
      }
      appendBlock(null, step.text, COLORS.agent);
    } else if (step.type === "reasoning") {
      const trimmed = step.text.trim();
      if (activeReasoningStream) {
        finalizeDelta(activeReasoningStream, trimmed);
        activeReasoningStream = undefined;
        return;
      }
      if (trimmed) appendBlock("[reasoning]", truncateToolResult(trimmed), COLORS.reasoning);
    } else if (step.type === "tool_call") {
      renderToolCall(step);
    } else if (step.type === "system") {
      appendBlock("[system]", step.message, COLORS.system);
    }
  }

  function renderDelta(
    block: StreamingBlock | undefined,
    label: string | null,
    delta: string,
    fg: string,
    truncate = false,
  ): StreamingBlock {
    const next =
      block ??
      ({
        line: new TextRenderable(renderer, { content: "", fg }),
        label,
        body: "",
        truncate,
      } satisfies StreamingBlock);
    if (!block) {
      beginBlock();
      transcript.add(next.line);
    }
    next.body += delta;
    updateStreamingBlock(next);
    return next;
  }

  // Render a tool call as a single, self-updating block. The first event
  // (`status: "running"`) creates the block with a spinner; the second event
  // (`completed` or `error`) replaces the spinner with ✓/✗ and appends the
  // truncated result inline so the call and its outcome stay visually paired.
  function renderToolCall(step: Extract<TurnStep, { type: "tool_call" }>): void {
    const existing = activeToolBlocks.get(step.toolCallId);
    if (!existing) {
      const inputBody = step.input === undefined ? "" : formatCompactJson(step.input);
      const isLive = step.status === "running" || step.status === "pending";
      const startedAt = isLive ? Date.now() : undefined;
      const header = isLive ? `[tool ${step.toolName}] ⏳ 0.0s` : `[tool ${step.toolName}] ⏳`;
      const fg = step.status === "error" ? COLORS.error : COLORS.tool;
      const line = new TextRenderable(renderer, {
        content: inputBody ? `${header}\n${inputBody}` : header,
        fg,
      });
      beginBlock();
      transcript.add(line);
      const block: ToolBlock = { line, toolName: step.toolName, inputBody, startedAt };
      activeToolBlocks.set(step.toolCallId, block);
      scrollToBottomSoon();
      // The same event may already carry a terminal status (cached/replayed
      // history). Fall through to finalize against the just-created block.
      if (step.status !== "running" && step.status !== "pending") {
        finalizeToolCall(step, block);
      }
      return;
    }
    finalizeToolCall(step, existing);
  }

  function finalizeToolCall(
    step: Extract<TurnStep, { type: "tool_call" }>,
    block: ToolBlock,
  ): void {
    const isError = step.status === "error";
    const marker = isError ? "✗" : "✓";
    const header =
      block.startedAt === undefined
        ? `[tool ${block.toolName}] ${marker}`
        : `[tool ${block.toolName}] ${marker} ${formatToolDuration(Date.now() - block.startedAt)}`;
    const sections = [block.inputBody ? `${header}\n${block.inputBody}` : header];
    if (step.output && step.output.length > 0) {
      const text = textFromContent(step.output);
      if (text) {
        const label = isError ? "[error]" : "[result]";
        sections.push(`${label}\n${truncateToolResult(text)}`);
      }
    }
    block.line.content = sections.join("\n");
    block.line.fg = isError ? COLORS.error : COLORS.tool;
    activeToolBlocks.delete(step.toolCallId);
    scrollToBottomSoon();
  }

  function finalizeDelta(block: StreamingBlock, body: string): void {
    block.body = body;
    updateStreamingBlock(block);
  }

  function updateStreamingBlock(block: StreamingBlock): void {
    const body = block.truncate ? truncateToolResult(block.body) : block.body;
    block.line.content = block.label ? `${block.label}\n${body}` : body;
    scrollToBottomSoon();
  }

  function renderMemoryStatus(event: Extract<TurnEvent, { type: "memory" }>): void {
    if (event.status === "running") {
      workingMessage = event.message;
      refreshWorkingStatus();
      return;
    }
    const body = formatMemoryEventBody(event);
    if (body) {
      appendBlock(`[memory:${event.phase}]`, body, COLORS.memory);
    }
    if (running) {
      workingMessage = "working…";
      refreshWorkingStatus();
    }
  }

  function formatMemoryEventBody(event: Extract<TurnEvent, { type: "memory" }>): string {
    if (!event.observations || event.observations.length === 0) {
      return "";
    }
    const content = event.observations.map((observation) => observation.content).join("\n\n");
    return truncateToolResult(`${event.message}\n${content}`);
  }

  // ---- input handling --------------------------------------------------------

  // Track shift state for the most recent Enter keypress. The focused
  // InputRenderable handles its own `enter` event after onKeyDown fires, so we
  // capture the modifier here and read it during the ENTER event below.
  let lastEnterShift = false;
  let skillAutocompleteSkills: readonly SkillAutocompleteItem[] = [];
  let skillAutocompleteToken: SkillAutocompleteToken | undefined;
  let skillAutocompleteItems: SkillAutocompleteItem[] = [];
  let skillAutocompleteSelectedIndex = 0;
  let pendingQuestions: TurnQuestion[] = [];
  let questionOptionSelectedIndex = 0;
  let suppressNextEscapeExit = false;

  let closingAfterInterrupt = false;

  const requestExit = async (): Promise<void> => {
    if (running) {
      if (closingAfterInterrupt) return;
      closingAfterInterrupt = true;
      stopWorkingTicker();
      setStatus("● interrupting…");
      try {
        await input.session.interrupt();
        await input.session.waitForTerminal();
      } catch (error) {
        reportError(error);
      } finally {
        renderer.destroy();
      }
    } else {
      renderer.destroy();
    }
  };

  function skillAutocompleteIsOpen(): boolean {
    return Boolean(skillAutocompleteToken && skillAutocompleteItems.length > 0);
  }

  function questionPickerIsOpen(): boolean {
    const question = pendingQuestions[0];
    return Boolean(question && question.options.length > 0);
  }

  function hideSkillAutocomplete(): void {
    skillAutocompleteToken = undefined;
    skillAutocompleteItems = [];
    skillAutocompleteSelectedIndex = 0;
    skillAutocompletePanel.visible = false;
    for (const row of skillAutocompleteRows) {
      row.visible = false;
      row.content = "";
    }
  }

  function hideQuestions(): void {
    pendingQuestions = [];
    questionOptionSelectedIndex = 0;
    questionPanel.visible = false;
    for (const row of questionRows) {
      row.visible = false;
      row.content = "";
    }
  }

  function showQuestions(questions: TurnQuestion[]): void {
    pendingQuestions = questions;
    questionOptionSelectedIndex = 0;
    renderQuestions();
  }

  function renderQuestions(): void {
    const question = pendingQuestions[0];
    if (!question || question.options.length === 0) {
      hideQuestions();
      return;
    }

    questionPanel.visible = true;
    questionTitle.content = question.header
      ? `${question.header}: ${question.question}`
      : question.question;
    const visibleOptions = question.options.slice(0, QUESTION_OPTION_LIMIT);
    for (const [index, row] of questionRows.entries()) {
      const option = visibleOptions[index];
      if (!option) {
        row.visible = false;
        row.content = "";
        continue;
      }

      const selected = index === questionOptionSelectedIndex;
      const labelColor = selected ? COLORS.status : COLORS.user;
      const description = formatQuestionOptionDescription(option.description);
      row.content = description
        ? t`${fg(labelColor)(option.label)}\n${description}`
        : t`${fg(labelColor)(option.label)}`;
      row.fg = selected ? COLORS.agent : COLORS.hint;
      row.visible = true;
    }
  }

  function submitSelectedQuestionOption(): boolean {
    const answers = questionPickerAnswerPayload(pendingQuestions, questionOptionSelectedIndex);
    if (!answers) return false;

    appendBlock("you:", Object.values(answers).join("\n"), COLORS.user);
    void input.session
      .answer({ questions: pendingQuestions, answers, behavior: "follow_up" })
      .catch(reportError);
    hideQuestions();
    markRunning();
    return true;
  }

  function refreshSkillAutocomplete(): void {
    const token = activeSkillAutocompleteToken(inputField.plainText, inputField.cursorOffset);
    if (!token) {
      hideSkillAutocomplete();
      return;
    }

    const items = skillAutocompleteMatches(skillAutocompleteSkills, token.query);
    if (items.length === 0) {
      hideSkillAutocomplete();
      return;
    }

    const previousToken = skillAutocompleteToken;
    skillAutocompleteToken = token;
    skillAutocompleteItems = items;
    const queryChanged =
      !previousToken ||
      previousToken.start !== token.start ||
      previousToken.end !== token.end ||
      previousToken.query !== token.query;
    if (queryChanged || skillAutocompleteSelectedIndex >= items.length) {
      skillAutocompleteSelectedIndex = 0;
    }
    renderSkillAutocomplete();
  }

  function renderSkillAutocomplete(): void {
    skillAutocompletePanel.visible = skillAutocompleteItems.length > 0;
    for (const [index, row] of skillAutocompleteRows.entries()) {
      const item = skillAutocompleteItems[index];
      if (!item) {
        row.visible = false;
        row.content = "";
        continue;
      }

      const selected = index === skillAutocompleteSelectedIndex;
      const nameColor = selected ? COLORS.status : COLORS.user;
      const pathColor = selected ? COLORS.agent : COLORS.hint;
      const description = formatSkillAutocompleteDescription(item.description);
      row.content = item.path
        ? t`${fg(nameColor)(`/${item.name}`)} ${fg(pathColor)(`(${item.path})`)}\n${description}\n`
        : t`${fg(nameColor)(`/${item.name}`)}\n${description}\n`;
      row.fg = selected ? COLORS.agent : COLORS.hint;
      row.visible = true;
    }
  }

  function completeSelectedSkillAutocomplete(): boolean {
    const token = skillAutocompleteToken;
    const item = skillAutocompleteItems[skillAutocompleteSelectedIndex];
    if (!token || !item) return false;

    const insertion = inputField.plainText[token.end]?.match(/\s/)
      ? `/${item.name}`
      : `/${item.name} `;
    inputField.setSelection(token.start, token.end);
    inputField.deleteSelection();
    inputField.insertText(insertion);
    hideSkillAutocomplete();
    return true;
  }

  const keyHandler = (renderer as unknown as { _keyHandler: InternalKeyHandlerLike })._keyHandler;
  keyHandler.onInternal("keypress", (key: KeyEvent) => {
    if (key.name !== "escape") return;
    if (suppressNextEscapeExit) {
      suppressNextEscapeExit = false;
      key.preventDefault();
      return;
    }
    if (skillAutocompleteIsOpen()) {
      key.preventDefault();
      hideSkillAutocomplete();
      return;
    }
    if (questionPickerIsOpen()) {
      key.preventDefault();
      hideQuestions();
      return;
    }
    key.preventDefault();
    void requestExit();
  });

  // Attach directly to the focused InputRenderable. The Textarea-based input
  // consumes escape via its own keybindings before any global keypress handler
  // fires, so we intercept at the Renderable's onKeyDown hook which runs first.
  inputField.onKeyDown = (key: KeyEvent) => {
    if (skillAutocompleteIsOpen()) {
      if (key.name === "up") {
        skillAutocompleteSelectedIndex = moveSkillAutocompleteSelection(
          skillAutocompleteSelectedIndex,
          skillAutocompleteItems.length,
          -1,
        );
        renderSkillAutocomplete();
        key.preventDefault();
        return;
      }
      if (key.name === "down") {
        skillAutocompleteSelectedIndex = moveSkillAutocompleteSelection(
          skillAutocompleteSelectedIndex,
          skillAutocompleteItems.length,
          1,
        );
        renderSkillAutocomplete();
        key.preventDefault();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        key.preventDefault();
        completeSelectedSkillAutocomplete();
        return;
      }
      if (key.name === "escape") {
        key.preventDefault();
        suppressNextEscapeExit = true;
        hideSkillAutocomplete();
        return;
      }
    }

    if (questionPickerIsOpen()) {
      if (key.name === "up") {
        questionOptionSelectedIndex = moveQuestionOptionSelection(
          questionOptionSelectedIndex,
          Math.min(pendingQuestions[0]?.options.length ?? 0, QUESTION_OPTION_LIMIT),
          -1,
        );
        renderQuestions();
        key.preventDefault();
        return;
      }
      if (key.name === "down") {
        questionOptionSelectedIndex = moveQuestionOptionSelection(
          questionOptionSelectedIndex,
          Math.min(pendingQuestions[0]?.options.length ?? 0, QUESTION_OPTION_LIMIT),
          1,
        );
        renderQuestions();
        key.preventDefault();
        return;
      }
      if (key.name === "escape") {
        key.preventDefault();
        suppressNextEscapeExit = true;
        hideQuestions();
        return;
      }
    }

    if (key.name === "return" || key.name === "enter") {
      lastEnterShift = Boolean(key.shift);
      // Take over Enter so the textarea does not insert a newline. We submit
      // the current buffer contents and reset, regardless of shift state —
      // shift only differentiates steer vs. queued follow-up.
      const value = inputField.plainText.trim();
      inputField.clear();
      key.preventDefault();
      if (value) {
        submit(value, lastEnterShift);
      } else if (questionPickerIsOpen()) {
        submitSelectedQuestionOption();
      }
      lastEnterShift = false;
      return;
    }
    if (key.name === "escape") {
      void requestExit();
      return;
    }
  };

  inputField.onContentChange = () => refreshSkillAutocomplete();
  inputField.onCursorChange = () => refreshSkillAutocomplete();

  function submit(message: string, shiftEnter: boolean): void {
    appendBlock("you:", message, COLORS.user);
    hideQuestions();

    if (running) {
      // Mid-turn: Enter → steer, Shift+Enter → queued follow-up.
      const behavior = shiftEnter ? "follow_up" : "steer";
      void input.session.prompt({ message, behavior }).catch(reportError);
      // Keep status as "working"; the existing turn continues.
      return;
    }

    // Idle: dispatch a prompt against the already-set-up session. Setup
    // happens before the TUI starts so skills are visible right away.
    void input.session.prompt({ message, behavior: "follow_up" }).catch(reportError);
    markRunning();
  }

  // ---- replay history on resume ---------------------------------------------

  // Setup already ran before the TUI launched, so we can read the resolved
  // skills/agent-files synchronously through the session getters.
  const [skills, agentFiles] = await Promise.all([
    input.session.getSkills(),
    input.session.getResolvedAgentFiles(),
  ]);
  skillAutocompleteSkills = skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    path: skill.baseDir,
  }));
  refreshSkillAutocomplete();
  renderSetupIntro(skills, agentFiles);
  refreshSidebar();

  const resumeHistoryLines = input.resumeHistoryLines ?? Number.POSITIVE_INFINITY;
  if (resumeHistoryLines > 0 && input.history && input.history.length > 0) {
    const limited = limitHistoryDisplayBlocks(
      historyDisplayBlocks(input.history),
      resumeHistoryLines,
    );
    if (limited.omittedLines > 0) {
      appendLine(
        `[resume] showing last ${resumeHistoryLines} lines of prior session history`,
        COLORS.hint,
      );
    }
    for (const block of limited.blocks) {
      appendDisplayBlock(block);
    }
    scrollToBottomSoon();
  }

  // ---- bootstrap initial prompt ----------------------------------------------

  if (input.initialPrompt) {
    appendBlock("you:", input.initialPrompt, COLORS.user);
    void input.session
      .prompt({ message: input.initialPrompt, behavior: "follow_up" })
      .catch(reportError);
    markRunning();
  } else {
    // No initial prompt — wait for the user. Setup already ran above, so
    // the skill summary is rendered before the user types.
    markIdle();
  }

  // ---- run renderer until the user quits -------------------------------------

  await new Promise<void>((resolve) => {
    const onDestroy = () => resolve();
    renderer.once("destroy", onDestroy);
  });

  unsubscribe();
  return lastTerminal;

  // --------------------------------------------------------------------------

  function textFromContent(content: ReadonlyArray<TextContent | ImageContent>): string {
    return content
      .filter((b): b is TextContent => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }

  function appendDisplayBlock(block: HistoryDisplayBlock): void {
    appendBlock(null, block.content, colorForHistoryBlock(block.kind));
  }

  function colorForHistoryBlock(kind: HistoryBlockKind): string {
    if (kind === "user") return COLORS.user;
    if (kind === "reasoning") return COLORS.reasoning;
    if (kind === "tool") return COLORS.tool;
    if (kind === "error") return COLORS.error;
    return COLORS.agent;
  }
}

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

export function activeSkillAutocompleteToken(
  text: string,
  cursorOffset: number,
): SkillAutocompleteToken | undefined {
  const boundedOffset = Math.max(0, Math.min(cursorOffset, text.length));
  const tokenStart = text.slice(0, boundedOffset).search(/(?:^|\s)\/[^\s]*$/);
  if (tokenStart < 0) return undefined;

  const start = text[tokenStart] === "/" ? tokenStart : tokenStart + 1;
  const tokenEnd = text.slice(boundedOffset).search(/\s/);
  const end = tokenEnd < 0 ? text.length : boundedOffset + tokenEnd;
  const token = text.slice(start, end);
  const match = token.match(SKILL_AUTOCOMPLETE_TOKEN);
  if (!match) return undefined;

  return { start, end, query: text.slice(start + 1, boundedOffset) };
}

export function skillAutocompleteMatches(
  skills: readonly SkillAutocompleteItem[],
  query: string,
  limit = SKILL_AUTOCOMPLETE_LIMIT,
): SkillAutocompleteItem[] {
  const normalizedQuery = query.toLocaleLowerCase();
  return [...skills]
    .filter((skill) => skill.name.toLocaleLowerCase().startsWith(normalizedQuery))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
}

export function formatSkillAutocompleteItem(item: SkillAutocompleteItem): string {
  const path = item.path ? ` (${item.path})` : "";
  const lines = [`/${item.name}${path}`, formatSkillAutocompleteDescription(item.description)];
  return lines.filter((line) => line.length > 0).join("\n");
}

export function formatSkillAutocompleteDescription(description: string | undefined): string {
  if (!description) return "";

  const wrapped = wrapText(description, SKILL_AUTOCOMPLETE_DESCRIPTION_WIDTH);
  const visible = wrapped.slice(0, SKILL_AUTOCOMPLETE_DESCRIPTION_LINES);
  if (wrapped.length > visible.length) {
    const lastIndex = visible.length - 1;
    visible[lastIndex] = `${visible[lastIndex]!.replace(/\s+$/, "")}...`;
  }
  return visible.join("\n");
}

function wrapText(text: string, width: number): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }

  if (current) lines.push(current);
  return lines;
}

export function moveSkillAutocompleteSelection(
  selectedIndex: number,
  itemCount: number,
  direction: -1 | 1,
): number {
  if (itemCount <= 0) return 0;
  return (selectedIndex + direction + itemCount) % itemCount;
}

export function moveQuestionOptionSelection(
  selectedIndex: number,
  itemCount: number,
  direction: -1 | 1,
): number {
  if (itemCount <= 0) return 0;
  return (selectedIndex + direction + itemCount) % itemCount;
}

export function questionPickerAnswerPayload(
  questions: readonly TurnQuestion[],
  selectedIndex: number,
): Record<string, string> | undefined {
  const firstQuestion = questions[0];
  const selectedOption = firstQuestion?.options[selectedIndex];
  if (!firstQuestion || !selectedOption) return undefined;

  return { [firstQuestion.question]: selectedOption.label };
}

export function formatQuestionOptionDescription(description: string | undefined): string {
  if (!description) return "";

  return wrapText(description, QUESTION_OPTION_DESCRIPTION_WIDTH).join("\n");
}

export function replaceSkillAutocompleteToken(
  text: string,
  token: SkillAutocompleteToken,
  skillName: string,
): SkillAutocompleteReplacement {
  const insertion = text[token.end]?.match(/\s/) ? `/${skillName}` : `/${skillName} `;
  const nextText = `${text.slice(0, token.start)}${insertion}${text.slice(token.end)}`;
  return { text: nextText, cursorOffset: token.start + insertion.length };
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

function restoreWindowGlobal(previousWindow: PropertyDescriptor | undefined): void {
  // OpenTUI installs `window.requestAnimationFrame` for browser-style
  // animation compatibility. In Bun, the presence of `window` can send fetch
  // internals down browser-only paths, while `global.requestAnimationFrame`
  // remains enough for OpenTUI after initialization.
  if (previousWindow) {
    Object.defineProperty(globalThis, "window", previousWindow);
    return;
  }
  delete (globalThis as typeof globalThis & { window?: unknown }).window;
}
