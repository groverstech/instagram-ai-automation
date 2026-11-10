import "server-only";
import { mockActive } from "./mode";
import { DEFAULT_IMAGE_MODEL, IMAGE_SIZES, type ImageQuality, type ImageSize } from "./catalog";
import { ImageProviderError, ImageProviderUnavailable, ImageRefusedError } from "./errors";
import { headerRetryAfter } from "./errors";
import { baseRoute, resolveRoute, type ResolvedRoute } from "./routes";
import type { Usage } from "./llm";

/**
 * Image generation (OpenAI GPT image models): the provider adapter behind the `image.generate`
 * and `image.edit` routes (docs/AI_PROVIDERS.md). Generated images are AI imagery; brand photos
 * (approved product/reference assets) are handled in src/server/creative/visuals.ts and involve no
 * image model. Brand colours, fonts, logo and text are composited by our renderer, never drawn by
 * the model. Callers store the returned bytes through the storage abstraction (R2-ready).
 *
 * The API key stays on the server (OPENAI_API_KEY). Requests carry a keyed hash of the
 * organisation as `safety_identifier`, so abuse reports can be traced without sending our IDs.
 */
export type { ImageSize } from "./catalog";
export { ImageProviderError, ImageProviderUnavailable, ImageRefusedError } from "./errors";
export const IMAGE_SIZE_LIST = IMAGE_SIZES;

export type ImageResult = { data: Buffer; mime: string; model: string; size: ImageSize; quality?: ImageQuality; usage: Usage; requestId?: string | null };

export interface ImageProvider {
  readonly name: string;
  readonly model: string;
  generate(prompt: string, size: ImageSize): Promise<ImageResult>;
  /** A variation of `image` following `prompt` (creative iterations). */
  edit(prompt: string, image: { data: Buffer; mime: string }, size: ImageSize): Promise<ImageResult>;
}

const OPENAI_URL = () => (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");

type OpenAIImageResponse = {
  data?: { b64_json?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { text_tokens?: number; image_tokens?: number } };
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
  const usage: Usage = {
    images: 1,
    imageModel: route.model,
    imageInputTokens: json.usage?.input_tokens,
    imageTextInputTokens: json.usage?.input_tokens_details?.text_tokens,
    imageImageInputTokens: json.usage?.input_tokens_details?.image_tokens,
    imageOutputTokens: json.usage?.output_tokens,
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

const imagePricing = async (route: ResolvedRoute, size: ImageSize) => {
  const { imageCost } = await import("./pricing");
  const units = (u: Usage) => ({
    images: u.images ?? 0,
    inputTokens: u.imageInputTokens ?? 0,
    textInputTokens: u.imageTextInputTokens ?? 0,
    imageInputTokens: u.imageImageInputTokens ?? 0,
    outputTokens: u.imageOutputTokens ?? 0,
  });
  return {
    price: (u: Usage) =>
      imageCost({
        size,
        quality: route.quality,
        units: { images: u.images, inputTokens: u.imageInputTokens, outputTokens: u.imageOutputTokens, textInputTokens: u.imageTextInputTokens, imageInputTokens: u.imageImageInputTokens },
      }),
    units,
  };
};

/** Fold the call's estimated cost into the usage the run ledger sums. */
async function withCost(r: ImageResult, route: ResolvedRoute, size: ImageSize, total: Usage): Promise<ImageResult> {
  const { imageCost } = await import("./pricing");
  const c = imageCost({ size, quality: route.quality, units: { images: total.images, inputTokens: total.imageInputTokens, outputTokens: total.imageOutputTokens, textInputTokens: total.imageTextInputTokens, imageInputTokens: total.imageImageInputTokens } });
  return { ...r, usage: { ...total, ...(c.usd === null ? { unpricedImages: total.images ?? 1 } : { imageCostUsd: c.usd }) } };
}

async function routedImage(key: "image.generate" | "image.edit") {
  const { aiContext } = await import("./context");
  return resolveRoute(key, { brandId: aiContext().brandId });
}

const openaiImages: ImageProvider = {
  get name() {
    return `openai:${baseRoute("image.generate").model}`;
  },
  get model() {
    return baseRoute("image.generate").model;
  },
  async generate(prompt, size) {
    const route = await routedImage("image.generate");
    const { execute } = await import("./call");
    const sid = await safetyId();
    const out = await execute(route, await imagePricing(route, size), async () => {
      const r = await openaiRequest(
        "/images/generations",
        JSON.stringify({ model: route.model, prompt, size, quality: route.quality, n: 1, ...(sid ? { safety_identifier: sid } : {}) }),
        { "content-type": "application/json" },
        route,
        size,
      );
      return { value: r, usage: r.usage, requestId: r.requestId };
    });
    return withCost(out.value, route, size, out.usage);
  },
  async edit(prompt, image, size) {
    const route = await routedImage("image.edit");
    const { execute } = await import("./call");
    const sid = await safetyId();
    const out = await execute(route, await imagePricing(route, size), async () => {
      const form = new FormData();
      form.set("model", route.model);
      form.set("prompt", prompt);
      form.set("size", size);
      if (route.quality) form.set("quality", route.quality);
      form.set("n", "1");
      if (sid) form.set("safety_identifier", sid);
      const ext = image.mime === "image/jpeg" ? "jpg" : image.mime === "image/webp" ? "webp" : "png";
      form.append("image", new Blob([new Uint8Array(image.data)], { type: image.mime }), `source.${ext}`);
      const r = await openaiRequest("/images/edits", form, {}, route, size);
      return { value: r, usage: r.usage, requestId: r.requestId };
    });
    return withCost(out.value, route, size, out.usage);
  },
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
async function recordMockImage(route: "image.generate" | "image.edit") {
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
  async edit(_prompt, _image, size) {
    await recordMockImage("image.edit");
    return placeholder(size, "DEMO VARIATION");
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

export function imageStatus() {
  const p = imageProvider();
  return { ready: Boolean(p), provider: p?.name ?? "none", demo: p?.name === MOCK_IMAGE_PROVIDER, model: p && p.name !== MOCK_IMAGE_PROVIDER ? p.model : null, defaultModel: DEFAULT_IMAGE_MODEL };
}
