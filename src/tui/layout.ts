import {
  BoxRenderable,
  type CliRenderer,
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
} from "@opentui/core";
import { AUTOCOMPLETE_LIMITS } from "./autocomplete.js";
import { BUILT_IN_SLASH_COMMAND_ITEMS } from "./slash-commands.js";
import { createSidebar } from "./sidebar.js";
import { COLORS, HINT_IDLE } from "./theme.js";

const SKILL_AUTOCOMPLETE_LIMIT = AUTOCOMPLETE_LIMITS.skill;
const FILE_AUTOCOMPLETE_LIMIT = AUTOCOMPLETE_LIMITS.file;
const QUESTION_OPTION_LIMIT = AUTOCOMPLETE_LIMITS.questionOption;

/**
 * Sidebar handle returned by {@link createSidebar}; exposed on
 * {@link LayoutRefs} so the turn controller can push todo / state-machine /
 * context-usage updates without re-importing the sidebar factory.
 */
type SidebarHandle = ReturnType<typeof createSidebar>;

/**
 * Renderable references for the static TUI chrome built by
 * {@link buildLayout}. Every field is mounted into `renderer.root` before
 * this object is returned, so callers only need to wire behavior (event
 * listeners, content updates, visibility flips).
 */
export interface LayoutRefs {
  /** Outer row container holding the main column and the sidebar. */
  root: BoxRenderable;
  /** Main column: transcript, status, hint, pickers, input. */
  layout: BoxRenderable;
  /** Right-side panel with todos, follow-up queue, state machine, and context usage. */
  sidebar: SidebarHandle;
  /** Sticky banner at the top of the main column that surfaces the most
   *  recent user message so it stays visible as the transcript scrolls. */
  latestUserBanner: BoxRenderable;
  /** Body text of {@link latestUserBanner}; updated by app.ts whenever a
   *  user message is recorded. */
  latestUserBannerText: TextRenderable;
  /** Scrollable transcript that pins to the bottom while the user has not manually scrolled. */
  transcript: ScrollBoxRenderable;
  /** Single-line working-status row below the transcript (spinner, elapsed, queue size). */
  status: TextRenderable;
  /** Single-line hint row showing the active keystrokes (Enter / Esc / copy). */
  hint: TextRenderable;
  /** Slash + skill autocomplete panel; toggled via `visible` from the autocomplete controller. */
  skillAutocompletePanel: BoxRenderable;
  /** Header row for the "commands" section of the slash/skill picker. */
  commandHeader: TextRenderable;
  /** Fixed pool of selectable rows for built-in slash commands. */
  commandRows: TextRenderable[];
  /** Header row for the "skills" section of the slash/skill picker. */
  skillHeader: TextRenderable;
  /** Fixed pool of selectable rows for matched skills. */
  skillRows: TextRenderable[];
  /** `@`-file picker panel; mirrors the slash panel's structure. */
  fileAutocompletePanel: BoxRenderable;
  /** Static "files" title row for the file picker. */
  fileAutocompleteTitle: TextRenderable;
  /** Fixed pool of selectable rows for matched files. */
  fileAutocompleteRows: TextRenderable[];
  /** Pending question panel; shown while the runner has questions awaiting answers. */
  questionPanel: BoxRenderable;
  /** Title row for the active question (prefix, prompt, navigation hint). */
  questionTitle: TextRenderable;
  /** Blank spacer between the question title and the option rows. */
  questionSpacer: TextRenderable;
  /** Fixed pool of selectable rows for the active question's options. */
  questionRows: TextRenderable[];
  /** Bordered row containing the prompt sigil and the input textarea. */
  inputBox: BoxRenderable;
  /** Leading "> " sigil rendered before the textarea; excluded from drag-select. */
  prompt: TextRenderable;
  /** Multi-line input textarea; focused on mount, soft-wraps long messages. */
  inputField: TextareaRenderable;
}

/**
 * Builds the static TUI chrome (containers, transcript, status / hint rows,
 * autocomplete + question panels, input box) and attaches everything to
 * `renderer.root`. The returned {@link LayoutRefs} are stable for the
 * lifetime of the renderer; callers wire behavior on top without
 * re-creating any of these nodes.
 *
 * Focus is set on `inputField` before returning so the user can type
 * immediately on mount.
 */
