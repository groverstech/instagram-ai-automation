import "server-only";
import type { Usage } from "./llm";
import { ANTHROPIC_PRICE_SOURCE, ANTHROPIC_WEB_SEARCH_PER_1K, TEXT_MODELS, type ImageQuality, type ImageSize, type TextPrice } from "./catalog";

/**
 * Cost estimates (USD) for AI usage tracking. Prices come from the catalog (catalog.ts) or from
 * configuration, never from guesses: anything that can't be priced is reported as unpriced
 * (`usd: null`), and its units are still recorded. Estimates are for budgets and dashboards; the
 * providers' own reports stay the billing source of truth.
 */
export type Priced = { usd: number | null; source: string };
export const UNPRICED = "unpriced";

type Env = Record<string, string | undefined>;
function envNum(env: Env, name: string): number | undefined {
  const v = env[name];
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
const round = (n: number) => Math.round(n * 1e6) / 1e6;

export type TextUnits = {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  /** All cache writes; `cacheWrite1hTokens` is the part written with the 1-hour TTL. */
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
  webSearches?: number;
};

/**
 * Price of a text call. AI_PRICE_INPUT_PER_MTOK / AI_PRICE_OUTPUT_PER_MTOK /
 * AI_PRICE_WEB_SEARCH_PER_1K override the list prices (for a negotiated contract).
 */
export function textCost(u: TextUnits, env: Env = process.env): Priced {
  const entry = u.model ? TEXT_MODELS[u.model] : undefined;
  if (!entry) return { usd: null, source: UNPRICED };
  const promptTokens = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  const base: TextPrice = entry.longContext && promptTokens > entry.longContext.aboveTokens ? entry.longContext.price : entry.price;
  const inOverride = envNum(env, "AI_PRICE_INPUT_PER_MTOK");
  const outOverride = envNum(env, "AI_PRICE_OUTPUT_PER_MTOK");
  const searchOverride = envNum(env, "AI_PRICE_WEB_SEARCH_PER_1K");
  const p = { ...base, input: inOverride ?? base.input, output: outOverride ?? base.output };
  const w1h = Math.min(u.cacheWrite1hTokens ?? 0, u.cacheWriteTokens ?? 0);
  const w5m = (u.cacheWriteTokens ?? 0) - w1h;
  const usd =
    ((u.inputTokens ?? 0) * p.input + (u.outputTokens ?? 0) * p.output + (u.cacheReadTokens ?? 0) * p.cacheRead + w5m * p.cacheWrite5m + w1h * p.cacheWrite1h) / 1_000_000 +
    ((u.webSearches ?? 0) * (searchOverride ?? ANTHROPIC_WEB_SEARCH_PER_1K)) / 1000;
  const configured = inOverride !== undefined || outOverride !== undefined || ((u.webSearches ?? 0) > 0 && searchOverride !== undefined);
  return { usd: round(usd), source: configured ? "config" : ANTHROPIC_PRICE_SOURCE };
}

export type ImageUnits = { images?: number; inputTokens?: number; outputTokens?: number; textInputTokens?: number; imageInputTokens?: number };

/**
 * Price of an image call, from configuration only (no built-in OpenAI prices):
 *   1. per token, when OPENAI_IMAGE_PRICE_OUTPUT_PER_MTOK and an input price are set and the
 *      provider reported token usage: OPENAI_IMAGE_PRICE_TEXT_INPUT_PER_MTOK,
 *      OPENAI_IMAGE_PRICE_IMAGE_INPUT_PER_MTOK (falls back to the text input price);
 *   2. per image: IMAGE_PRICE_USD_<QUALITY>_<SIZE>, then IMAGE_PRICE_USD_<SIZE>, then IMAGE_PRICE_USD;
 *   3. otherwise unpriced.
 */
export function imageCost(o: { size: ImageSize; quality?: ImageQuality; units: ImageUnits }, env: Env = process.env): Priced {
  const outRate = envNum(env, "OPENAI_IMAGE_PRICE_OUTPUT_PER_MTOK");
  const textIn = envNum(env, "OPENAI_IMAGE_PRICE_TEXT_INPUT_PER_MTOK");
  const imageIn = envNum(env, "OPENAI_IMAGE_PRICE_IMAGE_INPUT_PER_MTOK") ?? textIn;
  const u = o.units;
  if (outRate !== undefined && textIn !== undefined && u.outputTokens !== undefined) {
    const textTokens = u.textInputTokens ?? (u.imageInputTokens === undefined ? (u.inputTokens ?? 0) : Math.max(0, (u.inputTokens ?? 0) - u.imageInputTokens));
    const usd = (textTokens * textIn + (u.imageInputTokens ?? 0) * (imageIn ?? textIn) + u.outputTokens * outRate) / 1_000_000;
    return { usd: round(usd), source: "config:tokens" };
  }
  const n = u.images ?? 1;
  const size = o.size.toUpperCase();
  const perImage =
    (o.quality ? envNum(env, `IMAGE_PRICE_USD_${o.quality.toUpperCase()}_${size}`) : undefined) ?? envNum(env, `IMAGE_PRICE_USD_${size}`) ?? envNum(env, "IMAGE_PRICE_USD");
  if (perImage !== undefined) return { usd: round(perImage * n), source: "config:per-image" };
  return { usd: null, source: UNPRICED };
}

/** True when image costs are configured (Creative Studio says so before generating). */
export function imagesPriced(env: Env = process.env): boolean {
  return imageCost({ size: "1024x1024", quality: "high", units: { images: 1, inputTokens: 0, outputTokens: 0 } }, env).usd !== null;
}

/**
 * Estimated USD cost of a run's aggregated usage (agent_runs.cost_usd). Unpriced parts count as
 * 0 here; the usage ledger keeps them visible as unpriced.
 */
export function estimateCost(u: Usage | undefined | null): number {
  if (!u) return 0;
  const text = u.model ? (textCost(u).usd ?? 0) : 0;
  return round(text + (u.imageCostUsd ?? 0));
}

export function addUsage(a: Usage, b: Usage | undefined): Usage {
  if (!b) return a;
  const sum = (x?: number, y?: number) => (x ?? 0) + (y ?? 0) || undefined;
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
    cacheWrite1hTokens: sum(a.cacheWrite1hTokens, b.cacheWrite1hTokens),
    webSearches: (a.webSearches ?? 0) + (b.webSearches ?? 0),
    unknownUsageAttempts: sum(a.unknownUsageAttempts, b.unknownUsageAttempts),
    images: sum(a.images, b.images),
    imageCostUsd: sum(a.imageCostUsd, b.imageCostUsd),
    unpricedImages: sum(a.unpricedImages, b.unpricedImages),
    model: b.model ?? a.model,
    imageModel: b.imageModel ?? a.imageModel,
  };
}
