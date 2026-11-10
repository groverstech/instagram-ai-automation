/**
 * PR 4.1 provider layer: the REAL adapters (Anthropic SDK, OpenAI images over HTTP) with only the
 * network intercepted. Covers success, invalid credentials, rate limits, outages and the circuit
 * breaker, timeouts, retries, refusals, usage and cost recording, routing and spending limits.
 * Live validation with real keys is separate (`npm run test:live`).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";

process.env.AI_PROVIDER = "";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
process.env.OPENAI_API_KEY = "sk-openai-test-not-a-real-key";
process.env.IMAGE_PROVIDER = "openai";
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.ANTHROPIC_BASE_URL;
delete process.env.OPENAI_BASE_URL;
delete process.env.ANTHROPIC_MODEL;
delete process.env.OPENAI_IMAGE_MODEL;
process.env.AI_RETRY_BASE_MS = "2";
process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-aiprov-"));

type Call = { url: string; headers: Record<string, string>; body: unknown };
const anthropicCalls: Call[] = [];
const openaiCalls: Call[] = [];
let anthropic: (body: Record<string, unknown>, n: number) => Response | Promise<Response> = () => new Response("{}", { status: 500 });
let openai: (call: Call, n: number) => Response | Promise<Response> = () => new Response("{}", { status: 500 });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
  if (url.startsWith("https://api.anthropic.com/")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    anthropicCalls.push({ url, headers, body });
    return withAbort(init?.signal, () => anthropic(body, anthropicCalls.length));
  }
  if (url.startsWith("https://api.openai.com/")) {
    const body = init?.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `file:${(v as File).type}:${(v as File).size}`])) : JSON.parse(String(init?.body ?? "{}"));
    const call = { url, headers, body };
    openaiCalls.push(call);
    return withAbort(init?.signal, () => openai(call, openaiCalls.length));
  }
  return realFetch(input, init);
}) as typeof fetch;

/** Respect the caller's abort signal (timeouts), like a real network call. */
function withAbort(signal: AbortSignal | null | undefined, fn: () => Response | Promise<Response>): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")), { once: true });
    Promise.resolve(fn()).then(resolve, reject);
  });
}
const never = () => new Promise<Response>(() => {});

const message = (data: unknown, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 400, cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 0 } },
      ...extra,
    }),
    { status: 200, headers: { "content-type": "application/json", "request-id": "req_ok", ...headers } },
  );
const apiError = (status: number, type: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: "error", error: { type, message: `${type} (test)` } }), { status, headers: { "content-type": "application/json", "request-id": `req_${status}`, ...headers } });

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const okImage = (headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ created: 1, data: [{ b64_json: PNG }], usage: { input_tokens: 50, input_tokens_details: { text_tokens: 50, image_tokens: 0 }, output_tokens: 4000 } }), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "req_img_ok", ...headers },
  });
const openaiError = (status: number, code: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { message: `${code} (test)`, type: code, code } }), { status, headers: { "content-type": "application/json", "x-request-id": `req_img_${status}`, ...headers } });

const { getDb, schema } = await import("./db/client");
const { llm, friendlyAIError } = await import("./ai/llm");
const { imageProvider } = await import("./ai/image");
const { runAgent } = await import("./agents/orchestrator");
const { resetCircuits, circuitStatus } = await import("./ai/circuit");
const { usageSummary, monthlyCostUsd } = await import("./ai/usage");
const { resolveRoute, baseRoute, ROUTE_KEYS } = await import("./ai/routes");
const { textCost, imageCost } = await import("./ai/pricing");
const { TEXT_MODELS, IMAGE_MODELS } = await import("./ai/catalog");
const { assertAiQuota, QuotaError } = await import("./quota");
const { keyedHash } = await import("./crypto");

const Out = z.object({ answer: z.string() });
let wsId = "";
let brandId = "";
let otherWs = "";
let otherBrand = "";
const userId = "user-1";

