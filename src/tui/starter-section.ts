import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type CliRenderer,
  type ScrollBoxRenderable,
  TextRenderable,
  type TextareaRenderable,
} from "@opentui/core";

import { listRecentSessions } from "./recent-sessions.js";
import { orderedSelectableStarters, selectStarters } from "./starters.js";
import { COLORS } from "./theme.js";
import type { TranscriptWriter } from "./transcript-writer.js";

export interface StarterSectionOptions {
  /** Working directory used to seed cwd-aware starter prompts. */
  workDir: string;
  /** Current session id; excluded from the recent-sessions list so the
   *  "pick up the thread" rows do not advertise the live session. */
  sessionId: string;
  /** Optional resumed-conversation history fed into starter selection so
   *  the picker can surface a resume prompt synthesized from the last
   *  user turn. */
  history?: AgentMessage[];
  /** Composer renderable. The section watches `plainText.length` to decide
   *  whether to repaint the chrome on `syncVisibility`. */
  inputField: TextareaRenderable;
  /** Transcript scrollbox; each rendered starter row is appended to the
   *  scrollbox via `transcriptWriter.addLine` and removed on dismiss. */
  transcript: ScrollBoxRenderable;
  /** Transcript writer surfaces `addLine` for the rendered starter rows
   *  (so the scrollbox owns them) but the section never writes any
   *  bordered blocks. */
  transcriptWriter: TranscriptWriter;
  /** Renderer; only used to tear the TUI down when a "pick up the thread"
   *  row signals a resume to the outer dispatcher. */
  renderer: CliRenderer;
  /** Submit a typed prompt as if the user had hit Enter. Wired to
   *  `runTui`'s `submit` so non-resume starter rows kick off a real turn. */
  submit: (text: string) => void;
  /** When wired, recent-session rows route through this callback so the
   *  outer dispatcher can swap sessions; when unset (tests, playground)
   *  the section falls back to re-submitting the prior prompt. */
  onResumeRequest?: (sessionId: string) => void;
}

type StarterEntry =
  | { kind: "prompt"; label: string; submit: string }
  | { kind: "recent"; label: string; submit: string; sessionId: string };

/**
 * Boot-screen starter picker. Offers a small set of context-aware prompts
 * so first-time and returning users land on something concrete in <2
 * seconds instead of staring at a blank input.
 *
 * Lifecycle:
 *
 *   - `mount(skills)` runs once on boot and lays down the section.
 *   - `syncVisibility()` hides/restores the chrome as the composer fills
 *     and empties, until the user actually commits a prompt.
 *   - The first submit calls `destroyPermanently()` and the section
 *     never comes back this session.
 *
 * `runTui` skips construction entirely when `input.isResume` is set —
 * the user explicitly asked to drop back into a known conversation and
 * "what should we work on today?" before replaying history is noise.
 */
export class StarterSection {
  private readonly entries: StarterEntry[] = [];
  private readonly refs: TextRenderable[] = [];
  // Indexes within `refs` that correspond to numbered rows; used to
  // repaint highlight on arrow / digit navigation.
  private readonly rowIndexes: number[] = [];
  private highlightedIndex = 0;
  private visible = false;
  // Once the user commits a prompt, the chrome is gone for the session.
  // Until then `dismiss()` is a reversible hide that `syncVisibility()`
  // can restore when the composer empties again.
  private permanentlyDismissed = false;
  // Cached so the chrome can re-render the trailing "✦ N skills · /help"
  // line without re-running selectStarters.
  private skillCount = 0;

  constructor(private readonly opts: StarterSectionOptions) {}

  /**
   * Build the entry list from cwd-aware starter selection plus the recent
   * sessions on disk, then paint the chrome. Idempotent across the section
   * lifecycle in the sense that calling it again with no entries is a
   * no-op, but typical use is exactly once on boot.
   */
  mount(skills: ReadonlyArray<{ name: string }>): void {
    // Read recent sessions off disk synchronously. The helper swallows fs
    // errors and returns an empty list; a missing/empty ~/.duet/sessions
    // directory is the common first-boot case.
    const recentSessions = listRecentSessions({
      excludeId: this.opts.sessionId,
      limit: 4,
    });
    const result = selectStarters({
      cwd: this.opts.workDir,
      sessionHistory: this.opts.history,
      recentSessions,
    });
    // Selectable rows in render order. Recent sessions lead so returning
    // users hit "pick up the thread" first; new users see the cwd
    // starters under the original "what should we work on today?" header.
    const ordered = orderedSelectableStarters(result);
    this.entries.length = 0;
    for (const row of ordered) {
      if (row.kind === "recent" && row.sessionId !== undefined) {
        this.entries.push({
          kind: "recent",
          label: row.label,
          submit: row.submit,
          sessionId: row.sessionId,
        });
      } else {
        this.entries.push({ kind: "prompt", label: row.label, submit: row.submit });
      }
    }
    this.skillCount = skills.length;
    this.highlightedIndex = 0;
    this.mountChrome();
  }

  isVisible(): boolean {
    return this.visible;
  }

  move(delta: number): void {
    if (!this.visible || this.entries.length === 0) return;
    const next = (this.highlightedIndex + delta + this.entries.length) % this.entries.length;
    this.highlightedIndex = next;
    this.paintHighlight();
  }

  jump(targetIndex: number): boolean {
    if (!this.visible) return false;
    if (targetIndex < 0 || targetIndex >= this.entries.length) return false;
    this.highlightedIndex = targetIndex;
    this.paintHighlight();
    return true;
  }

