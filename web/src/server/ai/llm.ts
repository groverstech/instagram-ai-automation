import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { mockActive } from "./mode";
import { TEXT_MODELS } from "./catalog";
import { AIConfigError, AIOutputError, AIRefusalError } from "./errors";
import { baseRoute, resolveRoute, type Effort, type ResolvedRoute, type RouteKey } from "./routes";

/**
 * Text AI (Anthropic Claude): the provider adapter behind every text route
 * (docs/AI_PROVIDERS.md). Agents call `llm().structured(...)` / `llm().research(...)` with the
 * route of the job they do; the route picks the model and limits, and the executor (call.ts)
 * handles retries, the circuit breaker and the per-attempt usage ledger.
 *
 * The API key stays on the server (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN); it is never logged
 * or sent to the browser.
 */
export { mockActive };
export { AIConfigError, AIOutputError, AIRefusalError } from "./errors";
export { isRetryable, isServiceError, isTransient, friendlyAIError } from "./errors";
export type { Effort } from "./routes";

export type ImageInput = {
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "application/pdf";
  base64: string;
  label?: string;
};

export type StructuredRequest<T> = {
  /** The job this call does (routes.ts): decides model, limits and how usage is reported. */
  route: RouteKey;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Images and PDFs (brand guidelines) for vision analysis. */
  images?: ImageInput[];
  /** The agent's effort; a route override takes precedence. */
  effort?: Effort;
  /** Output budget (incl. thinking). Kept ≤ 16k so non-streaming requests stay within SDK limits. */
  maxTokens?: number;
  /** Only used in demo mode (AI_PROVIDER=mock). Agents supply a deterministic stand-in. */
  mock: () => T;
};

export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  /** All cache writes; `cacheWrite1hTokens` is the part written with the 1-hour TTL. */
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
  webSearches?: number;
  model?: string;
  /**
   * Requests whose outcome is unknown: the request may have reached the provider (and been billed)
   * but no response reached the app (connection dropped, timeout, worker died). Not priced.
   */
  unknownUsageAttempts?: number;
  /** Generated images (image providers). */
  images?: number;
  /** Image token usage as reported by the image provider (kept apart from text tokens). */
  imageInputTokens?: number;
  imageTextInputTokens?: number;
  imageImageInputTokens?: number;
  imageOutputTokens?: number;
  imageOutputImageTokens?: number;
  imageOutputTextTokens?: number;
  /** Estimated image cost in USD (from configured prices); absent when unpriced. */
  imageCostUsd?: number;
  /** Images generated without a configured price: counted, not priced. */
  unpricedImages?: number;
  imageModel?: string;
};

/** A search result the model actually received from the web search tool. */
export type ResearchSource = { url: string; title: string; publishedAt: string | null; cited: boolean };
export type StructuredResult<T> = { data: T; usage: Usage; provider: string };

/**
 * Usage travels with an error when the provider billed something before we rejected the result
 * (refusal, truncation, invalid output), and the executor replaces it with the call's total
 * (all attempts) before the error leaves it.
 */
const USAGE = Symbol.for("brandpilot.aiUsage");
export function attachUsage<E>(e: E, usage: Usage | undefined, opts: { replace?: boolean } = {}): E {
  if (!usage || !e || typeof e !== "object") return e;
  if (USAGE in (e as object) && !opts.replace) return e;
  Object.defineProperty(e, USAGE, { value: usage, enumerable: false, configurable: true });
  return e;
}
export function usageFromError(e: unknown): Usage | undefined {
  return e && typeof e === "object" ? ((e as Record<symbol, Usage | undefined>)[USAGE] ?? undefined) : undefined;
}

export interface LLMProvider {
  readonly name: string;
  structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
  /** Free-form research with Claude's web search tool. Returns notes + cited URLs. */
  research(req: { route: RouteKey; system: string; prompt: string; maxSearches?: number; mock: () => string }): Promise<{
    text: string;
    /** URLs of results and citations (legacy shape). */
    sources: string[];
    /** Every search result returned by the tool, with title and page age; `cited` if the text cites it. */
    results: ResearchSource[];
    usage: Usage;
    provider: string;
  }>;
}

