// `npm run ai:check-anthropic`: ONE minimal real Anthropic request through the app's own provider
// layer, to validate a staging key (docs/DEMO.md §4). Operator tool; never part of tests or CI.
//
// Before anything is sent it refuses to run unless:
//   - ANTHROPIC_API_KEY is set (checked by presence only) and ANTHROPIC_AUTH_TOKEN is not;
//   - demo mode is off, and the API host is https://api.anthropic.com;
//   - a spending cap is set (AI_SPEND_CAP_USD), so the request counts against the budget.
// While running:
//   - one attempt only (retries off), low effort, a tiny prompt, at most 1,024 output tokens;
//   - a guard at the network layer allows exactly one request to api.anthropic.com, and only if
//     it carries x-api-key and no Authorization header (checked by header name, never by value).
// Output: provider, model, HTTP status, request ID, token usage, estimated cost and outcome, from
// the usage ledger. Never the key or any header value. `--json <file>` also writes it to a file.
import fs from "node:fs";
import { z } from "zod";

const fail = (msg: string): never => {
  console.error(`Refusing to run: ${msg}`);
  process.exit(2);
};

const env = process.env;
if (!env.ANTHROPIC_API_KEY?.trim()) fail("ANTHROPIC_API_KEY is not set in this process (it's loaded when the session or server starts).");
if (env.ANTHROPIC_AUTH_TOKEN) fail("ANTHROPIC_AUTH_TOKEN is set; unset it so only the API key can be used.");
if (env.AI_PROVIDER === "mock") fail("demo mode is on (AI_PROVIDER=mock).");
const base = (env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
if (base !== "https://api.anthropic.com") fail("ANTHROPIC_BASE_URL points somewhere other than https://api.anthropic.com.");
if (!env.AI_SPEND_CAP_USD?.trim()) fail("set AI_SPEND_CAP_USD (and AI_SPEND_CAP_SINCE) so the request counts against the validation budget.");
env.AI_MAX_ATTEMPTS = "1"; // retries off for this process

// Network guard: exactly one Anthropic request, x-api-key present, Authorization absent.
let sent = 0;
let guardError: string | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.anthropic.com/")) {
    const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!h.has("x-api-key") || h.has("authorization")) {
      guardError = `blocked before sending: x-api-key ${h.has("x-api-key") ? "present" : "missing"}, Authorization ${h.has("authorization") ? "present" : "absent"}`;
      throw new Error(guardError);
    }
    if (++sent > 1) {
      guardError = "blocked a second request: this check sends exactly one";
      throw new Error(guardError);
    }
  }
  return realFetch(input, init);
}) as typeof fetch;

async function main() {
  const { llm, friendlyAIError } = await import("./llm");
  const { classify } = await import("./errors");
  const { getDb, schema } = await import("../db/client");
  const started = new Date();
  type Result = { data: { answer: string }; provider: string };
  let result: Result | null = null;
  let error: unknown = null;
  try {
    result = (await llm().structured({
      route: "brand.qa",
      system: "You are a connectivity check. Answer in one word.",
      prompt: "Reply with the single word: ok",
      schema: z.object({ answer: z.string() }),
      effort: "low",
      maxTokens: 1024,
      mock: () => ({ answer: "demo" }),
    })) as Result;
  } catch (e) {
    error = e;
  }
  const db = await getDb();
  const rows = (await db.select().from(schema.usageEvents)).filter((r) => r.createdAt >= started && r.provider === "anthropic");
  const attempt = rows[0];
  const units = (attempt?.units ?? {}) as Record<string, number>;
  const report = {
    ranAt: started.toISOString(),
    requestsSent: sent,
    provider: "anthropic",
    model: attempt?.model ?? null,
    httpStatus: attempt ? (attempt.httpStatus ?? (attempt.outcome === "success" ? 200 : null)) : null,
    requestId: attempt?.providerRequestId ?? null,
    usage: { inputTokens: units.inputTokens ?? 0, outputTokens: units.outputTokens ?? 0, cacheReadTokens: units.cacheReadTokens ?? 0, cacheWriteTokens: units.cacheWriteTokens ?? 0 },
    estimatedUsd: attempt?.costUsd ?? null,
    priceSource: attempt?.priceSource ?? null,
    latencyMs: attempt?.latencyMs ?? null,
    authenticated: attempt ? attempt.errorKind !== "auth" && attempt.errorKind !== "permission" && attempt.outcome !== "blocked" : false,
    realResponse: Boolean(result && result.provider.startsWith("anthropic:")),
    answer: result?.data.answer ?? null,
    outcome: error ? "failed" : "succeeded",
    errorCategory: guardError ? "header_guard" : error ? classify(error).kind : null,
    message: guardError ?? (error ? friendlyAIError(error) : null),
  };
  const args = process.argv.slice(2);
  const jsonAt = args.indexOf("--json");
  if (jsonAt >= 0 && args[jsonAt + 1]) fs.writeFileSync(args[jsonAt + 1], JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  return error ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
