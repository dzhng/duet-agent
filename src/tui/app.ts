// Slim orchestrator for the interactive TUI. `runTui` wires the chrome
// (renderer, layout, controllers) to the live `Session` and returns the
// terminal event that was active when the user exited. Non-trivial
// behavior lives in leaf modules under `src/tui/`; this file is the
// construction sequence plus the `submit` / `handleSteer` coordinators.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type CliRenderer, type PasteEvent, type Selection } from "@opentui/core";
import { renderBootScreen } from "./boot-screen.js";
import { createTuiControllers } from "./controllers.js";
import { replayResumeHistory } from "./history-replay.js";
import { bootstrapInitialPrompt } from "./initial-prompt.js";
import { type EscapeSuppressionFlag, installKeyHandlers } from "./key-handlers.js";
import { buildLayout } from "./layout.js";
import { acquireRenderer, waitForRendererDestroy } from "./renderer-lifecycle.js";
import { bindSessionToUi } from "./session-subscription.js";
import { StarterSection } from "./starter-section.js";
import { StatusController } from "./status-controller.js";
import { StepRenderer } from "./step-renderer.js";
import { applyRelayCommand } from "./relay-command.js";
import { tryDispatchSlashCommand } from "./slash-commands.js";
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
  /** Provenance for modelName (e.g. "inferred from ANTHROPIC_API_KEY in .env"). */
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
   * Called when the user submits `/reset`. The outer dispatcher should
   * dispose the current session, `manager.create({})`, and re-enter
   * `runTui` with the fresh session and no replayed history. The TUI
   * tears its own renderer down right after invoking this so the
   * dispatcher's `runTui` promise resolves and the loop can rebuild.
   */
  onResetRequest?: () => void;
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
    onBufferDestroyed: () => statusController.shutdown(),
  });
  const appendLine = (content: string, fg: string) => transcriptWriter.appendLine(content, fg);
  const appendBlock = (label: string | null, body: string, fg: string) =>
    transcriptWriter.appendBlock(label, body, fg);
  const recordTranscriptEntry = (kind: TranscriptEntry["kind"], text: string) =>
    transcriptWriter.recordEntry(kind, text);

  const statusController = new StatusController({
    renderer,
    status: ui.status,
    hint: ui.hint,
    refreshActiveToolBlocks: () => stepRenderer.refreshActiveToolBlocks(),
  });

  const stepRenderer = new StepRenderer({
    renderer,
    transcript: ui.transcript,
    transcriptWriter,
    statusController,
    onStepStart: () => {
      if (questionPicker.isOpen()) questionPicker.hide();
    },
  });

  const reportError = (error: unknown): void => {
    appendBlock("[error]", error instanceof Error ? error.message : String(error), COLORS.error);
    statusController.markIdle();
  };

  const escapeState: EscapeSuppressionFlag = { suppress: false };
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
    stepRenderer,
    statusController,
    questionPicker,
    appendLine,
    appendBlock,
  });

  // Esc cancels the in-flight turn; idle Esc is a no-op (Ctrl+C quits).
  function handleEscape(): void {
    if (!statusController.isRunning()) return;
    void input.session.interrupt().catch(reportError);
  }

  // Shared dispatch for submit (follow_up) and Ctrl+Enter (steer): log the
  // user message + attachments, hand the prompt to the session, flip the
  // chrome to "running".
  function dispatchTurn(message: string, behavior: "follow_up" | "steer"): void {
    const pending = pasteController.consume();
    recordTranscriptEntry("user", message);
    appendBlock("you:", message, COLORS.user);
    if (pending.length > 0) {
      const lines = pending.map((p) => `📎 ${p.label}: ${p.path}`).join("\n");
      appendBlock(null, lines, COLORS.hint);
    }
    const images = pending.map((p) => p.attachment);
    // Treat typed message as a flush so collected partial answers are not
    // dropped on the floor.
    if (behavior === "follow_up" && questionPicker.isOpen()) {
      questionPicker.flushWithMessage(message, images);
      return;
    }
    // `/relay` is an inline token, not a standalone command: when the session
    // can route to state-machine tools we strip every `/relay` token and
    // append a system reminder that primes the routing tools. In `agent`
    // mode the runner has no state-machine tools, so the token is left in
    // the message verbatim and the picker hides the command entirely.
    let outgoing = message;
    if (input.session.config.mode !== "agent") {
      const relay = applyRelayCommand(message);
      if (relay.applied) {
        outgoing = relay.message;
      }
    }
    void input.session.prompt({ message: outgoing, behavior, images }).catch(reportError);
    if (!statusController.isRunning()) statusController.markRunning();
  }

  // Ctrl+Enter: behavior:"steer" so the runner calls agent.steer() at
  // the next inference boundary instead of queueing behind the full turn.
  function handleSteer(): void {
    const message = ui.inputField.plainText.trim();
    if (message.length === 0) return;
    ui.inputField.clear();
    dispatchTurn(message, "steer");
  }

  // Plain Enter: slash-style local commands → shared dispatch (which
  // handles question-picker flush → follow_up turn). The boot starter
  // chrome is destroyed on the first user-driven submit.
  function submit(message: string): void {
    if (starters && !starters.isPermanentlyDismissed()) {
      starters.destroyPermanently();
    }
    if (
      tryDispatchSlashCommand(message, {
        pasteController,
        copyController,
        transcriptWriter,
        appendBlock,
        onReset: () => {
          input.onResetRequest?.();
          renderer.destroy();
        },
      })
    ) {
      return;
    }
    dispatchTurn(message, "follow_up");
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
    { appendLine, appendBlock, recordTranscriptEntry },
    { history: input.history, resumeHistoryMessages: input.resumeHistoryMessages },
  );

  bootstrapInitialPrompt({
    session: input.session,
    initialPrompt: input.initialPrompt,
    statusController,
    stepRenderer,
    appendBlock,
    recordTranscriptEntry,
    reportError,
  });

  await waitForRendererDestroy(renderer, () => {
    // Ctrl+C destroys text buffers synchronously. Tear down timers and
    // stop accepting chrome writes before resolving so in-flight session
    // events do not land on a dead TextBuffer.
    transcriptWriter.markDestroyed();
    statusController.shutdown();
  });

  unsubscribe();
  return statusController.lastTerminal();
}
