import type { StepTriggerConfig } from "./table.js";
import { stripSyntheticUserMessages } from "../lib/synthetic-user-message.js";

/** Pi-free summary of one completed assistant step and its tool-result output. */
export interface StepObservation {
  /** Content-block type names observed across the assistant message and tool results. */
  blockTypes: readonly string[];
  /** Caller-bounded concatenation of assistant and tool-result text blocks. */
  text: string;
}

/** Sticky turn-scoped facts used by correctness routing policy. */
export interface TurnFacts {
  /** Whether any prompt attachment or step output in this user turn contains an image. */
  hasImages: boolean;
}

/** Routing consequences contributed by one built-in or configured trigger. */
export interface TriggerEffect {
  /** Requests classification at the next model boundary. */
  classify: boolean;
  /** Sticky facts learned from the observed step. */
  facts?: Partial<TurnFacts>;
}

/**
 * Evaluate correctness and administrator-authored taste triggers for one step.
 * Configured keywords use case-insensitive substring matching so tokens and phrases
 * behave identically without imposing identifier or punctuation boundaries.
 */
export function evaluateStepTriggers(
  observation: StepObservation,
  configTriggers: readonly StepTriggerConfig[] | undefined,
): TriggerEffect[] {
  const effects: TriggerEffect[] = [];
  if (observation.blockTypes.includes("image")) {
    effects.push({ classify: true, facts: { hasImages: true } });
  }

  const normalizedText = stripSyntheticUserMessages(observation.text).toLocaleLowerCase();
  for (const trigger of configTriggers ?? []) {
    if (trigger.keywords.some((keyword) => normalizedText.includes(keyword.toLocaleLowerCase()))) {
      effects.push({ classify: true });
    }
  }
  return effects;
}
