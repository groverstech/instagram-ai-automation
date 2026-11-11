/**
 * The single list of AI providers, models and list prices (docs/AI_PROVIDERS.md). Nothing else in
 * the app names a model or a price: routes (routes.ts) pick models from here, and costs
 * (pricing.ts) are computed from here.
 *
 * Prices are **estimates for budgeting and dashboards**, not invoices. The providers' own usage
 * and cost reports stay the billing source of truth; every usage event stores the provider's
 * request ID so the two can be reconciled.
 *
 * - **Anthropic:** list prices from https://platform.claude.com/docs/en/about-claude/pricing,
 *   retrieved 2026-11-10. Update the table (and ANTHROPIC_PRICES_RETRIEVED) when they change.
 * - **OpenAI images:** per-token list prices from https://developers.openai.com/api/docs/pricing
 *   (Images, standard), retrieved 2026-11-11; the rates for GPT Image 2.5 are the same per the image
 *   generation guide. Image cost = text input + image input (edits) + image output tokens, from
 *   the usage each response reports. There is no per-image price.
 * - **Updating prices needs no code change:** rows in the `ai_prices` table (a negotiated
 *   contract or a list-price change) take precedence over these defaults (pricing.ts).
 *
 * No server-only import: also used by tests and the configuration check.
 */

export type TextPrice = {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
};

export type TextModel = {
  provider: "anthropic";
  label: string;
  price: TextPrice;
  /** Server-side refusal fallbacks (`fallbacks: "default"`); not available on Haiku 5.5. */
  serverFallback: boolean;
  /** Web search tool version for research routes; null = not used for research. */
  webSearchTool: "web_search_20260209" | null;
  /** Higher rates when the prompt (input, cache reads and writes) exceeds `aboveTokens`. */
  longContext?: { aboveTokens: number; price: TextPrice };
};

export const ANTHROPIC_PRICES_RETRIEVED = "2026-11-10";
export const ANTHROPIC_PRICE_SOURCE = `anthropic-list-${ANTHROPIC_PRICES_RETRIEVED}`;

export const TEXT_MODELS: Record<string, TextModel> = {
  "claude-opus-5-5": {
    provider: "anthropic",
    label: "Claude Opus 5.5",
    price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
    serverFallback: true,
    webSearchTool: "web_search_20260209",
  },
  "claude-sonnet-5-5": {
    provider: "anthropic",
    label: "Claude Sonnet 5.5",
    price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 },
    serverFallback: true,
    webSearchTool: "web_search_20260209",
  },
  "claude-haiku-5-5": {
    provider: "anthropic",
    label: "Claude Haiku 5.5",
    price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
    longContext: { aboveTokens: 100_000, price: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1 } },
    serverFallback: false,
    webSearchTool: null,
  },
};

/** Anthropic web search: USD per 1,000 searches (failed searches aren't billed). */
export const ANTHROPIC_WEB_SEARCH_PER_1K = 10;

/**
 * The default text model for every text route (the approved plan: Claude Opus 5.5). Changing it,
 * or routing a job to another model, is a configuration decision (ANTHROPIC_MODEL or a route
 * override), made after evaluation.
 */
export const DEFAULT_TEXT_MODEL = "claude-opus-5-5";

/** USD per million tokens for an OpenAI GPT image model. */
export type ImagePrice = {
  textInput: number;
  textCachedInput: number;
  imageInput: number;
  imageCachedInput: number;
  imageOutput: number;
};

export const OPENAI_PRICES_RETRIEVED = "2026-11-11";
export const OPENAI_PRICE_SOURCE = `openai-list-${OPENAI_PRICES_RETRIEVED}`;
const GPT_IMAGE_2X_PRICE: ImagePrice = { textInput: 5, textCachedInput: 1.25, imageInput: 8, imageCachedInput: 2, imageOutput: 30 };

/**
 * Image models the OpenAI adapter may be routed to (identifiers from the official `openai` SDK's
 * `ImageModel` type v7.55.0 and OpenAI's model pages; all support v1/images/generations and
 * v1/images/edits). `gpt-image-1` was shut down on 2026-10-23 and isn't listed.
 *   - Flare: "image generation and editing for fast iteration": the default for generation and
 *     variations.
 *   - Sunburst: "image generation and editing for detailed visual work": the default for
 *     precision edits.
 * GPT Image 2.5 stays available as a configured fallback. Choosing a model is configuration
 * (OPENAI_IMAGE_MODEL, OPENAI_IMAGE_EDIT_MODEL or a route override), never a code change.
 */
export const IMAGE_MODELS = ["gpt-image-2.6-flare", "gpt-image-2.6-sunburst", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const;
export type ImageModelId = (typeof IMAGE_MODELS)[number];
export const IMAGE_MODEL_INFO: Record<ImageModelId, { label: string; price: ImagePrice }> = {
  "gpt-image-2.6-flare": { label: "GPT Image 2.6 Flare", price: GPT_IMAGE_2X_PRICE },
  "gpt-image-2.6-sunburst": { label: "GPT Image 2.6 Sunburst", price: GPT_IMAGE_2X_PRICE },
  "gpt-image-2.5-flare": { label: "GPT Image 2.5 Flare", price: GPT_IMAGE_2X_PRICE },
  "gpt-image-2.5-sunburst": { label: "GPT Image 2.5 Sunburst", price: GPT_IMAGE_2X_PRICE },
};
export const DEFAULT_IMAGE_MODEL: ImageModelId = "gpt-image-2.6-flare";
export const DEFAULT_IMAGE_EDIT_MODEL: ImageModelId = "gpt-image-2.6-sunburst";

/** Rendering quality (all listed models support these five). */
export const IMAGE_QUALITIES = ["low", "medium", "high", "xhigh", "max"] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];
export const DEFAULT_IMAGE_QUALITY: ImageQuality = "high";
/** How much the model plans before rendering (no separate fee; the API defaults to high). */
export const IMAGE_COMPLEXITIES = ["low", "medium", "high"] as const;
export type ImageComplexity = (typeof IMAGE_COMPLEXITIES)[number];

export const IMAGE_SIZES = ["1024x1024", "1024x1536", "1536x1024"] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

export function isTextModel(model: string): boolean {
  return Object.hasOwn(TEXT_MODELS, model);
}

export function isImageModel(model: string): model is ImageModelId {
  return (IMAGE_MODELS as readonly string[]).includes(model);
}
