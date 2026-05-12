import {
  type BoxRenderable,
  fg,
  type KeyEvent,
  t,
  type TextareaRenderable,
  type TextRenderable,
} from "@opentui/core";
import {
  AUTOCOMPLETE_LIMITS,
  commitActiveAnswer,
  formatQuestionOptionDescription,
  moveQuestionHighlight,
  NO_HIGHLIGHT,
  restoreSavedAnswer,
} from "./autocomplete.js";
import type { Session } from "../session/session.js";
import { COLORS } from "./theme.js";
import type { TranscriptEntryKind } from "./transcript-log.js";
import type { TurnPromptImage, TurnQuestion } from "../types/protocol.js";

const QUESTION_OPTION_LIMIT = AUTOCOMPLETE_LIMITS.questionOption;

export interface QuestionPickerOptions {
  /** Bordered panel that wraps the title + option rows; toggled visible
   *  alongside the row pool. */
  questionPanel: BoxRenderable;
  /** Single text row used as the panel header; rewritten on every render
   *  with the active question text and (i/N) progress. */
  questionTitle: TextRenderable;
  /** Fixed-size pool of selectable rows. The picker shows/hides entries
   *  from this pool rather than mounting fresh renderables per question
   *  so layout heights stay stable across questions. */
  questionRows: TextRenderable[];
  /** Composer textarea. Read for `plainText.length` so the picker can
   *  defer Space/Left/Right bindings to typing when the user is mid-prompt. */
  inputField: TextareaRenderable;
  /** Session that receives the assembled answer payload via `.answer(...)`
   *  once the user finishes the picker. */
  session: Session;
  /** Notify the host that the picker is about to swallow an Escape so the
   *  global escape-to-exit handler suppresses the next Escape it sees and
   *  doesn't double-handle the keystroke. */
  onEscapeClose: () => void;
  /** Append a bordered transcript block (label + body). Used for the
   *  `you:` echo when the user confirms an answer, mirroring how free-form
   *  prompts render. */
  appendBlock: (label: string | null, body: string, color: string) => void;
  /** Mirror committed answers into the in-memory transcript log so /copy
   *  and resume snapshots include them in order. */
  recordTranscriptEntry: (kind: TranscriptEntryKind, text: string) => void;
  /** Surface a dispatch failure (rejected `session.answer` promise) the
   *  same way the rest of runTui does. */
  reportError: (error: unknown) => void;
  /** Bridge to the status controller so the picker can flip the working
   *  indicator on when an answer kicks off a new turn. */
  markRunning: () => void;
  /** Asked before `markRunning()` so the picker mirrors the host's
   *  conditional "only mark when currently idle" behaviour. */
  isRunning: () => boolean;
}

/**
 * Owns the question picker: an ask terminal hands it a list of
 * `TurnQuestion`s and the picker walks the user through them, accumulating
 * selected option labels until the user either finishes the last question
 * (dispatches an `answer`), types a free-form prompt over the top
 * (`flushWithMessage`), or escapes out (host suppresses next escape so the
 * TUI doesn't also exit).
 *
 * Single-select questions live-record the highlighted option as the answer
 * so arrow navigation alone is enough; multi-select keeps the highlight
 * separate from a checked-set toggled via Space/Enter and grows a synthetic
 * "Done" row that advances to the next question.
 */
export class QuestionPicker {
  private pendingQuestions: TurnQuestion[] = [];
  private activeIndex = 0;
  // `NO_HIGHLIGHT` (-1) means no row is highlighted yet — the user must press
  // Up/Down to land on a concrete row. Single-select live-records the
  // highlight as the answer; multi-select uses highlight purely for
  // navigation and toggles the checked set on Space/Enter.
  private optionSelectedIndex = NO_HIGHLIGHT;
  // Per-question checked indices for the active multi-select question. Reset
  // when the picker advances to the next question; single-select questions
  // simply ignore this set and use `optionSelectedIndex` instead.
  private multiSelectChecked = new Set<number>();
  // Answers collected while walking the picker, keyed by question text. We
  // dispatch the full map once the user finishes the last question, or flush
  // it early when they decide to type a free-form prompt instead.
  private accumulatedAnswers: Record<string, string[]> = {};

  constructor(private readonly opts: QuestionPickerOptions) {}

  isOpen(): boolean {
    const question = this.pendingQuestions[this.activeIndex];
    return Boolean(question && question.options.length > 0);
  }

  show(questions: TurnQuestion[]): void {
    this.pendingQuestions = questions;
    this.activeIndex = 0;
    this.optionSelectedIndex = NO_HIGHLIGHT;
    this.multiSelectChecked = new Set<number>();
    this.accumulatedAnswers = {};
    this.render();
  }

