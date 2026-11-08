import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { ImageProviderError, ImageProviderUnavailable, ImageRefusedError } from "./image";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type ImageInput = {
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "application/pdf";
  base64: string;
  label?: string;
};

export type StructuredRequest<T> = {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Images and PDFs (brand guidelines) for vision analysis. */
  images?: ImageInput[];
  effort?: Effort;
  /** Output budget (incl. thinking). Kept ≤ 16k so non-streaming requests stay within SDK limits. */
  maxTokens?: number;
  /** Only used when AI_PROVIDER=mock. Agents supply a deterministic stand-in. */
  mock: () => T;
};

export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  webSearches?: number;
  model?: string;
  /**
   * Requests whose outcome is unknown: the request may have reached the provider (and been billed)
   * but no response reached the app (connection dropped, timeout, worker died). Not priced.
   */
  unknownUsageAttempts?: number;
  /** Generated images (image providers). */
  images?: number;
  /** Estimated image cost in USD (from configured per-image prices); absent when unpriced. */
  imageCostUsd?: number;
  /** Images generated without a configured price: counted, not priced. */
  unpricedImages?: number;
  imageModel?: string;
};

/** A search result the model actually received from the web search tool. */
export type ResearchSource = { url: string; title: string; publishedAt: string | null; cited: boolean };
export type StructuredResult<T> = { data: T; usage: Usage; provider: string };

export class AIConfigError extends Error {}
export class AIRefusalError extends Error {}
/** The model responded, but the output was unusable (truncated, invalid JSON, wrong shape). */
export class AIOutputError extends Error {}

/**
 * Billed usage travels with an error when the provider returned a response we then rejected
 * (refusal, truncation, invalid output). Errors with no response (network, 5xx) carry none.
 */
const USAGE = Symbol.for("brandpilot.aiUsage");
export function attachUsage<E>(e: E, usage: Usage | undefined): E {
  if (usage && e && typeof e === "object" && !(USAGE in (e as object))) Object.defineProperty(e, USAGE, { value: usage, enumerable: false });
  return e;
}
export function usageFromError(e: unknown): Usage | undefined {
  return e && typeof e === "object" ? ((e as Record<symbol, Usage | undefined>)[USAGE] ?? undefined) : undefined;
}

export interface LLMProvider {
  readonly name: string;
  structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
  /** Free-form research with Claude's web search tool. Returns notes + cited URLs. */
  research(req: { system: string; prompt: string; maxSearches?: number; mock: () => string }): Promise<{
    text: string;
    /** URLs of results and citations (legacy shape). */
    sources: string[];
    /** Every search result returned by the tool, with title and page age; `cited` if the text cites it. */
    results: ResearchSource[];
    usage: Usage;
    provider: string;
  }>;
}

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new AIConfigError(
      "No AI provider is configured. Add ANTHROPIC_API_KEY to your environment (see .env.example).",
    );
  }
  client ??= new Anthropic();
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

const anthropicProvider: LLMProvider = {
  name: "anthropic",
  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    // Structured outputs constrain the response to the JSON schema. We parse it ourselves *after*
    // checking stop_reason, so refusals and truncation produce clear errors instead of JSON
    // parse exceptions, and the result is re-validated with the same Zod schema.
    const format = betaZodOutputFormat(req.schema) as unknown as { schema: Record<string, unknown> };
    const res = await anthropic().beta.messages.create({
      model: MODEL,
      max_tokens: Math.min(req.maxTokens ?? 16000, 16000),
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: req.effort ?? "medium", format: { type: "json_schema", schema: format.schema } },
      system: req.system,
      messages: [{ role: "user", content: userContent(req.prompt, req.images) }],
    });
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
    return { data: parsed.data, usage, provider: `anthropic:${res.model}` };
  },
  async research(req) {
    const res = await anthropic().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: req.system,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: req.maxSearches ?? 5 }],
      messages: [{ role: "user", content: req.prompt }],
    });
    if (res.stop_reason === "refusal") throw attachUsage(new AIRefusalError("The AI declined this research request."), usageOf(res));
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
      usage: usageOf(res),
      provider: `anthropic:${res.model}`,
    };
  },
};

function usageOf(res: Anthropic.Beta.BetaMessage): Usage {
  return {
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
    webSearches: res.usage.server_tool_use?.web_search_requests ?? 0,
    model: res.model,
  };
}

