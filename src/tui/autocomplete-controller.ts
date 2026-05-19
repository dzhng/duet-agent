import {
  type BoxRenderable,
  type KeyEvent,
  type TextareaRenderable,
  type TextRenderable,
  fg,
  t,
} from "@opentui/core";
import {
  type AutocompleteToken,
  activeFileAutocompleteToken,
  activeSkillAutocompleteToken,
  type FileAutocompleteItem,
  fileAutocompleteMatches,
  formatSkillAutocompleteDescription,
  moveSkillAutocompleteSelection,
  replaceFileAutocompleteToken,
  type SkillAutocompleteItem,
  skillAutocompleteMatches,
  type SlashAutocompleteGroup,
} from "./autocomplete.js";
import { buildFileIndex } from "./file-index.js";
import { COLORS } from "./theme.js";

export interface AutocompleteControllerOptions {
  /** Input textarea whose `plainText` + `cursorOffset` drive token
   *  detection, and whose `setSelection` / `deleteSelection` / `insertText`
   *  methods perform the completion in place so attachment placeholders and
   *  the cursor model stay consistent. */
  inputField: TextareaRenderable;
  /** Slash + skill picker panel; `visible` is flipped from render(). */
  skillAutocompletePanel: BoxRenderable;
  /** Fixed pool of selectable rows for built-in slash commands. */
  commandRows: TextRenderable[];
  /** Header row above the commands section; hidden when no command rows
   *  matched the query. */
  commandHeader: TextRenderable;
  /** Fixed pool of selectable rows for matched skills. */
  skillRows: TextRenderable[];
  /** Header row above the skills section; hidden when no skill rows
   *  matched the query. */
  skillHeader: TextRenderable;
  /** `@`-file picker panel; mirrors the slash panel's structure. */
  fileAutocompletePanel: BoxRenderable;
  /** Fixed pool of selectable rows for matched files. */
  fileAutocompleteRows: TextRenderable[];
  /** Working directory used to build the file index on first `@` trigger. */
  workDir: string;
  /**
   * Called when the user presses Escape inside an open picker. The global
   * escape handler runs *after* this one and would otherwise exit the TUI;
   * the caller uses this hook to flip a one-shot suppression flag so the
   * escape that closed the picker stops there.
   */
  onEscapeClose: () => void;
  /**
   * Fires the moment the slash picker opens (token went from absent to
   * present). Used to re-discover installed skills so additions made
   * during the session show up; the cached catalog is shown first and
   * the callback updates it asynchronously.
   */
  onSkillTokenOpened?: () => void;
}

/**
 * Owns both autocomplete pickers (slash/skill and `@`/file) and the keys
 * that drive them. The pickers share a refresh/render lifecycle (token
 * detection on every content + cursor change, lazy file index, fixed-pool
 * row updates) so they live behind one controller. Production wiring
 * inlines the completion path via `inputField.setSelection / deleteSelection
 * / insertText` so it composes with attachment placeholders.
 */
export class AutocompleteController {
  private skills: readonly SkillAutocompleteItem[] = [];
  private skillToken: AutocompleteToken | undefined;
  private skillItems: SkillAutocompleteItem[] = [];
  private skillSelectedIndex = 0;

  // File index loads lazily after the first @ trigger and never re-runs.
  // Repos large enough to matter would block the first keystroke otherwise;
  // a stale-by-a-few-files index is a fair trade for a snappy first paint.
  private fileAllFiles: readonly FileAutocompleteItem[] = [];
  private fileIndexPromise: Promise<readonly FileAutocompleteItem[]> | undefined;
  private fileToken: AutocompleteToken | undefined;
  private fileItems: FileAutocompleteItem[] = [];
  private fileSelectedIndex = 0;

  constructor(private readonly opts: AutocompleteControllerOptions) {}

  /** Set the skill catalog (built-in slash commands + discovered skills).
   *  Idempotent: callers typically invoke once after session setup completes. */
  setSkillItems(skills: readonly SkillAutocompleteItem[]): void {
    this.skills = skills;
  }

