import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type CliRenderer,
  createCliRenderer,
  decodePasteBytes,
  fg,
  type KeyEvent,
  type PasteEvent,
  type Selection,
  t,
  TextRenderable,
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
import { isTextBufferDestroyedError, TranscriptWriter } from "./transcript-writer.js";
import type { Session } from "../session/session.js";
import {
  describeUpgradeStatus,
  type UpgradeStatus,
  type UpgradeStatusStream,
} from "../cli/auto-upgrade.js";
import type {
  TurnAgentFile,
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
  commitActiveAnswer,
  fileAutocompleteMatches,
  formatQuestionOptionDescription,
  formatSkillAutocompleteDescription,
  moveQuestionHighlight,
  moveSkillAutocompleteSelection,
  NO_HIGHLIGHT,
  replaceFileAutocompleteToken,
  restoreSavedAnswer,
  type SkillAutocompleteItem,
  skillAutocompleteMatches,
  type SlashAutocompleteGroup,
} from "./autocomplete.js";
import { homedir } from "node:os";
import { submitDuetFeedback } from "../lib/feedback.js";
import { buildFileIndex } from "./file-index.js";
import {
  DUET_BANNER_LINES_COMPACT,
  type HistoryBlockKind,
  type HistoryDisplayBlock,
  historyDisplayBlocks,
  limitHistoryDisplayMessages,
} from "./history.js";
import { listRecentSessions } from "./recent-sessions.js";
import { buildLayout } from "./layout.js";
import { SIDEBAR_WIDTH } from "./sidebar.js";
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
  commitActiveAnswer,
  fileAutocompleteMatches,
  formatQuestionOptionDescription,
  formatSkillAutocompleteDescription,
  moveQuestionHighlight,
  moveSkillAutocompleteSelection,
  NO_HIGHLIGHT,
  questionPickerAnswer,
  replaceFileAutocompleteToken,
  restoreSavedAnswer,
  skillAutocompleteMatches,
} from "./autocomplete.js";
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
  /** npm package name; used to label the auto-upgrade status line. */
  packageName: string;
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
   * Live status stream from the in-process auto-upgrade flow. The TUI
   * subscribes on mount and renders one line in the intro that mutates in
   * place through "Checking for updates…", "Updating to vX…", and
   * "Updated. Restart duet to use it." Undefined statuses (current, locked,
   * skipped) hide the line entirely so the header stays clean.
   */
  upgradeStatus$?: UpgradeStatusStream;
  /** Past messages to replay into the transcript on resume. */
  history?: AgentMessage[];
  /**
   * True when this TUI mount is a `--resume <id>` invocation. Suppresses
   * the boot starter menu so the user lands straight back in the
   * conversation instead of seeing "what should we work on today?" again.
   */
  isResume?: boolean;
  /**
   * Called when the user picks a "pick up the thread" recent-session
   * row. The outer dispatcher (`run.ts`) should dispose the current
   * session, `manager.resume(sessionId)` + `hydrate()` + `start()`, and
   * re-enter `runTui` with the hydrated session and its replayed history.
   *
   * When this callback is not provided (tests, playground, any caller
   * that does not own a SessionManager), picker rows fall back to the
   * legacy behavior of re-submitting the prior prompt as a fresh turn
   * in the current session.
   */
  onResumeRequest?: (sessionId: string) => void;
  /**
   * Number of trailing user-turn exchanges to replay from prior history.
   * Each exchange is the user prompt plus the assistant blocks (text,
   * reasoning, tools, errors) that followed it. `0` disables replay; when
   * unset, every block is replayed. The CLI passes the configured default
   * so resumes do not flood the transcript.
   */
  resumeHistoryMessages?: number;
  /**
   * Pre-built renderer for tests. When provided, `runTui` skips
   * `createCliRenderer` and the `globalThis.window` shimming that wraps it.
   * Production callers leave this unset; the test harness in
   * `test/helpers/tui-harness.ts` passes a `createTestRenderer` instance so
   * mock keys can drive the picker without a real TTY.
   */
  renderer?: CliRenderer;
}

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
  //
  // Tests inject a `createTestRenderer` instance via `input.renderer`; in
  // that mode we skip the production renderer construction and the
  // `globalThis.window` restore that wraps it (the test renderer never
  // installs the shim).
  let renderer: CliRenderer;
  if (input.renderer) {
    renderer = input.renderer;
  } else {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    renderer = await createCliRenderer({
      exitOnCtrlC: true,
      useMouse: true,
      useKittyKeyboard: {},
      targetFps: 60,
    });
    restoreWindowGlobal(previousWindow);
  }

  // Most recent drag-selected text. OpenTUI emits the `selection` event
  // whenever a drag finishes; we cache the resulting string so /copy and
  // the copy keystroke can prefer the user's actual highlight over the
  // last-message heuristic, and so the bottom hint can advertise the
  // copy keystroke only while it actually does something.
  let lastSelectionText = "";
  renderer.on("selection", (selection: Selection) => {
    lastSelectionText = selection.getSelectedText();
    transcriptWriter.logSelection(lastSelectionText);
    refreshHint();
  });

  const {
    sidebar,
    transcript,
    status,
    hint,
    skillAutocompletePanel,
    commandHeader,
    commandRows,
    skillHeader,
    skillRows,
    fileAutocompletePanel,
    fileAutocompleteRows,
    questionPanel,
    questionTitle,
    questionRows,
    inputField,
  } = buildLayout(renderer);

  // ---- transcript writer ----------------------------------------------------

  const transcriptWriter = new TranscriptWriter(renderer, transcript, {
    getLastSelectionText: () => lastSelectionText,
    onBufferDestroyed: () => stopWorkingTicker(),
  });

  function appendLine(content: string, fg: string): void {
    transcriptWriter.appendLine(content, fg);
  }

  function appendBlock(label: string | null, body: string, fg: string): void {
    transcriptWriter.appendBlock(label, body, fg);
  }

  function setStatus(text: string): void {
    // Renderer teardown destroys the underlying TextBuffer synchronously,
    // but in-flight async work (session events, ticker callbacks, upgrade
    // status pushes) may still drive chrome updates on the next microtask.
    // The `destroyed` flag catches writes that arrive after our destroy
    // handler runs; the try/catch backstops the window between OpenTUI
    // tearing down child TextBuffers and emitting the `destroy` event,
    // which is when the ticker callback in the stack trace lands.
    if (transcriptWriter.isDestroyed()) return;
    try {
      status.content = text;
    } catch (error) {
      if (isTextBufferDestroyedError(error)) {
        transcriptWriter.markDestroyed();
        stopWorkingTicker();
        return;
      }
      throw error;
    }
  }

  function setHint(running: boolean): void {
    if (transcriptWriter.isDestroyed()) return;
    const base = running ? HINT_RUNNING : HINT_IDLE;
    const segments: string[] = [];
    if (pendingImages.length > 0) segments.push(attachmentHint());
    segments.push(base);
    if (lastSelectionText.trim().length > 0) segments.push(HINT_SELECTION_COPY);
    try {
      hint.content = segments.join(" · ");
    } catch (error) {
      if (isTextBufferDestroyedError(error)) {
        transcriptWriter.markDestroyed();
        stopWorkingTicker();
        return;
      }
      throw error;
    }
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
  function recordTranscriptEntry(kind: TranscriptEntry["kind"], text: string): void {
    transcriptWriter.recordEntry(kind, text);
  }
  let lastTerminal: TurnTerminalEvent | undefined;
  // Context bar + session cost are owned by `Session` (persisted beside
  // `TurnState` in `state.json`), not `TurnRunner` / `TurnState`.
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
    if (transcriptWriter.isDestroyed()) return;
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
    const snap = input.session.getLastContextUsage();
    sidebar.setContextUsage(
      snap
        ? {
            type: "context_usage",
            usage: snap.usage,
            effectiveContextWindow: snap.effectiveContextWindow,
            contextWindowUsage: snap.contextWindowUsage,
          }
        : undefined,
    );
    sidebar.setSessionCost(input.session.getSessionCostUsd());
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

    if (input.upgradeStatus$) {
      // Lazy construction on the first status that has human-readable text.
      // Statuses without text (current/locked/skipped) skip the constructor
      // entirely; constructing eagerly would allocate a native text buffer
      // against the renderer that we'd never `destroy()` on the silent path.
      //
      // `subscribe()` replays the latest status synchronously, so the handler
      // runs before `subscribe()` returns its unsubscribe handle. We set a
      // `done` flag from inside the handler and tear down after `subscribe()`
      // returns; subsequent (async) terminal statuses unsubscribe inline via
      // the real handle.
      let upgradeLine: TextRenderable | undefined;
      let done = false;
      let unsubscribe = (): void => {};
      const handle = (status: UpgradeStatus): void => {
        const text = describeUpgradeStatus(input.packageName, status);
        if (!text) {
          if (upgradeLine) {
            transcript.remove(upgradeLine.id);
            upgradeLine.destroy();
            upgradeLine = undefined;
          }
          // Terminal statuses with no human-readable form (current, locked,
          // skipped) close the subscription so we stop reacting.
          if (status.kind !== "checking") {
            done = true;
            unsubscribe();
          }
          return;
        }
        const fg = status.kind === "failed" ? COLORS.error : COLORS.system;
        if (!upgradeLine) {
          upgradeLine = new TextRenderable(renderer, { content: `[update] ${text}`, fg });
          transcript.add(upgradeLine);
        } else {
          upgradeLine.content = `[update] ${text}`;
          upgradeLine.fg = fg;
        }
        if (status.kind === "upgraded" || status.kind === "failed") {
          done = true;
          unsubscribe();
        }
      };
      unsubscribe = input.upgradeStatus$.subscribe(handle);
      if (done) unsubscribe();
    }

    // Only mention agent files when one is actually loaded; "[agent file]
    // none" is noise on every empty boot.
    if (agentFiles.length > 0) {
      appendLine(`[agent file] ${agentFiles.map((file) => file.name).join(", ")}`, COLORS.hint);
    }

    // --resume <id> launches skip the starter menu entirely: the user has
    // explicitly asked to drop back into a known conversation, so showing
    // "what should we work on today?" before replaying history is noise.
    // Resumed sessions with zero prior messages still skip the menu so the
    // contract is "any --resume" not "--resume with content".
    if (!input.isResume) {
      renderStarters(skills);
    }
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
  // Once the user actually commits a prompt (typed Enter, picked a starter,
  // hit a slash command), the chrome is gone for the rest of the session.
  // Until then `dismissStarters()` is a reversible hide that
  // `syncStarterVisibility()` can restore when the composer empties again.
  let startersPermanentlyDismissed = false;
  // Cached for `mountStarterChrome()` so it can re-render the trailing
  // "✨ N skills · /help" line without re-running selectStarters.
  let starterSkillCount = 0;

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
    starterSkillCount = skills.length;
    highlightedStarterIndex = 0;
    mountStarterChrome();
  }

  // Paint the chrome (section headers, numbered rows, hint footer) from the
  // current `starterEntries` + `highlightedStarterIndex`. Called on first
  // boot and on every backspace-to-empty restoration. Idempotent: bails if
  // the chrome is already mounted or no entries exist.
  function mountStarterChrome(): void {
    if (startersVisible || starterEntries.length === 0) return;

    const recentEntries = starterEntries.filter((entry) => entry.kind === "recent");
    const promptEntries = starterEntries.filter((entry) => entry.kind === "prompt");
    const hasRecent = recentEntries.length > 0;

    // Every line we render here — spacers included — goes through `addLine`
    // and gets pushed to `starterRefs`. `dismissStarters()` iterates that
    // list to destroy refs; spacers added via fire-and-forget `appendLine`
    // would leak and accumulate above the next mount on each type →
    // backspace cycle, pushing the chrome lower every time.
    const spacer = (): void => {
      starterRefs.push(addLine(" ", COLORS.hint));
    };

    starterRowIndexes.length = 0;
    spacer();

    if (hasRecent) {
      starterRefs.push(addLine("pick up the thread", COLORS.agent));
      spacer();
      for (let i = 0; i < starterEntries.length; i += 1) {
        if (starterEntries[i]!.kind !== "recent") continue;
        const ref = addLine(formatStarterRow(i, false), COLORS.hint);
        starterRowIndexes.push(starterRefs.length);
        starterRefs.push(ref);
      }
      if (promptEntries.length > 0) {
        spacer();
        starterRefs.push(addLine("or start something new", COLORS.agent));
        spacer();
        for (let i = 0; i < starterEntries.length; i += 1) {
          if (starterEntries[i]!.kind !== "prompt") continue;
          const ref = addLine(formatStarterRow(i, false), COLORS.hint);
          starterRowIndexes.push(starterRefs.length);
          starterRefs.push(ref);
        }
      }
    } else {
      starterRefs.push(addLine("what should we work on today?", COLORS.agent));
      spacer();
      for (let i = 0; i < starterEntries.length; i += 1) {
        const ref = addLine(formatStarterRow(i, false), COLORS.hint);
        starterRowIndexes.push(starterRefs.length);
        starterRefs.push(ref);
      }
    }

    spacer();
    starterRefs.push(
      addLine("type a number to run, ↑/↓ to highlight, or just start typing.", COLORS.hint),
    );
    starterRefs.push(
      addLine(
        `✦ ${starterSkillCount} skill${starterSkillCount === 1 ? "" : "s"} · /help`,
        COLORS.hint,
      ),
    );

    startersVisible = true;
    if (highlightedStarterIndex >= starterEntries.length) highlightedStarterIndex = 0;
    paintStarterHighlight();
  }

  function addLine(content: string, fg: string): TextRenderable {
    return transcriptWriter.addLine(content, fg);
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

  // Transient hide. Tears down the rendered refs but keeps `starterEntries`
  // and `highlightedStarterIndex` so `mountStarterChrome()` can restore the
  // exact same picker if the user backspaces the composer empty again.
  function dismissStarters(): void {
    if (!startersVisible && starterRefs.length === 0) return;
    for (const ref of starterRefs) {
      transcript.remove(ref.id);
      ref.destroy();
    }
    starterRefs.length = 0;
    starterRowIndexes.length = 0;
    startersVisible = false;
  }

  // Permanent destruction: called when the user commits a prompt. After
  // this the chrome never comes back, even on backspace-to-empty.
  function destroyStartersPermanently(): void {
    dismissStarters();
    starterEntries.length = 0;
    highlightedStarterIndex = 0;
    startersPermanentlyDismissed = true;
  }

  // Toggle hook called from `inputField.onContentChange`. Hides the
  // chrome as soon as the user starts composing, brings it back if they
  // backspace the composer empty (but only until they actually submit
  // something — then `startersPermanentlyDismissed` latches).
  function syncStarterVisibility(): void {
    if (startersPermanentlyDismissed) return;
    if (starterEntries.length === 0) return;
    const empty = inputField.plainText.length === 0;
    if (!empty && startersVisible) {
      dismissStarters();
    } else if (empty && !startersVisible) {
      mountStarterChrome();
    }
  }

  function submitHighlightedStarter(): boolean {
    if (!startersVisible) return false;
    const entry = starterEntries[highlightedStarterIndex];
    if (!entry) return false;
    destroyStartersPermanently();
    // Recent-session rows: when the host wires `onResumeRequest`, signal
    // the outer dispatcher to swap sessions and tear down this renderer.
    // The dispatcher disposes the placeholder, calls `manager.resume(id)`
    // + `hydrate()` + `start()`, and re-enters `runTui` with the hydrated
    // session + its full message history. End user lands on the same
    // session id, same agent context, same transcript replayed inline.
    //
    // When no callback is wired (tests, playground), fall back to the
    // legacy shortcut: re-submit the prior prompt in the current session.
    // Agent has no context; the user lands on the same task with one
    // keystroke instead of typing it again.
    if (entry.kind === "recent" && input.onResumeRequest) {
      input.onResumeRequest(entry.sessionId);
      renderer.destroy();
      return true;
    }
    submit(entry.submit);
    return true;
  }

  function renderUsage(usage?: TurnTokenUsage): void {
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
      transcriptWriter.beginBlock();
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
    transcriptWriter.beginBlock();
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
    const hasObservations = Boolean(event.observations && event.observations.length > 0);
    const hasBumps = Boolean(
      event.usageBumpedObservations && event.usageBumpedObservations.length > 0,
    );
    if (!hasObservations && !hasBumps) {
      return "";
    }
    const sections: string[] = [event.message];
    if (hasObservations) {
      sections.push(event.observations!.map((observation) => observation.content).join("\n\n"));
    }
    return truncateToolText(sections.join("\n"));
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
  let questionActiveIndex = 0;
  // `NO_HIGHLIGHT` (-1) means no row is highlighted yet — the user must press
  // Up/Down to land on a concrete row. Single-select live-records the
  // highlight as the answer; multi-select uses highlight purely for
  // navigation and toggles the checked set on Space/Enter.
  let questionOptionSelectedIndex = NO_HIGHLIGHT;
  // Per-question checked indices for the active multi-select question. Reset
  // when the picker advances to the next question; single-select questions
  // simply ignore this set and use `questionOptionSelectedIndex` instead.
  let questionMultiSelectChecked = new Set<number>();
  // Answers collected while walking the picker, keyed by question text. We
  // dispatch the full map once the user finishes the last question, or flush
  // it early when they decide to type a free-form prompt instead.
  let questionAccumulatedAnswers: Record<string, string[]> = {};
  let suppressNextEscapeExit = false;

  function skillAutocompleteIsOpen(): boolean {
    return Boolean(skillAutocompleteToken && skillAutocompleteItems.length > 0);
  }

  function fileAutocompleteIsOpen(): boolean {
    return Boolean(fileAutocompleteToken && fileAutocompleteItems.length > 0);
  }

  function questionPickerIsOpen(): boolean {
    const question = pendingQuestions[questionActiveIndex];
    return Boolean(question && question.options.length > 0);
  }

  function activeQuestion(): TurnQuestion | undefined {
    return pendingQuestions[questionActiveIndex];
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
    questionActiveIndex = 0;
    questionOptionSelectedIndex = NO_HIGHLIGHT;
    questionMultiSelectChecked = new Set<number>();
    questionAccumulatedAnswers = {};
    questionPanel.visible = false;
    for (const row of questionRows) {
      row.visible = false;
      row.content = "";
    }
  }

  function showQuestions(questions: TurnQuestion[]): void {
    pendingQuestions = questions;
    questionActiveIndex = 0;
    questionOptionSelectedIndex = NO_HIGHLIGHT;
    questionMultiSelectChecked = new Set<number>();
    questionAccumulatedAnswers = {};
    renderQuestions();
  }

  /**
   * Total navigable rows for the active question. The Up/Down handler clamps
   * navigation to what is actually rendered on screen so a user cannot land
   * the highlight on a row they cannot see.
   */
  function activeRowCount(): number {
    const question = activeQuestion();
    if (!question) return 0;
    const optionLimit = question.multiSelect ? QUESTION_OPTION_LIMIT - 1 : QUESTION_OPTION_LIMIT;
    const visibleOptionCount = Math.min(question.options.length, optionLimit);
    return visibleOptionCount + (question.multiSelect ? 1 : 0);
  }

  /**
   * Row index of the synthetic Done row when the active question is
   * multi-select; `undefined` otherwise so callers don't compare against a
   * sentinel value. The Done row sits one past the last visible option,
   * clamped to the same limit `renderQuestions` uses.
   */
  function activeQuestionDoneIndex(): number | undefined {
    const question = activeQuestion();
    if (!question?.multiSelect) return undefined;
    const optionLimit = QUESTION_OPTION_LIMIT - 1;
    return Math.min(question.options.length, optionLimit);
  }

  function renderQuestions(): void {
    const question = activeQuestion();
    if (!question || question.options.length === 0) {
      hideQuestions();
      return;
    }

    questionPanel.visible = true;
    const baseTitle = question.header
      ? `${question.header}: ${question.question}`
      : question.question;
    const positionPrefix =
      pendingQuestions.length > 1 ? `(${questionActiveIndex + 1}/${pendingQuestions.length}) ` : "";
    const navHint = pendingQuestions.length > 1 ? " [←/→ navigate]" : "";
    questionTitle.content = `${positionPrefix}${baseTitle}${navHint}`;
    const optionLimit = question.multiSelect ? QUESTION_OPTION_LIMIT - 1 : QUESTION_OPTION_LIMIT;
    const visibleOptions = question.options.slice(0, optionLimit);
    const doneIndex = activeQuestionDoneIndex();
    for (const [index, row] of questionRows.entries()) {
      if (index < visibleOptions.length) {
        const option = visibleOptions[index]!;
        const highlighted = index === questionOptionSelectedIndex;
        const checkbox = question.multiSelect
          ? questionMultiSelectChecked.has(index)
            ? "[x] "
            : "[ ] "
          : "";
        const labelColor = highlighted ? COLORS.status : COLORS.user;
        const description = formatQuestionOptionDescription(option.description);
        const labelLine = `${checkbox}${option.label}`;
        row.content = description
          ? t`${fg(labelColor)(labelLine)}\n${description}`
          : t`${fg(labelColor)(labelLine)}`;
        row.fg = highlighted ? COLORS.agent : COLORS.hint;
        row.visible = true;
        continue;
      }

      if (question.multiSelect && index === visibleOptions.length) {
        // Synthetic Done row carries no checkbox prefix and self-documents
        // its purpose so users discover how to advance from a multi-select.
        const highlighted = doneIndex === questionOptionSelectedIndex;
        const labelColor = highlighted ? COLORS.status : COLORS.user;
        const description = formatQuestionOptionDescription("Advance to next question");
        row.content = t`${fg(labelColor)("Done")}\n${description}`;
        row.fg = highlighted ? COLORS.agent : COLORS.hint;
        row.visible = true;
        continue;
      }

      row.visible = false;
      row.content = "";
    }
  }

  function moveActiveQuestionHighlight(direction: -1 | 1): void {
    const question = activeQuestion();
    if (!question) return;
    questionOptionSelectedIndex = moveQuestionHighlight(
      questionOptionSelectedIndex,
      activeRowCount(),
      direction,
    );
    // Single-select live-records the highlight as the answer so a
    // prompt-flush or arrow-nav captures it without requiring Space/Enter.
    // Multi-select keeps highlight separate from the toggled set.
    if (!question.multiSelect) {
      questionAccumulatedAnswers = commitActiveAnswer(
        question,
        questionOptionSelectedIndex,
        questionMultiSelectChecked,
        questionAccumulatedAnswers,
      );
    }
    renderQuestions();
  }

  function toggleActiveMultiSelectOption(): void {
    const question = activeQuestion();
    if (!question?.multiSelect) return;
    if (questionMultiSelectChecked.has(questionOptionSelectedIndex)) {
      questionMultiSelectChecked.delete(questionOptionSelectedIndex);
    } else {
      questionMultiSelectChecked.add(questionOptionSelectedIndex);
    }
    questionAccumulatedAnswers = commitActiveAnswer(
      question,
      questionOptionSelectedIndex,
      questionMultiSelectChecked,
      questionAccumulatedAnswers,
    );
    renderQuestions();
  }

  function navigateActiveQuestion(direction: -1 | 1): boolean {
    if (pendingQuestions.length <= 1) return false;
    const nextIndex = questionActiveIndex + direction;
    if (nextIndex < 0 || nextIndex >= pendingQuestions.length) return false;

    questionAccumulatedAnswers = commitActiveAnswer(
      activeQuestion(),
      questionOptionSelectedIndex,
      questionMultiSelectChecked,
      questionAccumulatedAnswers,
    );

    questionActiveIndex = nextIndex;
    const restored = restoreSavedAnswer(activeQuestion(), questionAccumulatedAnswers);
    questionOptionSelectedIndex = restored.selectedIndex;
    questionMultiSelectChecked = restored.checked;
    renderQuestions();
    return true;
  }

  function describeAnswerLabels(question: TurnQuestion, labels: readonly string[]): string {
    if (labels.length === 0) return question.multiSelect ? "(no selection)" : "";
    return labels.join(", ");
  }

  /**
   * Handle Space/Enter when the picker is open and the composer is empty.
   * Multi-select on a regular row toggles; multi-select on the Done row
   * advances. Single-select always advances (highlight = answer is already
   * live-recorded by Up/Down). No-op when nothing is highlighted yet so the
   * user is forced to make an explicit choice (or skip via Right-arrow).
   */
  function confirmActiveSelection(): boolean {
    const question = activeQuestion();
    if (!question) return false;
    if (questionOptionSelectedIndex === NO_HIGHLIGHT) return false;
    if (question.multiSelect && questionOptionSelectedIndex !== activeQuestionDoneIndex()) {
      toggleActiveMultiSelectOption();
      return true;
    }
    return advanceOrSubmit();
  }

  function advanceOrSubmit(): boolean {
    const question = activeQuestion();
    if (!question) return false;
    const accumulatedForActive = questionAccumulatedAnswers[question.question] ?? [];
    const transcriptText = describeAnswerLabels(question, accumulatedForActive);
    if (transcriptText) {
      recordTranscriptEntry("user", transcriptText);
      appendBlock("you:", transcriptText, COLORS.user);
    }

    if (questionActiveIndex < pendingQuestions.length - 1) {
      questionActiveIndex += 1;
      const restored = restoreSavedAnswer(activeQuestion(), questionAccumulatedAnswers);
      questionOptionSelectedIndex = restored.selectedIndex;
      questionMultiSelectChecked = restored.checked;
      renderQuestions();
      return true;
    }

    void input.session
      .answer({
        questions: pendingQuestions,
        answers: questionAccumulatedAnswers,
        behavior: "follow_up",
      })
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

    // Insert a markdown link `[@<basename>](./<relative-path>)` so the
    // visible token still reads as an `@`-mention while the link target is
    // a path the agent can hand straight to its `read` tool. The format
    // contract lives in `replaceFileAutocompleteToken`; this call site
    // mutates the inputField in place via setSelection/insertText so it
    // composes cleanly with attachment placeholders and the cursor model.
    const replacement = replaceFileAutocompleteToken(
      inputField.plainText,
      token,
      item.relativePath,
    );
    const insertion = replacement.text.slice(token.start, replacement.cursorOffset);
    inputField.setSelection(token.start, token.end);
    inputField.deleteSelection();
    inputField.insertText(insertion);
    hideFileAutocomplete();
    return true;
  }

  const keyHandler = (renderer as unknown as { _keyHandler: InternalKeyHandlerLike })._keyHandler;
  keyHandler.onInternal("keypress", (key: KeyEvent) => {
    transcriptWriter.logKey("global", key);
    // Copy keystroke. Lives on the global handler (not
    // inputField.onKeyDown) because the mousedown that starts a
    // drag-select moves focus off the textarea — the focused-renderable
    // path stops firing right when the user has something to copy. The
    // global handler always fires regardless of focus.
    if (handleCopyKeystroke(key)) return;
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
    transcriptWriter.logKey("keydown", key);
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
        moveActiveQuestionHighlight(-1);
        key.preventDefault();
        return;
      }
      if (key.name === "down") {
        moveActiveQuestionHighlight(1);
        key.preventDefault();
        return;
      }
      // Space confirms the active selection only when the composer is empty
      // so users can still type a free-form prompt that includes spaces.
      // Match either the named form (most terminals) or the literal-char
      // form some kitty-keyboard parsers emit so the binding is robust
      // regardless of how the host reports an unmodified Space.
      if ((key.name === "space" || key.name === " ") && inputField.plainText.length === 0) {
        key.preventDefault();
        confirmActiveSelection();
        return;
      }
      // Left/Right navigate between questions, but only when the composer is
      // empty so editing a typed prompt with arrow keys still works.
      if (
        (key.name === "left" || key.name === "right") &&
        inputField.plainText.length === 0 &&
        pendingQuestions.length > 1
      ) {
        const direction = key.name === "left" ? -1 : 1;
        if (navigateActiveQuestion(direction)) {
          key.preventDefault();
          return;
        }
      }
      if (key.name === "escape") {
        key.preventDefault();
        suppressNextEscapeExit = true;
        hideQuestions();
        return;
      }
    }

    if (key.name === "return" || key.name === "enter") {
      // Three modifier flavors on the Enter key. The modifier is only
      // distinguishable when the terminal speaks the kitty-keyboard
      // protocol (or modifyOtherKeys); in a legacy terminal Ctrl+Enter
      // and Shift+Enter collapse to plain Enter. We accept that
      // tradeoff for the same reason Shift+Enter accepts it: modern
      // terminals are the target.
      //
      //   Plain Enter   → submit (idle = fresh turn, running = soft queue
      //                  via follow_up).
      //   Shift+Enter   → insert a literal newline at the cursor, matching
      //                  every modern chat composer (Slack, ChatGPT,
      //                  Discord, Cursor, Claude Code).
      //   Ctrl+Enter    → steer: dispatch with behavior:"steer" so the
      //                  runner hands it to agent.steer() at the next
      //                  inference boundary instead of waiting for the
      //                  full turn to wrap up.
      key.preventDefault();
      if (key.shift) {
        inputField.insertText("\n");
        return;
      }
      if (key.ctrl) {
        handleSteerKeystroke();
        return;
      }
      const value = inputField.plainText.trim();
      // Pre-latch the starter chrome before clearing the composer so the
      // clear-induced `onContentChange` doesn't briefly re-mount the chrome
      // (it would see empty composer + starters hidden and call
      // mountStarterChrome before submit got a chance to destroy them).
      // Only pre-latch when we know a typed-submit is about to fire —
      // empty-Enter into the picker / starter-row branches still need the
      // chrome state intact so they can dispatch.
      if (value && !startersPermanentlyDismissed) destroyStartersPermanently();
      inputField.clear();
      if (value) {
        submit(value);
      } else if (questionPickerIsOpen()) {
        confirmActiveSelection();
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

  // Ctrl+Enter sends the composer text with behavior:"steer" — the
  // runner routes this to agent.steer() when the agent is mid-inference
  // (most of an active turn), which preempts the current LLM call and
  // injects the message into the next iteration. If the runner is
  // between inference calls (e.g. mid-tool-call) the steer-flagged
  // command enqueues and gets picked up at the next agent boundary.
  // Either way the user gets "at next sensible task boundary" pickup,
  // which is sooner than the soft-queue follow_up (which only fires at
  // end of the full turn).
  //
  // Empty composer: no-op. The keybind is dedicated to send-with-steer,
  // and a bare Ctrl+Enter should not interrupt or otherwise affect state.
  function handleSteerKeystroke(): void {
    const message = inputField.plainText.trim();
    if (message.length === 0) return;
    // Snapshot before clearing so attachments ride with the steer
    // dispatch and the user-facing labels render correctly.
    const submittedImages = pendingImages;
    inputField.clear();
    clearPendingImages();
    refreshHint();
    recordTranscriptEntry("user", message);
    appendBlock("you:", message, COLORS.user);
    if (submittedImages.length > 0) {
      const lines = submittedImages.map((p) => `📎 ${p.label}: ${p.path}`).join("\n");
      appendBlock(null, lines, COLORS.hint);
    }
    const images = submittedImages.map((p) => p.attachment);
    void input.session.prompt({ message, behavior: "steer", images }).catch(reportError);
    if (!running) {
      markRunning();
    }
  }

  // ---- /diag diagnostics -----------------------------------------------------

  // `/diag` toggles a key+selection event log so the user can show us
  // exactly what their terminal forwards when something silently fails
  // (e.g. a keystroke not reaching the handler, a selection event firing
  // with empty text). Kept as a flag rather than a one-shot capture so
  // we can layer additional diagnostic facets on the same surface
  // without inventing new commands every time.

  function handleDiagSlashCommand(raw: string): void {
    const argument = raw === "/diag" ? "" : raw.slice("/diag ".length).trim();
    if (argument === "" || argument === "keys") {
      const enabled = !transcriptWriter.isKeyDiagnosticsEnabled();
      transcriptWriter.setKeyDiagnosticsEnabled(enabled);
      appendBlock(
        "[diag]",
        enabled
          ? "key + selection event logging ON. Run /diag again to stop."
          : "key + selection event logging OFF.",
        COLORS.system,
      );
      return;
    }
    appendBlock(
      "[diag]",
      "Usage: /diag (or /diag keys) — toggles key + selection event logging",
      COLORS.system,
    );
  }

  /**
   * Copy keystroke detection. Accepts Cmd+C, Cmd+Shift+C, and Ctrl+Shift+C
   * because each mainstream terminal forwards a different subset — see
   * `theme.ts` for which one ends up in the hint label per terminal.
   * Returns true (and prevents default) when the keystroke matched and a
   * non-empty selection was on the clipboard path; false otherwise so the
   * caller can fall through to other handlers (Esc, etc.).
   *
   * Accepts both "c" and "C" as the key name because some kitty parsers
   * report the shifted letter while others report the base letter with
   * `shift: true`.
   */
  function handleCopyKeystroke(key: KeyEvent): boolean {
    const isCopyLetter = key.name === "c" || key.name === "C";
    if (!isCopyLetter) return false;
    const cmdHeld = key.super || key.meta;
    const isCmdC = cmdHeld && !key.shift && !key.ctrl;
    const isCmdShiftC = cmdHeld && key.shift && !key.ctrl;
    const isCtrlShiftC = key.ctrl && key.shift && !cmdHeld;
    if (!(isCmdC || isCmdShiftC || isCtrlShiftC)) return false;
    if (lastSelectionText.trim().length === 0) return false;
    key.preventDefault();
    void copyActiveSelection();
    return true;
  }

  inputField.onContentChange = () => {
    // Typing hides the starter chrome; backspacing the composer empty
    // brings it back (until the user actually submits a prompt, at which
    // point it's gone for good).
    syncStarterVisibility();
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
    if (!startersPermanentlyDismissed) destroyStartersPermanently();
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
    if (message === "/diag" || message.startsWith("/diag ")) {
      handleDiagSlashCommand(message);
      return;
    }
    if (message === "/feedback" || message.startsWith("/feedback ")) {
      void handleFeedbackSlashCommand(message);
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

    const images = submittedImages.map((p) => p.attachment);

    // Reset before dispatch so an in-flight error does not leave the user
    // double-charged with the same attachments on retry.
    clearPendingImages();

    // If the question picker is open, treat the typed message as a flush:
    // dispatch whatever answers were already collected together with the new
    // prompt text so the model sees one combined turn instead of dropping
    // the partial answers on the floor.
    if (pendingQuestions.length > 0) {
      void input.session
        .answer({
          questions: pendingQuestions,
          answers: questionAccumulatedAnswers,
          behavior: "follow_up",
          message,
          images,
        })
        .catch(reportError);
      hideQuestions();
      if (!running) markRunning();
      return;
    }

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
    const text = useSelection
      ? lastSelectionText
      : selectCopyText(transcriptWriter.entries(), argument);
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
   * Two-stage clipboard write. The platform-native CLI (pbcopy / wl-copy /
   * xclip / xsel / clip.exe) goes first because it actually writes to the
   * OS clipboard and — critically — `writeClipboardText` reads the
   * clipboard back through pbpaste / wl-paste / xclip -o to confirm the
   * bytes landed. Exit-code-only success is not enough: pbcopy from inside
   * a raw-mode TUI on Warp/macOS exits 0 without actually updating
   * NSPasteboard, and OSC 52 has the same silent-drop problem on Warp.
   *
   * OSC 52 is only the fallback when no local CLI is available at all
   * (e.g. an SSH session with no clipboard tool installed remotely). When
   * a local CLI ran but failed verification we surface that error
   * directly instead of falling through to OSC 52, because OSC 52 would
   * also silently "succeed" on the same broken terminals and hide the
   * real failure behind a fake "copied via OSC 52" line.
   */
  async function copyTextToClipboard(text: string): Promise<ClipboardWriteResult> {
    const cli = await writeClipboardText(text);
    if (cli.ok) return cli;
    // Only fall back to OSC 52 when the CLI was simply unavailable. If a
    // CLI ran but the readback did not match (cli.kind ===
    // "verification-failed"), OSC 52 is on the same broken pipe and
    // would silently "succeed" the same way — surface the real error.
    if (
      cli.kind === "no-writer" &&
      renderer.isOsc52Supported() &&
      renderer.copyToClipboardOSC52(text)
    ) {
      return { ok: true, via: "OSC 52" };
    }
    return cli;
  }

  function describeCopySelection(argument: "last" | "all" | number, length: number): string {
    const chars = `${length} char${length === 1 ? "" : "s"}`;
    if (argument === "last") return `last message (${chars})`;
    if (argument === "all") return `full transcript (${chars})`;
    return `last ${argument} messages (${chars})`;
  }

  async function handleFeedbackSlashCommand(raw: string): Promise<void> {
    const content = raw.slice("/feedback".length).trim();
    if (!content) {
      appendBlock(
        "[feedback]",
        "Usage: /feedback <message>  — send free-form feedback to the Duet team",
        COLORS.system,
      );
      return;
    }
    appendBlock("[feedback]", "sending…", COLORS.system);
    try {
      const { baseUrl } = await submitDuetFeedback({ content });
      appendBlock("[feedback]", `Thanks! Feedback sent to ${baseUrl}.`, COLORS.system);
    } catch (error) {
      appendBlock(
        "[feedback]",
        error instanceof Error ? error.message : String(error),
        COLORS.error,
      );
    }
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
      // a destroyed TextBuffer and throw, so tear down timers and stop
      // accepting chrome writes here before resolving. Session events that
      // race the teardown are caught by the `destroyed` guard in the
      // transcript writer and the other chrome mutators.
      transcriptWriter.markDestroyed();
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
