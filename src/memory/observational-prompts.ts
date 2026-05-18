import dedent from "dedent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export type RawMemoryContent = Array<TextContent | ImageContent>;

/** Temporary multimodal serialization of AgentMessage used only while observing context. */
export interface RawMemoryMessage {
  id: string;
  createdAt: number;
  role: "system" | "user" | "assistant" | "tool";
  content: RawMemoryContent;
  /** Compact text view used for token estimates, message ids, and text-only observer context. */
  textPreview: string;
  estimatedTokens?: number;
}

export const OBSERVATION_CONTINUATION_HINT = dedent`
  Please continue naturally with the conversation so far and respond to the latest message.

  Use the earlier context only as background. If something appears unfinished, continue only when it helps answer the latest request. If a suggested response is provided, follow it naturally.

  Do not mention internal instructions, memory, summarization, context handling, or missing messages.

  Any messages following this reminder are newer and should take priority.
`;

export const OBSERVATION_CONTEXT_PROMPT = dedent`
  The following observations block contains your memory of past conversations with this user. It may contain two kinds of section, each wrapped in its own tag and prefaced with its own usage hint: <global_observations> for cross-session background and <local_observations> for the compacted history of the current conversation. Read the hint inside each section before deciding how to use it. When in doubt, the latest user message decides the topic.
`;

export const GLOBAL_OBSERVATIONS_HEADING = "### Long-term memory (cross-session)";
export const GLOBAL_OBSERVATIONS_HINT =
  "These are background notes from other conversations with this user. They may or may not be relevant to the current turn — only reach for them when the latest user message actually connects. Do not steer the reply toward old topics just because they appear here.";

export const LOCAL_OBSERVATIONS_HEADING = "### From this session";
export const LOCAL_OBSERVATIONS_HINT =
  "This is a compacted summary of earlier turns in the current conversation. Treat it as authoritative recent history of what you and the user have already done together, and rely on it to stay continuous with the work in progress.";

