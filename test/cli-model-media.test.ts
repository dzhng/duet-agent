import { expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runModelCommand } from "../src/cli/model.js";
import { testIfDocker } from "./helpers/docker-only.js";

testIfDocker.each([
  ["bytedance/seedance-2.5", 5],
  ["google/veo-3.1-generate-001", 4],
  ["spacexai/grok-imagine-video-1.5", 5],
])(
  "%s preserves source image URLs, video request controls and file output",
  async (model, duration) => {
    const temp = await mkdtemp(join(tmpdir(), "media-refresh-"));
    const oldKey = process.env.DUET_API_KEY;
    const oldBase = process.env.DUET_GATEWAY_BASE_URL;
    const requests: Array<{ model: string | null; body: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push({ model: request.headers.get("ai-model-id"), body: await request.json() });
        return new Response(
          `data: ${JSON.stringify({ type: "result", videos: [{ type: "base64", data: btoa("video-bytes"), mediaType: "video/mp4" }], warnings: [] })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      process.env.DUET_API_KEY = "controlled";
      process.env.DUET_GATEWAY_BASE_URL = server.url.toString();
      const output = join(temp, "clip.mp4");
      await runModelCommand([
        "-m",
        model,
        "--type",
        "video",
        "--image",
        "https://example.test/source.png",
        "--duration",
        String(duration),
        "--aspect",
        "16:9",
        "--resolution",
        "1280x720",
        "-o",
        output,
        "animate",
      ]);
      expect(requests).toEqual([
        {
          model,
          body: expect.objectContaining({
            prompt: "animate",
            duration,
            aspectRatio: "16:9",
            resolution: "1280x720",
            image: { type: "url", url: "https://example.test/source.png" },
          }),
        },
      ]);
      expect(await readFile(output, "utf8")).toBe("video-bytes");
    } finally {
      server.stop(true);
      if (oldKey === undefined) delete process.env.DUET_API_KEY;
      else process.env.DUET_API_KEY = oldKey;
      if (oldBase === undefined) delete process.env.DUET_GATEWAY_BASE_URL;
      else process.env.DUET_GATEWAY_BASE_URL = oldBase;
      await rm(temp, { recursive: true, force: true });
    }
  },
  30_000,
);

testIfDocker(
  "stable Gemini image generation uses the language image endpoint and writes its image",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "image-refresh-"));
    const oldKey = process.env.DUET_API_KEY;
    const oldBase = process.env.DUET_GATEWAY_BASE_URL;
    const requests: Array<{ model: string | null; path: string; body: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/models")
          return Response.json({
            data: [{ id: "google/gemini-3.1-flash-image", type: "language" }],
          });
        requests.push({
          model: request.headers.get("ai-language-model-id"),
          path,
          body: await request.json(),
        });
        return Response.json({
          content: [
            {
              type: "file",
              mediaType: "image/png",
              data: { type: "data", data: btoa("image-bytes") },
            },
          ],
          finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          warnings: [],
        });
      },
    });
    try {
      process.env.DUET_API_KEY = "controlled";
      process.env.DUET_GATEWAY_BASE_URL = server.url.toString();
      const output = join(temp, "image.png");
      await runModelCommand([
        "-m",
        "google/gemini-3.1-flash-image",
        "--type",
        "image",
        "-o",
        output,
        "draw a fox",
      ]);
      expect(requests).toEqual([
        {
          model: "google/gemini-3.1-flash-image",
          path: "/v4/ai/language-model",
          body: expect.objectContaining({
            prompt: expect.arrayContaining([expect.objectContaining({ role: "user" })]),
          }),
        },
      ]);
      expect(await readFile(output, "utf8")).toBe("image-bytes");
    } finally {
      server.stop(true);
      if (oldKey === undefined) delete process.env.DUET_API_KEY;
      else process.env.DUET_API_KEY = oldKey;
      if (oldBase === undefined) delete process.env.DUET_GATEWAY_BASE_URL;
      else process.env.DUET_GATEWAY_BASE_URL = oldBase;
      await rm(temp, { recursive: true, force: true });
    }
  },
  30_000,
);
