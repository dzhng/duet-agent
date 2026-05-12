import type { TurnQuestion } from "../types/protocol.js";

const SKILL_AUTOCOMPLETE_LIMIT = 8;
const SKILL_AUTOCOMPLETE_TOKEN = /^\/([A-Za-z0-9_.-]*)$/;
const SKILL_AUTOCOMPLETE_DESCRIPTION_WIDTH = 72;
const SKILL_AUTOCOMPLETE_DESCRIPTION_LINES = 2;

const FILE_AUTOCOMPLETE_LIMIT = 8;
const FILE_AUTOCOMPLETE_TOKEN = /^@([A-Za-z0-9_./-]*)$/;

const QUESTION_OPTION_LIMIT = 8;
const QUESTION_OPTION_DESCRIPTION_WIDTH = 72;

export const AUTOCOMPLETE_LIMITS = {
  skill: SKILL_AUTOCOMPLETE_LIMIT,
  file: FILE_AUTOCOMPLETE_LIMIT,
  questionOption: QUESTION_OPTION_LIMIT,
} as const;

/**
 * Group an autocomplete row belongs to. `commands` are TUI built-ins
 * intercepted at submit time (e.g. `/image`, `/paste`, `/clear-images`);
 * `skills` are user-installed skill packages from the runner. The picker
 * renders each group under its own header.
 */
export type SlashAutocompleteGroup = "commands" | "skills";

/**
 * One row in the slash picker. `name` is shown as `/<name>`, the optional
 * `path` is rendered next to it (typically the skill's base dir), and the
 * description is wrapped underneath. `group` controls which header the row
 * appears under and defaults to `"skills"`.
 */
export interface SkillAutocompleteItem {
  name: string;
  description?: string;
  path?: string;
  group?: SlashAutocompleteGroup;
}

/**
 * The inline `/relay` token is only meaningful when the runner can route
 * to state-machine tools, so the autocomplete row is gated to non-`agent`
 * modes. Lives here rather than in the slash-command registry because
 * `/relay` is parsed inline by `applyRelayCommand` instead of being
 * dispatched at submit time; the picker still surfaces it so users can
 * discover the token by typing `/`.
 */
export const RELAY_SLASH_COMMAND: SkillAutocompleteItem = {
  name: "relay",
  description: "Inline anywhere in a prompt to nudge the agent into state-machine (relay) mode",
  group: "commands",
};

/**
 * One row in the @-file picker. `relativePath` is what gets inserted; the
 * basename is shown larger and the directory portion is shown next to it
 * so deeply nested files stay scannable.
 */
export interface FileAutocompleteItem {
  /** File basename, used as the prominent label. */
  name: string;
  /** Repo-relative POSIX path inserted into the input on selection. */
  relativePath: string;
}

/**
 * Cursor-anchored token covering the trigger character (`/` or `@`) plus
 * everything up to the next whitespace. The renderer highlights this slice
 * and replaces it on selection.
 */
export interface AutocompleteToken {
  start: number;
  end: number;
  query: string;
}

export interface SkillAutocompleteReplacement {
  text: string;
  cursorOffset: number;
}

/**
 * Locate a `/skill` token bracketing the cursor. Returns undefined when the
 * cursor is not inside a slash-prefixed identifier so callers can hide the
 * picker without inspecting the panel state separately.
 */
export function activeSkillAutocompleteToken(
  text: string,
  cursorOffset: number,
): AutocompleteToken | undefined {
  return activeTriggerToken(text, cursorOffset, "/", SKILL_AUTOCOMPLETE_TOKEN);
}

/** Same shape as the skill token, but anchored to `@<path>` for file mentions. */
export function activeFileAutocompleteToken(
  text: string,
  cursorOffset: number,
): AutocompleteToken | undefined {
  return activeTriggerToken(text, cursorOffset, "@", FILE_AUTOCOMPLETE_TOKEN);
}

function activeTriggerToken(
  text: string,
  cursorOffset: number,
  trigger: "/" | "@",
  pattern: RegExp,
): AutocompleteToken | undefined {
  const boundedOffset = Math.max(0, Math.min(cursorOffset, text.length));
  // The trigger must be at the start of input or preceded by whitespace —
  // otherwise URLs (https://…) and emails (a@b) would open the picker.
  const escapedTrigger = trigger === "/" ? "\\/" : "@";
  const tokenStart = text
    .slice(0, boundedOffset)
    .search(new RegExp(`(?:^|\\s)${escapedTrigger}[^\\s]*$`));
  if (tokenStart < 0) return undefined;

  const start = text[tokenStart] === trigger ? tokenStart : tokenStart + 1;
  const tokenEnd = text.slice(boundedOffset).search(/\s/);
  const end = tokenEnd < 0 ? text.length : boundedOffset + tokenEnd;
  const token = text.slice(start, end);
  if (!pattern.test(token)) return undefined;

  return { start, end, query: text.slice(start + 1, boundedOffset) };
}

