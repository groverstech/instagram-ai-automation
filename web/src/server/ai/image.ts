import "server-only";
import { mockActive } from "./mode";
import { IMAGE_MODEL_INFO, IMAGE_SIZES, type ImageModelId, type ImageQuality, type ImageSize } from "./catalog";
import { ImageProviderError, ImageProviderUnavailable, ImageRefusedError } from "./errors";
import { headerRetryAfter } from "./errors";
import { baseRoute, resolveRoute, type ResolvedRoute } from "./routes";
import type { Usage } from "./llm";

/**
 * Image generation and editing (OpenAI GPT Image 2.6): the provider adapter behind the
 * `image.generate`, `image.variation` and `image.edit` routes (docs/AI_PROVIDERS.md).
 *   - generate: a new image from art direction (default model: Flare);
 *   - variation: the same subject and mood, a fresh composition (Flare, via v1/images/edits);
 *   - edit: a precise change to the current image from an instruction (Sunburst, v1/images/edits).
 * Brand colours, fonts, logo and text are composited by our renderer, never drawn by the model.
 * Callers store the returned bytes through the storage abstraction (R2-ready).
 *
 * The API key stays on the server (OPENAI_API_KEY). Requests carry a keyed hash of the
 * organisation as `safety_identifier`, so abuse reports can be traced without sending our IDs.
 * Each response's token usage (text and image input, image and text output) is recorded and
 * priced per token (pricing.ts); there is no per-image price.
 */
export type { ImageSize } from "./catalog";
export { ImageProviderError, ImageProviderUnavailable, ImageRefusedError } from "./errors";
export const IMAGE_SIZE_LIST = IMAGE_SIZES;

export type ImageResult = { data: Buffer; mime: string; model: string; size: ImageSize; quality?: ImageQuality; usage: Usage; requestId?: string | null };
type Source = { data: Buffer; mime: string };

export interface ImageProvider {
  readonly name: string;
  readonly model: string;
  generate(prompt: string, size: ImageSize): Promise<ImageResult>;
  /** A variation of `image` following `prompt` (creative iterations). */
  variation(prompt: string, image: Source, size: ImageSize): Promise<ImageResult>;
  /** A precise edit of `image` following `instruction`, keeping everything else. */
  edit(instruction: string, image: Source, size: ImageSize): Promise<ImageResult>;
}

const OPENAI_URL = () => (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");

type OpenAIImageResponse = {
  data?: { b64_json?: string }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { text_tokens?: number; image_tokens?: number };
    output_tokens_details?: { text_tokens?: number; image_tokens?: number };
  };
};

/** One HTTP attempt. Errors are classified (errors.ts); the executor decides about retries. */
async function openaiRequest(path: string, body: BodyInit, headers: Record<string, string>, route: ResolvedRoute, size: ImageSize): Promise<ImageResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new ImageProviderUnavailable("OPENAI_API_KEY is not set.");
  let res: Response;
  try {
    res = await globalThis.fetch(`${OPENAI_URL()}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, ...headers },
      body,
      signal: AbortSignal.timeout(route.timeoutMs),
      redirect: "error",
    });
  } catch (e) {
    // No response: the request may or may not have been processed (and billed).
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new ImageProviderError(`Couldn't reach the image service (${timeout ? "timed out" : "network error"}).`, undefined, { reason: timeout ? "timeout" : "network" });
  }
  const requestId = res.headers.get("x-request-id") ?? undefined;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let err: { code?: string; type?: string } = {};
    try {
      err = (JSON.parse(text) as { error?: { code?: string; type?: string } }).error ?? {};
    } catch {
      // not JSON
    }
    const code = err.code ?? err.type;
    if (res.status === 400 && (code === "moderation_blocked" || code === "content_policy_violation" || /content_policy|safety|moderation/i.test(text))) {
      throw new ImageRefusedError("The image service declined this prompt under its content policy. Edit the art direction and try again.", requestId);
    }
    const shouldRetry = res.headers.get("x-should-retry");
    throw new ImageProviderError(`The image service returned an error (${res.status}).`, res.status, {
      code,
      requestId,
      retryAfterMs: headerRetryAfter(res.headers),
      shouldRetry: shouldRetry === "true" ? true : shouldRetry === "false" ? false : undefined,
    });
  }
  const json = (await res.json().catch(() => ({}))) as OpenAIImageResponse;
  const u = json.usage;
  const usage: Usage = {
    images: 1,
    imageModel: route.model,
    imageInputTokens: u?.input_tokens,
    imageTextInputTokens: u?.input_tokens_details?.text_tokens,
    imageImageInputTokens: u?.input_tokens_details?.image_tokens,
    imageOutputTokens: u?.output_tokens,
    imageOutputImageTokens: u?.output_tokens_details?.image_tokens,
    imageOutputTextTokens: u?.output_tokens_details?.text_tokens,
  };
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) {
    // Answered without an image: treat as a provider failure (the response may have been billed).
    const { attachUsage } = await import("./llm");
    throw attachUsage(new ImageProviderError("The image service returned no image.", 502, { requestId }), usage);
  }
  return { data: Buffer.from(b64, "base64"), mime: "image/png", model: route.model, size, quality: route.quality, usage, requestId };
}