/** True for failures worth retrying: unusable output, network errors, overload and 5xx. Never auth/config/refusal/4xx. */
export function isRetryable(e: unknown): boolean {
  if (e instanceof AIOutputError) return true;
  if (e instanceof ImageProviderError) return e.status === undefined || e.status === 429 || e.status >= 500;
  if (e instanceof Anthropic.APIConnectionError) return true;
  if (e instanceof Anthropic.APIError) return e.status === 408 || e.status === 409 || e.status === 429 || (e.status !== undefined && e.status >= 500);
  return false;
}

/**
 * Retry an AI call on transient failures with exponential backoff. The SDK already retries
 * HTTP-level failures twice; this adds retries for unusable model output and keeps the count.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: { attempts?: number; baseMs?: number; onRetry?: (e: unknown, attempt: number) => void } = {}): Promise<T> {
  const attempts = opts.attempts ?? 2;
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      last = e;
      if (i === attempts || !isRetryable(e)) throw e;
      opts.onRetry?.(e, i);
      await new Promise((r) => setTimeout(r, (opts.baseMs ?? 1500) * 2 ** (i - 1)));
    }
  }
  throw last;
}

const mockProvider: LLMProvider = {
  name: "mock",
  async structured<T>(req: StructuredRequest<T>) {
    return { data: req.schema.parse(req.mock()), usage: {}, provider: "mock" };
  },
  async research(req) {
    return { text: req.mock(), sources: [], results: [], usage: {}, provider: "mock" };
  },
};

/**
 * The mock provider is for tests and local UI work. In production it is only honoured with an
 * explicit AI_ALLOW_MOCK_IN_PRODUCTION=true, so a stray AI_PROVIDER=mock can't silently
 * replace Claude for real users.
 */
export function mockActive(): boolean {
  if (process.env.AI_PROVIDER !== "mock") return false;
  if (process.env.NODE_ENV === "production" && process.env.AI_ALLOW_MOCK_IN_PRODUCTION !== "true") {
    if (!mockWarned) {
      console.error("[ai] AI_PROVIDER=mock is ignored in production. Set AI_ALLOW_MOCK_IN_PRODUCTION=true only for demos/E2E.");
      mockWarned = true;
    }
    return false;
  }
  return true;
}
let mockWarned = false;

export function llm(): LLMProvider {
  return mockActive() ? mockProvider : anthropicProvider;
}

/** Errors that mean "the AI service is unavailable", not "this input is bad". Retrying later may work. */
export function isServiceError(e: unknown): boolean {
  if (e instanceof AIConfigError) return true;
  if (e instanceof ImageProviderError) return e.status === undefined || e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500;
  if (e instanceof Anthropic.APIConnectionError) return true;
  if (e instanceof Anthropic.APIError) return e.status === undefined || e.status === 401 || e.status === 403 || e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500;
  return false;
}

/** User-facing message for AI failures; never exposes raw API payloads. */
export function friendlyAIError(e: unknown): string | null {
  if (e instanceof AIConfigError || e instanceof AIRefusalError || e instanceof AIOutputError) return e.message;
  if (e instanceof ImageRefusedError) return e.message;
  if (e instanceof ImageProviderUnavailable) return "No image provider is configured. Choose brand photos or a typographic layout, or set OPENAI_API_KEY on the server.";
  if (e instanceof ImageProviderError) {
    if (e.status === 401 || e.status === 403) return "The image service rejected the API key. Check OPENAI_API_KEY on the server.";
    if (e.status === 429) return "The image service is rate-limiting requests. Please try again in a minute.";
    if (e.status === undefined || e.status >= 500) return "The image service is temporarily unavailable. Please try again shortly.";
    return "The image service couldn't process this request.";
  }
  if (e instanceof Anthropic.APIConnectionError) return "Couldn't reach the AI service. Check the server's network connection and try again.";
  if (e instanceof Anthropic.APIError) {
    if (e.status === 401 || e.status === 403) return "The AI service rejected the API key. Check ANTHROPIC_API_KEY on the server.";
    if (e.status === 429) return "The AI service is rate-limiting requests. Please try again in a minute.";
    if (e.status === 400) return "The AI service couldn't process this request. Try again, or remove unusual files and retry.";
    if (e.status !== undefined && e.status >= 500) return "The AI service is temporarily unavailable. Please try again shortly.";
    return "The AI request failed. Please try again.";
  }
  return null;
}

export function aiStatus() {
  if (mockActive()) return { provider: "mock", ready: true, model: "mock" } as const;
  const ready = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  return { provider: "anthropic", ready, model: MODEL } as const;
}

export { anthropic as anthropicClient };
