import { afterEach, beforeEach, expect, test } from "bun:test";

import { duetModels, duetStreamFn } from "../src/model-resolution/models.js";
import { resolveModelName } from "../src/model-resolution/resolver.js";

/**
 * ChatGPT tokens are JWTs the Codex transport reads the account id out of, so
 * a bare string never reaches the wire whatever auth decides. This carries the
 * one claim it needs and nothing else.
 */
const CALLER_TOKEN = [
  "e30",
  btoa(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } }),
  ).replace(/=+$/, ""),
  "caller-supplied-token",
].join(".");

const DUET_KEY = process.env.DUET_API_KEY;

beforeEach(() => {
  process.env.DUET_API_KEY = "duet-test-key";
});

afterEach(() => {
  if (DUET_KEY === undefined) delete process.env.DUET_API_KEY;
  else process.env.DUET_API_KEY = DUET_KEY;
});

/**
 * The turn runner resolves a connected provider's token itself — Duet stores
 * and refreshes ChatGPT/Copilot credentials, pi-ai's credential store never
 * sees them — and hands it to the loop as `apiKey`. That override is honored
 * only for a provider that declares api-key auth, and `openai-codex` declares
 * OAuth alone, so if the registry stops saying Duet holds the credential,
 * every connected turn is refused before a request is built.
 */
test.each(["openai-codex", "github-copilot", "duet-gateway"])(
  "%s dispatch sends the caller's key instead of refusing the request",
  async (provider) => {
    const model =
      provider === "duet-gateway"
        ? resolveModelName("duet-gateway:moonshotai/kimi-k3")
        : (duetModels().getModels(provider)[0] ?? undefined);
    expect(model, `${provider} serves no models`).toBeDefined();

    let sentAuthorization: string | undefined;
    const stream = duetStreamFn(
      model!,
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      {
        apiKey: CALLER_TOKEN,
        fetch: (async (_input: unknown, init?: RequestInit) => {
          sentAuthorization = new Headers(init?.headers).get("authorization") ?? undefined;
          return new Response("", { status: 500 });
        }) as never,
      },
    );

    let errorMessage = "";
    for await (const event of await stream) {
      const message = (event as { message?: { errorMessage?: string } }).message;
      if (message?.errorMessage) errorMessage = message.errorMessage;
    }

    // A 500 from the fake upstream is the expected end state; being refused
    // before the request is built is the regression.
    expect(errorMessage).not.toContain("Provider is not configured");
    expect(sentAuthorization ?? "<no request was made>").toContain("caller-supplied-token");
  },
);

/**
 * A model's `api` is a claim about how its request is serialized, and the
 * gateways depend on it: OpenAI models need the Responses shape or their
 * reasoning effort is silently dropped, and an image-capable model needs the
 * OpenAI shape or a tool result's image arrives as text.
 *
 * The claim is not self-enforcing. Serialization belongs to the *provider*, so
 * rewriting `model.api` to a transport the provider does not implement leaves
 * a model that says "responses" and is sent as Anthropic — which is exactly
 * what pinning `vercel-ai-gateway:` did until its provider declared all three.
 */
// The two OpenAI-shaped payloads and the Anthropic one all carry `messages`,
// so the token-limit field is the discriminator that actually separates them.
const WIRE_SHAPES = {
  "openai-responses": { present: "input", absent: "messages" },
  "openai-completions": { present: "max_completion_tokens", absent: "thinking" },
  "anthropic-messages": { present: "thinking", absent: "max_completion_tokens" },
} as const;

test.each([
  ["duet-gateway:openai/gpt-5.6-sol", "openai-responses"],
  ["duet-gateway:moonshotai/kimi-k3", "openai-completions"],
  ["duet-gateway:anthropic/claude-sonnet-5", "anthropic-messages"],
  ["vercel-ai-gateway:openai/gpt-5.6-sol", "openai-responses"],
  ["vercel-ai-gateway:moonshotai/kimi-k3", "openai-completions"],
  ["vercel-ai-gateway:anthropic/claude-sonnet-5", "anthropic-messages"],
])("%s is serialized as %s, the transport it declares", async (pin, api) => {
  const model = resolveModelName(pin);
  expect(model.api).toBe(api);

  let payload: Record<string, unknown> | undefined;
  const stream = duetModels().streamSimple(
    model,
    { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    {
      apiKey: "test-key",
      reasoning: "high",
      onPayload: (sent) => {
        payload = sent as Record<string, unknown>;
        return undefined;
      },
      fetch: (async () => new Response("", { status: 500 })) as never,
    },
  );
  for await (const _event of await stream) void _event;

  const shape = WIRE_SHAPES[api as keyof typeof WIRE_SHAPES];
  expect(payload, "no request was built").toBeDefined();
  expect(payload).toHaveProperty(shape.present);
  expect(payload).not.toHaveProperty(shape.absent);

  // The reasoning ask has a different field name per transport; what matters
  // is that a reasoning-capable model carries one at all.
  if (model.reasoning) {
    const asked = payload?.reasoning ?? payload?.reasoning_effort ?? payload?.thinking ?? undefined;
    expect(asked, `${pin} sent no reasoning request`).toBeDefined();
  }
});
