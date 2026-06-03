import type { CliRenderer, KeyEvent, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import type { AutocompleteController } from "./autocomplete-controller.js";
import type { CopyController } from "./copy-controller.js";
import type { DinoPanel } from "./dino/index.js";
import type { PasteController } from "./paste-controller.js";
import type { QuestionPicker } from "./question-picker.js";
import type { StarterSection } from "./starter-section.js";
import type { TranscriptWriter } from "./transcript-writer.js";

/**
 * Mutable flag shared between Esc-closing controllers (autocomplete, question
 * picker) and the global Esc handler. The controllers set `suppress = true`
 * when they consume Escape so the next bubbled Escape does not also cancel
 * the active turn. The flag is reset on the very next Escape press.
 */
export interface EscapeSuppressionFlag {
  suppress: boolean;
}

/**
 * Mutable dedupe flag for Ctrl+C, mirroring {@link EscapeSuppressionFlag}.
 * The composer's `onKeyDown` hook runs before the renderer's global
 * keypress handler, so when it consumes a Ctrl+C it sets `suppress = true`
 * to stop the global fallback from running the state machine a second time
 * for the same press.
 */
export interface CtrlCSuppressionFlag {
  suppress: boolean;
}

/** A *plain* Ctrl+C keystroke, by name or by the raw 0x03 byte legacy
 *  terminals send. Shared by the global handler and the composer hook so
 *  both agree on what counts as Ctrl+C. Shift is excluded so Ctrl+Shift+C
 *  (the copy keystroke, which some kitty parsers report as `name:"c"`
 *  with `shift:true`) is left for the copy handler rather than triggering
 *  the exit state machine. */
function isCtrlCKey(key: KeyEvent): boolean {
  return Boolean(key.ctrl) && !key.shift && (key.name === "c" || key.sequence === "\u0003");
}

interface InternalKeyHandlerLike {
  onInternal(event: "keypress", handler: (key: KeyEvent) => void): void;
}

export interface KeyHandlerDeps {
  renderer: CliRenderer;
  inputField: TextareaRenderable;
  transcript: ScrollBoxRenderable;
  autocomplete: AutocompleteController;
  questionPicker: QuestionPicker;
  pasteController: PasteController;
  copyController: CopyController;
  starters: StarterSection | undefined;
  transcriptWriter: TranscriptWriter;
  escapeState: EscapeSuppressionFlag;
  /** Submit the current composer contents as a regular follow_up turn. */
  onSubmit(value: string): void;
  /** Cancel any in-flight turn (Escape when running). */
  onEscape(): void;
  /** Dedupe flag shared with the global Ctrl+C fallback. */
  ctrlCState: CtrlCSuppressionFlag;
  /** Run the Ctrl+C state machine: interrupt a running turn, else clear a
   *  non-empty composer, else arm/confirm the exit prompt. */
  onCtrlC(): void;
  /** Whether the persistent exit-confirm prompt is currently showing. */
  isExitConfirmActive(): boolean;
  /** Confirm the pending exit and tear the TUI down via the normal quit
   *  teardown path. */
  onExitConfirmAccept(): void;
  /** Cancel the pending exit prompt and return to normal editing. */
  onExitConfirmCancel(): void;
  /** Dispatch the composer text with behavior:"steer" (Ctrl+Enter). */
  onSteer(): void;
  /** Dino mini-game panel. The panel always owns Ctrl-G, which
   *  cycles collapsed → expanded+game-focused → expanded+composer-focused
   *  → collapsed. The only game keystroke is ArrowUp; the spacebar is
   *  always the composer's so a half-typed follow-up can coexist with
   *  the running game. Ctrl-G hands the up-arrow back and forth. */
  dinoPanel: DinoPanel;
}

/**
 * Wires up the two keyboard event surfaces the TUI listens on:
 *
 *  - The renderer's global keypress hook, used for keystrokes that fire
 *    regardless of focus (Esc cancel, Cmd/Ctrl+Shift+C copy when focus
 *    has drifted off the textarea during drag-select).
 *  - The composer `TextareaRenderable`'s `onKeyDown`, which intercepts
 *    keys before the textarea's own bindings (Esc would otherwise be
 *    consumed by Textarea internals).
 *
 * All input keystroke routing lives here so `runTui` stays a wiring
 * sketch and key handling can be reasoned about in one place.
 */
export function installKeyHandlers(deps: KeyHandlerDeps): void {
  const {
    renderer,
    inputField,
    transcript,
    autocomplete,
    questionPicker,
    pasteController,
    copyController,
    starters,
    transcriptWriter,
    escapeState,
    onSubmit,
    onEscape,
    onSteer,
    dinoPanel,
    ctrlCState,
    onCtrlC,
    isExitConfirmActive,
    onExitConfirmAccept,
    onExitConfirmCancel,
  } = deps;

  const keyHandler = (renderer as unknown as { _keyHandler: InternalKeyHandlerLike })._keyHandler;
  keyHandler.onInternal("keypress", (key: KeyEvent) => {
    transcriptWriter.logKey("global", key);
    // Copy keystroke. Lives on the global handler (not
    // inputField.onKeyDown) because the mousedown that starts a
    // drag-select moves focus off the textarea — the focused-renderable
    // path stops firing right when the user has something to copy. The
    // global handler always fires regardless of focus.
    if (copyController.handleCopyKeystroke(key)) return;
    // Ctrl+C. Normally the composer's onKeyDown (below) handles it first and
    // sets `ctrlCState.suppress`; this branch is the fallback for when focus
    // has drifted off the textarea (e.g. mid drag-select) so onKeyDown never
    // fired.
    if (isCtrlCKey(key)) {
      key.preventDefault();
      if (ctrlCState.suppress) {
        ctrlCState.suppress = false;
        return;
      }
      onCtrlC();
      return;
    }
    if (key.name !== "escape") return;
    if (escapeState.suppress) {
      escapeState.suppress = false;
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
    onEscape();
  });

  // Keyboard scroll bindings for the transcript. Mirrors the mouse wheel
  // for terminals that swallow mouse events (tmux without mouse mode, ssh
  // sessions where the local terminal owns the wheel, screen readers).
  // Page = one viewport; Shift+arrow = three lines, matching wheel cadence.
  function scrollByLines(delta: number): void {
    transcript.scrollBy({ x: 0, y: delta });
  }
  function scrollByPage(direction: 1 | -1): void {
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

    // Ctrl+C owns the highest priority: it must beat submit, newline, and the
    // dino toggle. The state machine (interrupt / clear / arm-or-confirm exit)
    // lives in `onCtrlC`. We set `ctrlCState.suppress` so the global keypress
    // fallback does not double-fire for the same press.
    if (isCtrlCKey(key)) {
      key.preventDefault();
      ctrlCState.suppress = true;
      onCtrlC();
      return;
    }

    // While the exit-confirm prompt is up (idle + empty composer), Enter
    // confirms the exit and any other keystroke cancels the prompt and
    // resumes normal editing. A second Ctrl+C also confirms, handled above.
    if (isExitConfirmActive()) {
      if (key.name === "return" || key.name === "enter") {
        key.preventDefault();
        onExitConfirmAccept();
        return;
      }
      onExitConfirmCancel();
      // Fall through so the cancelling keystroke is processed normally.
    }

    // Ctrl-G: the dino panel always owns this keystroke regardless of
    // focus, the agent's running state, or whether the composer has
    // typed text. Toggling the panel must never be eaten by autocomplete
    // or starter chrome below.
    if (key.ctrl && (key.name === "g" || key.sequence === "\u0007")) {
      key.preventDefault();
      dinoPanel.toggle();
      return;
    }

    // Forward ArrowUp to the dino panel whenever it is expanded AND
    // game-focused. Spacebar is deliberately not a game key: users
    // frequently type a follow-up while the game keeps running, and
    // letting the composer always own space avoids the awkward case of
    // a stray jump while typing. We deliberately do not gate on
    // `statusController.isRunning()` so the game is fully testable at
    // rest.
    if (dinoPanel.isGameFocused()) {
      if (key.name === "up" && !key.ctrl && !key.meta && !key.super && !key.shift) {
        if (dinoPanel.handleKey(key.name)) {
          key.preventDefault();
          return;
        }
      }
    }
    if (key.name === "pageup") {
      scrollByPage(-1);
      key.preventDefault();
      return;
    }
    if (key.name === "pagedown") {
      scrollByPage(1);
      key.preventDefault();
      return;
    }
    if (key.shift && key.name === "up" && !key.ctrl && !key.meta && !key.super) {
      scrollByLines(-3);
      key.preventDefault();
      return;
    }
    if (key.shift && key.name === "down" && !key.ctrl && !key.meta && !key.super) {
      scrollByLines(3);
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

    if (autocomplete.handleKey(key)) return;
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
        onSteer();
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
        onSubmit(value);
      } else if (questionPicker.isOpen()) {
        questionPicker.confirmSelection();
      } else if (starters?.isVisible()) {
        starters.submitHighlighted();
      }
      return;
    }
    if (key.name === "escape") {
      // Suppress the next global keypress for this Escape press so the
      // renderer-level handler does not also call onEscape — the textarea
      // hook runs first and consumes the keystroke here.
      key.preventDefault();
      escapeState.suppress = true;
      onEscape();
      return;
    }
  };
}