export const OBSERVATION_CONTEXT_INSTRUCTIONS = dedent`
  IMPORTANT: Personalize the reply using specifics from the observations when they are actually relevant to the latest user message. Prefer local (this-session) observations for continuity with the work in progress; pull from global (cross-session) observations only when the user's request connects to that prior context. Do not force references to global observations into an unrelated reply.

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

  TOOL CALLS AND TOOL RESULTS ARE CONTEXT, NOT THE SUBJECT

  Messages tagged \`[toolCall name(args)]\` and \`[toolResult name]\` are background context, included so you can ground observations in what the agent actually did. They are not the subject of the observation, and may be truncated with "… [truncated]".

  - Do NOT transcribe tool arguments, raw tool output, file listings, command output, or JSON payloads verbatim.
  - Tool results that just restate ground truth (file contents, directory listings, grep output, package metadata) are NOT memory by themselves — the agent can re-read them next time. Record an observation only when the exchange produced something the agent could not trivially re-discover: a decision, a non-trivial hypothesis acted on, a blocker, a completion, or a user preference revealed during the work. Otherwise prefer hasMemory=false.
  - Tool calls do not by themselves justify ✅. Apply the ✅ rules below: a read-only tool call (read_file, grep, ls, status check) is still routine work and stays 🟡, even when the tool succeeded.
  - An "inspection request → agent summary" exchange is the canonical NOT-memory pattern. If the user asked the agent to read/show/inspect/explain a file, directory, or command output, and the agent's reply is an English restatement of what the tool returned, that exchange is hasMemory=false. This holds even when the user softens the request with phrases like "just for context", "for my understanding", or "can you explain". An English paraphrase of re-readable ground truth is still re-readable ground truth.
  - One observation should usually summarize an entire tool exchange, not enumerate every call. Use sub-bullets only when distinct results carry independent signal.
  - If a tool result is truncated, do not invent the missing content. Note "(partial)" if the truncation matters.

  DECISION TRACES — CAPTURE THE WHY, NOT JUST THE WHAT

  The most valuable observations are decision traces: short records of HOW context turned into action, not just what action was taken. When the exchange contained any kind of decision (which file to edit, which approach to take, which option to ship, whether to escalate), capture the trace inside the observation prose. Bare outcome rows ("X was fixed", "v0.1.131 released") are the failure mode — expand them into traces.

  A decision trace surfaces, when each is visible in the exchange:

    - INPUTS GATHERED. Which files, tool results, error strings, commands, or prior messages did the agent draw on before acting? Name the surfaces (file paths, tool names) that materially shaped the decision — not every single read, just the ones that informed the choice.
    - ALTERNATIVES CONSIDERED AND REJECTED. What did the agent try first that didn't work, propose that was dropped, or weigh against the chosen path? "Tried \`findAtomicCoverage\` first, dropped it as overengineered" is a high-value trace; "the fix is X" alone is not. The article on context graphs calls this the conflicts/precedent layer — future agents reuse rejected options as much as chosen ones.
    - USER STEERS / APPROVALS / OVERRIDES. When the user pushed back, redirected, vetoed, or explicitly approved a path, preserve their wording near-verbatim and treat it as an authority signal. Quotes like "I think this is overengineered", "we should not treat them as legacy", "do X instead", "go ahead" are the equivalent of a VP approving a discount on a Zoom call: not in any system of record until you write it down. These are the HIGHEST-signal observations to capture, because they are the precedent that overrides defaults.
    - CONVENTION OR POLICY APPLIED. Which \`AGENTS.md\` rule, project guideline, skill instruction, or prior decision was leaned on? "Per AGENTS.md ‘Prefer Direct, Local Guarantees’, removed the redundant guard" is a trace; "removed the redundant guard" alone loses the rule that justified it.
    - PRIOR PRECEDENT. When the decision was informed by a prior memory row, a prior PR, or an earlier session's choice, mention it by name or short paraphrase so the future agent can find the precedent edge. This is also what \`usedObservationIds\` captures structurally — the prose should mirror it for readers who only see the content.
    - EXCEPTION / OVERRIDE FLAG. If the path taken deviates from the usual approach or contradicts an existing rule, mark it plainly ("exception:", "override:", "departing from the default because…"). Exceptions are the most-reused precedent.

  Not every observation is a decision — user facts, preferences, and routine completions don't need traces. But when a decision IS being recorded, omitting the trace is the same as recording a discount approval without the policy version, the exception route, or who signed off. The outcome alone is not enough.

  PRESERVE SPECIFICS

  Capture user facts, preferences, goals, constraints, corrections, explicit decisions, project details, file paths, commands, unresolved tasks, and completed work.
  When a tool result reveals a concrete fact the agent acted on (a file path, a function name, a line number, a count, an error message), preserve that specific fact — not the surrounding output.
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
  - If the agent calls tools, observe what was called, why, and what was learned — not the raw arguments or raw output. Only record the exchange when something durable came out of it (decision, blocker, completion, user signal).
  - When observing files with line numbers, include the line number if useful
  - If the agent's response only restates re-readable ground truth, prefer hasMemory=false over writing a faithful transcript. Memory is for things the agent could not trivially re-discover.
  - Make sure each observation starts with a priority emoji (🔴, 🟡, 🟢) or a completion marker (✅)
  - Capture short and medium user messages nearly verbatim; summarize long messages but keep key quotes that carry intent
  - Default a user task request to 🟡. Only escalate to 🔴 when the request itself reveals a durable user fact, preference, or critical cross-session goal that goes beyond the immediate task
  - Reserve ✅ for state-changing concrete completions: code shipped, file edited, command that mutated state, verified bug fix. Do NOT mark ✅ for read-only file inspections, lookups, or routine Q&A — those stay 🟡. A decision or plan to do something later is NOT a completion: "agreed to refactor X", "we'll extract Y", "next step is Z" stay 🟡 (or 🔴 if the decision is durable cross-session). ✅ requires that the work has actually been performed in this exchange.
  - Do not use ✅ when the user defers, postpones, abandons, or changes their mind. Tag deferrals as 🟢. Tag content surfaced along the way as 🟡 only when it is grounded in measured/observed facts; otherwise 🟢
  - When the conversation is dominated by uncertainty, speculation, "maybe / might / not sure / no data yet" framing, or explicit deferral, the whole observation should stay at 🟢. Do not sneak in 🟡 lines just to elevate the priority
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
        - threadTitle: A short, noun-phrase title for this conversation (2-5 words). Only update when the topic meaningfully changes.
      `
    : "";

  return dedent`
    Use priority levels:
    - 🔴 High: durable user-identity facts (job, environment, relationships, identifiers), explicit user preferences, and unresolved critical decisions or blockers the user cares about across sessions. Do NOT use 🔴 for ordinary task requests. Do NOT use 🔴 for an in-session refactor plan, agreed approach, or "yes, let's do that" confirmation — those are 🟡 even when the user agrees enthusiastically. Escalation to 🔴 requires a durable cross-session signal (a preference, identity fact, or lasting goal), not the strength of in-session agreement.
    - 🟡 Medium: in-session work that carries durable signal — decisions reached, hypotheses the agent committed to, blockers/errors that still gate progress, and ordinary task requests being performed. This is the default home for agreed in-session plans and refactor decisions, including ones the user explicitly confirmed ("yes, do that", "go ahead"). Do NOT use 🟡 just to record what the agent read; if the only content is "agent looked at X and X says Y", prefer hasMemory=false.
    - 🟢 Low: tentative, speculative, or uncertain observations ("maybe", "might be", unmeasured guesses), explicit deferrals or "no data yet" states, and incidental details whose future relevance is unclear. Use 🟢 freely and do not promote tentative or unresolved content to 🟡 to look helpful.
    - ✅ Completed: a state-changing artifact was produced — code shipped, file edited, command run that mutated state, or a verified bug fix. Do NOT use ✅ for read-only lookups, file inspections, or simple Q&A. Do NOT use ✅ when the user defers, postpones, or changes their mind.

    Group related observations by indenting:
    * 🟡 (14:33) Agent debugging auth issue
      * -> ran git status, found 3 modified files
      * -> viewed auth.ts:45-60, found missing null check
      * ✅ Tests passing, auth issue resolved

    Group observations by date, then list each with 24-hour time.

    hasMemory:
    - true when the message history contains durable information worth remembering: user preferences, user-identity facts, decisions taken, state-changing completions, blockers/errors that gate future work, or hard-won discoveries that took real investigation to produce.
    - false when the exchange only restates ground truth the agent could trivially re-discover by re-running a tool — file listings, file contents quoted back, grep output, package.json dumps, status-quo code structure. Re-runnable facts are not memory. Recording them just bloats the durable store and the agent can read them fresh next time.
    - Decisions ABOUT the ground truth ARE memory ("we agreed to refactor the duplicated auth checks into a middleware"); the ground truth that prompted the decision is not.
    - Tool-result errors that block the user's work (build failures, failing tests, runtime errors the user is asking about) ARE memory while unresolved, because they carry forward into the next turn even though the agent could re-run the same tool.
    - Tentative or low-priority signals about the user's preferences, plans, or constraints still count as durable memory; record them as 🟢. Tentative observations about ground truth do not.

    Concrete examples of what is NOT memory (return hasMemory=false unless something durable ALSO appears in the exchange):
    - "User asked to see / read / inspect FILE" — an inspection request is not a durable signal. The user can ask again next session.
    - "Agent read FILE and the contents/structure are X" — re-readable.
    - "Agent ran COMMAND and the output was X" — re-runnable.
    - "Agent listed DIRECTORY and found these files" — re-runnable.
    - "Agent grepped for PATTERN and found N matches" — re-runnable.
    Recording any of the above by itself bloats the store with content the agent will fetch fresh anyway. Only record when the exchange ALSO produced a durable signal (a decision, a completion, an unresolved blocker, or a user preference revealed during the work).

    - Always call the structured output tool. Use hasMemory=false instead of skipping the tool call.

    observations:
    Date: Dec 4, 2025
    * 🔴 (14:30) User prefers direct answers
    * 🟡 (14:31) Working on feature X this session
    - When hasMemory=false, observations must be an empty string.

    currentTask:
    State the current task(s) explicitly:
    - Primary: what the agent is currently working on
    - Secondary: other pending tasks, marked "waiting for user" when appropriate
    - If the agent started doing something without user approval, note that it is off-task

    usedObservationIds:
    The existing observations block above lists prior cross-session memories with explicit \`[memory id: mem_xxx]\` markers. If the assistant's response in this exchange leaned on one or more of those memories — referenced facts, preferences, prior decisions, or context drawn from them — list the matching ids here. Omit or return [] when no prior memory was actually used. Only cite ids that appear verbatim in the markers above; do not invent ids.

    CITE EACH DISTINCT FACT YOU USED, AT THE NARROWEST ROW THAT CARRIES IT — AND AT EXACTLY ONE ROW PER FACT. For each distinct fact the response leaned on, find every row in the observations block that mentions that fact, then pick exactly ONE id to cite for it:
    1. Prefer the most specific row — the one whose subject is that fact, not a broader summary that mentions it among many.
    2. Among rows of similar specificity, prefer the highest-priority (🔴 > 🟡 > 🟢) and most recently observed wording.
    3. Fall back to a broader summary row ONLY when no narrower row carries the fact at all.

    NEVER cite two ids for the same fact, even when the rows are worded differently or have different specificity. If three rows describe the same lint convention at different levels of detail ("User wants consistent linting", "User uses Biome", "User configured Biome with 2-space indent, double quotes, and \`noUnusedImports\` as error in \`biome.json\`"), pick the single best representative and leave the duplicates alone. Bumping every overlapping row uniformly refreshes stale or vague duplicates and defeats freshness decay; that is exactly what this field must avoid.

    When the response leaned on multiple DISTINCT facts (different subjects, not different phrasings of the same subject), emit one id per fact actually used. A 100-token row whose only subject is one fact beats a 5,000-token row that mentions the same fact alongside fifteen others; bumping the narrow row keeps the broad summary fading until something specifically uses it again.

    Worked example A (prefer narrow over summary). The block has \`[memory id: mem_backend_conventions]\` summarising the user's backend project conventions — logger module path, error base class, migration filename format, ORM choice, test runner, and Dockerfile base image — plus six narrower rows \`mem_logger\`, \`mem_errors\`, \`mem_migrations\`, \`mem_orm\`, \`mem_test_runner\`, \`mem_docker\` each focused on one of those facts. If your response leaned on the migration filename format and the Dockerfile base image, cite \`["mem_migrations", "mem_docker"]\` — not \`mem_backend_conventions\`, and not the narrower ids for facts you did not use.

    Worked example A2 (prefer narrow over summary, release-history flavour). The block has \`[memory id: mem_release_log]\` summarising a recent release train — a docs cleanup release, a bundled-dependency release, a runtime-recovery release, an upgrade release, and a couple of tag-only releases — plus per-release narrow rows \`mem_rel_docs\`, \`mem_rel_bundled_dep\`, \`mem_rel_recovery\`, \`mem_rel_upgrade\`, \`mem_rel_tagonly_a\`, \`mem_rel_tagonly_b\`. If your response leaned on the bundled-dependency release and the runtime-recovery release, cite \`["mem_rel_bundled_dep", "mem_rel_recovery"]\` — not \`mem_release_log\`, and not the narrower ids for releases you did not reference.

    Worked example B (collapse duplicates of the same fact). The block has \`mem_best\` (🔴 recent, specific: "For senior IC interviews, user weights system-design 40%, coding 30%, behavioural 20%, take-home 10%, and requires two strong-yes signals on system-design to advance"), \`mem_dup_medium\` (🟡 older, less specific: "User weights system-design heavily for senior IC hires"), and \`mem_dup_vague\` (🟢 oldest, vague: "User has an interview rubric"). All three cover the same fact. If your response leaned on that one fact, cite \`["mem_best"]\` only — never \`["mem_best", "mem_dup_medium"]\` and never all three.

    Worked example C (fallback to summary). The block has only \`mem_quarterly_plan\` covering the user's Q3 plan (three OKRs, a hiring target, a launch event in week 9, a vacation block in week 7, a board update date, and a budget cap) and no narrower siblings. If your response leaned on the launch event and the board update date, cite \`["mem_quarterly_plan"]\` because no narrower row carries those facts.

    Do not cite ids you did not actually use. Freshness decay relies on bumps reflecting real usage, so an unused citation is worse than an omitted one.

    suggestedContinuation:
    Hint for the agent's immediate next message. If the assistant needs to respond to the user, say that it should pause for user reply before continuing other tasks.
    ${threadTitleSection}
  `;
}

