/**
 * Earliest point where observed behavior alone proves an agent turn outgrew a direct answer or one
 * local check. This is consultation scheduling, not a work limit: it never stops a turn or caps
 * model/tool use. A semantic complexity classifier here would add another model call to every turn.
 */
const SUBSTANTIVE_AGENT_STEP_THRESHOLD = 3;

/**
 * Turn-local owner for the product's orientation and completion-review advisor checkpoints.
 * The runner reports completed parent steps, successful consultations, and executed tools; this
 * policy decides whether a checkpoint is due without changing the public protocol.
 */
export class AdvisorTurnLifecycle {
  private orientationCheckpointSent = false;
  private completionCheckpointSent = false;
  private completionCheckpointCanRearm = false;
  private completionCheckpointRearmed = false;
  private lastSuccessfulConsultStep?: number;
  private substantiveWorkSinceLastConsult = false;

  constructor(private readonly startingAssistantStep: number) {}

  /** A successful call resets the evidence boundary used to recognize a final-state review. */
  noteSuccessfulConsult(step: number): void {
    this.lastSuccessfulConsultStep = step;
    this.substantiveWorkSinceLastConsult = false;
  }

  /**
   * Non-advisor tool execution means reality changed or was checked after the last review. It
   * also re-arms a completion checkpoint that fired before the work was actually finished. An
   * executor may legitimately stop after diagnosis, consult, then continue implementing; the
   * later diff must still receive a final review. Only a checkpoint issued before any successful
   * consultation can re-arm, and it can do so once: advisor-requested verification must not
   * recursively create more mandatory reviews.
   */
  noteExecutedTools(toolNames: readonly string[]): void {
    if (toolNames.some((name) => name !== "ask_advisor")) {
      if (this.completionCheckpointSent && this.completionCheckpointCanRearm) {
        this.completionCheckpointSent = false;
        this.completionCheckpointCanRearm = false;
        this.completionCheckpointRearmed = true;
      }
      if (this.lastSuccessfulConsultStep === undefined) return;
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
   * Take the completion checkpoint unless the last successful consultation already saw all final
   * evidence. Assistant prose after that call does not make the evidence stale; another real tool
   * execution does.
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
    this.completionCheckpointCanRearm =
      !this.completionCheckpointRearmed && this.lastSuccessfulConsultStep === undefined;
    return true;
  }

  private isSubstantive(assistantStep: number): boolean {
    return assistantStep - this.startingAssistantStep >= SUBSTANTIVE_AGENT_STEP_THRESHOLD;
  }
}