async function safetyId(): Promise<string | undefined> {
  const { aiContext } = await import("./context");
  const ws = aiContext().workspaceId;
  if (!ws) return undefined;
  const { keyedHash } = await import("../crypto");
  return keyedHash(`org:${ws}`, 32);
}

const unitsOf = (u: Usage) => ({
  images: u.images ?? 0,
  inputTokens: u.imageInputTokens ?? 0,
  textInputTokens: u.imageTextInputTokens ?? 0,
  imageInputTokens: u.imageImageInputTokens ?? 0,
  outputTokens: u.imageOutputTokens ?? 0,
  imageOutputTokens: u.imageOutputImageTokens ?? 0,
  textOutputTokens: u.imageOutputTextTokens ?? 0,
});
const priceUnitsOf = (u: Usage) => ({
  images: u.images,
  inputTokens: u.imageInputTokens,
  textInputTokens: u.imageTextInputTokens,
  imageInputTokens: u.imageImageInputTokens,
  outputTokens: u.imageOutputTokens,
  imageOutputTokens: u.imageOutputImageTokens,
  textOutputTokens: u.imageOutputTextTokens,
});

async function pricingFor(route: ResolvedRoute, size: ImageSize) {
  const { imageCost } = await import("./pricing");
  return {
    price: (u: Usage) => imageCost({ model: u.imageModel ?? route.model, units: priceUnitsOf(u) }),
    units: unitsOf,
    params: { quality: route.quality, size, complexity: route.complexity },
  };
}

/** Fold the call's estimated cost into the usage the run ledger sums. */
async function withCost(r: ImageResult, route: ResolvedRoute, total: Usage): Promise<ImageResult> {
  const { imageCost } = await import("./pricing");
  const c = imageCost({ model: route.model, units: priceUnitsOf(total) });
  return { ...r, usage: { ...total, ...(c.usd === null ? { unpricedImages: total.images ?? 1 } : { imageCostUsd: c.usd }) } };
}

async function routed(key: "image.generate" | "image.variation" | "image.edit") {
  const { aiContext } = await import("./context");
  return resolveRoute(key, { brandId: aiContext().brandId });
}

/** One generation or edit request through the executor. */
async function run(key: "image.generate" | "image.variation" | "image.edit", prompt: string, size: ImageSize, source?: Source): Promise<ImageResult> {
  const route = await routed(key);
  const { execute } = await import("./call");
  const sid = await safetyId();
  const out = await execute(route, await pricingFor(route, size), async () => {
    let r: ImageResult;
    if (!source) {
      r = await openaiRequest(
        "/images/generations",
        JSON.stringify({ model: route.model, prompt, size, quality: route.quality, n: 1, ...(route.complexity ? { complexity: route.complexity } : {}), ...(sid ? { safety_identifier: sid } : {}) }),
        { "content-type": "application/json" },
        route,
        size,
      );
    } else {
      const form = new FormData();
      form.set("model", route.model);
      form.set("prompt", prompt);
      form.set("size", size);
      if (route.quality) form.set("quality", route.quality);
      if (route.complexity) form.set("complexity", route.complexity);
      form.set("n", "1");
      if (sid) form.set("safety_identifier", sid);
      const ext = source.mime === "image/jpeg" ? "jpg" : source.mime === "image/webp" ? "webp" : "png";
      form.append("image", new Blob([new Uint8Array(source.data)], { type: source.mime }), `source.${ext}`);
      r = await openaiRequest("/images/edits", form, {}, route, size);
    }
    return { value: r, usage: r.usage, requestId: r.requestId };
  });
  return withCost(out.value, route, out.usage);
}