export interface ObserverPromptContext {
  /**
   * Working directory the runner is executing in. Surfaced verbatim
   * to the observer so project-specific observations carry enough
   * cwd / project signal to stay meaningful when read back later
   * — especially across repos or after the user switches projects.
   */
  cwd?: string;
}

export function buildObserverSystemPrompt(
  instruction?: string,
  includeThreadTitle = false,
  context: ObserverPromptContext = {},
): string {
  const cwdBlock = context.cwd
    ? dedent`

        === CURRENT PROJECT (CWD) ===

        The runner is operating in:

          ${context.cwd}

        Every observation produced here is implicitly scoped to this directory. The persistence layer also writes this cwd onto the surrounding <observation-group> wrapper automatically, so you do NOT need to copy the literal path into observation content. What you DO need to do is keep enough project signal in the prose itself (the repo name, key package or module names, or the product/area being worked on) so a future reader who sees only one observation — without the wrapper attributes — can still tell which project it is about. "Updated session-store.ts" is too thin; "Updated \`packages/agent-gateway/src/session-store.ts\` in the duet-agent monorepo" is right-sized. Skip project tagging only for observations that are clearly user-level facts unrelated to any codebase (preferences, personal info, schedule).
      `
    : "";
  return dedent`
    You are the memory consciousness of an AI assistant. Your observations will be the ONLY information the assistant has about past interactions with this user.${cwdBlock}

    Extract observations that will help the assistant remember:

    ${OBSERVER_EXTRACTION_INSTRUCTIONS}

    === STRUCTURED OUTPUT FIELDS ===

    Call the structured output tool with these fields. Do not write free-form text outside the tool call.

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
  targetTokens: number,
  retry?: { actualTokens: number },
  now = new Date(),
): RawMemoryContent {
  const retryInstruction = retry
    ? dedent`
        The previous observation log was approximately ${retry.actualTokens.toLocaleString("en-US")} tokens, which exceeded the ${targetTokens.toLocaleString("en-US")}-token budget.

        Retry with a shorter observation log under approximately ${targetTokens.toLocaleString("en-US")} tokens. Preserve the highest-priority user facts, unresolved work, concrete decisions, and completion markers first.
      `
    : dedent`
        Target budget: keep the new observation log under approximately ${targetTokens.toLocaleString("en-US")} tokens.
      `;
  const previous = existingObservations.trim()
    ? dedent`
        ## Existing Observations

        Do not repeat these existing observations. New observations will be appended.

        ${existingObservations}

        ---
      `
    : "";
  const header = dedent`
    ${previous}
    ## New Message History to Observe

    Current date: ${now.toISOString()}
  `;

  return [
    { type: "text", text: header },
    ...formatMessagesForObserver(messages),
    {
      type: "text",
      text: dedent`
        ---

        ${retryInstruction}

        Extract new observations from this message history. When images are attached to a message, inspect them directly and summarize relevant visual details, user-visible text, UI state, diagrams, errors, or other facts needed for future continuity.
      `,
    },
  ];
}

export function formatMessagesForObserver(messages: RawMemoryMessage[]): RawMemoryContent {
  return messages.flatMap((message) => {
    const date = new Date(message.createdAt).toISOString();
    const parts: RawMemoryContent = [
      {
        type: "text",
        text: `--- message boundary (${date}) ---\n${message.role.toUpperCase()} [${message.id}]\n${message.textPreview}`,
      },
    ];
    parts.push(...message.content.filter(isImageContent));
    return parts;
  });
}

function isImageContent(part: TextContent | ImageContent): part is ImageContent {
  return part.type !== "text";
}

export interface ReflectorPromptContext {
  /**
   * Working directory of the in-session reflector run. Only set when
   * the rolled-up blob comes from one session in one cwd; the global
   * reflector spans many sessions and many cwds, so it leaves this
   * undefined and instead relies on the cwd attribute already on each
   * source <observation-group>.
   */
  cwd?: string;
}

export function buildReflectorSystemPrompt(
  instruction?: string,
  context: ReflectorPromptContext = {},
): string {
  const cwdBlock = context.cwd
    ? dedent`

        Current working directory for this batch:

          ${context.cwd}

        Every source observation was captured inside this cwd. Preserve the project / repo / module identifier in the reflected narrative so it stays meaningful when read back in another project.
      `
    : dedent`

        Source observations may come from multiple working directories. Each <observation-group> in the input carries a \`cwd="..."\` attribute on its opening tag identifying the project that row belongs to. Treat that attribute as authoritative project context and INCLUDE the project / repo name in the narrative of each reflected row (e.g. "in the duet-agent monorepo", "on the marketing-site repo") when the row is project-specific. A row whose action only makes sense inside a specific codebase but doesn't name the project is incomplete.
      `;
  return dedent`
    You are the reflection agent for an observational memory system. Your output is the long-term cross-session memory the acting assistant will see weeks from now, when the original transcript is gone. Optimize for an agent who has never read the original turns.${cwdBlock}

    Each row is one durable insight told as a self-contained mini-narrative. A bare factual headline ("X was done on Y") is the WRONG shape. The RIGHT shape captures the journey:

      1. Trigger — what surfaced the problem, request, or decision? What was the symptom, complaint, error, or goal that started this thread of work?
      2. Investigation / path — what was tried, ruled out, or considered? Which file/system/person was involved? What constraint forced the path that was taken?
      3. Decision or outcome — what was actually done or chosen, with the concrete identifiers (file path, commit SHA, version, person, place) that let the agent find it again.
      4. Rationale or higher-level lesson — WHY this was the right call given the constraints. What is the durable principle the next session should generalize? Often this is the most important part of the row.
      5. Project / cwd anchor — name the repo, package, or product surface the work belongs to whenever the row is project-specific. A row about "the session store race" is ambiguous without "duet-agent's \`packages/agent-gateway/\`"; the future agent may be working in a different repo when it reads this back. Skip the anchor only for rows that are clearly user-level facts unrelated to any codebase (preferences, personal info, schedule).
      6. Decision-trace dimensions — when the source observations recorded any of these for a decision, PRESERVE them in the reflected row. Do not strip them as "narrative fluff". Every row that records a DECISION (a path chosen, a fix landed, an option weighed) must ATTRIBUTE that decision to a concrete source: a user steer, a project convention or rule, a prior precedent / earlier fix, an observed symptom / error / measurement, or an explicit "no precedent — fresh judgement call". Passive-voice outcome rows ("X was changed to Y", "v1.2.3 was released") are INVALID — always name WHY the path was taken.
           - Alternatives considered and rejected ("tried X first, dropped it because…", "weighed Y vs Z, picked Y because…"). Future agents reuse rejected options as much as chosen ones.
           - User steers, push-backs, approvals, vetoes — quote or near-quote the user's wording. These are the highest-signal precedent because they override defaults. A reflection that loses the user's "we should not treat them as legacy" or "I think this is overengineered" has destroyed the most valuable input.
           - Convention / policy applied (\`AGENTS.md\` rules, skill instructions, project guidelines that justified the path).
           - Prior precedent / earlier decisions / earlier memory rows the work built on, by short paraphrase so the next agent can follow the precedent edge.
           - Exception / override markers when the path deviates from the default. Exceptions are the most-reused precedent.

    Treat reflection as writing a short "why" memo, not bullet-point minutes. Multi-sentence rows that explain the journey are preferred over short rows that only state the outcome. A row that omits the trigger or the rationale is incomplete — expand it.

    Rules:
    - Each row must be readable cold, by an agent with no other context. Test it: if a reader can't tell why the work mattered or what problem it solved, the row is too thin.
    - Preserve concrete identifiers (dates, file paths, commit SHAs, PR numbers, error strings, version tags, names of people/products) wherever they appear in the source. They are how the future agent finds the work.
    - Deduplicate across rows. Each insight gets one row. If two source observations describe the same journey, merge them.
    - Group cause and effect into one row, not two. "The metadata.json race caused /answer 400s" + "SessionStore.save was made atomic" belong in the SAME row because the second is the resolution of the first.
    - Consolidate aggressively when multiple source observations describe the same underlying journey from different angles (the symptom, the investigation, the fix, the verification). Those are ONE row covering the whole arc, not three rows. Successive tweaks to the same file or subsystem also belong in one row that tells the layered story — not one row per release.
    - When two rows would describe the SAME overarching outcome or lesson at a different zoom level (one summarizes the loop, the other zooms in on one fix inside the loop), MERGE them into one row that names the specific fixes inside the larger arc. Do not let "this row mentions a different SHA" justify keeping a duplicate — the test is whether the durable insight is the same.
    - Preserve chronology and observation-group headings/ranges where they exist in the source.
    - Do not invent details. If a fact wasn't in the source, leave it out — but DO restate context that IS in the source even if it feels redundant within the row, because it won't be redundant when read cold.
    - Length budget per row: roughly 150-600 tokens (one short paragraph). Going longer is fine when the journey genuinely needs it; staying very short is the failure mode to avoid.
    ${instruction ? `\nCustom instructions:\n${instruction}` : ""}
  `;
}

export function buildReflectorPrompt(
  observations: string,
  targetTokens: number,
  retry?: { actualTokens: number },
): string {
  const budgetInstruction = retry
    ? dedent`
        The previous reflected observation log was approximately ${retry.actualTokens.toLocaleString("en-US")} tokens, which exceeded the ${targetTokens.toLocaleString("en-US")}-token budget.

        Retry with a shorter reflected observation log under approximately ${targetTokens.toLocaleString("en-US")} tokens. Preserve high-priority facts, unresolved work, concrete decisions, chronology, and completion markers first.
      `
    : `Target budget: keep the reflected observation log under approximately ${targetTokens.toLocaleString("en-US")} tokens.`;

  return dedent`
    Reflect on these observations and return an ARRAY of atomic reflection rows. One self-contained narrative per row.

    For each row, walk through trigger → journey → decision → rationale/lesson. A row that only states the outcome ("X was fixed", "v0.1.131 was released") is incomplete — expand it with what triggered the work, what was tried, why this resolution was chosen, and what the durable lesson is.

    ${budgetInstruction}

    ${observations}
  `;
}
