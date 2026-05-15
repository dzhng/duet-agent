import dedent from "dedent";

/**
 * Inline `/relay` slash command. Unlike the other built-in slash commands,
 * `/relay` is not a standalone message handled by the dispatcher — users
 * embed it *inside* a normal prompt to nudge the agent toward durable
 * state-machine work. On submit we strip every `/relay` token from the
 * message and append a system reminder that primes the routing tools.
 *
 * Gated to non-`agent` modes by the caller. In `agent` mode the runner
 * does not expose state-machine tools, so the reminder would be misleading
 * and the token is left in the message verbatim.
 */

/**
 * Build a fresh `/g` matcher per call. Sharing a module-scope `/g`
 * regex would carry `lastIndex` across invocations and force a manual
 * reset after every `.test()`; a per-call instance makes that footgun
 * impossible. Captures the surrounding whitespace so the replacement
 * can collapse `"foo /relay bar"` into `"foo bar"` without leaving a
 * double space, while a leading or trailing token disappears
 * completely. Anchored so partial matches inside other words
 * (e.g. `/relayed`, `/relay-runner`) do not trigger.
 */
function relayTokenMatcher(): RegExp {
  return /(^|\s)\/relay(\s|$)/g;
}

/**
 * Appended verbatim to the prompt when at least one `/relay` token was
 * stripped. Mirrors the system-reminder shape already used elsewhere
 * (memory, steer, tool-result hints) so the agent treats it as internal
 * guidance rather than user-authored content.
 */
const RELAY_REMINDER = dedent`
  <system-reminder>
  The user requested relay mode for this prompt. Strongly prefer the state-machine tools (create_state_machine_definition or select_state_machine_state) over handling the work inline. If no state machine is active, create one with agent/script/poll/terminal states sized to the request. If one is active, select the next state instead of replying directly. Only fall back to a plain answer when the request is genuinely a one-shot question that cannot be expressed as a state.
  </system-reminder>
`;

export interface RelayCommandResult {
  /** Prompt text after stripping `/relay` tokens; trailing reminder appended when applied. */
  message: string;
  /** True when at least one `/relay` token was found and the reminder was appended. */
  applied: boolean;
}

/**
 * Strip every `/relay` token from `message` and append the relay system
 * reminder when at least one token was present. Whitespace around the
 * stripped token is collapsed so `"foo /relay bar"` becomes `"foo bar"`
 * before the reminder is appended.
 */
export function applyRelayCommand(message: string): RelayCommandResult {
  const matcher = relayTokenMatcher();
  if (!matcher.test(message)) {
    return { message, applied: false };
  }
  const stripped = message
    .replace(relayTokenMatcher(), (_match, leading: string, trailing: string) =>
      // Collapse to a single space only when the token sat between two
      // words; an edge token (no leading or no trailing) disappears
      // entirely so the trimmed message keeps clean boundaries.
      leading && trailing ? " " : "",
    )
    .trim();
  const body = stripped.length > 0 ? `${stripped}\n\n${RELAY_REMINDER}` : RELAY_REMINDER;
  return { message: body, applied: true };
}
