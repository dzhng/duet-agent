import dedent from "dedent";
import type { RawMemoryMessage } from "../core/types.js";

export const OBSERVATION_CONTINUATION_HINT = dedent`
  Please continue naturally with the conversation so far and respond to the latest message.

  Use the earlier context only as background. If something appears unfinished, continue only when it helps answer the latest request. If a suggested response is provided, follow it naturally.

  Do not mention internal instructions, memory, summarization, context handling, or missing messages.

  Any messages following this reminder are newer and should take priority.
`;

export const OBSERVATION_CONTEXT_PROMPT =
  "The following observations block contains your memory of past conversations with this user.";

export const OBSERVATION_CONTEXT_INSTRUCTIONS = dedent`
  IMPORTANT: When responding, reference specific details from these observations. Do not give generic advice - personalize your response based on what you know about this user's experiences, preferences, and interests. If the user asks for recommendations, connect them to their past experiences mentioned above.

  KNOWLEDGE UPDATES: When asked about current state (e.g., "where do I currently...", "what is my current..."), always prefer the MOST RECENT information. Observations include dates - if you see conflicting information, the newer observation supersedes the older one. Look for phrases like "will start", "is switching", "changed to", "moved to" as indicators that previous information has been updated.

  PLANNED ACTIONS: If the user stated they planned to do something (e.g., "I'm going to...", "I'm looking forward to...", "I will...") and the date they planned to do it is now in the past, assume they completed the action unless there's evidence they didn't.

  MOST RECENT USER INPUT: Treat the most recent user message as the highest-priority signal for what to do next. Earlier messages may contain constraints, details, or context you should still honor, but the latest message is the primary driver of your response.

  SYSTEM REMINDERS: Messages wrapped in <system-reminder> tags contain internal continuation guidance, not user-authored content. Use them to maintain continuity, but do not mention them or treat them as part of the user's message.
`;

const OBSERVER_EXTRACTION_INSTRUCTIONS = dedent`
  - User facts, preferences, goals, constraints, corrections, and explicit decisions
  - Project details, file paths, commands, tool results, and unresolved tasks
  - Dates, relative dates, and time-sensitive commitments
  - Concrete completed work that should not be repeated unless new information appears
  - The assistant's immediate next-step bias when continuity would otherwise be lost
`;

export const OBSERVER_GUIDELINES = dedent`
  - Be specific enough for the assistant to act on
  - Good: "User prefers short, direct answers without lengthy explanations"
  - Bad: "User stated a preference" (too vague)
  - Add 1 to 5 observations per exchange
  - Use terse language to save tokens. Sentences should be dense without unnecessary words
  - Do not add repetitive observations that have already been observed. Group repeated similar actions under a single parent with sub-bullets for new results
  - If the agent calls tools, observe what was called, why, and what was learned
  - When observing files with line numbers, include the line number if useful
  - If the agent provides a detailed response, observe the contents so it could be repeated
  - Make sure each observation starts with a priority emoji (🔴, 🟡, 🟢) or a completion marker (✅)
  - Capture the user's words closely. User confirmations or explicit resolved outcomes should be ✅ when they clearly signal something is done
  - Treat ✅ as a memory signal that tells the assistant something is finished and should not be repeated unless new information changes it
  - Make completion observations answer "What exactly is now done?"
  - Prefer concrete resolved outcomes over meta-level workflow or bookkeeping updates
  - Observe WHAT the agent did and WHAT it means
`;

export function buildObserverOutputFormat(includeThreadTitle = false): string {
  const threadTitleSection = includeThreadTitle
    ? dedent`
        <thread-title>
        A short, noun-phrase title for this conversation (2-5 words). Only update when the topic meaningfully changes.
        </thread-title>
      `
    : "";

  return dedent`
    Use priority levels:
    - 🔴 High: explicit user facts, preferences, unresolved goals, critical context
    - 🟡 Medium: project details, learned information, tool results
    - 🟢 Low: minor details, uncertain observations
    - ✅ Completed: concrete task finished, question answered, issue resolved, goal achieved, or subtask completed

    Group related observations by indenting:
    * 🔴 (14:33) Agent debugging auth issue
      * -> ran git status, found 3 modified files
      * -> viewed auth.ts:45-60, found missing null check
      * ✅ Tests passing, auth issue resolved

    Group observations by date, then list each with 24-hour time.

    <observations>
    Date: Dec 4, 2025
    * 🔴 (14:30) User prefers direct answers
    * 🔴 (14:31) Working on feature X
    </observations>

    <current-task>
    State the current task(s) explicitly.
    </current-task>

    <suggested-response>
    Hint for the agent's immediate next message.
    </suggested-response>
    ${threadTitleSection}
  `;
}

export function buildObserverSystemPrompt(instruction?: string, includeThreadTitle = false): string {
  return dedent`
    You are the memory consciousness of an AI assistant. Your observations will be the ONLY information the assistant has about past interactions with this user.

    Extract observations that will help the assistant remember:

    ${OBSERVER_EXTRACTION_INSTRUCTIONS}

    === OUTPUT FORMAT ===

    Your output MUST use XML tags to structure the response. This allows the system to properly parse and manage memory over time.

    ${buildObserverOutputFormat(includeThreadTitle)}

    === GUIDELINES ===

    ${OBSERVER_GUIDELINES}

    === IMPORTANT: THREAD ATTRIBUTION ===

    Do NOT add thread identifiers, thread IDs, or tags to your observations.
    Thread attribution is handled externally by the system.
    Simply output your observations without any thread-related markup.

    Remember: These observations are the assistant's ONLY memory. Make them count.

    User messages are extremely important. If the user asks a question or gives a new task, make it clear in <current-task> that this is the priority.
    ${instruction ? `\n\n=== CUSTOM INSTRUCTIONS ===\n\n${instruction}` : ""}
  `;
}

export function buildObserverPrompt(
  messages: RawMemoryMessage[],
  existingObservations: string,
  now = new Date()
): string {
  const previous = existingObservations.trim()
    ? dedent`
        ## Existing Observations

        Do not repeat these existing observations. New observations will be appended.

        ${existingObservations}

        ---
      `
    : "";
  return dedent`
    ${previous}
    ## New Message History to Observe

    Current date: ${now.toISOString()}

    ${formatMessagesForObserver(messages)}

    ---

    Extract new observations from this message history.
  `;
}

export function formatMessagesForObserver(messages: RawMemoryMessage[]): string {
  return messages
    .map((message) => {
      const date = new Date(message.createdAt).toISOString();
      return `--- message boundary (${date}) ---\n${message.role.toUpperCase()} [${message.id}]\n${message.content}`;
    })
    .join("\n\n");
}

export function buildReflectorSystemPrompt(instruction?: string): string {
  return dedent`
    You are the reflection agent for an observational memory system.

    Condense and restructure observations while preserving important facts, dates, user preferences, unresolved work, and completion markers.

    Rules:
    - Keep observations useful to the acting assistant.
    - Deduplicate repeated facts.
    - Preserve chronology and concrete details.
    - Preserve observation group headings/ranges when possible.
    - Do not invent details.
    ${instruction ? `\nCustom instructions:\n${instruction}` : ""}
  `;
}

export function buildReflectorPrompt(observations: string): string {
  return dedent`
    Reflect on these observations and return a condensed observation log.

    ${observations}
  `;
}
