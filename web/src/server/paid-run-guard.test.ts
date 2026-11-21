/**
 * Spending-cap guard for paid operator commands (`npm run test:live`, `npm run ai:check-anthropic`):
 * a missing, invalid or exhausted cap refuses the run before any network request, and every
 * provider request must hold a reservation under the cap. No real provider is ever contacted: all
 * fetches are stubbed and counted here.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

for (const k of Object.keys(process.env)) if (/^(AI_SPEND_CAP_|AI_PROVIDER$|CI$|DATABASE_URL$|ANTHROPIC_|OPENAI_|VOYAGE_)/.test(k)) delete process.env[k];
// A persistent ledger (a temporary on-disk database), as paid commands require.
process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-paidguard-pg-"));
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-paidguard-store-"));
process.env.ANTHROPIC_API_KEY = "placeholder-not-a-real-key";
process.env.AI_MAX_ATTEMPTS = "1";

const networkCalls: string[] = [];
const stubFetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  networkCalls.push(url);
  return new Response(JSON.stringify({ error: { type: "api_error", message: "stub" } }), { status: 500, headers: { "content-type": "application/json" } });
}) as typeof fetch;
globalThis.fetch = stubFetch;

const guard = await import("./ai/paid-run-guard");
const spend = await import("./ai/spend-cap");
const { recordAttempt } = await import("./ai/usage");
const { llm } = await import("./ai/llm");
const { classify } = await import("./ai/errors");

const NOW = new Date("2026-11-21T12:00:00Z");
const valid = { AI_SPEND_CAP_USD: "10", AI_SPEND_CAP_SINCE: "2026-11-21T02:54:00Z", PGLITE_DIR: "/tmp/ledger" };
const refusal = (env: Record<string, string | undefined>) =>
  guard.checkPaidRunConfig(env, NOW).then(
    () => null,
    (e: unknown) => (e instanceof guard.PaidRunRefused ? e.message : `unexpected: ${String(e)}`),
  );

beforeAll(async () => {
  await (await import("./db/client")).getDb();
});
beforeEach(() => {
  networkCalls.length = 0;
  spend.resetSpendCapState();
  for (const k of Object.keys(process.env)) if (/^AI_SPEND_CAP_/.test(k)) delete process.env[k];
});
afterEach(() => {
  globalThis.fetch = stubFetch;
});

describe("paid runs: configuration is refused before anything is sent", () => {
  it("accepts a valid cap and UTC start time with a persistent ledger", async () => {
    expect(await refusal(valid)).toBeNull();
    expect(await refusal({ ...valid, PGLITE_DIR: undefined })).toBeNull(); // default .data/pg
    expect(await refusal({ ...valid, PGLITE_DIR: "memory://", DATABASE_URL: "postgres://db/x" })).toBeNull();
    expect(await refusal({ ...valid, AI_SPEND_CAP_SINCE: "2026-11-21T02:54:00.123Z" })).toBeNull();
  });

  it("refuses a missing cap or start time", async () => {
    expect(await refusal({ ...valid, AI_SPEND_CAP_USD: undefined })).toMatch(/AI_SPEND_CAP_USD is required/);
    expect(await refusal({ ...valid, AI_SPEND_CAP_USD: "  " })).toMatch(/AI_SPEND_CAP_USD is required/);
    expect(await refusal({ ...valid, AI_SPEND_CAP_SINCE: undefined })).toMatch(/AI_SPEND_CAP_SINCE is required/);
  });

  it("refuses an invalid cap", async () => {
    for (const v of ["ten", "-1", "1e3", "$10", "10 USD", "NaN", "Infinity", "0x10"]) {
      expect(await refusal({ ...valid, AI_SPEND_CAP_USD: v }), v).toMatch(/AI_SPEND_CAP_USD must be a non-negative number/);
    }
    expect(await refusal({ ...valid, AI_SPEND_CAP_USD: "0" })).toMatch(/greater than \$0/);
  });

  it("refuses a start time that isn't a UTC time in the documented format, or is in the future", async () => {
    for (const v of ["yesterday", "2026-11-21", "2026-11-21 02:54:00", "2026-11-21T02:54:00", "2026-11-21T02:54:00+05:30", "Sat, 21 Nov 2026 02:54:00 GMT", "2026-13-40T99:99:99Z"]) {
      expect(await refusal({ ...valid, AI_SPEND_CAP_SINCE: v }), v).toMatch(/AI_SPEND_CAP_SINCE/);
    }
    expect(await refusal({ ...valid, AI_SPEND_CAP_SINCE: "2026-11-22T00:00:00Z" })).toMatch(/in the future/);
  });

  it("refuses an in-memory ledger (earlier spending would be invisible) and CI", async () => {
    expect(await refusal({ ...valid, PGLITE_DIR: "memory://" })).toMatch(/in memory/);
    expect(await refusal({ ...valid, CI: "true" })).toMatch(/never run in CI/);
  });
});

describe("paid runs: the cap counts recorded spending, in-flight requests and the worst case", () => {
  it("refuses the run when recorded spending has used up the cap, without a network request", async () => {
    const since = new Date(Date.now() - 1000).toISOString().replace(/\.\d+Z$/, "Z");
    await recordAttempt({ route: "brand.qa", provider: "anthropic", model: "m", kind: "text", attempt: 1, outcome: "success", costUsd: 0.6, priceSource: "test" });
    await recordAttempt({ route: "image.generate", provider: "openai", model: "m", kind: "image", attempt: 1, outcome: "unknown", costUsd: null, priceSource: "unknown" }); // counts at its $1 reserve
    const env: Record<string, string | undefined> = { AI_SPEND_CAP_USD: "1.6", AI_SPEND_CAP_SINCE: since, PGLITE_DIR: process.env.PGLITE_DIR };
    await expect(guard.preparePaidRun(env)).rejects.toThrow(/already used up/);
    env.AI_SPEND_CAP_USD = "2";
    const budget = await guard.preparePaidRun(env);
    expect(budget.committedUsd).toBeCloseTo(1.6, 9);
    expect(budget.remainingUsd).toBeCloseTo(0.4, 9);
    expect(env.AI_SPEND_CAP_REQUIRED).toBe("true");
    expect(networkCalls).toHaveLength(0);
  });

  it("required mode: a missing or invalid cap refuses each request (fails closed, never 'no cap')", async () => {
    const route = { kind: "text" as const, key: "brand.qa" as const };
    const e1 = await spend.reserveSpend(route, 0.01, { AI_SPEND_CAP_REQUIRED: "true" }).catch((e: unknown) => e);
    expect(classify(e1).kind).toBe("spend_cap");
    // Without required mode, a cap that is set but malformed also fails closed (previously: no cap).
    const e2 = await spend.reserveSpend(route, 0.01, { AI_SPEND_CAP_USD: "ten" }).catch((e: unknown) => e);
    expect(classify(e2).kind).toBe("spend_cap");
    const e3 = await spend.reserveSpend(route, 0.01, { AI_SPEND_CAP_USD: "10", AI_SPEND_CAP_SINCE: "yesterday" }).catch((e: unknown) => e);
    expect(classify(e3).kind).toBe("spend_cap");
    expect(spend.activeReservations()).toBe(0);
  });

  it("in-flight reserves count: concurrent requests can't together exceed the cap", async () => {
    const env = { AI_SPEND_CAP_USD: "1", AI_SPEND_CAP_SINCE: new Date().toISOString(), AI_SPEND_CAP_REQUIRED: "true" };
    const route = { kind: "text" as const, key: "brand.qa" as const };
    const results = await Promise.allSettled([spend.reserveSpend(route, 0.6, env), spend.reserveSpend(route, 0.6, env)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(spend.activeReservations()).toBe(1);
    (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<() => void>).value();
    expect(spend.activeReservations()).toBe(0);
    // A non-finite worst case falls back to the kind's reserve rather than reserving nothing.
    await expect(spend.reserveSpend(route, Number.NaN, { ...env, AI_SPEND_CAP_USD: "0.4" })).rejects.toThrow(/spending cap/);
  });

  it("a real text request with the cap missing in required mode never reaches the network", async () => {
    process.env.AI_SPEND_CAP_REQUIRED = "true";
    const err = await llm()
      .structured({ route: "brand.qa", system: "s", prompt: "p", schema: z.object({ answer: z.string() }), effort: "low", maxTokens: 64, mock: () => ({ answer: "demo" }) })
      .catch((e: unknown) => e);
    expect(classify(err).kind).toBe("spend_cap");
    expect(networkCalls).toHaveLength(0);
  });

  it("a real text request whose worst case exceeds the remaining budget never reaches the network", async () => {
    process.env.AI_SPEND_CAP_REQUIRED = "true";
    process.env.AI_SPEND_CAP_USD = "0.0001";
    process.env.AI_SPEND_CAP_SINCE = new Date().toISOString();
    const err = await llm()
      .structured({ route: "brand.qa", system: "s", prompt: "p", schema: z.object({ answer: z.string() }), effort: "low", maxTokens: 1024, mock: () => ({ answer: "demo" }) })
      .catch((e: unknown) => e);
    expect(classify(err).kind).toBe("spend_cap");
    expect(networkCalls).toHaveLength(0);
  });
});

describe("paid runs: the network guard", () => {
  it("blocks provider requests without a cap reservation and paid hosts the cap doesn't cover", async () => {
    await guard.installPaidRequestGuard({ OPENAI_BASE_URL: "https://gateway.example.test/v1" });
    expect(guard.paidRequestGuardInstalled()).toBe(true);
    for (const url of ["https://api.anthropic.com/v1/messages", "https://api.openai.com/v1/images/generations", "https://gateway.example.test/v1/images/edits", "https://api.voyageai.com/v1/embeddings"]) {
      await expect(fetch(url, { method: "POST" }), url).rejects.toThrow(guard.PaidRunRefused);
    }
    expect(networkCalls).toHaveLength(0);
    // With a reservation (i.e. through the executor), provider requests go through; voyage never does.
    const release = await spend.reserveSpend({ kind: "text" as const, key: "brand.qa" as const }, 0.01, { AI_SPEND_CAP_USD: "10", AI_SPEND_CAP_SINCE: new Date().toISOString(), AI_SPEND_CAP_REQUIRED: "true" });
    await fetch("https://api.anthropic.com/v1/messages", { method: "POST" });
    await expect(fetch("https://api.voyageai.com/v1/embeddings")).rejects.toThrow(guard.PaidRunRefused);
    release();
    await expect(fetch("https://api.anthropic.com/v1/messages")).rejects.toThrow(guard.PaidRunRefused);
    // Other hosts are untouched.
    await fetch("https://example.test/health");
    expect(networkCalls).toEqual(["https://api.anthropic.com/v1/messages", "https://example.test/health"]);
  });

  it("live tests load the guard before any test file", async () => {
    const cfg = fs.readFileSync(path.join(import.meta.dirname, "../../vitest.live.config.ts"), "utf8");
    expect(cfg).toMatch(/setupFiles: \["src\/server\/live\/paid-run\.setup\.ts"\]/);
    const live = fs.readFileSync(path.join(import.meta.dirname, "live/real-providers.live.ts"), "utf8");
    expect(live).not.toMatch(/PGLITE_DIR\s*=\s*"memory:\/\/"/);
    expect(live).toMatch(/paidRequestGuardInstalled\(\)/);
  });
});
