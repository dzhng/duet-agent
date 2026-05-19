import type { AgentMessage } from "@earendil-works/pi-agent-core";

interface TextContentBlock {
  type: "text";
  text: string;
}

function isTextContentBlock(block: unknown): block is TextContentBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    (block as { type: unknown }).type === "text" &&
    "text" in block &&
    typeof (block as { text: unknown }).text === "string"
  );
}

export function assistantText(messages: AgentMessage[]): string {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (!assistant) return "";
  const content = (assistant as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isTextContentBlock)
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Concatenate every assistant message's text content in order. Useful when a
 * caller cares whether a token appears anywhere in the parent transcript, not
 * just in the latest assistant message — e.g. acknowledgment-turn evals where
 * the model may emit the token on the SM1 ack while SM2's ack adds a trailing
 * summary that would otherwise shadow it in `assistantText`.
 */
export function allAssistantText(messages: AgentMessage[]): string {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => {
      const content = (message as { content?: unknown }).content;
      return Array.isArray(content) ? content.filter(isTextContentBlock).map((b) => b.text) : [];
    })
    .join("\n");
}
