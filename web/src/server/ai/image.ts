import "server-only";
import { mockActive } from "./mode";

/**
 * Image generation providers (modular: add a provider here without touching callers).
 * Generated images are AI imagery; brand photos (approved product/reference assets) are handled
 * separately in src/server/creative/visuals.ts and involve no image model.
 */

export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024";
export type ImageResult = { data: Buffer; mime: string; model: string; size: ImageSize; usage?: { inputTokens?: number; outputTokens?: number } };

export interface ImageProvider {
  readonly name: string;
  readonly model: string;
  generate(prompt: string, size: ImageSize): Promise<ImageResult>;
}

export class ImageProviderUnavailable extends Error {}
/** The provider refused the prompt (content policy). The message is safe to show. */
export class ImageRefusedError extends Error {}
/** Any other provider failure; `status` is the HTTP status when there was a response. */
export class ImageProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const OPENAI_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";

const openaiImages: ImageProvider = {
  name: `openai:${OPENAI_MODEL}`,
  model: OPENAI_MODEL,
  async generate(prompt, size) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new ImageProviderUnavailable("OPENAI_API_KEY is not set.");
    let res: Response;
    try {
      res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: OPENAI_MODEL, prompt, size, quality: "high", n: 1 }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (e) {
      // No response: the request may or may not have been processed (and billed).
      throw new ImageProviderError(`Couldn't reach the image service (${e instanceof Error ? e.name : "network error"}).`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 400 && /content_policy|safety|moderation/i.test(body)) {
        throw new ImageRefusedError("The image service declined this prompt under its content policy. Edit the art direction and try again.");
      }
      throw new ImageProviderError(`The image service returned an error (${res.status}).`, res.status);
    }
    const json = (await res.json()) as { data: { b64_json: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    if (!json.data?.[0]?.b64_json) throw new ImageProviderError("The image service returned no image.", res.status);
    return { data: Buffer.from(json.data[0].b64_json, "base64"), mime: "image/png", model: OPENAI_MODEL, size, usage: { inputTokens: json.usage?.input_tokens, outputTokens: json.usage?.output_tokens } };
  },
};

/**
 * Demo mode only: a clearly labelled placeholder so the AI-image flow can be demonstrated
 * without calling (or paying) an image API. It never runs outside AI_PROVIDER=mock.
 */
export const MOCK_IMAGE_PROVIDER = "mock";
const mockImages: ImageProvider = {
  name: MOCK_IMAGE_PROVIDER,
  model: "mock",
  async generate(_prompt, size) {
    const [w, h] = size.split("x").map(Number);
    const stripes = Array.from({ length: Math.ceil((w + h) / 60) }, (_, i) => `<path d="M${i * 60 - h} ${h} L${i * 60} 0" stroke="#d9d4cc" stroke-width="18"/>`).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#ebe7e0"/>${stripes}<rect x="${w / 2 - 330}" y="${h / 2 - 70}" width="660" height="140" rx="18" fill="#1f1d1a"/><text x="50%" y="${h / 2 - 8}" font-family="sans-serif" font-size="44" font-weight="700" fill="#ffffff" text-anchor="middle">DEMO IMAGE</text><text x="50%" y="${h / 2 + 40}" font-family="sans-serif" font-size="26" fill="#d9d4cc" text-anchor="middle">no AI image provider was called</text></svg>`;
    const { default: sharp } = await import("sharp");
    return { data: await sharp(Buffer.from(svg)).png().toBuffer(), mime: "image/png", model: "mock", size };
  },
};

export function imageProvider(): ImageProvider | null {
  const p = (process.env.IMAGE_PROVIDER ?? "openai").toLowerCase();
  if (p === "none") return null;
  // Demo mode never calls a paid image API, even when a key is configured.
  if (mockActive()) return mockImages;
  if (p === "openai") return process.env.OPENAI_API_KEY ? openaiImages : null;
  return null;
}

export function imageStatus() {
  const p = imageProvider();
  return { ready: Boolean(p), provider: p?.name ?? "none", demo: p?.name === MOCK_IMAGE_PROVIDER };
}

/**
 * Estimated price of one generated image in USD, from configuration:
 * IMAGE_PRICE_USD_1024X1024 / _1024X1536 / _1536X1024, or IMAGE_PRICE_USD for all sizes.
 * Unconfigured → null ("unpriced"): we record the image count and never guess a price.
 */
export function imagePrice(size: ImageSize): number | null {
  const specific = process.env[`IMAGE_PRICE_USD_${size.toUpperCase()}`];
  const v = specific ?? process.env.IMAGE_PRICE_USD;
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