/** The text model text routes use by default (ANTHROPIC_MODEL or the catalog default). */
export const MODEL = baseRoute("brand.profile").model;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new AIConfigError("No AI provider is configured. Add ANTHROPIC_API_KEY to your environment (see .env.example).");
  }
  // SDK retries are off: the executor retries, so every attempt is visible and recorded.
  client ??= new Anthropic({ maxRetries: 0, fetch: (url, init) => globalThis.fetch(url, init) });
  return client;
}

function userContent(prompt: string, images?: ImageInput[]): Anthropic.Beta.BetaContentBlockParam[] {
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const img of images ?? []) {
    if (img.label) blocks.push({ type: "text", text: `Image: ${img.label}` });
    if (img.mime === "application/pdf") {
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: img.base64 } });
    } else {
      blocks.push({ type: "image", source: { type: "base64", media_type: img.mime, data: img.base64 } });
    }
  }
  blocks.push({ type: "text", text: prompt });
  return blocks;
}

/**
 * Request parameters shared by every Claude call: the routed model, adaptive thinking, the
 * effort, server-side refusal fallbacks where the model supports them, and the agent's system
 * prompt marked for prompt caching (it is identical across calls of the same agent).
 */
function common(route: ResolvedRoute, system: string, effort: Effort) {
  const fallback = TEXT_MODELS[route.model]?.serverFallback ?? false;
  return {
    model: route.model,
    ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    thinking: { type: "adaptive" as const },
    system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }],
    effort,
  };
}

const requestIdOf = (res: unknown) => (res as { _request_id?: string | null })._request_id ?? null;

function usageOf(res: Anthropic.Beta.BetaMessage): Usage {
  const u = res.usage;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheWrite1hTokens: u.cache_creation?.ephemeral_1h_input_tokens || undefined,
    webSearches: u.server_tool_use?.web_search_requests ?? 0,
    // The model that actually served it (a server-side fallback may differ from the route's).
    model: res.model,
  };
}

async function routed(key: RouteKey): Promise<ResolvedRoute> {
  const { aiContext } = await import("./context");
  return resolveRoute(key, { brandId: aiContext().brandId });
}

const textPricing = async () => {
  const { textCost } = await import("./pricing");
  return {
    price: (u: Usage) => textCost(u),
    units: (u: Usage) => ({
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cacheReadTokens: u.cacheReadTokens ?? 0,
      cacheWriteTokens: u.cacheWriteTokens ?? 0,
      cacheWrite1hTokens: u.cacheWrite1hTokens ?? 0,
      webSearches: u.webSearches ?? 0,
    }),
  };
};

