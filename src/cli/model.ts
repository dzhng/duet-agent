import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import {
  createDownload,
  experimental_generateVideo as generateVideo,
  generateImage,
  generateText,
  streamText,
  type ImagePart,
  type ModelMessage,
} from "ai";
import { createDuetModelGateway, fetchModelCatalog, type ModelType } from "./model-gateway.js";
import { printModelHelp } from "./help.js";
import { fail, loadCliEnvFiles, resolveUserPath } from "./shared.js";

/**
 * High-level capability the CLI routes a request to. The gateway catalog uses
 * `language` for text models; everything else maps straight through. `--type`
 * lets the user override routing when the catalog is missing or wrong.
 */
type RequestType = "text" | "image" | "video";

/** Parsed `duet model` flags. Prompt is positional or read from stdin. */
interface ModelArgs {
  model?: string;
  type?: RequestType;
  imagePath?: string;
  out?: string;
  system?: string;
  size?: string;
  aspect?: string;
  n?: number;
  seed?: number;
  duration?: number;
  resolution?: string;
  fps?: number;
  json: boolean;
  envFile?: string;
  prompt?: string;
  help: boolean;
}

/**
 * Map a gateway catalog capability to the CLI request type. `language` covers
 * text models, including the gemini `*-image` models that emit images as message
 * files; those are still text completions, so `--type image` is what reroutes
 * them. An unknown/missing catalog entry defaults to text.
 */
export function requestTypeForCapability(type: ModelType | undefined): RequestType {
  if (type === "image") return "image";
  if (type === "video") return "video";
  return "text";
}

/** Language models emit images via result.files, not the image endpoint. */
export function usesLanguageImagePath(type: ModelType | undefined): boolean {
  return type === "language";
}

/** Image file extension -> media type, for inlining vision input parts. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Generate a timestamped output filename like `model-20260629T141500-1.png`.
 * Used when the user does not pass `--out` for image/video generations so each
 * run lands a distinct, sortable file. Lives here so the image and video units
 * share one naming scheme.
 */
export function autoOutputFilename(extension: string, index = 1): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `model-${stamp}-${index}${extension}`;
}

/** Run `duet model` — call a gateway model directly via the AI SDK. */
export async function runModelCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.help) {
    printModelHelp();
    return;
  }
  loadCliEnvFiles(process.cwd(), parsed.envFile);

  if (!parsed.model) fail("Missing required --model/-m");
  const model = parsed.model;

  const prompt = parsed.prompt ?? (await readStdin());
  if (!prompt.trim()) fail("Missing prompt (pass as an argument or via stdin)");

  const requestType = parsed.type ?? (await resolveType(model));
  if (requestType === "image") {
    await runImagePath({ ...parsed, model, prompt });
    return;
  }
  if (requestType === "video") {
    await runVideoPath({ ...parsed, model, prompt });
    return;
  }

  await runTextPath({ ...parsed, model, prompt });
}

/** Generate one or more images, writing each to disk and reporting warnings. */
async function runImagePath(parsed: ModelArgs & { model: string; prompt: string }): Promise<void> {
  // Some catalog `language` models (e.g. google/gemini-2.5-flash-image) emit
  // images as message files rather than via the image-generation endpoint, so a
  // `--type image` request on a language model routes through generateText.
  if (usesLanguageImagePath(await lookupCapability(parsed.model))) {
    await runLanguageImagePath(parsed);
    return;
  }
  const gateway = createDuetModelGateway();
  const result = await generateImage({
    model: gateway.imageModel(parsed.model),
    prompt: await buildImagePrompt(parsed),
    size: parseSize(parsed.size),
    aspectRatio: parseAspect(parsed.aspect),
    n: parsed.n,
    seed: parsed.seed,
  });

  for (const warning of result.warnings) {
    process.stderr.write(`warning: ${JSON.stringify(warning)}\n`);
  }

  const single = result.images.length === 1;
  for (const [index, image] of result.images.entries()) {
    const extension = mediaTypeExtension(image.mediaType);
    const path = resolveImageOut(parsed.out, extension, index + 1, single);
    await writeFile(path, image.uint8Array);
    process.stdout.write(`${path}\n`);
  }
}

