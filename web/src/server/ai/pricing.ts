import "server-only";
import type { Usage } from "./llm";
import {
  ANTHROPIC_PRICE_SOURCE,
  ANTHROPIC_WEB_SEARCH_PER_1K,
  IMAGE_MODEL_INFO,
  OPENAI_PRICE_SOURCE,
  TEXT_MODELS,
  type ImagePrice,
  type TextPrice,
} from "./catalog";

/**
 * Cost estimates (USD) for AI usage tracking (docs/AI_PROVIDERS.md). Rates, highest priority first:
 *   1. the `ai_prices` table: the latest row in effect for the model (a negotiated contract or
 *      a list-price change; no code change, no redeploy; refreshed every minute);
 *   2. environment variables (AI_PRICE_* for Claude, OPENAI_IMAGE_PRICE_* for images);
 *   3. the dated list prices in catalog.ts.
 * Costs are computed from the usage each response reports. Anything that can't be priced is
 * reported as unpriced (`usd: null`), never guessed, and its units are still recorded. These are
 * **estimates**: provider-confirmed amounts are recorded separately (billing.ts).
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

// ---------------------------------------------------------------- ai_prices overrides

export type PriceOverride = { model: string; rates: Record<string, number>; source: string };
let overrides = new Map<string, PriceOverride>();
let loadedAt = 0;
const OVERRIDE_TTL_MS = 60_000;

/** Load the price rows in effect now (cached for a minute). Never throws: defaults then apply. */
export async function refreshPriceOverrides(opts: { force?: boolean; now?: Date } = {}) {
  if (!opts.force && Date.now() - loadedAt < OVERRIDE_TTL_MS) return;
  try {
    const { getDb, schema } = await import("../db/client");
    const { lte, desc } = await import("drizzle-orm");
    const db = await getDb();
    const rows = await db
      .select()
      .from(schema.aiPrices)
      .where(lte(schema.aiPrices.effectiveFrom, opts.now ?? new Date()))
      .orderBy(desc(schema.aiPrices.effectiveFrom));
    const next = new Map<string, PriceOverride>();
    for (const r of rows) if (!next.has(r.model)) next.set(r.model, { model: r.model, rates: sanitize(r.rates), source: `ai_prices:${r.source}` });
    overrides = next;
    loadedAt = Date.now();
  } catch (e) {
    const { log } = await import("../log");
    log.error("ai.price_overrides_unavailable", { error: e instanceof Error ? e.message : String(e) });
  }
}
function sanitize(r: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(r ?? {})) if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
  return out;
}
/** Tests only. */
export function setPriceOverrides(list: PriceOverride[]) {
  overrides = new Map(list.map((o) => [o.model, o]));
  loadedAt = Date.now();
}

// ---------------------------------------------------------------- text (Anthropic)

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

export function textCost(u: TextUnits, env: Env = process.env): Priced {
  const entry = u.model ? TEXT_MODELS[u.model] : undefined;
  const o = u.model ? overrides.get(u.model) : undefined;
  if (!entry && !o) return { usd: null, source: UNPRICED };
  const promptTokens = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  const listed: Partial<TextPrice> = entry ? (entry.longContext && promptTokens > entry.longContext.aboveTokens ? entry.longContext.price : entry.price) : {};
  const inEnv = envNum(env, "AI_PRICE_INPUT_PER_MTOK");
  const outEnv = envNum(env, "AI_PRICE_OUTPUT_PER_MTOK");
  const searchEnv = envNum(env, "AI_PRICE_WEB_SEARCH_PER_1K");
  const r = o?.rates ?? {};
  const p = {
    input: r.input ?? inEnv ?? listed.input,
    output: r.output ?? outEnv ?? listed.output,
    cacheRead: r.cacheRead ?? listed.cacheRead,
    cacheWrite5m: r.cacheWrite5m ?? listed.cacheWrite5m,
    cacheWrite1h: r.cacheWrite1h ?? listed.cacheWrite1h,
    webSearchPer1k: r.webSearchPer1k ?? searchEnv ?? ANTHROPIC_WEB_SEARCH_PER_1K,
  };
  const w1h = Math.min(u.cacheWrite1hTokens ?? 0, u.cacheWriteTokens ?? 0);
  const w5m = (u.cacheWriteTokens ?? 0) - w1h;
  const parts: [number, number | undefined][] = [
    [u.inputTokens ?? 0, p.input],
    [u.outputTokens ?? 0, p.output],
    [u.cacheReadTokens ?? 0, p.cacheRead],
    [w5m, p.cacheWrite5m],
    [w1h, p.cacheWrite1h],
  ];
  // Every unit used needs a rate; otherwise the call is unpriced rather than under-counted.
  if (parts.some(([n, rate]) => n > 0 && rate === undefined)) return { usd: null, source: UNPRICED };
  const usd = parts.reduce((s, [n, rate]) => s + n * (rate ?? 0), 0) / 1_000_000 + ((u.webSearches ?? 0) * p.webSearchPer1k) / 1000;
  const source = o ? o.source : inEnv !== undefined || outEnv !== undefined || ((u.webSearches ?? 0) > 0 && searchEnv !== undefined) ? "config" : ANTHROPIC_PRICE_SOURCE;
  return { usd: round(usd), source };
}

