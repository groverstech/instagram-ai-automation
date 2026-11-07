import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

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
  /** Only used when AI_PROVIDER=mock. Agents supply a deterministic stand-in. */
  mock: () => T;
};

export type Usage = { inputTokens?: number; outputTokens?: number };
export type StructuredResult<T> = { data: T; usage: Usage; provider: string };

export class AIConfigError extends Error {}
export class AIRefusalError extends Error {}
/** The model responded, but the output was unusable (truncated, invalid JSON, wrong shape). */
export class AIOutputError extends Error {}

export interface LLMProvider {
  readonly name: string;
  structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
  /** Free-form research with Claude's web search tool. Returns notes + cited URLs. */
  research(req: { system: string; prompt: string; maxSearches?: number; mock: () => string }): Promise<{
    text: string;
    sources: string[];
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
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: req.effort ?? "medium", format: { type: "json_schema", schema: format.schema } },
      system: req.system,
      messages: [{ role: "user", content: userContent(req.prompt, req.images) }],
    });
    if (res.stop_reason === "refusal") {
      throw new AIRefusalError("The AI declined this request. Try rephrasing, or remove content that may be sensitive.");
    }
    if (res.stop_reason === "max_tokens") {
      throw new AIOutputError("The AI response was cut off before it finished. Please try again.");
    }
    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AIOutputError("The AI returned an incomplete response. Please try again.");
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) throw new AIOutputError("The AI returned output that didn't match the expected format. Please try again.");
    return {
      data: parsed.data,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      provider: `anthropic:${res.model}`,
    };
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
    if (res.stop_reason === "refusal") throw new AIRefusalError("The AI declined this research request.");
    const sources = new Set<string>();
    let text = "";
    for (const block of res.content) {
      if (block.type === "text") {
        text += block.text;
        for (const c of block.citations ?? []) if ("url" in c && c.url) sources.add(c.url);
      } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) if (r.type === "web_search_result") sources.add(r.url);
      }
    }
    return {
      text,
      sources: [...sources].slice(0, 20),
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      provider: `anthropic:${res.model}`,
    };
  },
};

const mockProvider: LLMProvider = {
  name: "mock",
  async structured<T>(req: StructuredRequest<T>) {
    return { data: req.schema.parse(req.mock()), usage: {}, provider: "mock" };
  },
  async research(req) {
    return { text: req.mock(), sources: [], usage: {}, provider: "mock" };
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
  if (e instanceof Anthropic.APIConnectionError) return true;
  if (e instanceof Anthropic.APIError) return e.status === undefined || e.status === 401 || e.status === 403 || e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500;
  return false;
}

/** User-facing message for AI failures; never exposes raw API payloads. */
export function friendlyAIError(e: unknown): string | null {
  if (e instanceof AIConfigError || e instanceof AIRefusalError || e instanceof AIOutputError) return e.message;
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