/** Generate images from a language model, extracting them from result.files. */
async function runLanguageImagePath(
  parsed: ModelArgs & { model: string; prompt: string },
): Promise<void> {
  const gateway = createDuetModelGateway();
  const messages: ModelMessage[] = [{ role: "user", content: await buildContent(parsed) }];
  const result = await generateText({
    model: gateway(parsed.model),
    system: parsed.system,
    messages,
  });

  const images = result.files.filter((file) => file.mediaType.startsWith("image/"));
  if (images.length === 0) fail(`Model ${parsed.model} returned no images`);

  const single = images.length === 1;
  for (const [index, image] of images.entries()) {
    const extension = mediaTypeExtension(image.mediaType);
    const path = resolveImageOut(parsed.out, extension, index + 1, single);
    await writeFile(path, image.uint8Array);
    process.stdout.write(`${path}\n`);
  }
}

// Video files are large; cap downloads at 512 MiB rather than the SDK's 2 GiB
// default so a runaway URL response fails fast instead of filling the disk.
const VIDEO_MAX_BYTES = 512 * 1024 * 1024;

/** Generate one or more videos, writing each to disk. Supports image->video. */
async function runVideoPath(parsed: ModelArgs & { model: string; prompt: string }): Promise<void> {
  const gateway = createDuetModelGateway();
  const result = await generateVideo({
    model: gateway.video(parsed.model),
    prompt: await buildVideoPrompt(parsed),
    aspectRatio: parseAspect(parsed.aspect),
    resolution: parseResolution(parsed.resolution),
    duration: parsed.duration,
    fps: parsed.fps,
    n: parsed.n,
    seed: parsed.seed,
    // Some video models return a URL the SDK must fetch; reuse the gateway's
    // 15-minute fetch indirectly and bound the body to VIDEO_MAX_BYTES.
    download: createDownload({ maxBytes: VIDEO_MAX_BYTES }),
  }).catch(failOnBillingError);

  for (const warning of result.warnings) {
    process.stderr.write(`warning: ${JSON.stringify(warning)}\n`);
  }

  const single = result.videos.length === 1;
  for (const [index, video] of result.videos.entries()) {
    const extension = mediaTypeExtension(video.mediaType);
    const path = resolveImageOut(parsed.out, extension, index + 1, single);
    await writeFile(path, video.uint8Array);
    process.stdout.write(`${path}\n`);
  }
}

/**
 * Video prompt: text alone for text->video, or `{ image, text }` when `--image`
 * supplies a still to animate. The AI SDK takes a single source image as bytes.
 */
async function buildVideoPrompt(parsed: ModelArgs & { prompt: string }) {
  if (!parsed.imagePath) return parsed.prompt;
  const source = await readFile(resolveUserPath(parsed.imagePath));
  return { image: new Uint8Array(source), text: parsed.prompt };
}

/**
 * Gateway billing gates (402 video-requires-payment, 403 forbidden) carry a
 * plain-English body; surface it verbatim so the user knows to pay rather than
 * seeing an opaque SDK stack. Anything else rethrows unchanged.
 */
function failOnBillingError(error: unknown): never {
  const status = (error as { statusCode?: number })?.statusCode;
  if (status === 402 || status === 403) {
    const body = (error as { responseBody?: string }).responseBody;
    const message = (error as { message?: string }).message ?? "billing error";
    fail(`${status}: ${body ?? message}`);
  }
  throw error;
}

/**
 * Image prompt: the text alone for text->image, or `{ text, images }` for
 * editing when `--image` supplies a source image to transform.
 */
async function buildImagePrompt(parsed: ModelArgs & { prompt: string }) {
  if (!parsed.imagePath) return parsed.prompt;
  const source = await readFile(resolveUserPath(parsed.imagePath));
  return { text: parsed.prompt, images: [new Uint8Array(source)] };
}

/** Pick a single `--out` path, or auto-name; suffix the index when n>1. */
function resolveImageOut(
  out: string | undefined,
  extension: string,
  index: number,
  single: boolean,
): string {
  if (out) return single ? resolveUserPath(out) : resolveUserPath(suffixIndex(out, index));
  return autoOutputFilename(extension, index);
}

/** Insert `-<index>` before the extension: `art.png` -> `art-2.png`. */
function suffixIndex(path: string, index: number): string {
  const extension = extname(path);
  return `${path.slice(0, path.length - extension.length)}-${index}${extension}`;
}

