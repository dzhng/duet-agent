// Slim orchestrator for the interactive TUI. `runTui` wires the chrome
// (renderer, layout, controllers) to the live `Session` and returns the
// terminal event that was active when the user exited. Non-trivial
// behavior lives in leaf modules under `src/tui/`; this file is the
// construction sequence plus the `submit` / `handleSteer` coordinators.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type CliRenderer, type PasteEvent, type Selection } from "@opentui/core";
import { renderBootScreen } from "./boot-screen.js";
import { createTuiControllers } from "./controllers.js";
import { createDinoPanel } from "./dino/index.js";
import { replayResumeHistory } from "./history-replay.js";
import { bootstrapInitialPrompt } from "./initial-prompt.js";
import {
  type CtrlCSuppressionFlag,
  type EscapeSuppressionFlag,
  installKeyHandlers,
} from "./key-handlers.js";
import { buildLayout } from "./layout.js";
import { acquireRenderer, waitForRendererDestroy } from "./renderer-lifecycle.js";
import { bindSessionToUi, type FollowUpPopSuppression } from "./session-subscription.js";
import { TaskLaneRenderer } from "./task-lane-renderer.js";
import { StarterSection } from "./starter-section.js";
import { StatusController } from "./status-controller.js";
import { StepRenderer } from "./step-renderer.js";
import { applyInlineSlashCommands, tryDispatchSlashCommand } from "./slash-commands.js";
import { COLORS } from "./theme.js";
import { TranscriptWriter } from "./transcript-writer.js";
import type { TranscriptEntry } from "./transcript-log.js";
import type { Session } from "../session/session.js";
import type { UpgradeStatusStream } from "../cli/auto-upgrade.js";
import type { TurnTerminalEvent } from "../types/protocol.js";

export type { HistoryBlockKind, HistoryDisplayBlock, LimitedHistory } from "./history.js";
export type { StartupHeaderInput } from "./history.js";
export type {
  AutocompleteToken,
  AutocompleteToken as SkillAutocompleteToken,
  FileAutocompleteItem,
  SkillAutocompleteItem,
  SkillAutocompleteReplacement,
} from "./autocomplete.js";
// Historical `tui/app.js` re-exports kept for tests + external callers.
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
  /** npm package name; labels the auto-upgrade status line. */
  packageName: string;
  /** Installed package version shown in the startup header. */
  packageVersion: string;
  /** User-facing model name for this CLI session. */
  modelName: string;
  /** Provenance for modelName (e.g. "inferred from AI_GATEWAY_API_KEY in .env"). */
  modelSource?: string;
  /** User-facing model name used for observational memory work. */
  memoryModelName: string;
  /** Provenance for memoryModelName. */
  memoryModelSource?: string;
  /**
   * Live status stream from the in-process auto-upgrade flow. The TUI
   * renders one mutating intro line through "Checking…", "Updating…",
   * "Updated. Restart duet to use it." Undefined statuses (current,
   * locked, skipped) hide the line entirely.
   */
  upgradeStatus$?: UpgradeStatusStream;
  /** Past messages to replay into the transcript on resume. */
  history?: AgentMessage[];
  /**
   * True when this TUI mount is a `--resume <id>` invocation. Suppresses
   * the boot starter menu so the user lands straight back in the prior
   * conversation instead of seeing the starter prompts again.
   */
  isResume?: boolean;
  /**
   * Called when the user picks a "pick up the thread" recent-session row.
   * The outer dispatcher should dispose the current session,
   * `manager.resume(sessionId)` + `hydrate()` + `start()`, and re-enter
   * `runTui` with the hydrated session and its replayed history. When
   * absent (tests, playground), picker rows fall back to re-submitting
   * the prior prompt as a fresh turn in the current session.
   */
  onResumeRequest?: (sessionId: string) => void;
  /**
   * Called when the user submits `/clear`. The outer dispatcher should
   * dispose the current session, `manager.create({})`, and re-enter
   * `runTui` with the fresh session and no replayed history. The TUI
   * tears its own renderer down right after invoking this so the
   * dispatcher's `runTui` promise resolves and the loop can rebuild.
   */
  onClearRequest?: () => void;
  /**
   * Trailing user-turn exchanges to replay from prior history. Each
   * exchange is the user prompt plus the assistant blocks that followed
   * it. `0` disables replay; when unset, every block is replayed.
   */
  resumeHistoryMessages?: number;
  /**
   * Pre-built renderer for tests. When provided, `runTui` skips
   * `createCliRenderer` and the `globalThis.window` shimming that wraps
   * it. The test harness in `test/helpers/tui-harness.ts` passes a
   * `createTestRenderer` instance so mock keys can drive the picker
   * without a real TTY.
   */
  renderer?: CliRenderer;
}