  hide(): void {
    this.pendingQuestions = [];
    this.activeIndex = 0;
    this.optionSelectedIndex = NO_HIGHLIGHT;
    this.multiSelectChecked = new Set<number>();
    this.accumulatedAnswers = {};
    this.opts.questionPanel.visible = false;
    for (const row of this.opts.questionRows) {
      row.visible = false;
      row.content = "";
    }
  }

  /**
   * Confirm whatever is currently highlighted. Multi-select on a regular row
   * toggles; multi-select on the Done row advances. Single-select always
   * advances (highlight = answer is already live-recorded by Up/Down). No-op
   * when nothing is highlighted yet so the user is forced to make an
   * explicit choice (or skip via Right-arrow).
   */
  confirmSelection(): boolean {
    const question = this.activeQuestion();
    if (!question) return false;
    if (this.optionSelectedIndex === NO_HIGHLIGHT) return false;
    if (question.multiSelect && this.optionSelectedIndex !== this.activeQuestionDoneIndex()) {
      this.toggleActiveMultiSelectOption();
      return true;
    }
    return this.advanceOrSubmit();
  }

  /**
   * Dispatch the partially-collected answers together with a free-form
   * `message` (and any pending image attachments) as a single
   * `session.answer({ ..., message, images })` turn, then hide the picker.
   * Used when the user types over the top of an open picker — without this
   * the partial selections would be discarded when the prompt fires.
   */
  flushWithMessage(message: string, images: TurnPromptImage[]): void {
    void this.opts.session
      .answer({
        questions: this.pendingQuestions,
        answers: this.accumulatedAnswers,
        behavior: "follow_up",
        message,
        images,
      })
      .catch(this.opts.reportError);
    this.hide();
    if (!this.opts.isRunning()) this.opts.markRunning();
  }

  /**
   * Handle a keystroke while the picker is open. Returns `true` if the key
   * was claimed (and `key.preventDefault()` already called); the caller
   * should stop further dispatch in that case. Returns `false` when the
   * picker is closed or the key isn't one this controller handles.
   */
  handleKey(key: KeyEvent): boolean {
    if (!this.isOpen()) return false;
    if (key.name === "up") {
      this.moveActiveHighlight(-1);
      key.preventDefault();
      return true;
    }
    if (key.name === "down") {
      this.moveActiveHighlight(1);
      key.preventDefault();
      return true;
    }
    // Space confirms the active selection only when the composer is empty
    // so users can still type a free-form prompt that includes spaces.
    // Match either the named form (most terminals) or the literal-char
    // form some kitty-keyboard parsers emit so the binding is robust
    // regardless of how the host reports an unmodified Space.
    if ((key.name === "space" || key.name === " ") && this.opts.inputField.plainText.length === 0) {
      key.preventDefault();
      this.confirmSelection();
      return true;
    }
    // Left/Right navigate between questions, but only when the composer is
    // empty so editing a typed prompt with arrow keys still works.
    if (
      (key.name === "left" || key.name === "right") &&
      this.opts.inputField.plainText.length === 0 &&
      this.pendingQuestions.length > 1
    ) {
      const direction = key.name === "left" ? -1 : 1;
      if (this.navigateActive(direction)) {
        key.preventDefault();
        return true;
      }
    }
    if (key.name === "escape") {
      key.preventDefault();
      this.opts.onEscapeClose();
      this.hide();
      return true;
    }
    return false;
  }

  // ---- internal -----------------------------------------------------------

  private activeQuestion(): TurnQuestion | undefined {
    return this.pendingQuestions[this.activeIndex];
  }

  /**
   * Total navigable rows for the active question. The Up/Down handler clamps
   * navigation to what is actually rendered on screen so a user cannot land
   * the highlight on a row they cannot see.
   */
  private activeRowCount(): number {
    const question = this.activeQuestion();
    if (!question) return 0;
    const optionLimit = question.multiSelect ? QUESTION_OPTION_LIMIT - 1 : QUESTION_OPTION_LIMIT;
    const visibleOptionCount = Math.min(question.options.length, optionLimit);
    return visibleOptionCount + (question.multiSelect ? 1 : 0);
  }

  /**
   * Row index of the synthetic Done row when the active question is
   * multi-select; `undefined` otherwise so callers don't compare against a
   * sentinel value. The Done row sits one past the last visible option,
   * clamped to the same limit `render()` uses.
   */
  private activeQuestionDoneIndex(): number | undefined {
    const question = this.activeQuestion();
    if (!question?.multiSelect) return undefined;
    const optionLimit = QUESTION_OPTION_LIMIT - 1;
    return Math.min(question.options.length, optionLimit);
  }