/**
 * Filter and order skills against a typed query.
 *
 * Prefix match keeps the picker predictable: typing `/re` should always
 * surface `release` ahead of skills that merely contain the substring.
 */
export function skillAutocompleteMatches(
  skills: readonly SkillAutocompleteItem[],
  query: string,
  limit = SKILL_AUTOCOMPLETE_LIMIT,
): SkillAutocompleteItem[] {
  const normalizedQuery = query.toLocaleLowerCase();
  return [...skills]
    .filter((skill) => skill.name.toLocaleLowerCase().startsWith(normalizedQuery))
    .sort(compareSlashItems)
    .slice(0, limit);
}

/**
 * Sort: commands group first (so built-ins are always visible at the top of
 * the picker), then skills. Within a group, alphabetical by name.
 */
function compareSlashItems(a: SkillAutocompleteItem, b: SkillAutocompleteItem): number {
  const groupDelta = groupOrder(a.group) - groupOrder(b.group);
  if (groupDelta !== 0) return groupDelta;
  return a.name.localeCompare(b.name);
}

function groupOrder(group: SlashAutocompleteGroup | undefined): number {
  return group === "commands" ? 0 : 1;
}

/**
 * Filter files for the `@` picker.
 *
 * Files are ranked so that basename prefix matches come first (most useful
 * when the user types a filename), followed by basename substring matches,
 * then full-path substring matches as a fallback for nested files.
 */
export function fileAutocompleteMatches(
  files: readonly FileAutocompleteItem[],
  query: string,
  limit = FILE_AUTOCOMPLETE_LIMIT,
): FileAutocompleteItem[] {
  const normalizedQuery = query.toLocaleLowerCase();
  if (!normalizedQuery) {
    return files.slice(0, limit);
  }
  const ranked = files
    .map((file) => ({ file, score: scoreFileMatch(file, normalizedQuery) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.file.relativePath.localeCompare(b.file.relativePath);
    });
  return ranked.slice(0, limit).map((entry) => entry.file);
}

function scoreFileMatch(file: FileAutocompleteItem, normalizedQuery: string): number {
  const name = file.name.toLocaleLowerCase();
  const relativePath = file.relativePath.toLocaleLowerCase();
  if (name.startsWith(normalizedQuery)) return 3;
  if (name.includes(normalizedQuery)) return 2;
  if (relativePath.includes(normalizedQuery)) return 1;
  return 0;
}

export function formatSkillAutocompleteDescription(description: string | undefined): string {
  if (!description) return "";

  const wrapped = wrapText(description, SKILL_AUTOCOMPLETE_DESCRIPTION_WIDTH);
  const visible = wrapped.slice(0, SKILL_AUTOCOMPLETE_DESCRIPTION_LINES);
  if (wrapped.length > visible.length) {
    const lastIndex = visible.length - 1;
    visible[lastIndex] = `${visible[lastIndex]!.replace(/\s+$/, "")}...`;
  }
  return visible.join("\n");
}

function wrapText(text: string, width: number): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }

  if (current) lines.push(current);
  return lines;
}

/** Cycle the highlighted skill row, wrapping at both ends. */
export function moveSkillAutocompleteSelection(
  selectedIndex: number,
  itemCount: number,
  direction: -1 | 1,
): number {
  if (itemCount <= 0) return 0;
  return (selectedIndex + direction + itemCount) % itemCount;
}

/**
 * Build the answer-array for a single question given the picker state.
 *
 * For single-select questions (`multiSelect` falsy) this resolves the
 * highlighted option to a one-element array. For multi-select questions
 * it emits the labels of every checked index in original option order, so
 * the serialized XML preserves the question's option ordering rather than
 * the order in which the user toggled them.
 *
 * Returns `undefined` when the picker has no question to answer; callers
 * use that to short-circuit a submission attempt. An empty array is a
 * valid result for a multi-select where the user advanced without picking.
 */
export function questionPickerAnswer(
  question: TurnQuestion | undefined,
  selectedIndex: number,
  checkedIndices: ReadonlySet<number>,
): string[] | undefined {
  if (!question) return undefined;
  if (question.multiSelect) {
    const checked: string[] = [];
    for (const [index, option] of question.options.entries()) {
      if (checkedIndices.has(index)) checked.push(option.label);
    }
    return checked;
  }
  const selectedOption = question.options[selectedIndex];
  if (!selectedOption) return undefined;
  return [selectedOption.label];
}