  isSkillPickerOpen(): boolean {
    return Boolean(this.skillToken && this.skillItems.length > 0);
  }

  isFilePickerOpen(): boolean {
    return Boolean(this.fileToken && this.fileItems.length > 0);
  }

  /** Re-evaluate both pickers against the current input. Called on every
   *  content change and cursor change in the textarea. */
  refresh(): void {
    this.refreshSkill();
    this.refreshFile();
  }

  /** Force both pickers closed. Used by `/`-command submit paths and the
   *  global escape handler. */
  hideAll(): void {
    this.hideSkill();
    this.hideFile();
  }

  /**
   * Handle a keystroke while a picker is open. Returns `true` if the key was
   * claimed (and `key.preventDefault()` already called); the caller should
   * stop further dispatch in that case. Returns `false` when neither picker
   * is open or the key isn't one this controller handles.
   */
  handleKey(key: KeyEvent): boolean {
    if (this.isSkillPickerOpen()) {
      if (key.name === "up") {
        this.skillSelectedIndex = moveSkillAutocompleteSelection(
          this.skillSelectedIndex,
          this.skillItems.length,
          -1,
        );
        this.renderSkill();
        key.preventDefault();
        return true;
      }
      if (key.name === "down") {
        this.skillSelectedIndex = moveSkillAutocompleteSelection(
          this.skillSelectedIndex,
          this.skillItems.length,
          1,
        );
        this.renderSkill();
        key.preventDefault();
        return true;
      }
      if (key.name === "return" || key.name === "enter" || key.name === "tab") {
        key.preventDefault();
        this.completeSelectedSkill();
        return true;
      }
      if (key.name === "escape") {
        key.preventDefault();
        this.opts.onEscapeClose();
        this.hideSkill();
        return true;
      }
    }

    if (this.isFilePickerOpen()) {
      if (key.name === "up") {
        this.fileSelectedIndex = moveSkillAutocompleteSelection(
          this.fileSelectedIndex,
          this.fileItems.length,
          -1,
        );
        this.renderFile();
        key.preventDefault();
        return true;
      }
      if (key.name === "down") {
        this.fileSelectedIndex = moveSkillAutocompleteSelection(
          this.fileSelectedIndex,
          this.fileItems.length,
          1,
        );
        this.renderFile();
        key.preventDefault();
        return true;
      }
      if (key.name === "return" || key.name === "enter" || key.name === "tab") {
        key.preventDefault();
        this.completeSelectedFile();
        return true;
      }
      if (key.name === "escape") {
        key.preventDefault();
        this.opts.onEscapeClose();
        this.hideFile();
        return true;
      }
    }

    return false;
  }

  // ---- internal -----------------------------------------------------------

  private async ensureFileIndex(): Promise<readonly FileAutocompleteItem[]> {
    if (this.fileAllFiles.length > 0) return this.fileAllFiles;
    if (!this.fileIndexPromise) {
      this.fileIndexPromise = buildFileIndex(this.opts.workDir).catch(() => []);
    }
    this.fileAllFiles = await this.fileIndexPromise;
    return this.fileAllFiles;
  }

  private refreshSkill(): void {
    const { inputField } = this.opts;
    const token = activeSkillAutocompleteToken(inputField.plainText, inputField.cursorOffset);
    if (!token) {
      this.hideSkill();
      return;
    }

    const items = skillAutocompleteMatches(this.skills, token.query);
    if (items.length === 0) {
      this.hideSkill();
      return;
    }

    const previousToken = this.skillToken;
    this.skillToken = token;
    this.skillItems = items;
    const queryChanged =
      !previousToken ||
      previousToken.start !== token.start ||
      previousToken.end !== token.end ||
      previousToken.query !== token.query;
    if (queryChanged || this.skillSelectedIndex >= items.length) {
      this.skillSelectedIndex = 0;
    }
    this.renderSkill();
    // Fire after rendering the cached catalog so the picker paints
    // immediately; the reload runs in the background and a follow-up
    // setSkillItems()+refresh() updates the open picker in place.
    if (!previousToken) {
      this.opts.onSkillTokenOpened?.();
    }
  }

