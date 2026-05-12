import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type CliRenderer,
  createCliRenderer,
  type KeyEvent,
  type PasteEvent,
  type Selection,
  TextRenderable,
} from "@opentui/core";
import { type ClipboardWriteResult, writeClipboardText } from "./clipboard.js";
import { PasteController } from "./paste-controller.js";
import { parseCopyArgument, selectCopyText, type TranscriptEntry } from "./transcript-log.js";
import { StatusController } from "./status-controller.js";
import { StepRenderer } from "./step-renderer.js";
import { TranscriptWriter } from "./transcript-writer.js";
import type { Session } from "../session/session.js";
import {
  describeUpgradeStatus,
  type UpgradeStatus,
  type UpgradeStatusStream,
} from "../cli/auto-upgrade.js";
import type { TurnAgentFile, TurnEvent, TurnTerminalEvent } from "../types/protocol.js";
import { BUILT_IN_SLASH_COMMANDS } from "./autocomplete.js";
import { AutocompleteController } from "./autocomplete-controller.js";
import { QuestionPicker } from "./question-picker.js";
import { homedir } from "node:os";
import { submitDuetFeedback } from "../lib/feedback.js";
import {
  DUET_BANNER_LINES_COMPACT,
  type HistoryBlockKind,
  type HistoryDisplayBlock,
  historyDisplayBlocks,
  limitHistoryDisplayMessages,
} from "./history.js";
import { listRecentSessions } from "./recent-sessions.js";
import { buildLayout } from "./layout.js";
import { orderedSelectableStarters, selectStarters } from "./starters.js";
import { COLORS } from "./theme.js";

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
    statusController.setSelectionText(lastSelectionText);
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
    onBufferDestroyed: () => statusController.shutdown(),
  });

  function appendLine(content: string, fg: string): void {
    transcriptWriter.appendLine(content, fg);
  }

  function appendBlock(label: string | null, body: string, fg: string): void {
    transcriptWriter.appendBlock(label, body, fg);
  }

  // ---- runtime state ---------------------------------------------------------

  function recordTranscriptEntry(kind: TranscriptEntry["kind"], text: string): void {
    transcriptWriter.recordEntry(kind, text);
  }
  // Context bar + session cost are owned by `Session` (persisted beside
  // `TurnState` in `state.json`), not `TurnRunner` / `TurnState`.

  const statusController = new StatusController({
    renderer,
    status,
    hint,
    refreshActiveToolBlocks: () => stepRenderer.refreshActiveToolBlocks(),
  });

  const stepRenderer = new StepRenderer({
    renderer,
    transcript,
    transcriptWriter,
    statusController,
    onStepStart: () => {
      if (questionPicker.isOpen()) questionPicker.hide();
    },
  });

  function reportError(error: unknown): void {
    appendBlock("[error]", error instanceof Error ? error.message : String(error), COLORS.error);
    statusController.markIdle();
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
      stepRenderer.renderStep(event.step);
    } else if (event.type === "follow_up_queue") {
      // Sidebar already refreshed from session state above; mirror the count
      // into the working-status line so the user can see queued prompts at a
      // glance without scrolling the sidebar.
      statusController.setQueuedFollowUps(event.prompts.length);
    } else if (event.type === "todos") {
      // Sidebar refresh covers the visual update; nothing else to do here.
    } else if (event.type === "memory") {
      stepRenderer.renderMemoryStatus(event);
    } else if (event.type === "system") {
      appendBlock("[system]", event.message, COLORS.system);
      if (event.level === "error") statusController.markIdle();
    } else if (event.type === "ask") {
      appendBlock("[question]", event.questions.map((q) => q.question).join("\n"), COLORS.system);
      questionPicker.show(event.questions);
      stepRenderer.renderUsage(event.usage);
      stepRenderer.renderTurnElapsed();
      statusController.markIdle(event);
    } else if (event.type === "complete") {
      if (event.error) {
        appendBlock("[error]", event.error, COLORS.error);
      }
      stepRenderer.renderUsage(event.usage);
      stepRenderer.renderTurnElapsed();
      statusController.markIdle(event);
    } else if (event.type === "interrupted") {
      appendLine("[interrupted]", COLORS.system);
      stepRenderer.renderUsage(event.usage);
      stepRenderer.renderTurnElapsed();
      statusController.markIdle(event);
    } else if (event.type === "sleep") {
      stepRenderer.renderUsage(event.usage);
      stepRenderer.renderSleeping(event.wakeAt);
      statusController.markIdle(event);
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

  // ---- input handling --------------------------------------------------------

  const autocomplete = new AutocompleteController({
    inputField,
    skillAutocompletePanel,
    commandRows,
    commandHeader,
    skillRows,
    skillHeader,
    fileAutocompletePanel,
    fileAutocompleteRows,
    workDir: input.workDir,
    onEscapeClose: () => {
      suppressNextEscapeExit = true;
    },
  });

  let suppressNextEscapeExit = false;

  const questionPicker = new QuestionPicker({
    questionPanel,
    questionTitle,
    questionRows,
    inputField,
    session: input.session,
    onEscapeClose: () => {
      suppressNextEscapeExit = true;
    },
    appendBlock,
    recordTranscriptEntry,
    reportError,
    markRunning: () => statusController.markRunning(),
    isRunning: () => statusController.isRunning(),
  });

  const pasteController = new PasteController({
    inputField,
    sessionId: input.sessionId,
    workDir: input.workDir,
    appendBlock,
    statusController,
  });

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
    if (autocomplete.isSkillPickerOpen() || autocomplete.isFilePickerOpen()) {
      key.preventDefault();
      autocomplete.hideAll();
      return;
    }
    if (questionPicker.isOpen()) {
      key.preventDefault();
      questionPicker.hide();
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
      void pasteController.triggerClipboardProbe("keystroke");
      return;
    }

    if (autocomplete.handleKey(key)) {
      return;
    }

    if (questionPicker.handleKey(key)) return;

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
      } else if (questionPicker.isOpen()) {
        questionPicker.confirmSelection();
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
    if (!statusController.isRunning()) return;
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
    inputField.clear();
    const submittedImages = pasteController.consume();
    recordTranscriptEntry("user", message);
    appendBlock("you:", message, COLORS.user);
    if (submittedImages.length > 0) {
      const lines = submittedImages.map((p) => `📎 ${p.label}: ${p.path}`).join("\n");
      appendBlock(null, lines, COLORS.hint);
    }
    const images = submittedImages.map((p) => p.attachment);
    void input.session.prompt({ message, behavior: "steer", images }).catch(reportError);
    if (!statusController.isRunning()) {
      statusController.markRunning();
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
    autocomplete.refresh();
  };
  inputField.onCursorChange = () => autocomplete.refresh();

  // Paste handling. Terminals that forward binary clipboard contents (kitty,
  // ghostty, recent iTerm2 builds) deliver image bytes directly via the paste
  // event — we intercept those, persist them under the session cache, and
  // surface a `[Image #N]` placeholder in the prompt buffer. Plain text pastes
  // fall through to the Textarea's default insert path so existing behavior
  // is unchanged for non-image clipboards.
  inputField.onPaste = (event: PasteEvent) => {
    void pasteController.handlePasteEvent(event).catch((error) => {
      appendBlock("[paste]", error instanceof Error ? error.message : String(error), COLORS.error);
    });
  };

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
      void pasteController.triggerClipboardProbe("slash");
      return;
    }
    if (message === "/clear-images") {
      pasteController.clearPendingImages();
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

    const submittedImages = pasteController.consume();
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

    // If the question picker is open, treat the typed message as a flush:
    // dispatch whatever answers were already collected together with the new
    // prompt text so the model sees one combined turn instead of dropping
    // the partial answers on the floor.
    if (questionPicker.isOpen()) {
      questionPicker.flushWithMessage(message, images);
      return;
    }

    // Every submit — running or idle — is a follow_up. While the agent is
    // running this queues; while idle it kicks off a fresh turn. Single
    // mental model: type, press Enter, your message lands.
    void input.session.prompt({ message, behavior: "follow_up", images }).catch(reportError);
    if (!statusController.isRunning()) {
      statusController.markRunning();
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
    statusController.setSelectionText("");
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
    await pasteController.attachImageFromPath(rest);
  }

  // ---- replay history on resume ---------------------------------------------

  // Setup already ran before the TUI launched, so we can read the resolved
  // skills/agent-files synchronously through the session getters.
  const [skills, agentFiles] = await Promise.all([
    input.session.getSkills(),
    input.session.getResolvedAgentFiles(),
  ]);
  autocomplete.setSkillItems([
    ...BUILT_IN_SLASH_COMMANDS,
    ...skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.baseDir,
      group: "skills" as const,
    })),
  ]);
  autocomplete.refresh();
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
    statusController.markRunning();
  } else {
    // A resumed sleeping session emitted its `sleep` terminal during
    // hydrate(), before this subscriber attached. Surface the banner now so
    // the user can see when the next wake will fire.
    const pending = input.session.getLastTerminal();
    if (pending?.type === "sleep") {
      stepRenderer.renderSleeping(pending.wakeAt);
      statusController.markIdle(pending);
    } else {
      statusController.markIdle();
    }
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
      statusController.shutdown();
      resolve();
    };
    renderer.once("destroy", onDestroy);
  });

  unsubscribe();
  return statusController.lastTerminal();

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
