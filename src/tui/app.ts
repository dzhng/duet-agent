import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type CliRenderer,
  createCliRenderer,
  type KeyEvent,
  type PasteEvent,
  type Selection,
} from "@opentui/core";
import { CopyController } from "./copy-controller.js";
import { PasteController } from "./paste-controller.js";
import { StarterSection } from "./starter-section.js";
import { type TranscriptEntry } from "./transcript-log.js";
import { StatusController } from "./status-controller.js";
import { StepRenderer } from "./step-renderer.js";
import { TranscriptWriter } from "./transcript-writer.js";
import type { Session } from "../session/session.js";
import type { UpgradeStatusStream } from "../cli/auto-upgrade.js";
import type { TurnEvent, TurnTerminalEvent } from "../types/protocol.js";
import { BUILT_IN_SLASH_COMMANDS } from "./autocomplete.js";
import { AutocompleteController } from "./autocomplete-controller.js";
import { QuestionPicker } from "./question-picker.js";
import { renderSetupIntro } from "./boot-screen.js";
import { replayResumeHistory } from "./history-replay.js";
import { tryDispatchSlashCommand } from "./slash-commands.js";
import { buildLayout } from "./layout.js";
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

  // ---- starter prompts (boot screen) ---------------------------------------

  // Boot screen offers a small set of context-aware starter prompts so
  // first-time and returning users land on something concrete in <2
  // seconds instead of staring at a blank input. The section dismisses
  // on first composition and never re-renders that session.
  //
  // Skipped entirely for --resume mounts: the user explicitly asked to
  // drop back into a known conversation, so the starter chrome would be
  // noise. Every call site below null-checks the local before using it.
  const starters = input.isResume
    ? undefined
    : new StarterSection({
        workDir: input.workDir,
        sessionId: input.sessionId,
        history: input.history,
        inputField,
        transcript,
        transcriptWriter,
        renderer,
        submit: (text) => submit(text),
        onResumeRequest: input.onResumeRequest,
      });

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
    if (copyController.handleCopyKeystroke(key)) return;
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
    if (starters?.isVisible() && inputField.plainText.length === 0) {
      if (key.name === "up") {
        starters.move(-1);
        key.preventDefault();
        return;
      }
      if (key.name === "down") {
        starters.move(1);
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
        if (starters.jump(target)) {
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
      if (value && starters && !starters.isPermanentlyDismissed()) {
        starters.destroyPermanently();
      }
      inputField.clear();
      if (value) {
        submit(value);
      } else if (questionPicker.isOpen()) {
        questionPicker.confirmSelection();
      } else if (starters?.isVisible()) {
        starters.submitHighlighted();
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

  const copyController = new CopyController({
    renderer,
    transcriptWriter,
    statusController,
    getLastSelectionText: () => lastSelectionText,
    clearLastSelectionText: () => {
      lastSelectionText = "";
    },
  });

  inputField.onContentChange = () => {
    // Typing hides the starter chrome; backspacing the composer empty
    // brings it back (until the user actually submits a prompt, at which
    // point it's gone for good).
    starters?.syncVisibility();
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
    if (starters && !starters.isPermanentlyDismissed()) {
      starters.destroyPermanently();
    }
    // Slash-style attach commands run locally and never reach the runner so
    // users on terminals that do not forward image bytes still have a way to
    // attach images by path.
    if (
      tryDispatchSlashCommand(message, {
        pasteController,
        copyController,
        transcriptWriter,
        appendBlock,
      })
    ) {
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
  renderSetupIntro(
    {
      renderer,
      transcript,
      appendLine,
      packageName: input.packageName,
      packageVersion: input.packageVersion,
      workDir: input.workDir,
      modelName: input.modelName,
      memoryModelName: input.memoryModelName,
      upgradeStatus$: input.upgradeStatus$,
      starters,
      isResume: input.isResume ?? false,
    },
    skills,
    agentFiles,
  );
  refreshSidebar();

  replayResumeHistory(
    { appendLine, appendBlock, recordTranscriptEntry },
    { history: input.history, resumeHistoryMessages: input.resumeHistoryMessages },
  );

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