/** `image/png` -> `.png`, `image/jpeg` -> `.jpg`; default to `.png`. */
function mediaTypeExtension(mediaType: string): string {
  const subtype = mediaType.split("/")[1] ?? "png";
  return subtype === "jpeg" ? ".jpg" : `.${subtype}`;
}

/** Validate `--size` is `{width}x{height}`; AI SDK requires that exact shape. */
function parseSize(size: string | undefined): `${number}x${number}` | undefined {
  if (!size) return undefined;
  if (!/^\d+x\d+$/.test(size)) fail(`Invalid --size: ${size} (expected {width}x{height})`);
  return size as `${number}x${number}`;
}

/** Validate `--aspect` is `{width}:{height}`; AI SDK requires that exact shape. */
function parseAspect(aspect: string | undefined): `${number}:${number}` | undefined {
  if (!aspect) return undefined;
  if (!/^\d+:\d+$/.test(aspect)) fail(`Invalid --aspect: ${aspect} (expected {width}:{height})`);
  return aspect as `${number}:${number}`;
}

/** Validate `--resolution` is `{width}x{height}`; AI SDK requires that exact shape. */
function parseResolution(resolution: string | undefined): `${number}x${number}` | undefined {
  if (!resolution) return undefined;
  if (!/^\d+x\d+$/.test(resolution)) {
    fail(`Invalid --resolution: ${resolution} (expected {width}x{height})`);
  }
  return resolution as `${number}x${number}`;
}

/** Stream a text completion to stdout or the `--out` file. */
async function runTextPath(parsed: ModelArgs & { model: string; prompt: string }): Promise<void> {
  const gateway = createDuetModelGateway();
  const messages: ModelMessage[] = [{ role: "user", content: await buildContent(parsed) }];
  const result = streamText({
    model: gateway(parsed.model),
    system: parsed.system,
    messages,
  });

  if (parsed.out) {
    const text = await result.text;
    process.stdout.write(text);
    await writeFile(resolveUserPath(parsed.out), text);
    return;
  }
  for await (const chunk of result.textStream) {
    process.stdout.write(chunk);
  }
  process.stdout.write("\n");
}

/**
 * Build the user message content: the prompt text plus, when `--image` is set,
 * an inline image part so vision models can see the picture.
 */
async function buildContent(parsed: ModelArgs & { prompt: string }) {
  if (!parsed.imagePath) return parsed.prompt;
  const path = resolveUserPath(parsed.imagePath);
  const mediaType = IMAGE_MEDIA_TYPES[extname(path).toLowerCase()];
  if (!mediaType) fail(`Unsupported image type: ${path}`);
  const imagePart: ImagePart = { type: "image", image: await readFile(path), mediaType };
  return [{ type: "text" as const, text: parsed.prompt }, imagePart];
}

/** Map a catalog capability to the CLI's request type; default to text. */
async function resolveType(model: string): Promise<RequestType> {
  return requestTypeForCapability(await lookupCapability(model));
}

async function lookupCapability(model: string): Promise<ModelType | undefined> {
  try {
    return (await fetchModelCatalog()).get(model);
  } catch {
    return undefined;
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

export function parseArgs(args: string[]): ModelArgs {
  const out: ModelArgs = { json: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = () => {
      const value = args[++i];
      if (value === undefined) fail(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--model":
      case "-m":
        out.model = next();
        break;
      case "--type":
        out.type = parseType(next());
        break;
      case "--image":
        out.imagePath = next();
        break;
      case "--out":
      case "-o":
        out.out = next();
        break;
      case "--system":
        out.system = next();
        break;
      case "--size":
        out.size = next();
        break;
      case "--aspect":
        out.aspect = next();
        break;
      case "--n":
        out.n = Number(next());
        break;
      case "--seed":
        out.seed = Number(next());
        break;
      case "--duration":
        out.duration = Number(next());
        break;
      case "--resolution":
        out.resolution = next();
        break;
      case "--fps":
        out.fps = Number(next());
        break;
      case "--json":
        out.json = true;
        break;
      case "--env-file":
        out.envFile = next();
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        if (arg.startsWith("-")) fail(`Unknown model option: ${arg}`);
        out.prompt = out.prompt ? `${out.prompt} ${arg}` : arg;
    }
  }
  return out;
}

function parseType(value: string): RequestType {
  if (value === "text" || value === "image" || value === "video") return value;
  fail(`Invalid --type: ${value} (expected text|image|video)`);
}