  private refreshFile(): void {
    const { inputField } = this.opts;
    const token = activeFileAutocompleteToken(inputField.plainText, inputField.cursorOffset);
    if (!token) {
      this.hideFile();
      return;
    }

    // Capture the token id we're looking up so a slow index resolution can
    // tell whether the user has typed past the original query and bail out.
    const targetStart = token.start;
    const targetEnd = token.end;
    const targetQuery = token.query;
    void this.ensureFileIndex().then((files) => {
      const stillCurrent =
        this.fileToken !== undefined
          ? this.fileToken.start === targetStart &&
            this.fileToken.end === targetEnd &&
            this.fileToken.query === targetQuery
          : activeFileAutocompleteToken(inputField.plainText, inputField.cursorOffset)?.query ===
            targetQuery;
      if (!stillCurrent && this.fileToken === undefined) return;
      const items = fileAutocompleteMatches(files, targetQuery);
      if (items.length === 0) {
        this.hideFile();
        return;
      }
      const previousToken = this.fileToken;
      this.fileToken = { start: targetStart, end: targetEnd, query: targetQuery };
      this.fileItems = items;
      const queryChanged =
        !previousToken ||
        previousToken.start !== targetStart ||
        previousToken.end !== targetEnd ||
        previousToken.query !== targetQuery;
      if (queryChanged || this.fileSelectedIndex >= items.length) {
        this.fileSelectedIndex = 0;
      }
      this.renderFile();
    });
  }

  private renderSkill(): void {
    const { skillAutocompletePanel, commandRows, commandHeader, skillRows, skillHeader } =
      this.opts;
    skillAutocompletePanel.visible = this.skillItems.length > 0;

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

    for (const [flatIndex, item] of this.skillItems.entries()) {
      const groupKey = item.group ?? "skills";
      const slot = groups[groupKey];
      const row = slot.rows[slot.cursor];
      if (!row) continue;
      slot.cursor += 1;
      const selected = flatIndex === this.skillSelectedIndex;
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

  private renderFile(): void {
    const { fileAutocompletePanel, fileAutocompleteRows } = this.opts;
    fileAutocompletePanel.visible = this.fileItems.length > 0;
    for (const [index, row] of fileAutocompleteRows.entries()) {
      const item = this.fileItems[index];
      if (!item) {
        row.visible = false;
        row.content = "";
        continue;
      }
      const selected = index === this.fileSelectedIndex;
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

  private hideSkill(): void {
    const { skillAutocompletePanel, commandRows, commandHeader, skillRows, skillHeader } =
      this.opts;
    this.skillToken = undefined;
    this.skillItems = [];
    this.skillSelectedIndex = 0;
    skillAutocompletePanel.visible = false;
    commandHeader.visible = false;
    skillHeader.visible = false;
    for (const row of [...commandRows, ...skillRows]) {
      row.visible = false;
      row.content = "";
    }
  }

  private hideFile(): void {
    const { fileAutocompletePanel, fileAutocompleteRows } = this.opts;
    this.fileToken = undefined;
    this.fileItems = [];
    this.fileSelectedIndex = 0;
    fileAutocompletePanel.visible = false;
    for (const row of fileAutocompleteRows) {
      row.visible = false;
      row.content = "";
    }
  }

  private completeSelectedSkill(): boolean {
    const { inputField } = this.opts;
    const token = this.skillToken;
    const item = this.skillItems[this.skillSelectedIndex];
    if (!token || !item) return false;

    const insertion = inputField.plainText[token.end]?.match(/\s/)
      ? `/${item.name}`
      : `/${item.name} `;
    inputField.setSelection(token.start, token.end);
    inputField.deleteSelection();
    inputField.insertText(insertion);
    this.hideSkill();
    return true;
  }

  private completeSelectedFile(): boolean {
    const { inputField } = this.opts;
    const token = this.fileToken;
    const item = this.fileItems[this.fileSelectedIndex];
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
    this.hideFile();
    return true;
  }
}