  /**
   * Transient hide. Tears down the rendered refs but keeps `entries` and
   * `highlightedIndex` so `mountChrome()` can restore the exact same
   * picker if the user backspaces the composer empty again.
   */
  dismiss(): void {
    if (!this.visible && this.refs.length === 0) return;
    for (const ref of this.refs) {
      this.opts.transcript.remove(ref.id);
      ref.destroy();
    }
    this.refs.length = 0;
    this.rowIndexes.length = 0;
    this.visible = false;
  }

  /**
   * Permanent destruction: called when the user commits a prompt. After
   * this the chrome never comes back, even on backspace-to-empty.
   */
  destroyPermanently(): void {
    this.dismiss();
    this.entries.length = 0;
    this.highlightedIndex = 0;
    this.permanentlyDismissed = true;
  }

  isPermanentlyDismissed(): boolean {
    return this.permanentlyDismissed;
  }

  /**
   * Toggle hook called from `inputField.onContentChange`. Hides the chrome
   * as soon as the user starts composing, brings it back if they backspace
   * the composer empty (but only until they actually submit — then
   * `permanentlyDismissed` latches).
   */
  syncVisibility(): void {
    if (this.permanentlyDismissed) return;
    if (this.entries.length === 0) return;
    const empty = this.opts.inputField.plainText.length === 0;
    if (!empty && this.visible) {
      this.dismiss();
    } else if (empty && !this.visible) {
      this.mountChrome();
    }
  }

  submitHighlighted(): boolean {
    if (!this.visible) return false;
    const entry = this.entries[this.highlightedIndex];
    if (!entry) return false;
    this.destroyPermanently();
    // Recent-session rows: when the host wires `onResumeRequest`, signal
    // the outer dispatcher to swap sessions and tear down this renderer.
    // The dispatcher disposes the placeholder, calls `manager.resume(id)`
    // + `hydrate()` + `start()`, and re-enters `runTui` with the hydrated
    // session + its full message history. End user lands on the same
    // session id, same agent context, same transcript replayed inline.
    //
    // When no callback is wired (tests, playground), fall back to the
    // legacy shortcut: re-submit the prior prompt in the current session.
    // Agent has no context; the user lands on the same task with one
    // keystroke instead of typing it again.
    if (entry.kind === "recent" && this.opts.onResumeRequest) {
      this.opts.onResumeRequest(entry.sessionId);
      this.opts.renderer.destroy();
      return true;
    }
    this.opts.submit(entry.submit);
    return true;
  }

  // Paint the chrome (section headers, numbered rows, hint footer) from
  // the current `entries` + `highlightedIndex`. Called on first boot and
  // on every backspace-to-empty restoration. Idempotent: bails if the
  // chrome is already mounted or no entries exist.
  private mountChrome(): void {
    if (this.visible || this.entries.length === 0) return;

    const recentEntries = this.entries.filter((entry) => entry.kind === "recent");
    const promptEntries = this.entries.filter((entry) => entry.kind === "prompt");
    const hasRecent = recentEntries.length > 0;

    // Every line we render here — spacers included — goes through
    // `addLine` and gets pushed to `refs`. `dismiss()` iterates that list
    // to destroy refs; spacers added via fire-and-forget `appendLine`
    // would leak and accumulate above the next mount on each type →
    // backspace cycle, pushing the chrome lower every time.
    const spacer = (): void => {
      this.refs.push(this.addLine(" ", COLORS.hint));
    };

    this.rowIndexes.length = 0;
    spacer();

    if (hasRecent) {
      this.refs.push(this.addLine("pick up the thread", COLORS.agent));
      spacer();
      for (let i = 0; i < this.entries.length; i += 1) {
        if (this.entries[i]!.kind !== "recent") continue;
        const ref = this.addLine(this.formatRow(i, false), COLORS.hint);
        this.rowIndexes.push(this.refs.length);
        this.refs.push(ref);
      }
      if (promptEntries.length > 0) {
        spacer();
        this.refs.push(this.addLine("or start something new", COLORS.agent));
        spacer();
        for (let i = 0; i < this.entries.length; i += 1) {
          if (this.entries[i]!.kind !== "prompt") continue;
          const ref = this.addLine(this.formatRow(i, false), COLORS.hint);
          this.rowIndexes.push(this.refs.length);
          this.refs.push(ref);
        }
      }
    } else {
      this.refs.push(this.addLine("what should we work on today?", COLORS.agent));
      spacer();
      for (let i = 0; i < this.entries.length; i += 1) {
        const ref = this.addLine(this.formatRow(i, false), COLORS.hint);
        this.rowIndexes.push(this.refs.length);
        this.refs.push(ref);
      }
    }

    spacer();
    this.refs.push(
      this.addLine("type a number to run, ↑/↓ to highlight, or just start typing.", COLORS.hint),
    );
    this.refs.push(
      this.addLine(
        `✦ ${this.skillCount} skill${this.skillCount === 1 ? "" : "s"} · /help`,
        COLORS.hint,
      ),
    );

    this.visible = true;
    if (this.highlightedIndex >= this.entries.length) this.highlightedIndex = 0;
    this.paintHighlight();
  }

  private addLine(content: string, fg: string): TextRenderable {
    return this.opts.transcriptWriter.addLine(content, fg);
  }

  private formatRow(index: number, highlighted: boolean): string {
    const entry = this.entries[index];
    const text = entry?.label ?? "";
    const number = index + 1;
    const arrow = highlighted ? "▶" : "→";
    const numberCell = highlighted ? `[${number}]` : ` ${number} `;
    return `   ${numberCell}  ${arrow}  ${text}`;
  }

  private paintHighlight(): void {
    for (let i = 0; i < this.rowIndexes.length; i += 1) {
      const ref = this.refs[this.rowIndexes[i]!]!;
      const isHighlighted = i === this.highlightedIndex;
      ref.content = this.formatRow(i, isHighlighted);
      ref.fg = isHighlighted ? COLORS.user : COLORS.hint;
    }
  }
}
