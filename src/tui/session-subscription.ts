import type { Session } from "../session/session.js";
import type { TurnEvent } from "../types/protocol.js";
import type { QuestionPicker } from "./question-picker.js";
import type { Sidebar } from "./sidebar.js";
import type { StatusController } from "./status-controller.js";
import type { StepRenderer } from "./step-renderer.js";
import { COLORS } from "./theme.js";

export interface SessionSubscriptionDeps {
  session: Session;
  sidebar: Sidebar;
  stepRenderer: StepRenderer;
  statusController: StatusController;
  questionPicker: QuestionPicker;
  appendLine(content: string, fg: string): void;
  appendBlock(label: string | null, body: string, fg: string): void;
}

/**
 * Re-paints the sidebar from the session's current state snapshot. Used both
 * inside the event subscription and after the initial boot screen renders.
 */
export function refreshSidebarFromSession(deps: { session: Session; sidebar: Sidebar }): void {
  const { session, sidebar } = deps;
  const state = session.getState();
  sidebar.setTodos(state?.todos ?? []);
  sidebar.setFollowUpQueue(state?.followUpQueue ?? []);
  sidebar.setStateMachine(state?.stateMachine);
  const snap = session.getLastUsage();
  sidebar.setUsage(
    snap
      ? {
          type: "usage",
          turnUsage: snap.turnUsage,
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
    stepRenderer,
    statusController,
    questionPicker,
    appendLine,
    appendBlock,
  } = deps;
  const refreshSidebar = () => refreshSidebarFromSession({ session, sidebar });
  return session.subscribe((event: TurnEvent) => {
    refreshSidebar();
    if (event.type === "step") {
      stepRenderer.renderStep(event.step);
    } else if (event.type === "follow_up_queue") {
      // Mirror the count into the working-status line so the user can see
      // queued prompts at a glance without scrolling the sidebar.
      statusController.setQueuedFollowUps(event.prompts.length);
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
