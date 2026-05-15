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
  /** Dispatch the composer text with behavior:"steer" (Ctrl+Enter). */
  onSteer(): void;
  /** Dino "while-you-wait" panel. The panel always owns Ctrl-G (toggle).
   *  Game keystrokes (space, ArrowUp) are forwarded while the panel is
   *  expanded AND the composer is empty, so an empty prompt at rest is
   *  fully playable but a half-typed follow-up keeps its spacebar. */
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

    // Ctrl-G: the dino panel always owns this keystroke regardless of
    // focus, the agent's running state, or whether the composer has
    // typed text. Toggling the panel must never be eaten by autocomplete
    // or starter chrome below.
    if (key.ctrl && (key.name === "g" || key.sequence === "\u0007")) {
      key.preventDefault();
      dinoPanel.toggle();
      return;
    }

    // Forward game keys (space, ArrowUp) to the dino panel whenever the
    // panel is expanded AND the composer is empty. The empty-composer
    // gate is what makes idle dogfooding work: with no typed text the
    // spacebar belongs to the game, but the moment the user starts
    // composing a follow-up their spaces go back into the textarea.
    // We deliberately do not gate on `statusController.isRunning()` so
    // the game is fully testable at rest.
    if (dinoPanel.isExpanded() && inputField.plainText.length === 0) {
      if ((key.name === "space" || key.name === "up") && !key.ctrl && !key.meta && !key.super) {
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
