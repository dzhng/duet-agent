/**
 * Stamp the correlation id the RPC wire requires.
 *
 * `prompt`, `answer` and `wake` are acknowledged by id, so the CLI rejects a
 * command that arrives without one and the turn dies before it starts. The
 * gateway mints its own per request; an eval only needs each command to be
 * well-formed and distinct, so a counter serves without reaching for a clock.
 */
let issued = 0;

const ACKNOWLEDGED_COMMANDS = new Set(["prompt", "answer", "wake"]);

export function withRequestId<T extends { type: string }>(command: T): T {
  if (!ACKNOWLEDGED_COMMANDS.has(command.type)) return command;
  const existing = (command as { requestId?: unknown }).requestId;
  if (typeof existing === "string" && existing.trim().length > 0) return command;
  return { ...command, requestId: `eval-${++issued}` };
}