beforeAll(async () => {
  const db = await getDb();
  [{ id: wsId }] = await db.insert(schema.workspaces).values({ name: "Org", plan: "growth" }).returning();
  [{ id: brandId }] = await db.insert(schema.brands).values({ workspaceId: wsId, name: "Kora" }).returning();
  [{ id: otherWs }] = await db.insert(schema.workspaces).values({ name: "Other", plan: "starter" }).returning();
  [{ id: otherBrand }] = await db.insert(schema.brands).values({ workspaceId: otherWs, name: "Elsewhere" }).returning();
});
beforeEach(() => {
  anthropicCalls.length = 0;
  openaiCalls.length = 0;
  resetCircuits();
  delete process.env.AI_TEXT_TIMEOUT_MS;
  delete process.env.AI_IMAGE_TIMEOUT_MS;
  delete process.env.AI_CIRCUIT_THRESHOLD;
  delete process.env.AI_CIRCUIT_OPEN_MS;
  for (const k of Object.keys(process.env)) if (/^(IMAGE_PRICE_USD|OPENAI_IMAGE_PRICE_|AI_MONTHLY_COST_LIMIT_USD|AI_PRICE_)/.test(k)) delete process.env[k];
});
afterEach(() => resetCircuits());

/** One agent call through the run ledger, like the app does. */
async function ask(route: Parameters<ReturnType<typeof llm>["structured"]>[0]["route"] = "brand.qa", brand = brandId) {
  return runAgent({ brandId: brand, userId }, "assistant", "test", null, () => llm().structured({ route, system: "You answer.", prompt: "Q?", schema: Out, effort: "low", mock: () => ({ answer: "demo" }) }));
}
const eventsOf = async (runId: string) => {
  const db = await getDb();
  return (await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.runId, runId))).sort((a, b) => a.attempt - b.attempt);
};
const runOf = async (runId: string) => {
  const db = await getDb();
  return (await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)))[0];
};
/** Run a failing call and return its run row (runAgent rethrows; the run is the latest for the brand). */
async function failing(route?: Parameters<typeof ask>[0]) {
  const err = await ask(route).then(
    () => null,
    (e: unknown) => e,
  );
  const db = await getDb();
  const runs = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.brandId, brandId));
  const run = runs.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
  return { err, run, events: await eventsOf(run.id) };
}