/**
 * Fold the active question's current selection into the accumulated answers
 * map. Single-select live-records on Up/Down so highlight equals selection;
 * multi-select live-records on every Space/Enter toggle. Arrow-nav also
 * calls it so the departing question's answer is saved before moving.
 *
 * Returns the input map unchanged when there is no active question, when a
 * single-select question has no highlight (`selectedIndex === NO_HIGHLIGHT`,
 * i.e. the user has not yet pressed Up/Down on this question), or when the
 * highlight points at a row outside the question's options array (e.g. the
 * synthetic Done row in a multi-select).
 */
export function commitActiveAnswer(
  question: TurnQuestion | undefined,
  selectedIndex: number,
  checkedIndices: ReadonlySet<number>,
  accumulated: Record<string, string[]>,
): Record<string, string[]> {
  if (!question) return accumulated;
  const answer = questionPickerAnswer(question, selectedIndex, checkedIndices);
  if (answer === undefined) return accumulated;
  return { ...accumulated, [question.question]: answer };
}

/**
 * Sentinel for "no row highlighted yet". Picker initial state and freshly
 * advanced questions both start at this value; the first Up/Down lands on a
 * concrete row and (for single-select) live-records the highlight.
 */
export const NO_HIGHLIGHT = -1;

/**
 * Reconstruct picker selection state from a previously saved answer for the
 * given question. Used when the user navigates back via the Left arrow so
 * their prior toggles / highlight reappear instead of a blank slate, and
 * when advancing to a question that has not been visited yet (defaults to
 * `NO_HIGHLIGHT` so the user must explicitly press Up/Down to commit a
 * single-select answer).
 */
export function restoreSavedAnswer(
  question: TurnQuestion | undefined,
  accumulated: Record<string, string[]>,
): { selectedIndex: number; checked: Set<number> } {
  if (!question) return { selectedIndex: NO_HIGHLIGHT, checked: new Set<number>() };
  const saved = accumulated[question.question];
  if (question.multiSelect) {
    const checked = new Set<number>();
    if (saved) {
      for (const [index, option] of question.options.entries()) {
        if (saved.includes(option.label)) checked.add(index);
      }
    }
    return { selectedIndex: NO_HIGHLIGHT, checked };
  }
  if (!saved || saved.length === 0) {
    return { selectedIndex: NO_HIGHLIGHT, checked: new Set<number>() };
  }
  const matchIndex = question.options.findIndex((option) => option.label === saved[0]);
  return {
    selectedIndex: matchIndex >= 0 ? matchIndex : NO_HIGHLIGHT,
    checked: new Set<number>(),
  };
}

/**
 * Move the picker highlight by one step, wrapping at both ends and lifting
 * the `NO_HIGHLIGHT` sentinel onto the first or last row depending on
 * direction. `itemCount` includes the synthetic Done row for multi-select.
 */
export function moveQuestionHighlight(
  selectedIndex: number,
  itemCount: number,
  direction: -1 | 1,
): number {
  if (itemCount <= 0) return NO_HIGHLIGHT;
  if (selectedIndex === NO_HIGHLIGHT) return direction === 1 ? 0 : itemCount - 1;
  return (selectedIndex + direction + itemCount) % itemCount;
}

export function formatQuestionOptionDescription(description: string | undefined): string {
  if (!description) return "";

  return wrapText(description, QUESTION_OPTION_DESCRIPTION_WIDTH).join("\n");
}

/**
 * Replace the @-token under the cursor with a markdown link of the form
 * `[@<basename>](<repo-relative-path>)`. The visible label keeps the `@`
 * prefix so it still reads as a mention; the link target is the path the
 * model can hand to its `read` tool. Trailing space is inserted only when
 * the next character is not whitespace, so chained mentions stay clean.
 */
export function replaceFileAutocompleteToken(
  text: string,
  token: AutocompleteToken,
  relativePath: string,
): SkillAutocompleteReplacement {
  const slash = relativePath.lastIndexOf("/");
  const basename = slash === -1 ? relativePath : relativePath.slice(slash + 1);
  // Prefix the target with `./` so it is unambiguously a repo-relative
  // path rather than a URL, package name, or absolute path.
  return replaceTriggerToken(text, token, `[@${basename}](./${relativePath})`);
}

function replaceTriggerToken(
  text: string,
  token: AutocompleteToken,
  insertionWithoutTrailing: string,
): SkillAutocompleteReplacement {
  const insertion = text[token.end]?.match(/\s/)
    ? insertionWithoutTrailing
    : `${insertionWithoutTrailing} `;
  const nextText = `${text.slice(0, token.start)}${insertion}${text.slice(token.end)}`;
  return { text: nextText, cursorOffset: token.start + insertion.length };
}

// ---- legacy aliases --------------------------------------------------------
// Kept so existing callers (and tests) that imported the old skill-only
// names keep working without a rename ripple.

/** @deprecated Use {@link AutocompleteToken}. */
export type SkillAutocompleteToken = AutocompleteToken;