const openaiImages: ImageProvider = {
  get name() {
    return `openai:${baseRoute("image.generate").model}`;
  },
  get model() {
    return baseRoute("image.generate").model;
  },
  generate: (prompt, size) => run("image.generate", prompt, size),
  variation: (prompt, image, size) => run("image.variation", prompt, size, image),
  edit: (instruction, image, size) => run("image.edit", instruction, size, image),
};

/**
 * Demo mode only: a clearly labelled placeholder so the AI-image flow can be demonstrated
 * without calling (or paying) an image API. It never runs outside AI_PROVIDER=mock. Recorded in
 * the usage ledger as provider "mock", never as real usage.
 */
export const MOCK_IMAGE_PROVIDER = "mock";
async function placeholder(size: ImageSize, label: string): Promise<ImageResult> {
  const [w, h] = size.split("x").map(Number);
  const stripes = Array.from({ length: Math.ceil((w + h) / 60) }, (_, i) => `<path d="M${i * 60 - h} ${h} L${i * 60} 0" stroke="#d9d4cc" stroke-width="18"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#ebe7e0"/>${stripes}<rect x="${w / 2 - 330}" y="${h / 2 - 70}" width="660" height="140" rx="18" fill="#1f1d1a"/><text x="50%" y="${h / 2 - 8}" font-family="sans-serif" font-size="44" font-weight="700" fill="#ffffff" text-anchor="middle">${label}</text><text x="50%" y="${h / 2 + 40}" font-family="sans-serif" font-size="26" fill="#d9d4cc" text-anchor="middle">no AI image provider was called</text></svg>`;
  const { default: sharp } = await import("sharp");
  return { data: await sharp(Buffer.from(svg)).png().toBuffer(), mime: "image/png", model: "mock", size, usage: {} };
}
async function recordMockImage(route: "image.generate" | "image.variation" | "image.edit") {
  const { recordAttempt } = await import("./usage");
  await recordAttempt({ route, provider: "mock", model: "mock", kind: "image", attempt: 1, outcome: "success", priceSource: "demo" });
}
const mockImages: ImageProvider = {
  name: MOCK_IMAGE_PROVIDER,
  model: "mock",
  async generate(_prompt, size) {
    await recordMockImage("image.generate");
    return placeholder(size, "DEMO IMAGE");
  },
  async variation(_prompt, _image, size) {
    await recordMockImage("image.variation");
    return placeholder(size, "DEMO VARIATION");
  },
  async edit(_instruction, _image, size) {
    await recordMockImage("image.edit");
    return placeholder(size, "DEMO EDIT");
  },
};

export function imageProvider(): ImageProvider | null {
  const p = (process.env.IMAGE_PROVIDER ?? "openai").trim().toLowerCase() || "openai";
  if (p === "none") return null;
  // Demo mode never calls a paid image API, even when a key is configured.
  if (mockActive()) return mockImages;
  if (p === "openai") return process.env.OPENAI_API_KEY ? openaiImages : null;
  return null;
}

export function imageModelLabel(model: string): string {
  return (IMAGE_MODEL_INFO as Record<string, { label: string } | undefined>)[model]?.label ?? model;
}

export function imageStatus() {
  const p = imageProvider();
  const gen = baseRoute("image.generate");
  const edit = baseRoute("image.edit");
  return {
    ready: Boolean(p),
    provider: p?.name ?? "none",
    demo: p?.name === MOCK_IMAGE_PROVIDER,
    model: p && p.name !== MOCK_IMAGE_PROVIDER ? (gen.model as ImageModelId) : null,
    editModel: p && p.name !== MOCK_IMAGE_PROVIDER ? (edit.model as ImageModelId) : null,
  };
}