/**
 * Runs the interactive TUI for a session and resolves with the terminal
 * event that was active when the user exited.
 */
export async function runTui(input: RunTuiInput): Promise<TurnTerminalEvent | undefined> {
  const renderer = await acquireRenderer(input.renderer);
  const ui = buildLayout(renderer);

  // Drag-selected text cached from the renderer's `selection` event so
  // /copy + the copy keystroke prefer the user's highlight over the
  // last-message heuristic, and the bottom hint advertises the keystroke
  // only while a selection is live.
  let lastSelectionText = "";

  const transcriptWriter = new TranscriptWriter(renderer, ui.transcript, {
    getLastSelectionText: () => lastSelectionText,
    onBufferDestroyed: () => {
      statusController.shutdown();
      clearInterval(bannerWatcher);
    },
  });

  // Record + render a user-attributed transcript block. Centralized so every
  // code path that shows a `you:` block also refreshes the banner anchor
  // and body. Returns the rendered lines so callers that want to group
  // trailing rows (e.g. attachment summaries) with the user block can do so.
  function appendUserBlock(message: string) {
    transcriptWriter.recordEntry("user", message);
    const lines = transcriptWriter.appendBlock("you:", message, COLORS.user);
    transcriptWriter.setLatestUserBlock(lines);
    ui.latestUserBannerText.content = clampBannerBody(message);
    refreshLatestUserBannerVisibility();
    return lines;
  }

  const appendLine = (content: string, fg: string) => transcriptWriter.appendLine(content, fg);
  const appendBlock = (label: string | null, body: string, fg: string) =>
    transcriptWriter.appendBlock(label, body, fg);
  const recordTranscriptEntry = (kind: TranscriptEntry["kind"], text: string) =>
    transcriptWriter.recordEntry(kind, text);

  // Show the sticky banner only when the latest `you:` block has scrolled
  // off the top of the transcript viewport (i.e. the user scrolled the
  // transcript down past their last message). When the block is still on
  // screen or sits below the viewport (user scrolled up to read earlier
  // history), the banner stays hidden. OpenTUI's `Renderable#y` getter
  // walks the parent chain and already folds in `content.translateY =
  // -scrollTop`, so child `screenY` values are in the same root-cumulative
  // coordinate space as `viewport.screenY`; comparing against `scrollTop`
  // (content-space) would mix coordinate systems.
  function refreshLatestUserBannerVisibility(): void {
    const lines = transcriptWriter.getLatestUserBlock();
    if (lines.length === 0) {
      ui.latestUserBanner.visible = false;
      return;
    }
    const last = lines[lines.length - 1]!;
    const viewTop = ui.transcript.viewport.screenY;
    const scrolledAboveViewport = last.screenY + last.height <= viewTop;
    ui.latestUserBanner.visible = scrolledAboveViewport;
  }

  // Yoga lays out children asynchronously and ScrollBoxRenderable does not
  // emit a scroll event, so poll on a short interval to keep the banner in
  // sync with both new content (which shifts the sticky-bottom view) and
  // manual scrolling. 100 ms is fast enough to feel responsive while staying
  // well below the per-frame cost; the visibility check is just a handful
  // of property reads.
  const bannerWatcher = setInterval(refreshLatestUserBannerVisibility, 100);

  let refreshActiveTools: () => void = () => undefined;
  let refreshTaskLane: () => void = () => undefined;
  const statusController = new StatusController({
    renderer,
    status: ui.status,
    hint: ui.hint,
    refreshActiveWork: () => {
      refreshActiveTools();
      refreshTaskLane();
    },
  });

  const stepRenderer = new StepRenderer({
    renderer,
    transcriptWriter,
    statusController,
    onStepStart: () => {
      if (questionPicker.isOpen()) questionPicker.hide();
    },
  });
  const taskLaneRenderer = new TaskLaneRenderer({ renderer, transcriptWriter, statusController });
  refreshActiveTools = () => stepRenderer.refreshActiveToolBlocks();
  refreshTaskLane = () => taskLaneRenderer.refresh();

  // Dino panel: an opt-in mini-game that lives below the input box.
  // Ctrl-G toggles it at any time; the agent's busy/idle transitions
  // drive freeze/resume so the world automatically pauses the moment
  // the user is needed and runs the 3-2-1 countdown when work resumes.
  const dinoPanel = createDinoPanel({ renderer });
  ui.dinoPanel.add(dinoPanel.view);
  const unsubscribeDino = statusController.onRunningChange((running) => {
    if (running) dinoPanel.resume();
    else dinoPanel.freeze();
  });

  const reportError = (error: unknown): void => {
    appendBlock("[error]", error instanceof Error ? error.message : String(error), COLORS.error);
  };

  const escapeState: EscapeSuppressionFlag = { suppress: false };
  const ctrlCState: CtrlCSuppressionFlag = { suppress: false };
  const popSuppression: FollowUpPopSuppression = { pending: [] };
  const setEscapeSuppress = () => {
    escapeState.suppress = true;
  };

  // Boot starter prompts; skipped on --resume so call sites null-check.
  const starters = input.isResume
    ? undefined
    : new StarterSection({
        workDir: input.workDir,
        sessionId: input.sessionId,
        history: input.history,
        inputField: ui.inputField,
        transcript: ui.transcript,
        transcriptWriter,
        renderer,
        submit: (text) => submit(text),
        onResumeRequest: input.onResumeRequest,
      });

  const { autocomplete, questionPicker, pasteController, copyController } = createTuiControllers({
    renderer,
    ui,
    session: input.session,
    sessionId: input.sessionId,
    workDir: input.workDir,
    transcriptWriter,
    statusController,
    appendBlock,
    appendUserBlock,
    recordTranscriptEntry,
    reportError,
    onPickerEscapeClose: setEscapeSuppress,
    getLastSelectionText: () => lastSelectionText,
    clearLastSelectionText: () => {
      lastSelectionText = "";
    },
  });

  renderer.on("selection", (selection: Selection) => {
    lastSelectionText = selection.getSelectedText();
    transcriptWriter.logSelection(lastSelectionText);
    statusController.setSelectionText(lastSelectionText);
  });

  const unsubscribe = bindSessionToUi({
    session: input.session,
    sidebar: ui.sidebar,
    followUpPanel: ui.followUpPanel,
    followUpPanelBody: ui.followUpPanelBody,
    stepRenderer,
    taskLaneRenderer,
    statusController,
    questionPicker,
    appendLine,
    appendBlock,
    appendUserBlock,
    popSuppression,
  });

  // Esc cancels the in-flight turn; idle Esc is a no-op.
  function handleEscape(): void {
    if (!statusController.isRunning()) return;
    void input.session.interrupt().catch(reportError);
  }

  // Ctrl+C is a small state machine rather than an immediate quit:
  //   0. running turn + empty composer + queued follow-ups → pop the newest
  //                      queued entry back into the composer (one per press),
  //                      leaving the turn running.
  //   1. running turn  → interrupt it (identical to Esc), no exit prompt.
  //   2. composer text → clear the composer (multiline included) only;
  //                       attachments, autocomplete, and picker state stay.
  //   3. idle + empty  → first press arms a persistent exit confirmation,
  //                       a second press (or Enter) quits.
  // The exit itself reuses `renderer.destroy()`, the same teardown the old
  // OpenTUI exitOnCtrlC handler used, so shutdown semantics are unchanged.
  function handleCtrlC(): void {
    if (
      statusController.isRunning() &&
      ui.inputField.plainText.length === 0 &&
      pasteController.attachments().length === 0
    ) {
      const queue = input.session.getState()?.followUpQueue ?? [];
      const popped = queue.at(-1);
      if (popped) {
        popSuppression.pending.push(popped);
        input.session.editFollowUpQueue({ prompts: queue.slice(0, -1) });
        pasteController.stageImages(popped.images ?? []);
        ui.inputField.insertText(popped.message);
        return;
      }
    }
    if (statusController.isRunning()) {
      handleEscape();
      return;
    }
    if (ui.inputField.plainText.length > 0) {
      ui.inputField.clear();
      return;
    }
    if (statusController.isExitConfirmActive()) {
      renderer.destroy();
      return;
    }
    statusController.showExitConfirm();
  }

  // Shared dispatch for submit (follow_up) and Ctrl+Enter (steer): log the
  // user message + attachments, hand the prompt to the session, flip the
  // chrome to "running".
  async function dispatchTurn(message: string, behavior: "follow_up" | "steer"): Promise<void> {
    // Auto-attach any image-shaped paths the user typed or dragged into the
    // compose buffer. Drag-from-screenshot-thumbnail on macOS is the
    // motivating case: the terminal synthesizes keystrokes instead of firing
    // a paste event, and the tempfile under `NSIRD_screencaptureui_*`
    // disappears within seconds of the thumbnail dismissing. Scanning on
    // submit captures the bytes before that race resolves badly.
    await pasteController.autoAttachFromMessage(message).catch(reportError);
    const pending = pasteController.consume();
    // Suppress the transcript `you:` block for follow-ups that are about
    // to be queued behind an in-flight turn: the runner will keep them in
    // `state.followUpQueue` until the active work settles, and the
    // follow-up panel above the compose row already surfaces them. The
    // session subscription emits the deferred `you:` block when the
    // runner drains the entry and delivers it to the agent. Steer
    // messages skip the queue entirely, so they always render here.
    const queued = behavior === "follow_up" && statusController.isRunning();
    if (!queued) {
      appendUserBlock(message);
      if (pending.length > 0) {
        const lines = pending.map((p) => `📎 ${p.label}: ${p.path}`).join("\n");
        appendBlock(null, lines, COLORS.hint);
      }
    }
    const images = pending.map((p) => p.attachment);
    // Treat typed message as a flush so collected partial answers are not
    // dropped on the floor.
    if (behavior === "follow_up" && questionPicker.isOpen()) {
      questionPicker.flushWithMessage(message, images);
      return;
    }
    void input.session.prompt({ message, behavior, images }).catch(reportError);
    if (!statusController.isRunning()) statusController.markRunning();
  }

  // Ctrl+Enter: behavior:"steer" so the runner calls agent.steer() at
  // the next inference boundary instead of queueing behind the full turn.
  // Empty-composer Ctrl+Enter promotes the oldest queued follow-up.
  function handleSteer(): void {
    const message = ui.inputField.plainText.trim();
    if (message.length === 0) {
      promoteQueuedFollowUpToSteer();
      return;
    }
    ui.inputField.clear();
    void dispatchTurn(message, "steer").catch(reportError);
  }

  // Dequeue before steering so the runner does not also deliver this entry
  // when the original follow-up queue drains.
  function promoteQueuedFollowUpToSteer(): void {
    const [next, ...rest] = input.session.getState()?.followUpQueue ?? [];
    if (!next) return;
    input.session.editFollowUpQueue({ prompts: rest });
    void input.session
      .prompt({ message: next.message, behavior: "steer", images: next.images })
      .catch(reportError);
    if (!statusController.isRunning()) statusController.markRunning();
  }

  // Plain Enter: slash-style local commands → shared dispatch (which
  // handles question-picker flush → follow_up turn). The boot starter
  // chrome is destroyed on the first user-driven submit.
  function submit(message: string): void {
    if (starters && !starters.isPermanentlyDismissed()) {
      starters.destroyPermanently();
    }
    const slashCtx = {
      pasteController,
      copyController,
      transcriptWriter,
      appendBlock,
      onClear: () => {
        input.onClearRequest?.();
        renderer.destroy();
      },
      setModel: (model: string) => input.session.setModel(model),
      setThinkingLevel: (level: string) => input.session.setThinkingLevel(level),
      routeStatus: () => input.session.routeStatus(),
      compact: () => {
        void input.session.compact();
      },
    };
    if (tryDispatchSlashCommand(message, slashCtx)) {
      return;
    }
    // Whole-message dispatch missed; fall back to inline application so
    // commands work anywhere inside a longer prompt (`hey can you review
    // this /model gpt-5.5`). Each matched slash form fires its handler
    // and is stripped out of the message; the leftover `residue` is what
    // the agent sees. When the residue is empty (the whole prompt was
    // slash commands), we skip the turn entirely — mirrors the
    // `tryDispatchSlashCommand` early-return above.
    const { residue } = applyInlineSlashCommands(message, slashCtx);
    if (residue.length === 0) return;
    void dispatchTurn(residue, "follow_up").catch(reportError);
  }

  installKeyHandlers({
    renderer,
    inputField: ui.inputField,
    transcript: ui.transcript,
    autocomplete,
    questionPicker,
    pasteController,
    copyController,
    starters,
    transcriptWriter,
    escapeState,
    onSubmit: submit,
    onEscape: handleEscape,
    onSteer: handleSteer,
    dinoPanel,
    ctrlCState,
    onCtrlC: handleCtrlC,
    isExitConfirmActive: () => statusController.isExitConfirmActive(),
    onExitConfirmAccept: () => renderer.destroy(),
    onExitConfirmCancel: () => statusController.clearExitConfirm(),
  });

  // Typing hides starter chrome; backspacing empty brings it back until
  // the user submits.
  ui.inputField.onContentChange = () => {
    starters?.syncVisibility();
    autocomplete.refresh();
  };
  ui.inputField.onCursorChange = () => autocomplete.refresh();

  // Binary-clipboard paste: terminals that forward image bytes (kitty,
  // ghostty, recent iTerm2) land here; text pastes fall through to the
  // Textarea's default insert path.
  ui.inputField.onPaste = (event: PasteEvent) => {
    void pasteController.handlePasteEvent(event).catch((error) => {
      appendBlock("[paste]", error instanceof Error ? error.message : String(error), COLORS.error);
    });
  };

  await renderBootScreen({
    renderer,
    transcript: ui.transcript,
    appendLine,
    session: input.session,
    sidebar: ui.sidebar,
    autocomplete,
    starters,
    packageName: input.packageName,
    packageVersion: input.packageVersion,
    workDir: input.workDir,
    modelName: input.modelName,
    memoryModelName: input.memoryModelName,
    upgradeStatus$: input.upgradeStatus$,
  });

  replayResumeHistory(
    {
      appendLine,
      appendBlock,
      recordTranscriptEntry,
      setLatestUserBlock: (lines) => transcriptWriter.setLatestUserBlock(lines),
    },
    { history: input.history, resumeHistoryMessages: input.resumeHistoryMessages },
  );

  bootstrapInitialPrompt({
    session: input.session,
    initialPrompt: input.initialPrompt,
    statusController,
    stepRenderer,
    appendUserBlock,
    reportError,
  });

  await waitForRendererDestroy(renderer, () => {
    // Ctrl+C destroys text buffers synchronously. Tear down timers and
    // stop accepting chrome writes before resolving so in-flight session
    // events do not land on a dead TextBuffer.
    transcriptWriter.markDestroyed();
    statusController.shutdown();
    unsubscribeDino();
    dinoPanel.destroy();
  });

  clearInterval(bannerWatcher);
  unsubscribe();
  return statusController.lastTerminal();
}

/**
 * Clamp the body of the sticky "latest user message" banner so it does not
 * dominate the screen for long pastes. We keep at most {@link BANNER_MAX_LINES}
 * raw lines and append an ellipsis when more was trimmed; the banner itself
 * soft-wraps so visual height may still exceed the raw line count.
 */
const BANNER_MAX_LINES = 3;
function clampBannerBody(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= BANNER_MAX_LINES) return text;
  return `${lines.slice(0, BANNER_MAX_LINES).join("\n")}…`;
}