const anthropicProvider: LLMProvider = {
  name: "anthropic",
  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const route = await routed(req.route);
    const { execute } = await import("./call");
    // Structured outputs constrain the response to the JSON schema. We parse it ourselves *after*
    // checking stop_reason, so refusals and truncation produce clear errors instead of JSON
    // parse exceptions, and the result is re-validated with the same Zod schema.
    const format = betaZodOutputFormat(req.schema) as unknown as { schema: Record<string, unknown> };
    const { effort, ...params } = common(route, req.system, route.effort ?? req.effort ?? "medium");
    const out = await execute(route, await textPricing(), async () => {
      const res = await anthropic().beta.messages.create(
        {
          ...params,
          max_tokens: Math.min(req.maxTokens ?? 16000, 16000),
          output_config: { effort, format: { type: "json_schema", schema: format.schema } },
          messages: [{ role: "user", content: userContent(req.prompt, req.images) }],
        },
        { timeout: route.timeoutMs },
      );
      const usage = usageOf(res);
      if (res.stop_reason === "refusal") {
        throw attachUsage(new AIRefusalError("The AI declined this request. Try rephrasing, or remove content that may be sensitive."), usage);
      }
      if (res.stop_reason === "max_tokens") {
        throw attachUsage(new AIOutputError("The AI response was cut off before it finished. Please try again."), usage);
      }
      const text = res.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw attachUsage(new AIOutputError("The AI returned an incomplete response. Please try again."), usage);
      }
      const parsed = req.schema.safeParse(json);
      if (!parsed.success) throw attachUsage(new AIOutputError("The AI returned output that didn't match the expected format. Please try again."), usage);
      return { value: { data: parsed.data, model: res.model }, usage, requestId: requestIdOf(res) };
    });
    return { data: out.value.data, usage: out.usage, provider: `anthropic:${out.value.model}` };
  },
  async research(req) {
    const route = await routed(req.route);
    const { execute } = await import("./call");
    const { effort, ...params } = common(route, req.system, route.effort ?? "medium");
    const out = await execute(route, await textPricing(), async () => {
      const res = await anthropic().beta.messages.create(
        {
          ...params,
          max_tokens: 16000,
          output_config: { effort },
          tools: [{ type: TEXT_MODELS[route.model]?.webSearchTool ?? "web_search_20260209", name: "web_search", max_uses: req.maxSearches ?? 5 }],
          messages: [{ role: "user", content: req.prompt }],
        },
        { timeout: route.timeoutMs },
      );
      if (res.stop_reason === "refusal") throw attachUsage(new AIRefusalError("The AI declined this research request."), usageOf(res));
      return { value: res, usage: usageOf(res), requestId: requestIdOf(res) };
    });
    const res = out.value;
    const sources = new Set<string>();
    const results = new Map<string, ResearchSource>();
    const cited = new Set<string>();
    let text = "";
    for (const block of res.content) {
      if (block.type === "text") {
        text += block.text;
        for (const c of block.citations ?? []) {
          if ("url" in c && c.url) {
            sources.add(c.url);
            cited.add(c.url);
          }
        }
      } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) {
          if (r.type !== "web_search_result") continue;
          sources.add(r.url);
          if (!results.has(r.url)) results.set(r.url, { url: r.url, title: r.title, publishedAt: r.page_age ?? null, cited: false });
        }
      }
    }
    for (const u of cited) {
      const r = results.get(u);
      if (r) r.cited = true;
    }
    return {
      text,
      sources: [...sources].slice(0, 20),
      results: [...results.values()].slice(0, 40),
      usage: out.usage,
      provider: `anthropic:${res.model}`,
    };
  },
};

/**
 * Retry an AI call on transient failures with exponential backoff (used by the run ledger for
 * whole-step retries; provider-level retries happen in the executor).
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: { attempts?: number; baseMs?: number; onRetry?: (e: unknown, attempt: number) => void } = {}): Promise<T> {
  const { isRetryable } = await import("./errors");
  const { handledByExecutor } = await import("./call");
  const attempts = opts.attempts ?? 2;
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      last = e;
      // Provider errors already went through the executor's retries: don't multiply them.
      if (i === attempts || !isRetryable(e) || handledByExecutor(e)) throw e;
      opts.onRetry?.(e, i);
      await new Promise((r) => setTimeout(r, (opts.baseMs ?? 1500) * 2 ** (i - 1)));
    }
  }
  throw last;
}

/**
 * Demo mode: deterministic stand-ins, clearly labelled in the UI. Never calls a provider. Each
 * call is still written to the usage ledger as provider "mock" with no cost, so the usage view
 * shows demo activity as demo, never as real provider usage.
 */
async function recordMock(route: RouteKey) {
  const { recordAttempt } = await import("./usage");
  const r = baseRoute(route);
  await recordAttempt({ route, provider: "mock", model: "mock", kind: r.kind, attempt: 1, outcome: "success", priceSource: "demo" });
}

const mockProvider: LLMProvider = {
  name: "mock",
  async structured<T>(req: StructuredRequest<T>) {
    await recordMock(req.route);
    return { data: req.schema.parse(req.mock()), usage: {}, provider: "mock" };
  },
  async research(req) {
    await recordMock(req.route);
    return { text: req.mock(), sources: [], results: [], usage: {}, provider: "mock" };
  },
};

export function llm(): LLMProvider {
  return mockActive() ? mockProvider : anthropicProvider;
}

export function aiStatus() {
  if (mockActive()) return { provider: "mock", ready: true, model: "mock" } as const;
  const ready = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  return { provider: "anthropic", ready, model: MODEL } as const;
}

export { anthropic as anthropicClient };
