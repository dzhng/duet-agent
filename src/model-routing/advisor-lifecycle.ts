/**
 * Earliest point where observed behavior alone proves an agent turn outgrew a direct answer or one
 * local check. This is consultation scheduling, not a work limit: it never stops a turn or caps
 * model/tool use. A semantic complexity classifier here would add another model call to every turn.
 */
const SUBSTANTIVE_AGENT_STEP_THRESHOLD = 3;

/**
 * Turn-local owner for the product's orientation and completion-review advisor checkpoints.
 * The runner reports completed parent steps, successful consultations, and executed tools; this
 * policy decides whether a one-shot checkpoint is due without changing the public protocol.
 */
export class AdvisorTurnLifecycle {
  private orientationCheckpointSent = false;
  private completionCheckpointSent = false;
  private lastSuccessfulConsultStep?: number;
  private substantiveWorkSinceLastConsult = false;

  constructor(private readonly startingAssistantStep: number) {}

  /** A successful call resets the evidence boundary used to recognize a final-state review. */
  noteSuccessfulConsult(step: number): void {
    this.lastSuccessfulConsultStep = step;
    this.substantiveWorkSinceLastConsult = false;
  }

  /** Non-advisor tool execution means reality changed or was checked after the last review. */
  noteExecutedTools(toolNames: readonly string[]): void {
    if (
      this.lastSuccessfulConsultStep !== undefined &&
      toolNames.some((name) => name !== "ask_advisor")
    ) {
      this.substantiveWorkSinceLastConsult = true;
    }
  }

  /** Take the one-shot orientation checkpoint once a turn proves itself substantive. */
  takeOrientationCheckpoint(assistantStep: number): boolean {
    if (
      this.orientationCheckpointSent ||
      this.lastSuccessfulConsultStep !== undefined ||
      !this.isSubstantive(assistantStep)
    ) {
      return false;
    }
    this.orientationCheckpointSent = true;
    return true;
  }

  /**
   * Take the one-shot completion checkpoint unless the last successful consultation already saw
   * all final evidence. Assistant prose after that call does not make the evidence stale; another
   * real tool execution does.
   */
  takeCompletionCheckpoint(assistantStep: number): boolean {
    if (
      this.completionCheckpointSent ||
      !this.isSubstantive(assistantStep) ||
      (this.lastSuccessfulConsultStep !== undefined && !this.substantiveWorkSinceLastConsult)
    ) {
      return false;
    }
    this.completionCheckpointSent = true;
    return true;
  }

  private isSubstantive(assistantStep: number): boolean {
    return assistantStep - this.startingAssistantStep >= SUBSTANTIVE_AGENT_STEP_THRESHOLD;
  }
}
