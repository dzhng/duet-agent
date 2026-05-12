import type { Session } from "../session/session.js";
import type { TranscriptEntry } from "./transcript-log.js";
import type { StatusController } from "./status-controller.js";
import type { StepRenderer } from "./step-renderer.js";
import { COLORS } from "./theme.js";

export interface BootstrapInitialPromptDeps {
  session: Session;
  initialPrompt?: string;
  statusController: StatusController;
  stepRenderer: StepRenderer;
  appendBlock(label: string | null, body: string, fg: string): void;
  recordTranscriptEntry(kind: TranscriptEntry["kind"], text: string): void;
  reportError(error: unknown): void;
}

/**
 * Kicks off the first turn (when `--prompt` was supplied) or paints the
 * appropriate idle/sleep banner when no initial prompt was provided.
 *
 * A resumed sleeping session emitted its `sleep` terminal during
 * `session.hydrate()` — before any TUI subscriber attached — so we read
 * the last terminal here and surface it explicitly so the user can see
 * when the next wake will fire.
 */
export function bootstrapInitialPrompt(deps: BootstrapInitialPromptDeps): void {
  const {
    session,
    initialPrompt,
    statusController,
    stepRenderer,
    appendBlock,
    recordTranscriptEntry,
    reportError,
  } = deps;
  if (initialPrompt) {
    recordTranscriptEntry("user", initialPrompt);
    appendBlock("you:", initialPrompt, COLORS.user);
    void session.prompt({ message: initialPrompt, behavior: "follow_up" }).catch(reportError);
    statusController.markRunning();
    return;
  }
  const pending = session.getLastTerminal();
  if (pending?.type === "sleep") {
    stepRenderer.renderSleeping(pending.wakeAt);
    statusController.markIdle(pending);
  } else {
    statusController.markIdle();
  }
}
