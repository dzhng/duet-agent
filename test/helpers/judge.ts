import { getModel, type Model, type Tool } from "@mariozechner/pi-ai";
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

const judgeModel = getModel("anthropic", "claude-sonnet-4-6");

export async function judge(input: {
  prompt: string;
  value: unknown;
  model?: Model<any>;
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
