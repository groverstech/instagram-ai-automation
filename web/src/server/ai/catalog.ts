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

/**
 * Models that may answer through a server-side fallback (`fallbacks: "default"`) but can't be chosen
 * for a route. Priced so a fallback-served attempt is costed rather than left unpriced, and so the
 * spending cap's worst case can include them. Source: Anthropic's Claude API reference (its model
 * pricing table, dated 2026-11-03, read 2026-11-21): Opus 5 and Opus 4.8 $5 in / $25 out, Sonnet 5
 * $2 / $10; its prompt-caching guide: cache reads 0.1x input on these models, cache writes 1.25x
 * (5-minute) and 2x (1-hour). Recorded with their own price source (FALLBACK_PRICE_SOURCE).
 */
export const FALLBACK_PRICE_SOURCE = "anthropic-list-2026-11-03";
export const FALLBACK_TEXT_MODELS: Record<string, { label: string; price: TextPrice }> = {
  "claude-opus-5": { label: "Claude Opus 5", price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 } },
  "claude-opus-4-8": { label: "Claude Opus 4.8", price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 } },
  "claude-sonnet-5": { label: "Claude Sonnet 5", price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 } },
};

/**
 * The models a server-side fallback may hand a request to, per routed model (Anthropic's
 * `allowed_fallback_models`; with "default" Anthropic picks among them by refusal category). From the
 * Claude API reference: Opus 5.5 → Opus 5, Opus 4.8 ("expect Claude Opus 5 / claude-opus-4-8"; the
 * authoritative list is `allowed_fallback_models` on the model's /v1/models entry, not yet checked
 * live); Sonnet 5.5 → Sonnet 5 (its only fallback target). A fallback to a model outside this list is
 * still recorded: priced if catalogued, otherwise unpriced and counted at its reserve.
 * Each may run at most once in a chain, after the routed model, so the spending cap's worst case
 * for one request is the routed model's plus every target's (routeWorstCaseUsd).
 */
export const SERVER_FALLBACK_TARGETS: Record<string, string[]> = {
  "claude-opus-5-5": ["claude-opus-5", "claude-opus-4-8"],
  "claude-sonnet-5-5": ["claude-sonnet-5"],
};

/**
 * Routed models whose fallback-target list above is confirmed exact, not merely expected. Sonnet 5.5:
 * the Claude API reference states its fallbacks "may name only `claude-sonnet-5`". Opus 5.5 is NOT
 * confirmed: the reference says to read `allowed_fallback_models` from the Models API and only to
 * "expect" Opus 5 and Opus 4.8. Under a spending cap, a model whose list isn't confirmed is sent
 * without server-side fallbacks (llm.ts serverFallbacksAllowed), and a request that still asks for
 * them in any form ("default", a list, or the fallback beta) is refused before it is sent. Add a model here only
 * once its list has been checked against `allowed_fallback_models`.
 */
export const FALLBACK_TARGETS_CONFIRMED: ReadonlySet<string> = new Set(["claude-sonnet-5-5"]);

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
