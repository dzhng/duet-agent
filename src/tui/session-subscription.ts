import type { BoxRenderable, TextRenderable } from "@opentui/core";
import type { Session } from "../session/session.js";
import type { TurnEvent, TurnFollowUpQueueEntry, TurnPromptImage } from "../types/protocol.js";
import type { QuestionPicker } from "./question-picker.js";
import type { Sidebar } from "./sidebar.js";
import type { StatusController } from "./status-controller.js";
import type { StepRenderer } from "./step-renderer.js";
import { COLORS } from "./theme.js";

/**
 * Maximum entry rows rendered in the follow-up panel body. When the queue
 * exceeds this, the last visible row collapses to a `+N more` summary so
 * the panel never grows past its `maxHeight` in layout.ts.
 */
const FOLLOW_UP_MAX_VISIBLE = 3;

export interface FollowUpPopSuppression {
  pending: TurnFollowUpQueueEntry[];
}

export interface SessionSubscriptionDeps {
  session: Session;
  sidebar: Sidebar;
  /** Compose-row-adjacent follow-up panel; hidden when the queue is empty. */
  followUpPanel: BoxRenderable;
  /** Body of {@link followUpPanel}; rewritten on every queue change. */
  followUpPanelBody: TextRenderable;
  stepRenderer: StepRenderer;
  statusController: StatusController;
  questionPicker: QuestionPicker;
  appendLine(content: string, fg: string): void;
  appendBlock(label: string | null, body: string, fg: string): void;
  /**
   * Render a `you:` block for a follow-up that the runner just delivered.
   * dispatchTurn suppresses the user block at queue time when a turn is
   * already running; this callback fires it later when the queue shrinks.
   */
  appendUserBlock(message: string): void;
  /**
   * Entries lifted out of the queue by a Ctrl+C pop. When a removed entry
   * matches one of these, it is dropped silently rather than rendered as a
   * delivered `you:` block. Optional so non-TUI callers (tests) can omit it.
   */
  popSuppression?: FollowUpPopSuppression;
}

/**
 * Re-paints the sidebar from the session's current state snapshot. Used both
 * inside the event subscription and after the initial boot screen renders.
 */
export function refreshSidebarFromSession(deps: { session: Session; sidebar: Sidebar }): void {
  const { session, sidebar } = deps;
  const state = session.getState();
  sidebar.setTodos(state?.todos ?? []);
  sidebar.setStateMachine(state?.stateMachine);
  const snap = session.getLastUsage();
  sidebar.setUsage(
    snap
      ? {
          type: "usage",
          turnUsage: snap.turnUsage,
          usageByModel: snap.usageByModel,
          lastMessageUsage: snap.lastMessageUsage,
          effectiveContextWindow: snap.effectiveContextWindow,
          contextWindowUsage: snap.contextWindowUsage,
        }
      : undefined,
  );
  sidebar.setSessionCost(session.getSessionCostUsd());
}

/**
 * Subscribes the chrome (transcript, sidebar, status, question picker) to the
 * session's event stream and returns the unsubscribe handle. Every event the
 * runner emits funnels through this one router so the visual layer stays a
 * thin projection of the session state.
 */
