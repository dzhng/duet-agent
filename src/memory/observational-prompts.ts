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
  CRITICAL: DISTINGUISH USER ASSERTIONS FROM QUESTIONS

  When the user tells you something about themselves, their work, or their environment, treat it as an assertion:
  - "I have two kids" -> "User stated they have two kids"
  - "I work at Acme Corp" -> "User stated they work at Acme Corp"

  When the user asks for help, preserve that as a question or request:
  - "Can you help me with X?" -> "User asked for help with X"
  - "What's the best way to do Y?" -> "User asked for the best way to do Y"

  Distinguish questions from statements of intent:
  - "Can you recommend..." -> question/request
  - "I'm looking forward to..." -> statement of intent
  - "I need to..." -> stated need or goal

  STATE CHANGES AND UPDATES

  When the user indicates a change, frame it as a current state that supersedes older information:
  - "I'm switching from A to B" -> "User is switching from A to B"
  - "I'm going to start doing X instead of Y" -> "User will start doing X (changing from Y)"
  - If new information contradicts older observations, explicitly say it replaces the older state.

  TEMPORAL ANCHORING

  Every observation already has the message time at the beginning. Only add a date at the end when the content references a different concrete time:
  - Add "(meaning DATE)" or "(estimated DATE)" for relative dates like "tomorrow", "last week", "this weekend", or "next month".
  - Do not add end dates for vague references like "recently", "soon", "lately", or "a while ago".
  - Split observations that contain multiple time-sensitive events so each event can carry its own date.

  PRESERVE SPECIFICS

  Capture user facts, preferences, goals, constraints, corrections, explicit decisions, project details, file paths, commands, tool results, unresolved tasks, and completed work.
  Preserve unusual phrasing in quotes when the user's exact wording matters.
  Preserve names, handles, identifiers, quantities, counts, measurements, statistics, roles, and distinguishing attributes.
  For assistant-generated recommendations, summaries, code, or explanations that the user may ask about later, retain the details that make the output reconstructable.
  Capture the assistant's immediate next-step bias when continuity would otherwise be lost.
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
  - Capture short and medium user messages nearly verbatim; summarize long messages but keep key quotes that carry intent
  - User confirmations or explicit resolved outcomes should be ✅ when they clearly signal something is done; unresolved or critical user facts remain 🔴
  - Treat ✅ as a memory signal that tells the assistant something is finished and should not be repeated unless new information changes it
  - Make completion observations answer "What exactly is now done?"
  - Prefer concrete resolved outcomes over meta-level workflow or bookkeeping updates
  - When multiple concrete things were completed, capture them concretely rather than collapsing them into vague progress
  - Observe WHAT the agent did and WHAT it means
  - If the user provides detailed messages, code snippets, or exact text they are iterating on, preserve all important details
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
    - 🔴 High: explicit user assertions, facts, preferences, requests, unresolved goals, critical context
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
    State the current task(s) explicitly:
    - Primary: what the agent is currently working on
    - Secondary: other pending tasks, marked "waiting for user" when appropriate
    - If the agent started doing something without user approval, note that it is off-task
    </current-task>

    <suggested-response>
    Hint for the agent's immediate next message. If the assistant needs to respond to the user, say that it should pause for user reply before continuing other tasks.
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
