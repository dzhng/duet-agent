import type { AgentMessage } from "@earendil-works/pi-agent-core";
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
import type { Session } from "../session/session.js";
import type {
  TurnAgentFile,
  TurnContextUsageEvent,
  TurnEvent,
  TurnQuestion,
  TurnStep,
  TurnTerminalEvent,
  TurnTokenUsage,
} from "../types/protocol.js";
import {
  type AutocompleteToken,
  activeFileAutocompleteToken,
  activeSkillAutocompleteToken,
  AUTOCOMPLETE_LIMITS,
  type FileAutocompleteItem,
  fileAutocompleteMatches,
  formatQuestionOptionDescription,
  formatSkillAutocompleteDescription,
  moveQuestionOptionSelection,
  moveSkillAutocompleteSelection,
  questionPickerAnswerPayload,
  type SkillAutocompleteItem,
  skillAutocompleteMatches,
} from "./autocomplete.js";
import { buildFileIndex } from "./file-index.js";
import {
  DUET_BANNER_LINES,
  type HistoryBlockKind,
  type HistoryDisplayBlock,
  historyDisplayBlocks,
  limitHistoryDisplayBlocks,
  startupHeaderLines,
} from "./history.js";
import { createSidebar } from "./sidebar.js";
import { COLORS, HINT_IDLE, HINT_RUNNING } from "./theme.js";

export type { HistoryBlockKind, HistoryDisplayBlock, LimitedHistory } from "./history.js";
export type { StartupHeaderInput } from "./history.js";
export type {
  AutocompleteToken,
  AutocompleteToken as SkillAutocompleteToken,
  FileAutocompleteItem,
  SkillAutocompleteItem,
  SkillAutocompleteReplacement,
} from "./autocomplete.js";
// Re-exports preserve the historical `tui/app.js` entry point used by tests
// and external callers; the implementations live in focused leaf modules.
export {
  activeFileAutocompleteToken,
  activeSkillAutocompleteToken,
  fileAutocompleteMatches,
  formatQuestionOptionDescription,
  formatSkillAutocompleteDescription,
  moveQuestionOptionSelection,
  moveSkillAutocompleteSelection,
  questionPickerAnswerPayload,
  replaceFileAutocompleteToken,
  replaceSkillAutocompleteToken,
  skillAutocompleteMatches,
} from "./autocomplete.js";
export { formatSkillAutocompleteItem } from "./autocomplete.js";
export {
  DUET_BANNER_LINES,
  historyDisplayBlocks,
  limitHistoryDisplayBlocks,
  startupHeaderLines,
} from "./history.js";
import { formatToolBlock, truncateToolText } from "./tool-formatters.js";

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