export function buildLayout(renderer: CliRenderer): LayoutRefs {
  // Outer row wraps the main column and a right-side sidebar that surfaces
  // the runner's current todo list and state-machine progress.
  const root = new BoxRenderable(renderer, {
    flexDirection: "row",
    width: "100%",
    height: "100%",
  });

  const layout = new BoxRenderable(renderer, {
    flexDirection: "column",
    flexGrow: 1,
    flexShrink: 1,
    height: "100%",
  });

  const sidebar = createSidebar(renderer);

  // Sticky banner that mirrors the most recent user message above the
  // transcript. Hidden until the first user message lands; app.ts sets
  // the body text whenever a user block is recorded and a short-interval
  // watcher toggles `visible` based on whether that block has scrolled
  // above the transcript viewport.
  // The banner sits directly above the transcript inside the shared
  // bordered frame below. The frame's `padding: 1` already gives it equal
  // 1-row gaps above the banner text and below the transcript content;
  // this `paddingBottom: 1` adds a matching 1-row gap between the banner
  // text and the transcript content so the banner is symmetrically inset
  // rather than glued to the scrolling area.
  const latestUserBanner = new BoxRenderable(renderer, {
    flexDirection: "column",
    paddingBottom: 1,
    flexShrink: 0,
  });
  latestUserBanner.visible = false;
  const latestUserBannerText = new TextRenderable(renderer, {
    content: "",
    fg: COLORS.user,
    wrapMode: "word",
    flexShrink: 0,
    selectable: false,
  });
  latestUserBanner.add(latestUserBannerText);

  // Shared bordered frame around the banner and the transcript so they
  // read as one main-content surface. The border/padding live here rather
  // than on the transcript so the banner inherits the same chrome.
  // `toolBlockColumns()` in step-renderer.ts assumes a 5-column transcript
  // chrome budget (2 border + 2 padding + 1 scrollbar gutter); keep this
  // wrapper's border+padding aligned with that math.
  const transcriptFrame = new BoxRenderable(renderer, {
    flexDirection: "column",
    flexGrow: 1,
    flexShrink: 1,
    border: true,
    borderColor: COLORS.border,
    padding: 1,
  });

  const transcript = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    flexShrink: 1,
    scrollY: true,
    // Pin to bottom as new lines arrive, but only while the user has not
    // manually scrolled away. ScrollBoxRenderable flips `_hasManualScroll`
    // the moment the user scrolls up, which pauses pinning until they
    // return to the bottom — without this, new output yanks the viewport
    // down while the user is reading history.
    stickyScroll: true,
    stickyStart: "bottom",
  });
  // Keep keyboard focus pinned to the composer. ScrollBoxRenderable is
  // focusable by default, so a mouse click on the transcript would steal
  // focus from the textarea and break starter-row arrow navigation, paste
  // keystroke handling, and drag-drop image attach — all of which are wired
  // up through inputField.onKeyDown / onPaste. Wheel scrolling, sticky
  // pinning, and drag-select selection do not require focus, so disabling
  // it here costs nothing.
  transcript.focusable = false;

  // Status and hint chrome are excluded from drag-select so a highlight that
  // sweeps the bottom of the screen does not pull the spinner / hint text
  // into the clipboard alongside the transcript content the user wanted.
  const status = new TextRenderable(renderer, {
    content: "",
    fg: COLORS.status,
    height: 1,
    flexShrink: 0,
    selectable: false,
  });

  const hint = new TextRenderable(renderer, {
    content: HINT_IDLE,
    fg: COLORS.hint,
    height: 1,
    flexShrink: 0,
    selectable: false,
  });

  const skillAutocompletePanel = new BoxRenderable(renderer, {
    flexDirection: "column",
    border: true,
    borderColor: COLORS.border,
    paddingLeft: 1,
    paddingRight: 1,
    flexShrink: 0,
  });
  skillAutocompletePanel.visible = false;

  // Two ordered sections: built-in commands first, skills second. Each
  // section has its own header row plus a fixed pool of item rows. Selection
  // navigates the flat ordered list of visible items across both sections.
  // Row height is assigned per render based on the wrapped description
  // length so a one-line description doesn't leave an empty trailing line
  // beneath the name. The renderer sets `height` whenever it writes
  // `content`.
  // Autocomplete and panel chrome are not part of the transcript content,
  // so exclude them from drag-select to keep the clipboard focused on
  // assistant/user messages.
  const makeItemRow = () => {
    const row = new TextRenderable(renderer, {
      content: "",
      fg: COLORS.hint,
      flexShrink: 0,
      selectable: false,
    });
    row.visible = false;
    return row;
  };
  const makeHeaderRow = (label: string) =>
    new TextRenderable(renderer, {
      content: label,
      fg: COLORS.status,
      height: 1,
      flexShrink: 0,
      selectable: false,
    });
  const commandHeader = makeHeaderRow("commands");
  const commandRows = Array.from({ length: BUILT_IN_SLASH_COMMAND_ITEMS.length }, makeItemRow);
  const skillHeader = makeHeaderRow("skills");
  const skillRows = Array.from({ length: SKILL_AUTOCOMPLETE_LIMIT }, makeItemRow);
  skillAutocompletePanel.add(commandHeader);
  for (const row of commandRows) skillAutocompletePanel.add(row);
  skillAutocompletePanel.add(skillHeader);
  for (const row of skillRows) skillAutocompletePanel.add(row);

  // The @-file picker mirrors the slash picker's structure so the renderer
  // logic and key handling can stay parallel between the two pickers.
  const fileAutocompletePanel = new BoxRenderable(renderer, {
    flexDirection: "column",
    border: true,
    borderColor: COLORS.border,
    paddingLeft: 1,
    paddingRight: 1,
    flexShrink: 0,
  });
  fileAutocompletePanel.visible = false;
  const fileAutocompleteTitle = new TextRenderable(renderer, {
    content: "files",
    fg: COLORS.status,
    height: 1,
    flexShrink: 0,
    selectable: false,
  });
  const fileAutocompleteRows = Array.from({ length: FILE_AUTOCOMPLETE_LIMIT }, () => {
    const row = new TextRenderable(renderer, {
      content: "",
      fg: COLORS.hint,
      height: 1,
      flexShrink: 0,
      selectable: false,
    });
    row.visible = false;
    return row;
  });
  fileAutocompletePanel.add(fileAutocompleteTitle);
  for (const row of fileAutocompleteRows) {
    fileAutocompletePanel.add(row);
  }

  const questionPanel = new BoxRenderable(renderer, {
    flexDirection: "column",
    border: true,
    borderColor: COLORS.border,
    paddingLeft: 1,
    paddingRight: 1,
    flexShrink: 0,
  });
  questionPanel.visible = false;

  const questionTitle = new TextRenderable(renderer, {
    content: "question",
    fg: COLORS.agent,
    wrapMode: "word",
    flexShrink: 0,
    selectable: false,
  });
  const questionSpacer = new TextRenderable(renderer, {
    content: "",
    height: 1,
    flexShrink: 0,
    selectable: false,
  });
  const questionRows = Array.from({ length: QUESTION_OPTION_LIMIT }, () => {
    const row = new TextRenderable(renderer, {
      content: "",
      fg: COLORS.hint,
      wrapMode: "word",
      flexShrink: 0,
      selectable: false,
    });
    row.visible = false;
    return row;
  });
  questionPanel.add(questionTitle);
  questionPanel.add(questionSpacer);
  for (const row of questionRows) {
    questionPanel.add(row);
  }

  const inputBox = new BoxRenderable(renderer, {
    flexDirection: "row",
    border: true,
    borderColor: COLORS.border,
    paddingLeft: 1,
    paddingRight: 1,
    flexShrink: 0,
  });

  // The leading "> " sigil is decoration, not content; excluding it from
  // selection means a drag that starts at the input row does not pull the
  // sigil into the clipboard alongside the highlighted text.
  const prompt = new TextRenderable(renderer, {
    content: "> ",
    fg: COLORS.user,
    width: 2,
    selectable: false,
  });

  // Textarea (rather than Input) so long messages soft-wrap visually. Enter
  // is intercepted in onKeyDown below to submit instead of inserting a newline.
  const inputField = new TextareaRenderable(renderer, {
    placeholder: "Type a message and press Enter…",
    flexGrow: 1,
    minHeight: 1,
    maxHeight: 10,
    wrapMode: "word",
  });

  inputBox.add(prompt);
  inputBox.add(inputField);

  transcriptFrame.add(latestUserBanner);
  transcriptFrame.add(transcript);
  layout.add(transcriptFrame);
  layout.add(status);
  layout.add(hint);
  layout.add(skillAutocompletePanel);
  layout.add(fileAutocompletePanel);
  layout.add(questionPanel);
  layout.add(inputBox);
  root.add(layout);
  root.add(sidebar.view);
  renderer.root.add(root);
  inputField.focus();

  return {
    root,
    layout,
    sidebar,
    latestUserBanner,
    latestUserBannerText,
    transcript,
    status,
    hint,
    skillAutocompletePanel,
    commandHeader,
    commandRows,
    skillHeader,
    skillRows,
    fileAutocompletePanel,
    fileAutocompleteTitle,
    fileAutocompleteRows,
    questionPanel,
    questionTitle,
    questionSpacer,
    questionRows,
    inputBox,
    prompt,
    inputField,
  };
}
