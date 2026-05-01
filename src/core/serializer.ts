import type { AgentMessage } from "@mariozechner/pi-agent-core";

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
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => {
      const content = (message as { content?: unknown }).content;
      return Array.isArray(content) ? content : [];
    })
    .filter(isTextContentBlock)
    .map((block) => block.text)
    .join("\n")
    .trim();
}
