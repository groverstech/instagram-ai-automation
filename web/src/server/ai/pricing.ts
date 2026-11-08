import "server-only";
import type { Usage } from "./llm";

/**
 * Cost estimates for AI usage tracking (USD). Prices are list prices per million tokens and per
 * 1,000 web searches; override with env vars when your contract differs. These are estimates for
 * budgeting and dashboards, not invoices: the Anthropic Console remains the billing source of truth.
 */
const DEFAULTS: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, // 5-minute cache writes
};
const FALLBACK = DEFAULTS["claude-opus-5-5"];

function envNum(name: string): number | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function priceFor(model?: string) {
  const base = (model && Object.entries(DEFAULTS).find(([k]) => model.startsWith(k))?.[1]) || FALLBACK;
  return {
    input: envNum("AI_PRICE_INPUT_PER_MTOK") ?? base.input,
    output: envNum("AI_PRICE_OUTPUT_PER_MTOK") ?? base.output,
    cacheRead: base.cacheRead,
    cacheWrite: base.cacheWrite,
    webSearchPer1k: envNum("AI_PRICE_WEB_SEARCH_PER_1K") ?? 10,
  };
}

/** Estimated USD cost of one call. Mock/unknown usage costs 0. */
export function estimateCost(u: Usage | undefined | null): number {
  if (!u) return 0;
  const p = priceFor(u.model);
  const cost =
    ((u.inputTokens ?? 0) * p.input + (u.outputTokens ?? 0) * p.output + (u.cacheReadTokens ?? 0) * p.cacheRead + (u.cacheWriteTokens ?? 0) * p.cacheWrite) / 1_000_000 +
    ((u.webSearches ?? 0) * p.webSearchPer1k) / 1000;
  return Math.round(cost * 1e6) / 1e6;
}

export function addUsage(a: Usage, b: Usage | undefined): Usage {
  if (!b) return a;
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
    webSearches: (a.webSearches ?? 0) + (b.webSearches ?? 0),
    unknownUsageAttempts: (a.unknownUsageAttempts ?? 0) + (b.unknownUsageAttempts ?? 0) || undefined,
    model: b.model ?? a.model,
  };
}