// ---------------------------------------------------------------- images (OpenAI)

/** Token usage reported by an image response (input split by modality, output split too). */
export type ImageUnits = {
  images?: number;
  inputTokens?: number;
  textInputTokens?: number;
  imageInputTokens?: number;
  outputTokens?: number;
  imageOutputTokens?: number;
  textOutputTokens?: number;
};

/** The rates that apply to an image model now, and where they come from. */
export function imageRates(model: string, env: Env = process.env): { rates: Partial<ImagePrice>; source: string } | null {
  const o = overrides.get(model);
  if (o) return { rates: o.rates as Partial<ImagePrice>, source: o.source };
  const list = (IMAGE_MODEL_INFO as Record<string, { price: ImagePrice } | undefined>)[model]?.price;
  const fromEnv: Partial<ImagePrice> = {
    textInput: envNum(env, "OPENAI_IMAGE_PRICE_TEXT_INPUT_PER_MTOK"),
    imageInput: envNum(env, "OPENAI_IMAGE_PRICE_IMAGE_INPUT_PER_MTOK"),
    imageOutput: envNum(env, "OPENAI_IMAGE_PRICE_OUTPUT_PER_MTOK"),
  };
  const configured = Object.values(fromEnv).some((v) => v !== undefined);
  if (!list && !configured) return null;
  const rates = { ...(list ?? {}), ...Object.fromEntries(Object.entries(fromEnv).filter(([, v]) => v !== undefined)) } as Partial<ImagePrice>;
  return { rates, source: configured ? "config" : OPENAI_PRICE_SOURCE };
}

/**
 * Price of an image call from the token usage the response reported:
 * text input + image input (edits) + image output tokens, at the model's per-token rates. No usage
 * reported means no estimate (unpriced). Text output tokens have no published image-model rate:
 * if any are reported, they're recorded and the source says so.
 */
export function imageCost(o: { model: string; units: ImageUnits }, env: Env = process.env): Priced {
  const r = imageRates(o.model, env);
  const u = o.units;
  if (!r || u.outputTokens === undefined || u.inputTokens === undefined) return { usd: null, source: UNPRICED };
  const imageIn = u.imageInputTokens ?? 0;
  const textIn = u.textInputTokens ?? Math.max(0, u.inputTokens - imageIn);
  const textOut = u.textOutputTokens ?? 0;
  const imageOut = u.imageOutputTokens ?? Math.max(0, u.outputTokens - textOut);
  const { textInput, imageInput, imageOutput } = r.rates;
  if ((textIn > 0 && textInput === undefined) || (imageIn > 0 && imageInput === undefined) || (imageOut > 0 && imageOutput === undefined)) return { usd: null, source: UNPRICED };
  const usd = (textIn * (textInput ?? 0) + imageIn * (imageInput ?? 0) + imageOut * (imageOutput ?? 0)) / 1_000_000;
  return { usd: round(usd), source: textOut > 0 ? `${r.source}; text output unpriced` : r.source };
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
    imageInputTokens: sum(a.imageInputTokens, b.imageInputTokens),
    imageTextInputTokens: sum(a.imageTextInputTokens, b.imageTextInputTokens),
    imageImageInputTokens: sum(a.imageImageInputTokens, b.imageImageInputTokens),
    imageOutputTokens: sum(a.imageOutputTokens, b.imageOutputTokens),
    imageOutputImageTokens: sum(a.imageOutputImageTokens, b.imageOutputImageTokens),
    imageOutputTextTokens: sum(a.imageOutputTextTokens, b.imageOutputTextTokens),
    imageCostUsd: sum(a.imageCostUsd, b.imageCostUsd),
    unpricedImages: sum(a.unpricedImages, b.unpricedImages),
    model: b.model ?? a.model,
    imageModel: b.imageModel ?? a.imageModel,
  };
}