describe("Anthropic: successful generation and usage tracking", () => {
  it("records one priced success with the request ID, cache tokens and organisation", async () => {
    anthropic = () => message({ answer: "Hello" });
    const out = await ask();
    expect(out.data).toEqual({ answer: "Hello" });
    expect(anthropicCalls).toHaveLength(1);
    const body = anthropicCalls[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", thinking: { type: "adaptive" }, output_config: { effort: "low" } });
    expect(anthropicCalls[0].headers["x-stainless-retry-count"] ?? "0").toBe("0"); // SDK retries off
    const [ev] = await eventsOf(out.runId);
    expect(ev).toMatchObject({ workspaceId: wsId, brandId, userId, route: "brand.qa", provider: "anthropic", model: "claude-opus-5-5", kind: "text", attempt: 1, outcome: "success", providerRequestId: "req_ok", priceSource: "anthropic-list-2026-11-10" });
    expect(ev.units).toEqual({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 400 });
    // $4 in, $20 out, $0.20 cache read, $5 5-minute cache write per MTok.
    expect(ev.costUsd).toBeCloseTo((1000 * 4 + 500 * 20 + 2000 * 0.2 + 400 * 5) / 1e6, 8);
    const run = await runOf(out.runId);
    expect(run).toMatchObject({ status: "succeeded", attempts: 1, workspaceId: wsId });
    expect(run.costUsd).toBeCloseTo(ev.costUsd!, 8);
  });

  it("prices 1-hour cache writes at their own rate", () => {
    const c = textCost({ model: "claude-opus-5-5", inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 400_000 });
    expect(c.usd).toBeCloseTo(0.6 * 5 + 0.4 * 8, 6);
  });

  it("records a model served by a server-side fallback that has no catalogued price as unpriced", async () => {
    anthropic = () => message({ answer: "ok" }, { model: "claude-opus-4-8" });
    const out = await ask();
    const [ev] = await eventsOf(out.runId);
    expect(ev).toMatchObject({ outcome: "success", model: "claude-opus-4-8", costUsd: null, priceSource: "unpriced" });
    expect(ev.units).toMatchObject({ inputTokens: 1000, outputTokens: 500 });
  });
});

describe("Anthropic: failures", () => {
  it("invalid credentials: not retried, recorded as failed (auth), clear message", async () => {
    anthropic = () => apiError(401, "authentication_error");
    const { err, run, events } = await failing();
    expect(anthropicCalls).toHaveLength(1);
    expect(friendlyAIError(err)).toMatch(/rejected the API key.*ANTHROPIC_API_KEY/);
    expect(String((err as Error).message)).not.toContain("sk-ant-test");
    expect(run).toMatchObject({ status: "failed", attempts: 1, usage: null });
    expect(events.map((e) => [e.outcome, e.errorKind, e.httpStatus, e.providerRequestId, e.costUsd])).toEqual([["failed", "auth", 401, "req_401", null]]);
    expect(circuitStatus("anthropic").consecutiveFailures).toBe(0); // not an outage
  });

  it("rate limit: waits for retry-after, retries, and records both attempts", async () => {
    anthropic = (_b, n) => (n === 1 ? apiError(429, "rate_limit_error", { "retry-after-ms": "20" }) : message({ answer: "after wait" }));
    const t0 = Date.now();
    const out = await ask();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
    expect(anthropicCalls).toHaveLength(2);
    expect((await eventsOf(out.runId)).map((e) => [e.attempt, e.outcome, e.errorKind, e.httpStatus])).toEqual([
      [1, "retried", "rate_limit", 429],
      [2, "success", null, null],
    ]);
    expect(await runOf(out.runId)).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("rate limit with a retry-after longer than the maximum wait: fails now, for the job layer to retry later", async () => {
    anthropic = () => apiError(429, "rate_limit_error", { "retry-after": "3600" });
    const { err, events } = await failing();
    expect(anthropicCalls).toHaveLength(1);
    expect(friendlyAIError(err)).toMatch(/rate-limiting/);
    expect(events.map((e) => e.outcome)).toEqual(["failed"]);
  });

  it("billing or quota errors are not retried", async () => {
    anthropic = () => apiError(400, "billing_error");
    const { err, events } = await failing();
    expect(anthropicCalls).toHaveLength(1);
    expect(friendlyAIError(err)).toMatch(/run out of credit|spending limit/);
    expect(events[0]).toMatchObject({ outcome: "failed", errorKind: "quota" });
  });

  it("overload (529) is retried up to the route's attempts, then fails with every attempt recorded", async () => {
    anthropic = () => apiError(529, "overloaded_error");
    const { err, run, events } = await failing();
    expect(anthropicCalls).toHaveLength(3);
    expect(friendlyAIError(err)).toMatch(/temporarily unavailable/);
    expect(events.map((e) => [e.outcome, e.errorKind])).toEqual([
      ["retried", "overloaded"],
      ["retried", "overloaded"],
      ["failed", "overloaded"],
    ]);
    expect(run).toMatchObject({ status: "failed", attempts: 3, usage: null });
  });

  it("timeout: recorded as unknown outcome (may be billed), retried for text, then succeeds", async () => {
    process.env.AI_TEXT_TIMEOUT_MS = "30";
    anthropic = (_b, n) => (n === 1 ? never() : message({ answer: "second try" }));
    const out = await ask();
    expect(out.data.answer).toBe("second try");
    const events = await eventsOf(out.runId);
    expect(events.map((e) => [e.outcome, e.errorKind, e.priceSource])).toEqual([
      ["retried", "timeout", "unknown"],
      ["success", null, "anthropic-list-2026-11-10"],
    ]);
    expect(events[0].units).toEqual({ unknownOutcome: 1 });
    expect((await runOf(out.runId)).usage).toMatchObject({ unknownUsageAttempts: 1, inputTokens: 1000 });
  });

  it("refusal: billed, recorded as refused, not retried", async () => {
    anthropic = () => message("", { stop_reason: "refusal", content: [] });
    const { err, run, events } = await failing();
    expect(anthropicCalls).toHaveLength(1);
    expect(friendlyAIError(err)).toMatch(/declined/);
    expect(events[0]).toMatchObject({ outcome: "refused", errorKind: "refusal" });
    expect(events[0].costUsd).toBeGreaterThan(0);
    expect(run.usage).toMatchObject({ inputTokens: 1000, outputTokens: 500 });
  });

  it("unusable output: billed, retried, and the run totals both attempts once", async () => {
    anthropic = (_b, n) => (n === 1 ? message("{not json") : message({ answer: "fixed" }));
    const out = await ask();
    const events = await eventsOf(out.runId);
    expect(events.map((e) => [e.outcome, e.errorKind])).toEqual([
      ["retried", "output_invalid"],
      ["success", null],
    ]);
    expect(events.every((e) => (e.costUsd ?? 0) > 0)).toBe(true);
    const run = await runOf(out.runId);
    expect(run.usage).toMatchObject({ inputTokens: 2000, outputTokens: 1000 });
    expect(run.costUsd).toBeCloseTo(events.reduce((s, e) => s + (e.costUsd ?? 0), 0), 8);
  });
});

describe("circuit breaker: provider outages", () => {
  it("opens after consecutive service failures, blocks calls without sending them, and closes after a successful probe", async () => {
    process.env.AI_CIRCUIT_THRESHOLD = "2";
    process.env.AI_CIRCUIT_OPEN_MS = "60";
    anthropic = () => apiError(500, "api_error", { "x-should-retry": "false" });
    await failing();
    await failing();
    expect(circuitStatus("anthropic").state).toBe("open");
    const sent = anthropicCalls.length;
    const { err, events } = await failing();
    expect(anthropicCalls).toHaveLength(sent); // nothing sent while open
    expect(friendlyAIError(err)).toMatch(/paused for a moment/);
    expect(events.map((e) => [e.outcome, e.errorKind])).toEqual([["blocked", "circuit_open"]]);
    await new Promise((r) => setTimeout(r, 80));
    anthropic = () => message({ answer: "back" });
    await ask();
    expect(circuitStatus("anthropic").state).toBe("closed");
  });

  it("auth and rate-limit errors don't open the circuit", async () => {
    process.env.AI_CIRCUIT_THRESHOLD = "1";
    anthropic = () => apiError(401, "authentication_error");
    await failing();
    anthropic = () => apiError(429, "rate_limit_error", { "x-should-retry": "false" });
    await failing();
    expect(circuitStatus("anthropic").state).toBe("closed");
  });
});

describe("routing: models and parameters from configuration, not code", () => {
  it("every route resolves to a catalogued, priced model; Opus 5.5 is the default for text", () => {
    for (const key of ROUTE_KEYS) {
      const r = baseRoute(key, {});
      if (r.kind === "image") expect(IMAGE_MODELS).toContain(r.model);
      else {
        expect(r.model).toBe("claude-opus-5-5");
        expect(textCost({ model: r.model, inputTokens: 1, outputTokens: 1 }).usd).not.toBeNull();
      }
    }
    for (const [model, m] of Object.entries(TEXT_MODELS)) {
      expect(textCost({ model, inputTokens: 50_000 }).usd).toBeCloseTo(m.price.input * 0.05, 9);
    }
    // Haiku 5.5's higher rates above 100k prompt tokens.
    expect(textCost({ model: "claude-haiku-5-5", inputTokens: 200_000, outputTokens: 1000 }).usd).toBeCloseTo((200_000 * 0.5 + 1000 * 2.5) / 1e6, 9);
  });

  it("environment overrides apply only to catalogued models", () => {
    expect(baseRoute("brand.qa", { ANTHROPIC_MODEL: "claude-sonnet-5-5" })).toMatchObject({ model: "claude-sonnet-5-5", source: "env" });
    expect(baseRoute("brand.qa", { ANTHROPIC_MODEL: "claude-unknown-9" })).toMatchObject({ model: "claude-opus-5-5", source: "default" });
    // Research needs the web search tool: Haiku isn't used for it.
    expect(baseRoute("strategy.research", { ANTHROPIC_MODEL: "claude-haiku-5-5" }).model).toBe("claude-opus-5-5");
    expect(baseRoute("image.generate", { OPENAI_IMAGE_MODEL: "gpt-image-1.5", OPENAI_IMAGE_QUALITY: "medium" })).toMatchObject({ model: "gpt-image-1.5", quality: "medium" });
  });

  it("database overrides: brand beats plan beats global; invalid values are ignored", async () => {
    const db = await getDb();
    await db.insert(schema.aiRoutes).values([
      { key: "content.copy", scopeType: "global", scopeId: "", model: "claude-sonnet-5-5", params: { effort: "high" } },
      { key: "content.copy", scopeType: "plan", scopeId: "growth", model: "claude-haiku-5-5" },
      { key: "content.ideas", scopeType: "brand", scopeId: brandId, model: "gpt-4-imaginary", params: { effort: "high", maxAttempts: 99 } },
    ]);
    expect(await resolveRoute("content.copy", { brandId })).toMatchObject({ model: "claude-haiku-5-5", effort: "high", source: "override:plan" });
    expect(await resolveRoute("content.copy", { brandId: otherBrand })).toMatchObject({ model: "claude-sonnet-5-5", source: "override:global" });
    expect(await resolveRoute("content.ideas", { brandId })).toMatchObject({ model: "claude-opus-5-5", effort: "high", maxAttempts: 3 });
    // The request goes out with the routed model; Haiku 5.5 has no server-side fallbacks.
    anthropic = () => message({ answer: "routed" }, { model: "claude-haiku-5-5" });
    const out = await ask("content.copy");
    const body = anthropicCalls[0].body as Record<string, unknown>;
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.fallbacks).toBeUndefined();
    expect((body.output_config as { effort: string }).effort).toBe("high"); // override beats the agent's "low"
    const [ev] = await eventsOf(out.runId);
    expect(ev).toMatchObject({ model: "claude-haiku-5-5", priceSource: "anthropic-list-2026-11-10" });
    expect(ev.costUsd).toBeCloseTo((1000 * 0.1 + 500 * 0.5 + 2000 * 0.01 + 400 * 0.125) / 1e6, 9);
    await db.delete(schema.aiRoutes);
  });
});

describe("OpenAI images", () => {
  const gen = (route: "generate" | "edit" = "generate") =>
    runAgent({ brandId, userId }, "design_generation", "image", null, async () => {
      const p = imageProvider()!;
      const img = route === "edit" ? await p.edit("Same, warmer light", { data: Buffer.from(PNG, "base64"), mime: "image/png" }, "1024x1536") : await p.generate("A ceramic mug", "1024x1536");
      return { data: img, usage: img.usage, provider: `openai:${img.model}` };
    });

  it("generates with the routed model and quality, and a hashed organisation identifier", async () => {
    openai = () => okImage();
    const out = await gen();
    expect(openaiCalls[0].url).toBe("https://api.openai.com/v1/images/generations");
    expect(openaiCalls[0].body).toMatchObject({ model: "gpt-image-1", size: "1024x1536", quality: "high", n: 1, safety_identifier: keyedHash(`org:${wsId}`, 32) });
    expect(JSON.stringify(openaiCalls[0].body)).not.toContain(wsId);
    expect(openaiCalls[0].headers.authorization).toBe("Bearer sk-openai-test-not-a-real-key");
    const [ev] = await eventsOf(out.runId);
    expect(ev).toMatchObject({ route: "image.generate", provider: "openai", model: "gpt-image-1", outcome: "success", providerRequestId: "req_img_ok", costUsd: null, priceSource: "unpriced" });
    expect(ev.units).toMatchObject({ images: 1, inputTokens: 50, textInputTokens: 50, outputTokens: 4000 });
    expect((await runOf(out.runId)).usage).toMatchObject({ images: 1, unpricedImages: 1 });
  });

  it("prices images only from configuration: per token, then per image by quality and size", async () => {
    expect(imageCost({ size: "1024x1536", quality: "high", units: { images: 1, inputTokens: 50, outputTokens: 4000 } }, {}).source).toBe("unpriced");
    expect(imageCost({ size: "1024x1536", quality: "high", units: { images: 1 } }, { IMAGE_PRICE_USD_HIGH_1024X1536: "0.25", IMAGE_PRICE_USD: "0.1" })).toEqual({ usd: 0.25, source: "config:per-image" });
    expect(imageCost({ size: "1024x1536", quality: "high", units: { images: 1, inputTokens: 50, textInputTokens: 50, outputTokens: 4000 } }, { OPENAI_IMAGE_PRICE_TEXT_INPUT_PER_MTOK: "5", OPENAI_IMAGE_PRICE_OUTPUT_PER_MTOK: "40" })).toEqual({ usd: (50 * 5 + 4000 * 40) / 1e6, source: "config:tokens" });
    process.env.IMAGE_PRICE_USD_1024X1536 = "0.2";
    openai = () => okImage();
    const out = await gen();
    const [ev] = await eventsOf(out.runId);
    expect(ev).toMatchObject({ costUsd: 0.2, priceSource: "config:per-image" });
    expect((await runOf(out.runId)).costUsd).toBeCloseTo(0.2, 6);
  });

  it("variations go to the edits endpoint with the source image", async () => {
    openai = () => okImage();
    const out = await gen("edit");
    expect(openaiCalls[0].url).toBe("https://api.openai.com/v1/images/edits");
    expect(openaiCalls[0].body).toMatchObject({ model: "gpt-image-1", prompt: "Same, warmer light", size: "1024x1536", quality: "high", image: expect.stringMatching(/^file:image\/png:\d+$/) });
    expect((await eventsOf(out.runId))[0]).toMatchObject({ route: "image.edit", outcome: "success" });
  });

  it("invalid key, exhausted quota and content policy are not retried; each is explained", async () => {
    for (const [res, re, kind, outcome] of [
      [() => openaiError(401, "invalid_api_key"), /rejected the API key.*OPENAI_API_KEY/, "auth", "failed"],
      [() => openaiError(429, "insufficient_quota"), /run out of credit/, "quota", "failed"],
      [() => openaiError(400, "moderation_blocked"), /content policy/, "content_policy", "refused"],
    ] as const) {
      openaiCalls.length = 0;
      openai = res;
      const err = await gen().then(() => null, (e: unknown) => e);
      expect(openaiCalls).toHaveLength(1);
      expect(friendlyAIError(err)).toMatch(re);
      const db = await getDb();
      const events = (await db.select().from(schema.usageEvents)).filter((e) => e.route === "image.generate").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      expect(events[0]).toMatchObject({ outcome, errorKind: kind });
    }
  });

  it("rate limits are retried (honouring retry-after); timeouts are not (the image may exist and be charged)", async () => {
    openai = (_c, n) => (n === 1 ? openaiError(429, "rate_limit_exceeded", { "retry-after-ms": "10" }) : okImage());
    const ok = await gen();
    expect((await eventsOf(ok.runId)).map((e) => e.outcome)).toEqual(["retried", "success"]);
    openaiCalls.length = 0;
    process.env.AI_IMAGE_TIMEOUT_MS = "30";
    openai = () => never();
    const err = await gen().then(() => null, (e: unknown) => e);
    expect(openaiCalls).toHaveLength(1);
    expect(friendlyAIError(err)).toMatch(/didn't answer in time.*may still have created/);
  });
});

describe("usage summaries, isolation and spending limits", () => {
  it("summarises this month's usage per organisation, by model, brand and route, never mixing organisations", async () => {
    anthropic = () => message({ answer: "x" });
    await ask("brand.qa", otherBrand);
    const mine = await usageSummary(wsId);
    const theirs = await usageSummary(otherWs);
    expect(mine.totals.attempts).toBeGreaterThan(theirs.totals.attempts);
    expect(theirs.byBrand.map((b) => b.brandId)).toEqual([otherBrand]);
    expect(mine.byBrand.some((b) => b.brandId === otherBrand)).toBe(false);
    expect(mine.byModel.find((r) => r.provider === "anthropic" && r.model === "claude-opus-5-5")!.costUsd).toBeGreaterThan(0);
    expect(mine.totals.unpricedAttempts).toBeGreaterThan(0); // the unpriced images above
    expect(mine.totals.retried).toBeGreaterThan(0);
    expect(mine.totals.unknown + mine.totals.retried).toBeGreaterThan(0);
    // A brand-scoped view only includes those brands.
    expect((await usageSummary(wsId, { brandIds: [] })).totals.attempts).toBe(0);
  });

  it("an optional monthly spending limit (per plan or global) stops new AI work once reached", async () => {
    await expect(assertAiQuota(brandId)).resolves.toBeUndefined(); // no limit configured: nothing assumed
    const spent = await monthlyCostUsd(wsId);
    expect(spent).toBeGreaterThan(0);
    process.env.AI_MONTHLY_COST_LIMIT_USD = String(spent * 10);
    await expect(assertAiQuota(brandId)).resolves.toBeUndefined();
    process.env.AI_MONTHLY_COST_LIMIT_USD_GROWTH = String(spent / 2);
    await expect(assertAiQuota(brandId)).rejects.toBeInstanceOf(QuotaError);
    await expect(assertAiQuota(otherBrand)).resolves.toBeUndefined(); // starter plan, other organisation
  });
});

describe("demo mode never calls a paid provider", () => {
  it("every route answers from the labelled stand-in, recorded as mock with no cost", async () => {
    process.env.AI_PROVIDER = "mock";
    try {
      const out = await ask("strategy.section");
      expect(out.data).toEqual({ answer: "demo" });
      await runAgent({ brandId, userId }, "market_research", "r", null, async () => {
        const r = await llm().research({ route: "strategy.research", system: "s", prompt: "p", mock: () => "demo notes" });
        return { data: r.text };
      });
      await runAgent({ brandId, userId }, "design_generation", "i", null, async () => ({ data: await imageProvider()!.generate("x", "1024x1024") }));
      expect(anthropicCalls).toHaveLength(0);
      expect(openaiCalls).toHaveLength(0);
      const [ev] = await eventsOf(out.runId);
      expect(ev).toMatchObject({ provider: "mock", model: "mock", costUsd: null, priceSource: "demo" });
    } finally {
      process.env.AI_PROVIDER = "";
    }
  });
});

describe("AI providers & usage view: who may see it", () => {
  it("only owners and admins with access to every brand; others are refused (and audited)", async () => {
    const { aiOverviewFor } = await import("./ai/overview");
    const db = await getDb();
    const mk = async (email: string) => (await db.insert(schema.users).values({ email, name: email, passwordHash: "x" }).returning())[0];
    const [owner, client, outsider] = [await mk("own@ai.test"), await mk("cli@ai.test"), await mk("out@ai.test")];
    await db.insert(schema.workspaceMembers).values([
      { workspaceId: wsId, userId: owner.id, role: "owner" },
      { workspaceId: wsId, userId: client.id, role: "editor", brandIds: [brandId] },
    ]);
    const sess = (u: { id: string; email: string; name: string | null }) => ({ sessionId: `s-${u.id}`, activeBrandId: null, user: { id: u.id, email: u.email, name: u.name ?? "" } });
    const view = await aiOverviewFor(sess(owner), wsId);
    expect(view.providers.map((p) => [p.id, p.configured])).toEqual([["anthropic", true], ["openai", true]]);
    expect(JSON.stringify(view)).not.toMatch(/sk-ant-test|sk-openai-test/);
    expect(view.live.status).toBe("pending");
    expect(view.usage.byBrand.every((b) => b.brandId !== otherBrand)).toBe(true);
    await expect(aiOverviewFor(sess(client), wsId)).rejects.toThrow();
    await expect(aiOverviewFor(sess(outsider), wsId)).rejects.toThrow();
  });
});

