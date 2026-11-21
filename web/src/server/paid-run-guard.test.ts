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

for (const k of Object.keys(process.env)) if (/^(AI_SPEND_CAP_|AI_PROVIDER$|CI$|DATABASE_URL$|ANTHROPIC_|BRANDPILOT_ANTHROPIC_|OPENAI_|VOYAGE_)/.test(k)) delete process.env[k];
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
    await new Promise((r) => setTimeout(r, 5));
    const since = new Date().toISOString(); // after the ledger was created, before these rows
    await recordAttempt({ route: "brand.qa", provider: "anthropic", model: "m", kind: "text", attempt: 1, outcome: "success", costUsd: 0.6, priceSource: "test" });
    await recordAttempt({ route: "image.generate", provider: "openai", model: "m", kind: "image", attempt: 1, outcome: "unknown", costUsd: null, priceSource: "unknown" }); // counts at its $1 reserve
    const env: Record<string, string | undefined> = { AI_SPEND_CAP_USD: "1.6", AI_SPEND_CAP_SINCE: since, PGLITE_DIR: process.env.PGLITE_DIR, AI_SPEND_LEDGER_SINGLE_SESSION: "true" };
    await expect(guard.preparePaidRun(env)).rejects.toThrow(/already used up/);
    env.AI_SPEND_CAP_USD = "2";
    const budget = await guard.preparePaidRun(env);
    expect(budget.committedUsd).toBeCloseTo(1.6, 9);
    expect(budget.remainingUsd).toBeCloseTo(0.4, 9);
    expect(env.AI_SPEND_CAP_REQUIRED).toBe("true");
    expect(budget.ledger).toMatchObject({ storage: "pglite-file", durable: false });
    expect(budget.coverage).toMatch(/SINGLE-SESSION LEDGER/);
    expect(budget.coverage).toMatch(/NOT counted/);
    expect(networkCalls).toHaveLength(0);
  });

  it("a local ledger: refused unless single-session is acknowledged, and never before the ledger began", async () => {
    const { ledgerInfo } = guard;
    const info = await ledgerInfo();
    expect(info.storage).toBe("pglite-file");
    expect(info.durable).toBe(false);
    expect(info.createdAt).toBeInstanceOf(Date);
    const created = info.createdAt!;
    await new Promise((r) => setTimeout(r, 5));
    const after = new Date().toISOString();
    const env = { AI_SPEND_CAP_USD: "10", AI_SPEND_CAP_SINCE: after, PGLITE_DIR: process.env.PGLITE_DIR };
    await expect(guard.preparePaidRun({ ...env })).rejects.toThrow(/local file .* AI_SPEND_LEDGER_SINGLE_SESSION=true/);
    // AI_SPEND_CAP_SINCE before the ledger existed: the cap would appear to cover unrecorded spending.
    const before = new Date(created.getTime() - 60_000).toISOString();
    await expect(guard.preparePaidRun({ ...env, AI_SPEND_LEDGER_SINGLE_SESSION: "true", AI_SPEND_CAP_SINCE: before })).rejects.toThrow(/created at .* after AI_SPEND_CAP_SINCE/);
    expect(networkCalls).toHaveLength(0);
  });

  it("earliestCapSince rounds a fractional-second ledger start UP to the next whole second, never down", () => {
    const f = guard.earliestCapSince;
    expect(f(new Date("2026-11-21T03:54:25.586Z"))).toBe("2026-11-21T03:54:26Z");
    expect(f(new Date("2026-11-21T03:54:25.001Z"))).toBe("2026-11-21T03:54:26Z");
    expect(f(new Date("2026-11-21T03:54:25.999Z"))).toBe("2026-11-21T03:54:26Z");
    expect(f(new Date("2026-11-21T03:54:59.500Z"))).toBe("2026-11-21T03:55:00Z"); // carries into the minute
    expect(f(new Date("2026-12-31T23:59:59.250Z"))).toBe("2027-01-01T00:00:00Z"); // and across the year
    expect(f(new Date("2026-11-21T03:54:25.000Z"))).toBe("2026-11-21T03:54:25Z"); // already whole: kept
    for (const ms of [0, 1, 586, 999]) {
      const created = new Date(Date.UTC(2026, 10, 21, 3, 54, 25, ms));
      const out = f(created);
      expect(out).toMatch(spend.SPEND_CAP_SINCE_FORMAT);
      expect(new Date(out).getTime()).toBeGreaterThanOrEqual(created.getTime());
      expect(new Date(out).getTime() - created.getTime()).toBeLessThan(1000);
    }
  });

  it("the suggested AI_SPEND_CAP_SINCE for a fractional-second ledger start is accepted by the guard", async () => {
    const created = (await guard.ledgerInfo()).createdAt!;
    const suggested = guard.earliestCapSince(created);
    // The old guidance dropped the milliseconds, giving a time before the ledger began: still refused.
    const truncated = created.toISOString().replace(/\.\d+Z$/, "Z");
    if (created.getUTCMilliseconds() > 0) {
      const err = await guard.preparePaidRun({ AI_SPEND_CAP_USD: "10", AI_SPEND_CAP_SINCE: truncated, AI_SPEND_LEDGER_SINGLE_SESSION: "true", PGLITE_DIR: process.env.PGLITE_DIR }).then(() => null, (e: Error) => e.message);
      expect(err).toMatch(/created at .* after AI_SPEND_CAP_SINCE/);
      expect(err).toContain(`Set AI_SPEND_CAP_SINCE to ${suggested} or later`);
      expect(err).not.toContain(`Set AI_SPEND_CAP_SINCE to ${truncated} or later`);
    }
    // The suggestion itself passes (once it is no longer in the future).
    const wait = new Date(suggested).getTime() - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait + 5));
    const budget = await guard.preparePaidRun({ AI_SPEND_CAP_USD: "10", AI_SPEND_CAP_SINCE: suggested, AI_SPEND_LEDGER_SINGLE_SESSION: "true", PGLITE_DIR: process.env.PGLITE_DIR });
    expect(budget.ledger.createdAt).toBe(created.toISOString());
    expect(networkCalls).toHaveLength(0);
  });

  it("refuses the run when the ledger database is unavailable, without a network request", async () => {
    const g = globalThis as unknown as { __db?: Promise<unknown> };
    const saved = g.__db;
    const down = Promise.reject(new Error("connection refused (test)"));
    down.catch(() => {});
    g.__db = down;
    try {
      const env = { AI_SPEND_CAP_USD: "10", AI_SPEND_CAP_SINCE: new Date().toISOString(), PGLITE_DIR: process.env.PGLITE_DIR, AI_SPEND_LEDGER_SINGLE_SESSION: "true" };
      await expect(guard.preparePaidRun(env)).rejects.toThrow(/usage ledger \(database\) is unavailable/);
    } finally {
      g.__db = saved;
    }
    expect(networkCalls).toHaveLength(0);
  });

  it("required mode: a missing or invalid cap refuses each request (fails closed, never 'no cap')", async () => {
    const route = { kind: "text" as const, key: "brand.qa" as const, provider: "anthropic" as const, model: "claude-opus-5-5" };
    const e1 = await spend.openAttempt(route, { attempt: 1 }, 0.01, { AI_SPEND_CAP_REQUIRED: "true" }).catch((e: unknown) => e);
    expect(classify(e1).kind).toBe("spend_cap");
    // Without required mode, a cap that is set but malformed also fails closed (previously: no cap).
    const e2 = await spend.openAttempt(route, { attempt: 1 }, 0.01, { AI_SPEND_CAP_USD: "ten" }).catch((e: unknown) => e);
    expect(classify(e2).kind).toBe("spend_cap");
    const e3 = await spend.openAttempt(route, { attempt: 1 }, 0.01, { AI_SPEND_CAP_USD: "10", AI_SPEND_CAP_SINCE: "yesterday" }).catch((e: unknown) => e);
    expect(classify(e3).kind).toBe("spend_cap");
    expect(spend.activeReservations()).toBe(0);
  });

  it("in-flight reserves count: concurrent requests can't together exceed the cap", async () => {
    const env = { AI_SPEND_CAP_USD: "1", AI_SPEND_CAP_SINCE: new Date().toISOString(), AI_SPEND_CAP_REQUIRED: "true" };
    const route = { kind: "text" as const, key: "brand.qa" as const, provider: "anthropic" as const, model: "claude-opus-5-5" };
    const results = await Promise.allSettled([spend.openAttempt(route, { attempt: 1 }, 0.6, env), spend.openAttempt(route, { attempt: 1 }, 0.6, env)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(spend.activeReservations()).toBe(1);
    const ticket = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<import("./ai/spend-cap").Ticket>).value;
    await spend.settleAttempt(ticket, { outcome: "failed", errorKind: "server" }); // not billed: releases the reserve
    expect(spend.activeReservations()).toBe(0);
    // A non-finite worst case falls back to the kind's reserve ($0.50) rather than reserving nothing.
    await expect(spend.openAttempt(route, { attempt: 1 }, Number.NaN, { ...env, AI_SPEND_CAP_USD: "0.4" })).rejects.toThrow(/spending cap/);
  });

  it("staging (web app and worker) refuses to start without a required, valid cap", async () => {
    const { checkConfig, enforceConfig } = await import("./config");
    const errs = (env: Record<string, string>) => checkConfig(env).filter((p) => p.level === "error").map((p) => p.key);
    const staging = { DEPLOY_ENV: "staging" };
    expect(errs(staging)).toEqual(expect.arrayContaining(["AI_SPEND_CAP_REQUIRED", "AI_SPEND_CAP_USD", "AI_SPEND_CAP_SINCE"]));
    const ok = { ...staging, AI_SPEND_CAP_REQUIRED: "true", AI_SPEND_CAP_USD: "10", AI_SPEND_CAP_SINCE: "2026-11-21T02:54:00Z" };
    expect(errs(ok)).not.toEqual(expect.arrayContaining(["AI_SPEND_CAP_REQUIRED"]));
    expect(errs(ok).filter((k) => k.startsWith("AI_SPEND_CAP"))).toEqual([]);
    expect(errs({ ...ok, AI_SPEND_CAP_SINCE: "2026-11-21" })).toContain("AI_SPEND_CAP_SINCE");
    expect(errs({ ...ok, VOYAGE_API_KEY: "x" })).toContain("VOYAGE_API_KEY");
    expect(errs({ ...ok, AI_SPEND_CAP_REQUIRED: "maybe" })).toContain("AI_SPEND_CAP_REQUIRED");
    // Production: opt-in, with the same checks.
    expect(errs({ DEPLOY_ENV: "production" }).filter((k) => k.startsWith("AI_SPEND_CAP"))).toEqual([]);
    expect(errs({ DEPLOY_ENV: "production", AI_SPEND_CAP_REQUIRED: "true" })).toEqual(expect.arrayContaining(["AI_SPEND_CAP_USD", "AI_SPEND_CAP_SINCE"]));
    // In strict environments a configuration error stops the process (web and worker both call this).
    let code: number | null = null;
    const quiet = { error: console.error, warn: console.warn };
    console.error = console.warn = () => {};
    try {
      enforceConfig("worker", staging, ((c: number) => {
        code = c;
        return undefined as never;
      }) as (c: number) => never);
    } finally {
      console.error = quiet.error;
      console.warn = quiet.warn;
    }
    expect(code).toBe(1);
  });

  it("staging is always required-cap mode", () => {
    expect(spend.spendCapRequired({ DEPLOY_ENV: "staging" })).toBe(true);
    expect(spend.spendCapRequired({ DEPLOY_ENV: "staging", AI_SPEND_CAP_REQUIRED: "false" })).toBe(true);
    expect(spend.spendCapRequired({ DEPLOY_ENV: "production" })).toBe(false);
    expect(spend.spendCapRequired({ DEPLOY_ENV: "production", AI_SPEND_CAP_REQUIRED: "true" })).toBe(true);
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
    const ticket = await spend.openAttempt({ kind: "text" as const, key: "brand.qa" as const, provider: "anthropic" as const, model: "claude-opus-5-5" }, { attempt: 1 }, 0.01, { AI_SPEND_CAP_USD: "10", AI_SPEND_CAP_SINCE: new Date().toISOString(), AI_SPEND_CAP_REQUIRED: "true" });
    await fetch("https://api.anthropic.com/v1/messages", { method: "POST" });
    await expect(fetch("https://api.voyageai.com/v1/embeddings")).rejects.toThrow(guard.PaidRunRefused);
    await spend.settleAttempt(ticket, { outcome: "failed", errorKind: "server" });
    await expect(fetch("https://api.anthropic.com/v1/messages")).rejects.toThrow(guard.PaidRunRefused);
    // Other hosts are untouched.
    await fetch("https://example.test/health");
    expect(networkCalls).toEqual(["https://api.anthropic.com/v1/messages", "https://example.test/health"]);
  });

  it("no other entry point talks to a paid AI provider directly (all go through the executor's accounting)", () => {
    // Allowed: the two provider adapters (every request inside execute(), call.ts), the guard itself,
    // the one-request check CLI (through llm.ts), and Voyage embeddings (refused while a cap is required).
    const allowed = new Set(["ai/llm.ts", "ai/image.ts", "ai/paid-run-guard.ts", "ai/anthropic-check-cli.ts", "ai/embeddings.ts"]);
    // Type-only SDK imports are fine; a value import (the client) or a direct Messages call is not.
    const pattern = /new Anthropic\(|api\.anthropic\.com|api\.openai\.com|OPENAI_URL\(\)|api\.voyageai\.com|from "openai"|^import (?!type )[^;]*from "@anthropic-ai\/sdk"|anthropicClient|\.messages\.create\(/m;
    const offenders: string[] = [];
    const root = path.join(import.meta.dirname, "..");
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f.name) && !/\.(test|live)\.ts$/.test(f.name) && pattern.test(fs.readFileSync(p, "utf8"))) offenders.push(path.relative(path.join(root, "server"), p));
      }
    };
    walk(root);
    expect(offenders.filter((f) => !allowed.has(f) && f !== "ai/errors.ts")).toEqual([]);
    // In the adapters, every provider call sits inside an execute() callback.
    const llmSrc = fs.readFileSync(path.join(root, "server/ai/llm.ts"), "utf8");
    expect(llmSrc.match(/anthropic\(\)\.beta\.messages/g)?.length ?? 0).toBe(llmSrc.match(/await execute\(/g)?.length ?? -1);
    const imageSrc = fs.readFileSync(path.join(root, "server/ai/image.ts"), "utf8");
    expect(imageSrc.match(/openaiRequest\(/g)?.length).toBeGreaterThan(1);
    expect(imageSrc.match(/await execute\(/g)?.length).toBe(1);
  });

  it("live tests load the guard before any test file", async () => {
    const cfg = fs.readFileSync(path.join(import.meta.dirname, "../../vitest.live.config.ts"), "utf8");
    expect(cfg).toMatch(/setupFiles: \["src\/server\/live\/paid-run\.setup\.ts"\]/);
    const live = fs.readFileSync(path.join(import.meta.dirname, "live/real-providers.live.ts"), "utf8");
    expect(live).not.toMatch(/PGLITE_DIR\s*=\s*"memory:\/\/"/);
    expect(live).toMatch(/paidRequestGuardInstalled\(\)/);
  });
});