  private render(): void {
    const question = this.activeQuestion();
    if (!question || question.options.length === 0) {
      this.hide();
      return;
    }
    const { questionPanel, questionTitle, questionRows } = this.opts;
    questionPanel.visible = true;
    const baseTitle = question.header
      ? `${question.header}: ${question.question}`
      : question.question;
    const positionPrefix =
      this.pendingQuestions.length > 1
        ? `(${this.activeIndex + 1}/${this.pendingQuestions.length}) `
        : "";
    const navHint = this.pendingQuestions.length > 1 ? " [←/→ navigate]" : "";
    questionTitle.content = `${positionPrefix}${baseTitle}${navHint}`;
    const optionLimit = question.multiSelect ? QUESTION_OPTION_LIMIT - 1 : QUESTION_OPTION_LIMIT;
    const visibleOptions = question.options.slice(0, optionLimit);
    const doneIndex = this.activeQuestionDoneIndex();
    for (const [index, row] of questionRows.entries()) {
      if (index < visibleOptions.length) {
        const option = visibleOptions[index]!;
        const highlighted = index === this.optionSelectedIndex;
        const checkbox = question.multiSelect
          ? this.multiSelectChecked.has(index)
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
        const highlighted = doneIndex === this.optionSelectedIndex;
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

  private moveActiveHighlight(direction: -1 | 1): void {
    const question = this.activeQuestion();
    if (!question) return;
    this.optionSelectedIndex = moveQuestionHighlight(
      this.optionSelectedIndex,
      this.activeRowCount(),
      direction,
    );
    // Single-select live-records the highlight as the answer so a
    // prompt-flush or arrow-nav captures it without requiring Space/Enter.
    // Multi-select keeps highlight separate from the toggled set.
    if (!question.multiSelect) {
      this.accumulatedAnswers = commitActiveAnswer(
        question,
        this.optionSelectedIndex,
        this.multiSelectChecked,
        this.accumulatedAnswers,
      );
    }
    this.render();
  }

  private toggleActiveMultiSelectOption(): void {
    const question = this.activeQuestion();
    if (!question?.multiSelect) return;
    if (this.multiSelectChecked.has(this.optionSelectedIndex)) {
      this.multiSelectChecked.delete(this.optionSelectedIndex);
    } else {
      this.multiSelectChecked.add(this.optionSelectedIndex);
    }
    this.accumulatedAnswers = commitActiveAnswer(
      question,
      this.optionSelectedIndex,
      this.multiSelectChecked,
      this.accumulatedAnswers,
    );
    this.render();
  }

  private navigateActive(direction: -1 | 1): boolean {
    if (this.pendingQuestions.length <= 1) return false;
    const nextIndex = this.activeIndex + direction;
    if (nextIndex < 0 || nextIndex >= this.pendingQuestions.length) return false;

    this.accumulatedAnswers = commitActiveAnswer(
      this.activeQuestion(),
      this.optionSelectedIndex,
      this.multiSelectChecked,
      this.accumulatedAnswers,
    );

    this.activeIndex = nextIndex;
    const restored = restoreSavedAnswer(this.activeQuestion(), this.accumulatedAnswers);
    this.optionSelectedIndex = restored.selectedIndex;
    this.multiSelectChecked = restored.checked;
    this.render();
    return true;
  }

  private describeAnswerLabels(question: TurnQuestion, labels: readonly string[]): string {
    if (labels.length === 0) return question.multiSelect ? "(no selection)" : "";
    return labels.join(", ");
  }

  private advanceOrSubmit(): boolean {
    const question = this.activeQuestion();
    if (!question) return false;
    const accumulatedForActive = this.accumulatedAnswers[question.question] ?? [];
    const transcriptText = this.describeAnswerLabels(question, accumulatedForActive);
    if (transcriptText) {
      this.opts.recordTranscriptEntry("user", transcriptText);
      this.opts.appendBlock("you:", transcriptText, COLORS.user);
    }

    if (this.activeIndex < this.pendingQuestions.length - 1) {
      this.activeIndex += 1;
      const restored = restoreSavedAnswer(this.activeQuestion(), this.accumulatedAnswers);
      this.optionSelectedIndex = restored.selectedIndex;
      this.multiSelectChecked = restored.checked;
      this.render();
      return true;
    }

    void this.opts.session
      .answer({
        questions: this.pendingQuestions,
        answers: this.accumulatedAnswers,
        behavior: "follow_up",
      })
      .catch(this.opts.reportError);
    this.hide();
    this.opts.markRunning();
    return true;
  }
}