const SKILL_AUTOCOMPLETE_LIMIT = AUTOCOMPLETE_LIMITS.skill;
const FILE_AUTOCOMPLETE_LIMIT = AUTOCOMPLETE_LIMITS.file;
const QUESTION_OPTION_LIMIT = AUTOCOMPLETE_LIMITS.questionOption;

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

  const sidebar = createSidebar(renderer);

  const transcript = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    flexShrink: 1,
    scrollY: true,
    // Pin to bottom as new lines arrive, but only while the user has not
    // manually scrolled away. ScrollBoxRenderable flips `_hasManualScroll`
    // the moment the user scrolls up, which pauses pinning until they
    // return to the bottom — without this, new output yanks the viewport
    // down while the user is reading history.
    stickyScroll: true,
    stickyStart: "bottom",
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

  // The @-file picker mirrors the slash picker's structure so the renderer
  // logic and key handling can stay parallel between the two pickers.
  const fileAutocompletePanel = new BoxRenderable(renderer, {
    flexDirection: "column",
    border: true,
    borderColor: COLORS.border,
    paddingLeft: 1,
    paddingRight: 1,
    flexShrink: 0,
  });
  fileAutocompletePanel.visible = false;
  const fileAutocompleteTitle = new TextRenderable(renderer, {
    content: "files",
    fg: COLORS.status,
    height: 1,
    flexShrink: 0,
  });
  const fileAutocompleteRows = Array.from({ length: FILE_AUTOCOMPLETE_LIMIT }, () => {
    const row = new TextRenderable(renderer, {
      content: "",
      fg: COLORS.hint,
      height: 1,
      flexShrink: 0,
    });
    row.visible = false;
    return row;
  });
  fileAutocompletePanel.add(fileAutocompleteTitle);
  for (const row of fileAutocompleteRows) {
    fileAutocompletePanel.add(row);
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
  layout.add(fileAutocompletePanel);
  layout.add(questionPanel);
  layout.add(inputBox);
  root.add(layout);
  root.add(sidebar.view);
  renderer.root.add(root);
  inputField.focus();

  // ---- transcript helpers ----------------------------------------------------

  function appendLine(content: string, fg: string): void {
    if (!content) return;
    const line = new TextRenderable(renderer, { content, fg });
    transcript.add(line);
  }

  // Tool results can be huge (file dumps, search output). Show only the head
  // in the transcript so the conversation flow stays readable; the full
  // payload remains in session history for the model.
  const truncateToolResult = truncateToolText;

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
    /** Formatter-produced header line, e.g. "$ ls /" or "[question]".
     *  The renderer prepends the spinner / completion marker live. */
    header: string;
    /** Optional input body lines shown under the header. */
    body: string;
    /** Original tool input, retained so the finalize pass can re-run the
     *  formatter with the output and produce a custom `result` section. */
    input: unknown;
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
  // Queued follow-up count surfaced inline on the status line so the user can
  // see at a glance how many prompts will run after the current turn settles.
  let queuedFollowUps = 0;

  function formatElapsed(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
  }

  function refreshWorkingStatus(): void {
    refreshActiveToolBlocks();
    if (workingStartedAt === undefined) {
      setStatus(queuedFollowUps > 0 ? `queued follow-ups: ${queuedFollowUps}` : "");
      return;
    }
    const elapsed = formatElapsed(Date.now() - workingStartedAt);
    const queued = queuedFollowUps > 0 ? ` · queued follow-ups: ${queuedFollowUps}` : "";
    setStatus(`● ${workingMessage} (${elapsed})${queued}`);
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
      const headerLine = `${block.header} ⏳ ${elapsed}`;
      block.line.content = block.body ? `${headerLine}\n${block.body}` : headerLine;
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
    refreshWorkingStatus();
  }

  function reportError(error: unknown): void {
    appendBlock("[error]", error instanceof Error ? error.message : String(error), COLORS.error);
    markIdle();
  }

  // ---- session subscription --------------------------------------------------

  function refreshSidebar(): void {
    const state = input.session.getState();
    sidebar.setTodos(state?.todos ?? []);
    sidebar.setStateMachine(state?.stateMachine);
    sidebar.setContextUsage(latestContextUsage);
  }

  const unsubscribe = input.session.subscribe((event: TurnEvent) => {
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
      sidebar.setContextUsage(event);
    } else if (event.type === "system") {
      appendBlock("[system]", event.message, COLORS.system);
      if (event.level === "error") markIdle();
    } else if (event.type === "ask") {
      appendBlock("[question]", event.questions.map((q) => q.question).join("\n"), COLORS.system);
      showQuestions(event.questions);
      renderUsage(event.usage);
      renderTurnElapsed();
      lastTerminal = event;
      markIdle();
    } else if (event.type === "complete") {
      if (event.error) {
        appendBlock("[error]", event.error, COLORS.error);
      }
      renderUsage(event.usage);
      renderTurnElapsed();
      lastTerminal = event;
      markIdle();
    } else if (event.type === "interrupted") {
      appendLine("[interrupted]", COLORS.system);
      renderUsage(event.usage);
      renderTurnElapsed();
      lastTerminal = event;
      markIdle();
    } else if (event.type === "sleep") {
      renderUsage(event.usage);
      renderSleeping(event.wakeAt);
      lastTerminal = event;
      markIdle();
    }
  });

  function renderSetupIntro(
    skills: ReadonlyArray<{ name: string }>,
    agentFiles: readonly TurnAgentFile[],
  ): void {
    for (const line of DUET_BANNER_LINES) appendLine(line, COLORS.status);
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

  function renderTurnElapsed(): void {
    if (workingStartedAt === undefined) return;
    appendLine(`● turn finished in ${formatElapsed(Date.now() - workingStartedAt)}`, COLORS.status);
  }

  // Sleep terminals replace the usual "turn finished" line because the session
  // is going back to sleep, not wrapping up. When a turn ran before the sleep
  // (e.g. an injected prompt while waiting on a state machine), include its
  // duration so the user can still see how long the work took.
  function renderSleeping(wakeAt: number): void {
    const wakeLabel = new Date(wakeAt).toLocaleTimeString();
    const turnDuration =
      workingStartedAt !== undefined
        ? ` · turn took ${formatElapsed(Date.now() - workingStartedAt)}`
        : "";
    appendLine(`● sleeping until ${wakeLabel}${turnDuration}`, COLORS.status);
  }

  function renderTodos(todos: readonly { id: string; status: string; content: string }[]): void {
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

  function renderFollowUpQueue(prompts: readonly string[]): void {
    queuedFollowUps = prompts.length;
    refreshWorkingStatus();
    if (prompts.length === 0) return;
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
  // Per-tool formatters in `tool-formatters.ts` decide the header text and
  // whether the call should appear in the transcript at all (e.g.
  // ask_user_question hides itself live and lets the `ask` terminal event
  // own the question display).
  function renderToolCall(step: Extract<TurnStep, { type: "tool_call" }>): void {
    const existing = activeToolBlocks.get(step.toolCallId);
    if (existing) {
      finalizeToolCall(step, existing);
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
    const headerLine = isLive ? `${formatted.header} ⏳ 0.0s` : `${formatted.header} ⏳`;
    const fg = step.status === "error" ? COLORS.error : COLORS.tool;
    const line = new TextRenderable(renderer, {
      content: formatted.body ? `${headerLine}\n${formatted.body}` : headerLine,
      fg,
    });
    beginBlock();
    transcript.add(line);
    const block: ToolBlock = {
      line,
      toolName: step.toolName,
      header: formatted.header,
      body: formatted.body ?? "",
      input: step.input,
      startedAt,
    };
    activeToolBlocks.set(step.toolCallId, block);
    // The same event may already carry a terminal status (cached/replayed
    // history). Fall through to finalize against the just-created block.
    if (!isLive) {
      finalizeToolCall(step, block);
    }
  }

  function finalizeToolCall(
    step: Extract<TurnStep, { type: "tool_call" }>,
    block: ToolBlock,
  ): void {
    const isError = step.status === "error";
    const marker = isError ? "✗" : "✓";
    const durationSuffix =
      block.startedAt === undefined ? "" : ` ${formatToolDuration(Date.now() - block.startedAt)}`;
    const headerLine = `${block.header} ${marker}${durationSuffix}`;
    const formatted = formatToolBlock({
      toolName: block.toolName,
      status: isError ? "error" : "completed",
      input: block.input,
      output: step.output,
      mode: "live",
    });
    const sections = [formatted.body ? `${headerLine}\n${formatted.body}` : headerLine];
    if (formatted.result && formatted.result.body) {
      sections.push(`${formatted.result.label}\n${formatted.result.body}`);
    }
    block.line.content = sections.join("\n");
    block.line.fg = isError ? COLORS.error : COLORS.tool;
    activeToolBlocks.delete(step.toolCallId);
  }

  function finalizeDelta(block: StreamingBlock, body: string): void {
    block.body = body;
    updateStreamingBlock(block);
  }

  function updateStreamingBlock(block: StreamingBlock): void {
    const body = block.truncate ? truncateToolResult(block.body) : block.body;
    block.line.content = block.label ? `${block.label}\n${body}` : body;
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
  let skillAutocompleteToken: AutocompleteToken | undefined;
  let skillAutocompleteItems: SkillAutocompleteItem[] = [];
  let skillAutocompleteSelectedIndex = 0;

  // File index loads lazily after the first @ trigger and never re-runs.
  // Repos large enough to matter would block the first keystroke otherwise;
  // a stale-by-a-few-files index is a fair trade for a snappy first paint.
  let fileAutocompleteAllFiles: readonly FileAutocompleteItem[] = [];
  let fileAutocompleteIndexPromise: Promise<readonly FileAutocompleteItem[]> | undefined;
  let fileAutocompleteToken: AutocompleteToken | undefined;
  let fileAutocompleteItems: FileAutocompleteItem[] = [];
  let fileAutocompleteSelectedIndex = 0;

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

  function fileAutocompleteIsOpen(): boolean {
    return Boolean(fileAutocompleteToken && fileAutocompleteItems.length > 0);
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

  function hideFileAutocomplete(): void {
    fileAutocompleteToken = undefined;
    fileAutocompleteItems = [];
    fileAutocompleteSelectedIndex = 0;
    fileAutocompletePanel.visible = false;
    for (const row of fileAutocompleteRows) {
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

  async function ensureFileIndex(): Promise<readonly FileAutocompleteItem[]> {
    if (fileAutocompleteAllFiles.length > 0) return fileAutocompleteAllFiles;
    if (!fileAutocompleteIndexPromise) {
      fileAutocompleteIndexPromise = buildFileIndex(input.workDir).catch(() => []);
    }
    fileAutocompleteAllFiles = await fileAutocompleteIndexPromise;
    return fileAutocompleteAllFiles;
  }

  function refreshAutocomplete(): void {
    refreshSkillAutocomplete();
    refreshFileAutocomplete();
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

  function refreshFileAutocomplete(): void {
    const token = activeFileAutocompleteToken(inputField.plainText, inputField.cursorOffset);
    if (!token) {
      hideFileAutocomplete();
      return;
    }

    // Capture the token id we're looking up so a slow index resolution can
    // tell whether the user has typed past the original query and bail out.
    const targetStart = token.start;
    const targetEnd = token.end;
    const targetQuery = token.query;
    void ensureFileIndex().then((files) => {
      const stillCurrent =
        fileAutocompleteToken !== undefined
          ? fileAutocompleteToken.start === targetStart &&
            fileAutocompleteToken.end === targetEnd &&
            fileAutocompleteToken.query === targetQuery
          : activeFileAutocompleteToken(inputField.plainText, inputField.cursorOffset)?.query ===
            targetQuery;
      if (!stillCurrent && fileAutocompleteToken === undefined) return;
      const items = fileAutocompleteMatches(files, targetQuery);
      if (items.length === 0) {
        hideFileAutocomplete();
        return;
      }
      const previousToken = fileAutocompleteToken;
      fileAutocompleteToken = { start: targetStart, end: targetEnd, query: targetQuery };
      fileAutocompleteItems = items;
      const queryChanged =
        !previousToken ||
        previousToken.start !== targetStart ||
        previousToken.end !== targetEnd ||
        previousToken.query !== targetQuery;
      if (queryChanged || fileAutocompleteSelectedIndex >= items.length) {
        fileAutocompleteSelectedIndex = 0;
      }
      renderFileAutocomplete();
    });
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

  function renderFileAutocomplete(): void {
    fileAutocompletePanel.visible = fileAutocompleteItems.length > 0;
    for (const [index, row] of fileAutocompleteRows.entries()) {
      const item = fileAutocompleteItems[index];
      if (!item) {
        row.visible = false;
        row.content = "";
        continue;
      }
      const selected = index === fileAutocompleteSelectedIndex;
      const nameColor = selected ? COLORS.status : COLORS.user;
      const pathColor = selected ? COLORS.agent : COLORS.hint;
      // Show basename + relative directory side-by-side. The directory
      // portion is the path with the trailing basename removed; for files at
      // the repo root this collapses to "./" so each row has a consistent
      // shape.
      const directory = item.relativePath.includes("/")
        ? item.relativePath.slice(0, item.relativePath.lastIndexOf("/") + 1)
        : "./";
      row.content = t`${fg(nameColor)(item.name)} ${fg(pathColor)(directory)}`;
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

  function completeSelectedFileAutocomplete(): boolean {
    const token = fileAutocompleteToken;
    const item = fileAutocompleteItems[fileAutocompleteSelectedIndex];
    if (!token || !item) return false;

    const insertion = inputField.plainText[token.end]?.match(/\s/)
      ? `@${item.relativePath}`
      : `@${item.relativePath} `;
    inputField.setSelection(token.start, token.end);
    inputField.deleteSelection();
    inputField.insertText(insertion);
    hideFileAutocomplete();
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
    if (fileAutocompleteIsOpen()) {
      key.preventDefault();
      hideFileAutocomplete();
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
      if (key.name === "return" || key.name === "enter" || key.name === "tab") {
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

    if (fileAutocompleteIsOpen()) {
      if (key.name === "up") {
        fileAutocompleteSelectedIndex = moveSkillAutocompleteSelection(
          fileAutocompleteSelectedIndex,
          fileAutocompleteItems.length,
          -1,
        );
        renderFileAutocomplete();
        key.preventDefault();
        return;
      }
      if (key.name === "down") {
        fileAutocompleteSelectedIndex = moveSkillAutocompleteSelection(
          fileAutocompleteSelectedIndex,
          fileAutocompleteItems.length,
          1,
        );
        renderFileAutocomplete();
        key.preventDefault();
        return;
      }
      if (key.name === "return" || key.name === "enter" || key.name === "tab") {
        key.preventDefault();
        completeSelectedFileAutocomplete();
        return;
      }
      if (key.name === "escape") {
        key.preventDefault();
        suppressNextEscapeExit = true;
        hideFileAutocomplete();
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

  inputField.onContentChange = () => refreshAutocomplete();
  inputField.onCursorChange = () => refreshAutocomplete();

  function submit(message: string, shiftEnter: boolean): void {
    appendBlock("you:", message, COLORS.user);
    hideQuestions();

    if (running) {
      const behavior = shiftEnter ? "follow_up" : "steer";
      void input.session.prompt({ message, behavior }).catch(reportError);
      return;
    }

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
  refreshAutocomplete();
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
  }

  // ---- bootstrap initial prompt ----------------------------------------------

  if (input.initialPrompt) {
    appendBlock("you:", input.initialPrompt, COLORS.user);
    void input.session
      .prompt({ message: input.initialPrompt, behavior: "follow_up" })
      .catch(reportError);
    markRunning();
  } else {
    // A resumed sleeping session emitted its `sleep` terminal during
    // hydrate(), before this subscriber attached. Surface the banner now so
    // the user can see when the next wake will fire.
    const pending = input.session.getLastTerminal();
    if (pending?.type === "sleep") {
      lastTerminal = pending;
      renderSleeping(pending.wakeAt);
    }
    markIdle();
  }

  // ---- run renderer until the user quits -------------------------------------

  await new Promise<void>((resolve) => {
    const onDestroy = () => {
      // Ctrl+C (exitOnCtrlC) destroys text buffers synchronously. Any
      // setInterval that survives into the next tick will call setStatus on
      // a destroyed TextBuffer and throw, so tear down timers here before
      // resolving.
      stopWorkingTicker();
      resolve();
    };
    renderer.once("destroy", onDestroy);
  });

  unsubscribe();
  return lastTerminal;

  // --------------------------------------------------------------------------

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
