import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  BoxRenderable,
  createCliRenderer,
  decodePasteBytes,
  fg,
  type KeyEvent,
  type PasteEvent,
  ScrollBoxRenderable,
  type Selection,
  t,
  TextRenderable,
  TextareaRenderable,
} from "@opentui/core";
import { type ClipboardWriteResult, writeClipboardText } from "./clipboard.js";
import {
  describeMacClipboardTypes,
  loadImageFromPath,
  looksLikeImageFilePath,
  type PendingImage,
  persistPastedImage,
  sniffImageMimeType,
  tryReadClipboardImage,
  tryReadClipboardText,
} from "./paste.js";
import { parseCopyArgument, selectCopyText, type TranscriptEntry } from "./transcript-log.js";
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
  BUILT_IN_SLASH_COMMANDS,
  fileAutocompleteMatches,
  formatQuestionOptionDescription,
  formatSkillAutocompleteDescription,
  moveQuestionOptionSelection,
  moveSkillAutocompleteSelection,
  questionPickerAnswerPayload,
  type SkillAutocompleteItem,
  skillAutocompleteMatches,
  type SlashAutocompleteGroup,
} from "./autocomplete.js";
import { homedir } from "node:os";

import { buildFileIndex } from "./file-index.js";
import {
  DUET_BANNER_LINES_COMPACT,
  type HistoryBlockKind,
  type HistoryDisplayBlock,
  historyDisplayBlocks,
  limitHistoryDisplayMessages,
} from "./history.js";
import { listRecentSessions } from "./recent-sessions.js";
import { createSidebar, SIDEBAR_WIDTH } from "./sidebar.js";
import { orderedSelectableStarters, selectStarters } from "./starters.js";
import { COLORS, HINT_IDLE, HINT_RUNNING, HINT_SELECTION_COPY } from "./theme.js";

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
  limitHistoryDisplayMessages,
  startupHeaderLines,
} from "./history.js";
import { assembleToolBlock, formatToolBlock, truncateToolText } from "./tool-formatters.js";

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
  /**
   * Pending probe for a package update notice. The TUI renders a placeholder
   * line in the intro and replaces it with the notice once the probe settles.
   * Resolves to undefined when the user is already on the latest version or
   * the registry lookup failed.
   */
  versionNoticePromise?: Promise<string | undefined>;
  /** Past messages to replay into the transcript on resume. */
  history?: AgentMessage[];
  /**
   * Number of trailing user-turn exchanges to replay from prior history.
   * Each exchange is the user prompt plus the assistant blocks (text,
   * reasoning, tools, errors) that followed it. `0` disables replay; when
   * unset, every block is replayed. The CLI passes the configured default
   * so resumes do not flood the transcript.
   */
  resumeHistoryMessages?: number;
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
  // useMouse: true so the scroll wheel reaches the transcript
  // ScrollBoxRenderable and so OpenTUI receives drag events for in-app
  // text selection. Selected text is captured via the renderer's
  // `selection` event below and copied to the clipboard via OSC 52 (or
  // CLI fallback) on the platform-appropriate copy keystroke (Cmd+C on
  // macOS, Ctrl+Shift+C elsewhere) or `/copy`. PageUp/PageDown and
  // Shift+Up/Down keyboard bindings below cover terminals or sessions
  // where the wheel does not reach us (e.g. tmux without mouse mode).
  //
  // Bare Ctrl+C remains the always-exit keystroke (handled via
  // exitOnCtrlC) so the convention every other interactive Linux/Windows
  // terminal app follows still works here.
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useMouse: true,
    useKittyKeyboard: {},
    targetFps: 60,
  });
  restoreWindowGlobal(previousWindow);

  // Most recent drag-selected text. OpenTUI emits the `selection` event
  // whenever a drag finishes; we cache the resulting string so /copy and
  // the copy keystroke can prefer the user's actual highlight over the
  // last-message heuristic, and so the bottom hint can advertise the
  // copy keystroke only while it actually does something.
  let lastSelectionText = "";
  renderer.on("selection", (selection: Selection) => {
    lastSelectionText = selection.getSelectedText();
    refreshHint();
  });

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

  // Status and hint chrome are excluded from drag-select so a highlight that
  // sweeps the bottom of the screen does not pull the spinner / hint text
  // into the clipboard alongside the transcript content the user wanted.
  const status = new TextRenderable(renderer, {
    content: "",
    fg: COLORS.status,
    height: 1,
    flexShrink: 0,
    selectable: false,
  });

  const hint = new TextRenderable(renderer, {
    content: HINT_IDLE,
    fg: COLORS.hint,
    height: 1,
    flexShrink: 0,
    selectable: false,
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

  // Two ordered sections: built-in commands first, skills second. Each
  // section has its own header row plus a fixed pool of item rows. Selection
  // navigates the flat ordered list of visible items across both sections.
  // Row height is assigned per render based on the wrapped description
  // length so a one-line description doesn't leave an empty trailing line
  // beneath the name. The renderer sets `height` whenever it writes
  // `content`.
  // Autocomplete and panel chrome are not part of the transcript content,
  // so exclude them from drag-select to keep the clipboard focused on
  // assistant/user messages.
  const makeItemRow = () => {
    const row = new TextRenderable(renderer, {
      content: "",
      fg: COLORS.hint,
      flexShrink: 0,
      selectable: false,
    });
    row.visible = false;
    return row;
  };
  const makeHeaderRow = (label: string) =>
    new TextRenderable(renderer, {
      content: label,
      fg: COLORS.status,
      height: 1,
      flexShrink: 0,
      selectable: false,
    });
  const commandHeader = makeHeaderRow("commands");
  const commandRows = Array.from({ length: BUILT_IN_SLASH_COMMANDS.length }, makeItemRow);
  const skillHeader = makeHeaderRow("skills");
  const skillRows = Array.from({ length: SKILL_AUTOCOMPLETE_LIMIT }, makeItemRow);
  skillAutocompletePanel.add(commandHeader);
  for (const row of commandRows) skillAutocompletePanel.add(row);
  skillAutocompletePanel.add(skillHeader);
  for (const row of skillRows) skillAutocompletePanel.add(row);

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
    selectable: false,
  });
  const fileAutocompleteRows = Array.from({ length: FILE_AUTOCOMPLETE_LIMIT }, () => {
    const row = new TextRenderable(renderer, {
      content: "",
      fg: COLORS.hint,
      height: 1,
      flexShrink: 0,
      selectable: false,
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
    selectable: false,
  });
  const questionSpacer = new TextRenderable(renderer, {
    content: "",
    height: 1,
    flexShrink: 0,
    selectable: false,
  });
  const questionRows = Array.from({ length: QUESTION_OPTION_LIMIT }, () => {
    const row = new TextRenderable(renderer, {
      content: "",
      fg: COLORS.hint,
      wrapMode: "word",
      flexShrink: 0,
      selectable: false,
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

  // The leading "> " sigil is decoration, not content; excluding it from
  // selection means a drag that starts at the input row does not pull the
  // sigil into the clipboard alongside the highlighted text.
  const prompt = new TextRenderable(renderer, {
    content: "> ",
    fg: COLORS.user,
    width: 2,
    selectable: false,
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
    const base = running ? HINT_RUNNING : HINT_IDLE;
    const segments: string[] = [];
    if (pendingImages.length > 0) segments.push(attachmentHint());
    segments.push(base);
    if (lastSelectionText.trim().length > 0) segments.push(HINT_SELECTION_COPY);
    hint.content = segments.join(" · ");
  }

  function attachmentHint(): string {
    const n = pendingImages.length;
    return n === 1 ? "📎 1 image attached" : `📎 ${n} images attached`;
  }

  // Single-channel hint refresh used by every input that affects what the
  // bottom row should advertise (running state, attachments, selection).
  function refreshHint(): void {
    setHint(running);
  }

  // ---- runtime state ---------------------------------------------------------

  let running = false;
  // Image attachments collected via paste / `/image` and forwarded to the
  // runner with the next prompt submission. Cleared after submit so each turn
  // ships its own attachments without leaking into the next.
  let pendingImages: PendingImage[] = [];
  // Monotonic counter for the next `[Image #N]` placeholder. Reset alongside
  // `pendingImages` so users see a fresh `#1` label after each submit.
  let nextImageId = 1;
  // Parallel record of user/agent message bodies driven by the same code
  // paths that render them into the transcript. The `/copy` slash command
  // and copy keystroke read from this log instead of trying to walk the
  // ScrollBoxRenderable, which only stores presentation lines.
  const transcriptLog: TranscriptEntry[] = [];
  function recordTranscriptEntry(kind: TranscriptEntry["kind"], text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    transcriptLog.push({ kind, text: trimmed });
  }
  let lastTerminal: TurnTerminalEvent | undefined;
  let latestContextUsage: TurnContextUsageEvent | undefined;
  // Running USD total across every settled turn in this session. Reset only
  // by exiting the TUI; resumed sessions start fresh because per-turn usage
  // events are not replayed from persisted state.
  let sessionCost = 0;
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

  function refreshActiveToolBlocks(): void {
    if (activeToolBlocks.size === 0) return;
    const columns = toolBlockColumns();
    for (const block of activeToolBlocks.values()) {
      if (block.startedAt === undefined) continue;
      block.line.content = assembleToolBlock(
        { header: block.header, body: block.body || undefined },
        runningMarker(Date.now() - block.startedAt),
        { columns },
      );
    }
  }

  /**
   * Spinner marker for an in-flight tool call. Hides the elapsed counter for
   * sub-second runs so a transcript of fast tools is not littered with "0s".
   */
  function runningMarker(elapsedMs: number): string {
    return elapsedMs >= 1000 ? `⏳ ${formatElapsed(elapsedMs)}` : "⏳";
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
    sidebar.setFollowUpQueue(state?.followUpQueue ?? []);
    sidebar.setStateMachine(state?.stateMachine);
    sidebar.setContextUsage(latestContextUsage);
    sidebar.setSessionCost(sessionCost);
  }

  const unsubscribe = input.session.subscribe((event: TurnEvent) => {
    refreshSidebar();
    if (event.type === "step") {
      renderStep(event.step);
    } else if (event.type === "follow_up_queue") {
      // Sidebar already refreshed from session state above; mirror the count
      // into the working-status line so the user can see queued prompts at a
      // glance without scrolling the sidebar.
      queuedFollowUps = event.prompts.length;
      refreshWorkingStatus();
    } else if (event.type === "todos") {
      // Sidebar refresh covers the visual update; nothing else to do here.
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
    // Compact 3-row wordmark. The full DUET_BANNER_LINES is ~6 rows tall
    // and pushed the starter list off-screen on small terminals; this one
    // keeps the brand mark visible while leaving room for the ice-break
    // prompts to land above the fold.
    for (const line of DUET_BANNER_LINES_COMPACT) appendLine(line, COLORS.status);
    appendLine(" ", COLORS.hint);
    appendLine(" ", COLORS.hint);
    // One-line header. Keeps cwd/model context visible without burning
    // another five rows. Provenance (env/file source) is intentionally
    // dropped here — surface it via /whoami later.
    appendLine(formatBootHeader(input), COLORS.status);

    if (input.versionNoticePromise) {
      const versionLine = new TextRenderable(renderer, {
        content: "[version] checking for updates…",
        fg: COLORS.hint,
      });
      transcript.add(versionLine);
      void input.versionNoticePromise.then((notice) => {
        if (notice) {
          versionLine.content = notice;
          versionLine.fg = COLORS.system;
        } else {
          transcript.remove(versionLine.id);
          versionLine.destroy();
        }
      });
    }

    // Only mention agent files when one is actually loaded; "[agent file]
    // none" is noise on every empty boot.
    if (agentFiles.length > 0) {
      appendLine(`[agent file] ${agentFiles.map((file) => file.name).join(", ")}`, COLORS.hint);
    }

    renderStarters(skills);
  }

  function formatBootHeader(headerInput: RunTuiInput): string {
    const cwdLabel = shortenCwd(headerInput.workDir);
    return `DUET AGENT  v${headerInput.packageVersion}   ·   ${cwdLabel}   ·   ${headerInput.modelName} + ${headerInput.memoryModelName}`;
  }

  function shortenCwd(cwd: string): string {
    const home = homedir();
    if (cwd === home) return "~";
    if (cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
    return cwd;
  }

  // ---- starter prompts (boot screen) ---------------------------------------

  // Boot screen offers a small set of context-aware starter prompts so
  // first-time and returning users land on something concrete in <2 seconds
  // instead of staring at a blank input. The starter section dismisses on
  // first composition or first submit and never re-renders that session.
  //
  // Each entry in `starterEntries` is either a raw cwd-based prompt to
  // submit verbatim, or a recent-session continuation that injects the
  // previous session's last user prompt into the input field. The two
  // kinds share the same numbered/highlighted row UX.
  type StarterEntry =
    | { kind: "prompt"; label: string; submit: string }
    | { kind: "recent"; label: string; submit: string; sessionId: string };
  const starterEntries: StarterEntry[] = [];
  // Lines we render for the starter section so we can repaint highlights
  // and tear them all down on dismissal. Includes the headline, numbered
  // rows, the optional resume row, and the two trailing hint rows.
  const starterRefs: TextRenderable[] = [];
  // Indexes within `starterRefs` that correspond to numbered rows; used
  // to repaint highlight on arrow / digit navigation.
  const starterRowIndexes: number[] = [];
  let highlightedStarterIndex = 0;
  let startersVisible = false;

  function startersAreVisible(): boolean {
    return startersVisible;
  }

  function renderStarters(skills: ReadonlyArray<{ name: string }>): void {
    // Read recent sessions off disk synchronously. The helper swallows fs
    // errors and returns an empty list; a missing/empty ~/.duet/sessions
    // directory is the common first-boot case.
    const recentSessions = listRecentSessions({
      excludeId: input.sessionId,
      limit: 4,
    });
    const result = selectStarters({
      cwd: input.workDir,
      sessionHistory: input.history,
      recentSessions,
    });
    // Selectable rows in render order. Recent sessions lead so returning
    // users hit "pick up the thread" first; new users see the cwd starters
    // under the original "what should we work on today?" headline.
    const ordered = orderedSelectableStarters(result);
    starterEntries.length = 0;
    for (const row of ordered) {
      if (row.kind === "recent" && row.sessionId !== undefined) {
        starterEntries.push({
          kind: "recent",
          label: row.label,
          submit: row.submit,
          sessionId: row.sessionId,
        });
      } else {
        starterEntries.push({ kind: "prompt", label: row.label, submit: row.submit });
      }
    }

    const hasRecent = result.recentSessions.length > 0;

    starterRowIndexes.length = 0;
    appendLine(" ", COLORS.hint);

    if (hasRecent) {
      // Returning user: continuity first.
      starterRefs.push(addLine("pick up the thread", COLORS.agent));
      appendLine(" ", COLORS.hint);
      for (let i = 0; i < result.recentSessions.length; i += 1) {
        const ref = addLine(formatStarterRow(i, false), COLORS.hint);
        starterRowIndexes.push(starterRefs.length);
        starterRefs.push(ref);
      }
      appendLine(" ", COLORS.hint);
      starterRefs.push(addLine("or start something new", COLORS.agent));
      appendLine(" ", COLORS.hint);
      for (let j = 0; j < result.starters.length; j += 1) {
        const i = result.recentSessions.length + j;
        const ref = addLine(formatStarterRow(i, false), COLORS.hint);
        starterRowIndexes.push(starterRefs.length);
        starterRefs.push(ref);
      }
    } else {
      // New user: original cwd-only ice-break.
      starterRefs.push(addLine("what should we work on today?", COLORS.agent));
      appendLine(" ", COLORS.hint);
      for (let i = 0; i < starterEntries.length; i += 1) {
        const ref = addLine(formatStarterRow(i, false), COLORS.hint);
        starterRowIndexes.push(starterRefs.length);
        starterRefs.push(ref);
      }
    }

    appendLine(" ", COLORS.hint);
    starterRefs.push(
      addLine("type a number to run, ↑/↓ to highlight, or just start typing.", COLORS.hint),
    );
    starterRefs.push(
      addLine(`✦ ${skills.length} skill${skills.length === 1 ? "" : "s"} · /help`, COLORS.hint),
    );

    startersVisible = starterEntries.length > 0;
    if (startersVisible) {
      highlightedStarterIndex = 0;
      paintStarterHighlight();
    }
  }

  function addLine(content: string, fg: string): TextRenderable {
    const line = new TextRenderable(renderer, { content: content || " ", fg });
    transcript.add(line);
    return line;
  }

  function formatStarterRow(index: number, highlighted: boolean): string {
    const entry = starterEntries[index];
    const text = entry?.label ?? "";
    const number = index + 1;
    const arrow = highlighted ? "▶" : "→";
    const numberCell = highlighted ? `[${number}]` : ` ${number} `;
    return `   ${numberCell}  ${arrow}  ${text}`;
  }

  function paintStarterHighlight(): void {
    for (let i = 0; i < starterRowIndexes.length; i += 1) {
      const ref = starterRefs[starterRowIndexes[i]];
      const isHighlighted = i === highlightedStarterIndex;
      ref.content = formatStarterRow(i, isHighlighted);
      ref.fg = isHighlighted ? COLORS.user : COLORS.hint;
    }
  }

  function moveStarterHighlight(delta: number): void {
    if (!startersVisible || starterEntries.length === 0) return;
    const next = (highlightedStarterIndex + delta + starterEntries.length) % starterEntries.length;
    highlightedStarterIndex = next;
    paintStarterHighlight();
  }

  function jumpStarterHighlight(targetIndex: number): boolean {
    if (!startersVisible) return false;
    if (targetIndex < 0 || targetIndex >= starterEntries.length) return false;
    highlightedStarterIndex = targetIndex;
    paintStarterHighlight();
    return true;
  }

  function dismissStarters(): void {
    if (!startersVisible && starterRefs.length === 0) return;
    for (const ref of starterRefs) {
      transcript.remove(ref.id);
      ref.destroy();
    }
    starterRefs.length = 0;
    starterRowIndexes.length = 0;
    starterEntries.length = 0;
    startersVisible = false;
  }

  function submitHighlightedStarter(): boolean {
    if (!startersVisible) return false;
    const entry = starterEntries[highlightedStarterIndex];
    if (!entry) return false;
    dismissStarters();
    // Recent-session rows reuse the prompt text in the *current* session
    // rather than tearing down the runtime to switch sessions. The agent
    // won't have prior context, but the user lands on the same task with
    // one keystroke instead of typing it again. Documented tradeoff: a
    // future iteration can swap this for true cross-session resume once
    // the session manager exposes a hot-swap API.
    submit(entry.submit);
    return true;
  }

  function renderUsage(usage?: TurnTokenUsage): void {
    if (!usage) return;
    sessionCost += usage.cost.total;
    sidebar.setSessionCost(sessionCost);
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
    appendLine(`[usage] ${tokens}${cost}`, COLORS.hint);
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
      recordTranscriptEntry("agent", step.text);
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
      if (trimmed) appendBlock("[reasoning]", truncateToolText(trimmed), COLORS.reasoning);
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
  // Width budget for a tool block: terminal width minus the fixed sidebar
  // column and a small fudge for borders/padding. Recomputed per render so a
  // resize after a tool block lands updates new blocks; existing blocks keep
  // the width they were rendered at, which is acceptable since the renderer
  // would otherwise re-wrap and could exceed the row cap.
  function toolBlockColumns(): number {
    const transcriptColumnPadding = 4;
    return Math.max(20, renderer.terminalWidth - SIDEBAR_WIDTH - transcriptColumnPadding);
  }

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
    const marker = "⏳";
    const fg = step.status === "error" ? COLORS.error : COLORS.tool;
    const columns = toolBlockColumns();
    const line = new TextRenderable(renderer, {
      content: assembleToolBlock(formatted, marker, { columns }),
      fg,
    });
    beginBlock();
    transcript.add(line);
    const block: ToolBlock = {
      line,
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
      columns: toolBlockColumns(),
    });
    block.line.fg = isError ? COLORS.error : COLORS.tool;
    activeToolBlocks.delete(step.toolCallId);
  }

  function finalizeDelta(block: StreamingBlock, body: string): void {
    block.body = body;
    updateStreamingBlock(block);
  }

  function updateStreamingBlock(block: StreamingBlock): void {
    const body = block.truncate ? truncateToolText(block.body) : block.body;
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
    return truncateToolText(`${event.message}\n${content}`);
  }

  // ---- input handling --------------------------------------------------------

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
    commandHeader.visible = false;
    skillHeader.visible = false;
    for (const row of [...commandRows, ...skillRows]) {
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

    const answerText = Object.values(answers).join("\n");
    recordTranscriptEntry("user", answerText);
    appendBlock("you:", answerText, COLORS.user);
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

    // Distribute matched items into the two section row pools by group. The
    // selection index navigates the flat list, so we track each item's flat
    // position to highlight the correct row regardless of section.
    const groups: Record<SlashAutocompleteGroup, { rows: TextRenderable[]; cursor: number }> = {
      commands: { rows: commandRows, cursor: 0 },
      skills: { rows: skillRows, cursor: 0 },
    };
    for (const row of [...commandRows, ...skillRows]) {
      row.visible = false;
      row.content = "";
    }

    for (const [flatIndex, item] of skillAutocompleteItems.entries()) {
      const groupKey = item.group ?? "skills";
      const slot = groups[groupKey];
      const row = slot.rows[slot.cursor];
      if (!row) continue;
      slot.cursor += 1;
      const selected = flatIndex === skillAutocompleteSelectedIndex;
      const nameColor = selected ? COLORS.status : COLORS.user;
      const pathColor = selected ? COLORS.agent : COLORS.hint;
      const description = formatSkillAutocompleteDescription(item.description);
      const tail = description ? `\n${description}` : "";
      row.content = item.path
        ? t`${fg(nameColor)(`/${item.name}`)} ${fg(pathColor)(`(${item.path})`)}${tail}`
        : t`${fg(nameColor)(`/${item.name}`)}${tail}`;
      // Height = name line + each wrapped description line. Without this the
      // box defaults to a single line and clips multi-line descriptions.
      row.height = description ? 1 + description.split("\n").length : 1;
      row.fg = selected ? COLORS.agent : COLORS.hint;
      row.visible = true;
    }

    commandHeader.visible = groups.commands.cursor > 0;
    skillHeader.visible = groups.skills.cursor > 0;
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
    handleEscape();
  });

  // Keyboard scroll bindings for the transcript. Mirrors the mouse wheel
  // for terminals that swallow mouse events (tmux without mouse mode, ssh
  // sessions where the local terminal owns the wheel, screen readers).
  // Page = one viewport; Shift+arrow = three lines, matching wheel cadence.
  function scrollTranscriptByLines(delta: number): void {
    transcript.scrollBy({ x: 0, y: delta });
  }
  function scrollTranscriptByPage(direction: 1 | -1): void {
    // Subtract 2 to account for the top+bottom border rows; padding lives
    // inside the scroll viewport and does not need to be deducted.
    const viewport = Math.max(1, transcript.height - 2);
    transcript.scrollBy({ x: 0, y: direction * viewport });
  }

  // Attach directly to the focused InputRenderable. The Textarea-based input
  // consumes escape via its own keybindings before any global keypress handler
  // fires, so we intercept at the Renderable's onKeyDown hook which runs first.
  inputField.onKeyDown = (key: KeyEvent) => {
    if (key.name === "pageup") {
      scrollTranscriptByPage(-1);
      key.preventDefault();
      return;
    }
    if (key.name === "pagedown") {
      scrollTranscriptByPage(1);
      key.preventDefault();
      return;
    }
    if (key.shift && key.name === "up" && !key.ctrl && !key.meta && !key.super) {
      scrollTranscriptByLines(-3);
      key.preventDefault();
      return;
    }
    if (key.shift && key.name === "down" && !key.ctrl && !key.meta && !key.super) {
      scrollTranscriptByLines(3);
      key.preventDefault();
      return;
    }

    // Boot starter navigation. Only intercepts when the starter section is
    // still on screen; once dismissed (by composition or first submit) all
    // of these branches no-op and keys flow normally to the input.
    if (startersAreVisible() && inputField.plainText.length === 0) {
      if (key.name === "up") {
        moveStarterHighlight(-1);
        key.preventDefault();
        return;
      }
      if (key.name === "down") {
        moveStarterHighlight(1);
        key.preventDefault();
        return;
      }
      if (
        key.name &&
        key.name.length === 1 &&
        key.name >= "1" &&
        key.name <= "9" &&
        !key.ctrl &&
        !key.meta &&
        !key.super
      ) {
        const target = Number.parseInt(key.name, 10) - 1;
        if (jumpStarterHighlight(target)) {
          key.preventDefault();
          return;
        }
      }
    }

    // Cmd+V / Ctrl+V keystroke trigger. Many terminals (Warp in particular,
    // and macOS Terminal.app for binary clipboards) do not forward a paste
    // event to TUI programs on Cmd+V — they handle the clipboard at the app
    // level and only deliver the resulting text. We catch the keystroke here
    // and probe the OS clipboard directly so image attach works regardless of
    // whether the terminal cooperates with bracketed paste for binary data.
    //
    // The keystroke handler only fires on terminals that actually deliver
    // Cmd+V as a keypress (kitty-keyboard-aware terminals: kitty, Ghostty,
    // recent iTerm2, WezTerm). For terminals that swallow Cmd+V entirely,
    // the `/paste` slash command below provides a guaranteed fallback.
    if (key.name === "v" && (key.super || key.meta || key.ctrl) && !key.shift) {
      key.preventDefault();
      void triggerClipboardProbe("keystroke");
      return;
    }

    // Copy keystrokes. The set is intentionally generous because each
    // mainstream terminal forwards a different subset:
    //
    //   - Cmd+C: macOS muscle memory; many terminals (Terminal.app, Warp)
    //     own this for their own selection UI and never forward it.
    //   - Cmd+Shift+C: forwarded by Warp on macOS and by some configs of
    //     iTerm2 / Ghostty where Cmd+C is reserved.
    //   - Ctrl+Shift+C: Linux/Windows terminal-app convention that
    //     leaves bare Ctrl+C free for "exit."
    //
    // The hint label surfaces only the OS-natural one so the bottom row
    // stays terse. No-op when nothing is selected so the keystroke still
    // falls through to whatever the terminal would do natively. We accept
    // both "c" and "C" because some kitty parsers report the shifted
    // letter while others report the base letter plus shift=true.
    const isCopyLetter = key.name === "c" || key.name === "C";
    const cmdHeld = key.super || key.meta;
    const isCmdC = isCopyLetter && cmdHeld && !key.shift && !key.ctrl;
    const isCmdShiftC = isCopyLetter && cmdHeld && key.shift && !key.ctrl;
    const isCtrlShiftC = isCopyLetter && key.ctrl && key.shift && !cmdHeld;
    if ((isCmdC || isCmdShiftC || isCtrlShiftC) && lastSelectionText.trim().length > 0) {
      key.preventDefault();
      void copyActiveSelection();
      return;
    }

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
      // Shift+Enter inserts a literal newline at the cursor, matching every
      // modern chat composer (Slack, Claude Code, ChatGPT, Discord). Plain
      // Enter always submits — when the agent is running the submit path
      // queues the message as a follow-up; otherwise it kicks off a new turn.
      key.preventDefault();
      if (key.shift) {
        inputField.insertText("\n");
        return;
      }
      const value = inputField.plainText.trim();
      inputField.clear();
      if (value) {
        submit(value);
      } else if (questionPickerIsOpen()) {
        submitSelectedQuestionOption();
      } else if (startersAreVisible()) {
        submitHighlightedStarter();
      }
      return;
    }
    if (key.name === "escape") {
      handleEscape();
      return;
    }
  };

  // Esc interrupts the in-flight turn; when nothing is running it is a
  // no-op so muscle memory does not eject the user out of the session.
  // Quitting goes through Ctrl+C (renderer's exitOnCtrlC) or closing the
  // terminal — both paths drain through the `finally` block in
  // cli/run.ts that disposes the SessionManager and flushes PGlite.
  function handleEscape(): void {
    if (!running) return;
    void input.session.interrupt().catch(reportError);
  }

  inputField.onContentChange = () => {
    // First real keystroke into the input collapses the starter section
    // — the user is composing their own prompt, so the suggestions get
    // out of the way for the rest of the session.
    if (startersAreVisible() && inputField.plainText.length > 0) dismissStarters();
    refreshAutocomplete();
  };
  inputField.onCursorChange = () => refreshAutocomplete();

  // Paste handling. Terminals that forward binary clipboard contents (kitty,
  // ghostty, recent iTerm2 builds) deliver image bytes directly via the paste
  // event — we intercept those, persist them under the session cache, and
  // surface a `[Image #N]` placeholder in the prompt buffer. Plain text pastes
  // fall through to the Textarea's default insert path so existing behavior
  // is unchanged for non-image clipboards.
  inputField.onPaste = (event: PasteEvent) => {
    void handlePasteEvent(event).catch((error) => {
      appendBlock("[paste]", error instanceof Error ? error.message : String(error), COLORS.error);
    });
  };

  async function handlePasteEvent(event: PasteEvent): Promise<void> {
    const metadata = event.metadata;
    const sniffed = sniffImageMimeType(event.bytes);
    const inferredMime =
      metadata?.mimeType && metadata.mimeType.startsWith("image/") ? metadata.mimeType : sniffed;

    // Synchronous fast paths — the paste payload itself is enough to decide.
    if (inferredMime) {
      event.preventDefault();
      await attachPastedImageBytes(event.bytes, inferredMime);
      return;
    }

    if (metadata?.kind === "binary") {
      // Non-image binary paste — we cannot meaningfully forward it, but the
      // terminal already swallowed the keystroke, so suppress the default
      // text-insert path that would otherwise garble the prompt.
      event.preventDefault();
      appendBlock(
        "[paste]",
        "Unsupported binary clipboard contents (only PNG/JPEG/GIF/WebP).",
        COLORS.system,
      );
      return;
    }

    // Text-shaped paste. Three sub-cases, ordered cheapest first so common
    // text pastes never wait on the macOS Swift clipboard probe:
    //
    //   1. The text resolves to an image file path (Finder/Files drag-paste).
    //   2. The terminal forwarded an empty payload but the OS clipboard
    //      may carry an image promise (e.g. Figma "Copy as PNG", screenshot,
    //      browser image copy that bracketed-paste cannot represent).
    //   3. Plain text — just insert it.
    //
    // Sub-cases 1 and 3 are fully synchronous after the path heuristic, so
    // the buffer paints immediately. Only sub-case 2 spawns the Swift
    // probe, and only when there is literally no text to insert anyway.
    const originalText = decodePasteBytes(event.bytes);
    const candidate = looksLikeImageFilePath(originalText);

    if (candidate) {
      // Path-shaped paste: suppress the default insert so we can swap in
      // the [Image #N] placeholder once load resolves.
      event.preventDefault();
      try {
        const pending = await loadImageFromPath({
          cwd: input.workDir,
          rawPath: candidate,
          id: nextImageId,
        });
        nextImageId += 1;
        pendingImages.push(pending);
        inputField.insertText(pending.label);
        appendBlock("[paste]", `attached ${pending.label} from ${pending.path}`, COLORS.system);
        refreshHint();
      } catch (error) {
        // The clipboard looked like an image path but we could not load
        // it — surface why and restore the original text so the user can
        // edit it manually instead of losing what they pasted.
        appendBlock(
          "[paste]",
          `looked like an image path but could not attach ${candidate}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          COLORS.system,
        );
        if (originalText.length > 0) inputField.insertText(originalText);
      }
      return;
    }

    if (originalText.length === 0) {
      // No text payload — the terminal had nothing to forward but the OS
      // clipboard may still carry an image promise. Suppress the default
      // (which would do nothing anyway) and run the slow probe.
      event.preventDefault();
      const clipboardImage = await tryReadClipboardImage();
      if (clipboardImage) {
        await attachPastedImageBytes(clipboardImage.bytes, clipboardImage.mimeType);
      }
      return;
    }

    // Plain text paste — fall through to the InputRenderable's default
    // insert path, which paints synchronously. Users whose intended image
    // arrived as text-shaped bytes (e.g. Figma) can still trigger an
    // explicit clipboard probe via the `/paste` slash command.
  }

  async function attachPastedImageBytes(bytes: Uint8Array, mimeType: string): Promise<void> {
    try {
      const pending = await persistPastedImage({
        sessionId: input.sessionId,
        id: nextImageId,
        bytes,
        mimeType,
      });
      nextImageId += 1;
      pendingImages.push(pending);
      inputField.insertText(pending.label);
      appendBlock(
        "[paste]",
        `attached ${pending.label} (${mimeType}, ${formatBytes(bytes.length)})`,
        COLORS.system,
      );
      refreshHint();
    } catch (error) {
      appendBlock("[paste]", error instanceof Error ? error.message : String(error), COLORS.error);
    }
  }

  function clearPendingImages(): void {
    if (pendingImages.length === 0) return;
    pendingImages = [];
    nextImageId = 1;
    refreshHint();
  }

  // Manual clipboard probe. Read the OS clipboard for an image right now and
  // attach it if found; otherwise emit a useful diagnostic line. Used both by
  // the Cmd+V/Ctrl+V keystroke handler above and the `/paste` slash command.
  async function triggerClipboardProbe(source: "keystroke" | "slash"): Promise<void> {
    try {
      const clipboardImage = await tryReadClipboardImage();
      if (clipboardImage) {
        await attachPastedImageBytes(clipboardImage.bytes, clipboardImage.mimeType);
        return;
      }
      // No image on the clipboard. The keystroke path may have eaten a
      // legitimate text paste, so fall back to a text probe so users do not
      // lose what they were trying to paste.
      const text = await tryReadClipboardText();
      if (text) {
        inputField.insertText(text);
        return;
      }
      if (source === "slash") {
        // Surface the actual clipboard UTI list when a /paste probe comes
        // up empty — lets users see what their source app actually put
        // there so the failure stops being mysterious.
        const types = await describeMacClipboardTypes();
        const detail = types
          ? ` — clipboard types: ${types}`
          : " — (could not query clipboard types; clipboard may be empty)";
        appendBlock("[paste]", `clipboard had no readable image or text${detail}`, COLORS.system);
      }
    } catch (error) {
      appendBlock(
        "[paste]",
        `clipboard probe failed: ${error instanceof Error ? error.message : String(error)}`,
        COLORS.error,
      );
    }
  }

  function submit(message: string): void {
    // First user submit collapses the boot starter section permanently for
    // this session, even when the prompt came from autocomplete or paste.
    if (startersAreVisible()) dismissStarters();
    // Slash-style attach commands run locally and never reach the runner so
    // users on terminals that do not forward image bytes still have a way to
    // attach images by path.
    if (message.startsWith("/image ") || message === "/image") {
      void handleImageSlashCommand(message);
      return;
    }
    if (message === "/paste") {
      void triggerClipboardProbe("slash");
      return;
    }
    if (message === "/clear-images") {
      clearPendingImages();
      appendBlock("[paste]", "cleared pending image attachments", COLORS.system);
      return;
    }
    if (message === "/copy" || message.startsWith("/copy ")) {
      void handleCopySlashCommand(message);
      return;
    }

    const submittedImages = pendingImages;
    recordTranscriptEntry("user", message);
    appendBlock("you:", message, COLORS.user);
    // Render attachments as a separate hint-colored footnote rather than
    // inlining them into the user-message block. Keeps the transcript
    // structure honest — the user message persists exactly as the agent
    // sees it, and resumed sessions render identically because no extra
    // text was concatenated.
    if (submittedImages.length > 0) {
      const lines = submittedImages.map((p) => `📎 ${p.label}: ${p.path}`).join("\n");
      appendBlock(null, lines, COLORS.hint);
    }
    hideQuestions();

    const images = submittedImages.map((p) => p.attachment);

    // Reset before dispatch so an in-flight error does not leave the user
    // double-charged with the same attachments on retry.
    clearPendingImages();

    // Every submit — running or idle — is a follow_up. While the agent is
    // running this queues; while idle it kicks off a fresh turn. Single
    // mental model: type, press Enter, your message lands.
    void input.session.prompt({ message, behavior: "follow_up", images }).catch(reportError);
    if (!running) {
      markRunning();
    }
  }

  /**
   * Copy the active drag-selection to the clipboard and clear the highlight
   * so the user gets visual confirmation the action happened. Used by the
   * platform copy keystroke (Cmd+C on macOS, Ctrl+Shift+C elsewhere); the
   * slash command path goes through `handleCopySlashCommand` so it can
   * also serve `/copy last|all|<N>`.
   */
  async function copyActiveSelection(): Promise<void> {
    const text = lastSelectionText;
    if (text.trim().length === 0) return;
    const result = await copyTextToClipboard(text);
    renderer.clearSelection();
    lastSelectionText = "";
    refreshHint();
    if (result.ok) {
      appendBlock(
        "[copy]",
        `copied selection (${text.length} char${text.length === 1 ? "" : "s"}) to clipboard via ${result.via}`,
        COLORS.system,
      );
    } else {
      appendBlock(
        "[copy]",
        `clipboard write failed: ${result.error ?? "unknown error"}` +
          (process.platform === "linux" ? "\nInstall one of: wl-clipboard, xclip, xsel" : ""),
        COLORS.error,
      );
    }
  }

  /**
   * Resolve a `/copy ...` invocation to clipboard text and pipe it to the
   * OS clipboard. When the user has an active drag-selection and ran a bare
   * `/copy`, copy that highlight verbatim — it matches what they actually
   * have on screen. Otherwise fall back to the transcript-log heuristic
   * (`last` / `all` / `<N>`).
   *
   * Failures are surfaced in the transcript so users on minimal Linux
   * installs see exactly which writer is missing.
   */
  async function handleCopySlashCommand(raw: string): Promise<void> {
    const argumentRaw = raw === "/copy" ? "" : raw.slice("/copy ".length);
    const argument = parseCopyArgument(argumentRaw);
    if (argument === undefined) {
      appendBlock(
        "[copy]",
        "Usage: /copy [last|all|<N>]  — last (default) copies the most recent agent reply, " +
          "or copies the active drag-selection when one is present",
        COLORS.system,
      );
      return;
    }

    // A bare `/copy` (or the copy keystroke while a selection is active)
    // prefers the drag-selection so the clipboard matches what the user
    // has highlighted on screen; an explicit `/copy last|all|<N>` always
    // uses the transcript log instead.
    const explicitArgument = argumentRaw.trim().length > 0;
    const useSelection = !explicitArgument && lastSelectionText.trim().length > 0;
    const text = useSelection ? lastSelectionText : selectCopyText(transcriptLog, argument);
    if (!text) {
      appendBlock("[copy]", "nothing to copy yet", COLORS.system);
      return;
    }
    const result = await copyTextToClipboard(text);
    if (result.ok) {
      const summary = useSelection
        ? `selection (${text.length} char${text.length === 1 ? "" : "s"})`
        : describeCopySelection(argument, text.length);
      appendBlock("[copy]", `copied ${summary} to clipboard via ${result.via}`, COLORS.system);
    } else {
      appendBlock(
        "[copy]",
        `clipboard write failed: ${result.error ?? "unknown error"}` +
          (process.platform === "linux" ? "\nInstall one of: wl-clipboard, xclip, xsel" : ""),
        COLORS.error,
      );
    }
  }

  /**
   * Two-stage clipboard write. OpenTUI's OSC 52 path is preferred because it
   * lands in the user's clipboard even when the TUI is running over SSH or
   * inside tmux — no host CLI required. When the terminal does not
   * advertise OSC 52 support (or stdout is gone), fall back to the
   * platform-native CLI writers in `clipboard.ts`.
   */
  async function copyTextToClipboard(text: string): Promise<ClipboardWriteResult> {
    if (renderer.isOsc52Supported() && renderer.copyToClipboardOSC52(text)) {
      return { ok: true, via: "OSC 52" };
    }
    return writeClipboardText(text);
  }

  function describeCopySelection(argument: "last" | "all" | number, length: number): string {
    const chars = `${length} char${length === 1 ? "" : "s"}`;
    if (argument === "last") return `last message (${chars})`;
    if (argument === "all") return `full transcript (${chars})`;
    return `last ${argument} messages (${chars})`;
  }

  async function handleImageSlashCommand(raw: string): Promise<void> {
    const rest = raw.slice("/image".length).trim();
    if (!rest) {
      appendBlock(
        "[paste]",
        "Usage: /image <path>  — attach a PNG/JPEG/GIF/WebP from disk",
        COLORS.system,
      );
      return;
    }
    try {
      const pending = await loadImageFromPath({
        cwd: input.workDir,
        rawPath: rest,
        id: nextImageId,
      });
      nextImageId += 1;
      pendingImages.push(pending);
      // Insert the placeholder back into the (now-empty) input so the user
      // can keep typing their prompt with the image already attached.
      inputField.insertText(pending.label);
      appendBlock("[paste]", `attached ${pending.label} from ${pending.path}`, COLORS.system);
      refreshHint();
    } catch (error) {
      appendBlock("[paste]", error instanceof Error ? error.message : String(error), COLORS.error);
    }
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  // ---- replay history on resume ---------------------------------------------

  // Setup already ran before the TUI launched, so we can read the resolved
  // skills/agent-files synchronously through the session getters.
  const [skills, agentFiles] = await Promise.all([
    input.session.getSkills(),
    input.session.getResolvedAgentFiles(),
  ]);
  skillAutocompleteSkills = [
    ...BUILT_IN_SLASH_COMMANDS,
    ...skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.baseDir,
      group: "skills" as const,
    })),
  ];
  refreshAutocomplete();
  renderSetupIntro(skills, agentFiles);
  refreshSidebar();

  const resumeHistoryMessages = input.resumeHistoryMessages ?? Number.POSITIVE_INFINITY;
  if (resumeHistoryMessages > 0 && input.history && input.history.length > 0) {
    const limited = limitHistoryDisplayMessages(
      historyDisplayBlocks(input.history),
      resumeHistoryMessages,
    );
    if (limited.omittedBlocks > 0) {
      appendLine(
        `[resume] showing last ${resumeHistoryMessages} message${resumeHistoryMessages === 1 ? "" : "s"} of prior session history`,
        COLORS.hint,
      );
    }
    for (const block of limited.blocks) {
      appendDisplayBlock(block);
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
        recordTranscriptEntry("user", stripped);
      } else if (block.kind === "agent") {
        recordTranscriptEntry("agent", block.content);
      }
    }
  }

  // ---- bootstrap initial prompt ----------------------------------------------

  if (input.initialPrompt) {
    recordTranscriptEntry("user", input.initialPrompt);
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
