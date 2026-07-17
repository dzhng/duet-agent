import {
  estimateTokens,
  serializeMessageForObserver,
  trimMessagesToTranscriptBudget,
} from "../memory/observational.js";

/**
 * Text projection produced by {@link serializeMessageForObserver}. The future
 * advisor tool can pass that projection directly after serializing the
 * `AgentMessage` values in `agent.state.messages`.
 */
export type SerializedAdvisorMessage = ReturnType<typeof serializeMessageForObserver>;

/** Inputs needed to assemble advisor context without runtime or persistence dependencies. */
export interface BuildAdvisorTranscriptInput {
  /** Serialized first user turn, pinned ahead of every lower-priority section. */
  firstUserMessage: SerializedAdvisorMessage;
  /** Fully resolved executor prompt; rendered as quoted transcript content, not instructions. */
  executorSystemPrompt: string;
  /** Chronological `Observation.content` values from `readSessionObservations`. */
  observations: readonly string[];
  /** Serialized recent messages in oldest-to-newest order. */
  tailMessages: readonly SerializedAdvisorMessage[];
  /** Maximum estimated tokens allowed in the returned text. */
  budgetTokens: number;
}

/** A budgeted advisor payload and the memory system's estimate for that exact text. */
export interface AdvisorTranscript {
  /** Curated transcript to send as advisor-call content. */
  text: string;
  /** Heuristic token estimate for `text`, using the memory system's estimator. */
  tokens: number;
  /** True when any source content was omitted or shortened to meet the budget. */
  truncated: boolean;
}

const FIRST_USER_HEADING = "## Pinned first user message";
const SYSTEM_PROMPT_HEADING = "## Executor system prompt (quoted content)";
const OBSERVATIONS_HEADING = "## Observations";
const TAIL_HEADING = "## Recent transcript";

/**
 * Assemble the executor context in descending retention priority. Higher-priority
 * prose consumes the budget first; recent messages are retained newest-first at
 * whole-message boundaries.
 */
export function buildAdvisorTranscript(input: BuildAdvisorTranscriptInput): AdvisorTranscript {
  const budgetTokens = normalizeBudget(input.budgetTokens);
  let text = "";
  let truncated = false;

  ({ text, truncated } = appendPriorityContent(
    text,
    `${FIRST_USER_HEADING}\n\n${input.firstUserMessage.textPreview}`,
    budgetTokens,
    truncated,
  ));

  const quotedSystemPrompt = quoteAsContent(input.executorSystemPrompt);
  ({ text, truncated } = appendPriorityContent(
    text,
    `${SYSTEM_PROMPT_HEADING}\n\nThe executor is operating under this system prompt:\n\n${quotedSystemPrompt}`,
    budgetTokens,
    truncated,
  ));

  if (input.observations.length > 0) {
    const observations = input.observations
      .map((observation, index) => `[Observation ${index + 1}]\n${observation}`)
      .join("\n\n");
    ({ text, truncated } = appendPriorityContent(
      text,
      `${OBSERVATIONS_HEADING}\n\n${observations}`,
      budgetTokens,
      truncated,
    ));
  }

  if (estimateTokens(text) < budgetTokens && !truncated) {
    const tail = withoutPinnedDuplicate(input.tailMessages, input.firstUserMessage);
    const tailResult = buildTailSection(text, tail, budgetTokens);
    text = tailResult.text;
    truncated = tailResult.truncated;
  } else if (input.tailMessages.length > 0) {
    truncated = true;
  }

  return { text, tokens: estimateTokens(text), truncated };
}

function normalizeBudget(budgetTokens: number): number {
  if (!Number.isFinite(budgetTokens)) return 0;
  return Math.max(0, Math.floor(budgetTokens));
}

function quoteAsContent(prompt: string): string {
  return prompt
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function appendPriorityContent(
  existing: string,
  content: string,
  budgetTokens: number,
  alreadyTruncated: boolean,
): { text: string; truncated: boolean } {
  if (alreadyTruncated) return { text: existing, truncated: true };
  const separator = existing.length > 0 ? "\n\n" : "";
  const candidate = `${existing}${separator}${content}`;
  if (estimateTokens(candidate) <= budgetTokens) {
    return { text: candidate, truncated: false };
  }

  let low = 0;
  let high = content.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (estimateTokens(`${existing}${separator}${content.slice(0, midpoint)}`) <= budgetTokens) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }
  return { text: `${existing}${separator}${content.slice(0, low)}`, truncated: true };
}

function withoutPinnedDuplicate(
  tailMessages: readonly SerializedAdvisorMessage[],
  firstUserMessage: SerializedAdvisorMessage,
): SerializedAdvisorMessage[] {
  const duplicateIndex = tailMessages.findIndex(
    (message) => message.textPreview === firstUserMessage.textPreview,
  );
  return tailMessages.filter((_message, index) => index !== duplicateIndex);
}

function buildTailSection(
  existing: string,
  tailMessages: readonly SerializedAdvisorMessage[],
  budgetTokens: number,
): { text: string; truncated: boolean } {
  if (tailMessages.length === 0) return { text: existing, truncated: false };

  const remainingTokens = Math.max(0, budgetTokens - estimateTokens(existing));
  const rawMessages = tailMessages.map((message, index) => ({
    id: String(index),
    createdAt: index,
    role: "assistant" as const,
    content: [{ type: "text" as const, text: message.textPreview }],
    textPreview: message.textPreview,
    estimatedTokens: estimateTokens(message.textPreview),
  }));
  const trimmed = trimMessagesToTranscriptBudget(rawMessages, remainingTokens);
  let kept = trimmed.filter((message) => {
    const source = rawMessages[Number(message.id)];
    return source?.textPreview === message.textPreview;
  });

  while (true) {
    const elidedCount = tailMessages.length - kept.length;
    const elision =
      elidedCount > 0 ? `[earlier transcript elided: ${elidedCount} messages]\n\n` : "";
    const body = kept.map((message) => message.textPreview).join("\n\n");
    const section = `${TAIL_HEADING}\n\n${elision}${body}`.trimEnd();
    const candidate = `${existing}\n\n${section}`;
    if (estimateTokens(candidate) <= budgetTokens) {
      return { text: candidate, truncated: elidedCount > 0 };
    }
    if (kept.length === 0) {
      return appendPriorityContent(existing, section, budgetTokens, false);
    }
    kept = kept.slice(1);
  }
}
