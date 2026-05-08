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
