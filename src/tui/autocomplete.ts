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
 * One row in the slash-skill picker. `name` is shown as `/<name>`, the
 * optional `path` is rendered next to it (typically the skill's base dir),
 * and the description is wrapped underneath.
 */
export interface SkillAutocompleteItem {
  name: string;
  description?: string;
  path?: string;
}

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
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
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

export function formatSkillAutocompleteItem(item: SkillAutocompleteItem): string {
  const path = item.path ? ` (${item.path})` : "";
  const lines = [`/${item.name}${path}`, formatSkillAutocompleteDescription(item.description)];
  return lines.filter((line) => line.length > 0).join("\n");
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

/** Cycle the highlighted question option, wrapping at both ends. */
export function moveQuestionOptionSelection(
  selectedIndex: number,
  itemCount: number,
  direction: -1 | 1,
): number {
  if (itemCount <= 0) return 0;
  return (selectedIndex + direction + itemCount) % itemCount;
}

/**
 * Build the structured `answer()` payload for the currently highlighted
 * option of the first pending question. Returns undefined when the picker
 * is empty so callers can short-circuit submission.
 */
export function questionPickerAnswerPayload(
  questions: readonly TurnQuestion[],
  selectedIndex: number,
): Record<string, string> | undefined {
  const firstQuestion = questions[0];
  const selectedOption = firstQuestion?.options[selectedIndex];
  if (!firstQuestion || !selectedOption) return undefined;

  return { [firstQuestion.question]: selectedOption.label };
}

export function formatQuestionOptionDescription(description: string | undefined): string {
  if (!description) return "";

  return wrapText(description, QUESTION_OPTION_DESCRIPTION_WIDTH).join("\n");
}

/**
 * Replace the slash-token under the cursor with the resolved skill name and
 * append a trailing space when the next character is not already whitespace.
 */
export function replaceSkillAutocompleteToken(
  text: string,
  token: AutocompleteToken,
  skillName: string,
): SkillAutocompleteReplacement {
  return replaceTriggerToken(text, token, `/${skillName}`);
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
