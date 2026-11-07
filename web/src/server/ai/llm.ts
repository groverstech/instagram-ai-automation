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
    const res = await anthropic().beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: req.effort ?? "medium", format: betaZodOutputFormat(req.schema) },
      system: req.system,
      messages: [{ role: "user", content: userContent(req.prompt, req.images) }],
    });
    if (res.stop_reason === "refusal") {
      throw new AIRefusalError("The AI declined this request. Try rephrasing the brief.");
    }
    if (res.stop_reason === "max_tokens") {
      throw new Error("The AI response was cut off before it finished. Try a smaller request.");
    }
    if (res.parsed_output == null) throw new Error("The AI returned output that didn't match the expected format.");
    return {
      data: res.parsed_output as T,
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

export function llm(): LLMProvider {
  return process.env.AI_PROVIDER === "mock" ? mockProvider : anthropicProvider;
}

export function aiStatus() {
  if (process.env.AI_PROVIDER === "mock") return { provider: "mock", ready: true, model: "mock" } as const;
  const ready = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  return { provider: "anthropic", ready, model: MODEL } as const;
}

export { anthropic as anthropicClient };