export function bindSessionToUi(deps: SessionSubscriptionDeps): () => void {
  const {
    session,
    sidebar,
    followUpPanel,
    followUpPanelBody,
    stepRenderer,
    statusController,
    questionPicker,
    appendLine,
    appendBlock,
    appendUserBlock,
    popSuppression,
  } = deps;
  const refreshSidebar = () => refreshSidebarFromSession({ session, sidebar });

  // Seed the queue snapshot from the session's hydrated state so a resumed
  // session that already has persisted follow-ups does not falsely treat
  // them as "delivered" the moment the first event arrives.
  let previousQueue: TurnFollowUpQueueEntry[] = [...(session.getState()?.followUpQueue ?? [])];
  renderFollowUpPanel(previousQueue, followUpPanel, followUpPanelBody);

  return session.subscribe((event: TurnEvent) => {
    refreshSidebar();
    if (event.type === "step") {
      stepRenderer.renderStep(event.step);
    } else if (event.type === "follow_up_queue") {
      const next = event.followUpQueue;
      for (const delivered of diffRemovedEntries(previousQueue, next)) {
        if (consumeSuppressedPop(popSuppression, delivered)) continue;
        appendUserBlock(delivered.message);
        if (delivered.images?.length) {
          appendBlock(
            null,
            `📎 ${delivered.images.length} image attachment${delivered.images.length === 1 ? "" : "s"}`,
            COLORS.hint,
          );
        }
      }
      previousQueue = [...next];
      renderFollowUpPanel(next, followUpPanel, followUpPanelBody);
      statusController.setQueuedFollowUps(next.length);
    } else if (event.type === "memory") {
      stepRenderer.renderMemoryStatus(event);
    } else if (event.type === "system") {
      appendBlock("[system]", event.message, COLORS.system);
      if (event.level === "error") statusController.markIdle();
    } else if (event.type === "ask") {
      appendBlock("[question]", event.questions.map((q) => q.question).join("\n"), COLORS.system);
      questionPicker.show(event.questions);
      stepRenderer.renderUsage(event.turnUsage);
      stepRenderer.renderTurnElapsed();
      statusController.markIdle(event);
    } else if (event.type === "complete") {
      if (event.error) {
        appendBlock("[error]", event.error, COLORS.error);
      }
      stepRenderer.renderUsage(event.turnUsage);
      stepRenderer.renderTurnElapsed();
      statusController.markIdle(event);
    } else if (event.type === "interrupted") {
      appendLine("[interrupted]", COLORS.system);
      stepRenderer.renderUsage(event.turnUsage);
      stepRenderer.renderTurnElapsed();
      statusController.markIdle(event);
    } else if (event.type === "sleep") {
      stepRenderer.renderUsage(event.turnUsage);
      stepRenderer.renderSleeping(event.wakeAt);
      statusController.markIdle(event);
    }
  });
}

/**
 * Project the runner's follow-up queue onto the compose-row panel. Entries
 * are formatted as `"N. <message>"` with an `📎N` suffix when the entry
 * carries image attachments, and the panel hides itself entirely when the
 * queue is empty so the compose row stays flush with the transcript.
 */
function renderFollowUpPanel(
  entries: readonly TurnFollowUpQueueEntry[],
  panel: BoxRenderable,
  body: TextRenderable,
): void {
  if (entries.length === 0) {
    panel.visible = false;
    body.content = "";
    return;
  }
  const showSummary = entries.length > FOLLOW_UP_MAX_VISIBLE;
  const visibleCount = showSummary ? FOLLOW_UP_MAX_VISIBLE - 1 : entries.length;
  const lines = entries.slice(0, visibleCount).map((entry, index) => {
    const attachments = entry.images?.length ? ` 📎${entry.images.length}` : "";
    return `${index + 1}. ${entry.message}${attachments}`.replace(/\s+/g, " ").trim();
  });
  if (showSummary) {
    lines.push(`+${entries.length - visibleCount} more`);
  }
  body.content = lines.join("\n");
  panel.visible = true;
}

function consumeSuppressedPop(
  suppression: FollowUpPopSuppression | undefined,
  removed: TurnFollowUpQueueEntry,
): boolean {
  if (!suppression) return false;
  const index = suppression.pending.findIndex((entry) => sameFollowUpEntry(entry, removed));
  if (index === -1) return false;
  suppression.pending.splice(index, 1);
  return true;
}

function sameFollowUpEntry(a: TurnFollowUpQueueEntry, b: TurnFollowUpQueueEntry): boolean {
  return a.message === b.message && sameImages(a.images, b.images);
}

function sameImages(
  a: readonly TurnPromptImage[] | undefined,
  b: readonly TurnPromptImage[] | undefined,
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every(
    (image, index) =>
      image.data === right[index]?.data && image.mimeType === right[index]?.mimeType,
  );
}

/**
 * Returns the entries that were in `prev` but are no longer in `next` so
 * delivered follow-ups render exactly once, including duplicate text with
 * different attachments.
 */
function diffRemovedEntries(
  prev: readonly TurnFollowUpQueueEntry[],
  next: readonly TurnFollowUpQueueEntry[],
): TurnFollowUpQueueEntry[] {
  const remaining = [...next];
  const removed: TurnFollowUpQueueEntry[] = [];
  for (const entry of prev) {
    const index = remaining.findIndex((candidate) => sameFollowUpEntry(entry, candidate));
    if (index === -1) {
      removed.push(entry);
    } else {
      remaining.splice(index, 1);
    }
  }
  return removed;
}
