import { type Tool } from "@earendil-works/pi-ai";
import dedent from "dedent";
import { Type, type Static } from "typebox";
import { generateStructuredOutput } from "../../src/core/structured-output.js";

const judgeSchema = Type.Object({
  valid: Type.Boolean({ description: "Whether the input satisfies the judgment prompt" }),
  reason: Type.String({ description: "One concise sentence explaining the decision" }),
});

export type JudgeResult = Static<typeof judgeSchema>;

const judgeTool: Tool<typeof judgeSchema> = {
  name: "judgeInput",
  description: "Judge whether arbitrary input satisfies the prompt",
  parameters: judgeSchema,
};

// Use the shorthand so the judge routes through whichever provider the
// eval environment has credentials for (duet-gateway when DUET_API_KEY is
// set, falling back to Anthropic-direct on a local laptop with
// ANTHROPIC_API_KEY). Pinning the provider here would break the docker
// eval container, which only has gateway-style credentials.
const judgeModel = "opus-4.7";

export async function judge(input: {
  prompt: string;
  value: unknown;
  model?: string;
  systemPrompt?: string;
}): Promise<JudgeResult> {
  return generateStructuredOutput({
    model: input.model ?? judgeModel,
    tool: judgeTool,
    systemPrompt:
      input.systemPrompt ??
      dedent`
        You are a test judge. Return valid=true only when the provided input
        satisfies the user's judgment prompt.
      `,
    prompt: dedent`
      JUDGMENT PROMPT:
      ${input.prompt}

      INPUT:
      ${JSON.stringify(input.value, null, 2)}
    `,
  });
}
