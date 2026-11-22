/**
 * Fail-closed usage accounting (spend-cap.ts, call.ts): a paid request is sent only after its usage
 * row is durably recorded as pending; the row is settled in place; failures to record refuse the
 * request (database down, write failed) or the next one (settlement failed); interrupted attempts
 * keep counting at their reserve; concurrent and retried attempts are never double-counted.
 * The provider is a stub: no real request is ever made.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, gte } from "drizzle-orm";
import { z } from "zod";

for (const k of Object.keys(process.env)) if (/^(AI_SPEND_CAP_|AI_PROVIDER$|DATABASE_URL$|ANTHROPIC_|OPENAI_|VOYAGE_|AI_TEXT_TIMEOUT_MS$|AI_MAX_ATTEMPTS$|DEPLOY_ENV$)/.test(k)) delete process.env[k];
// A persistent ledger: a temporary PGlite directory, or, with TEST_DATABASE_URL, a fresh database on
// a real Postgres server (pooled connections: concurrent transactions really race for the lock).
const PG_ADMIN = process.env.TEST_DATABASE_URL;
let pgDatabase: string | null = null;
if (PG_ADMIN) {
  const { default: postgres } = await import("postgres");
  pgDatabase = `bp_accounting_${Date.now().toString(36)}`;
  const admin = postgres(PG_ADMIN, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${pgDatabase}`);
  await admin.end();
  const u = new URL(PG_ADMIN);
  u.pathname = `/${pgDatabase}`;
  process.env.DATABASE_URL = u.toString();
} else {
  process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-accounting-pg-"));
}
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-accounting-store-"));
process.env.ANTHROPIC_API_KEY = "placeholder-not-a-real-key";
process.env.AI_RETRY_BASE_MS = "1";

type Handler = () => Response | Promise<Response>;
const ok = () =>
  new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: JSON.stringify({ answer: "ok" }) }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 10 },
    }),
    { status: 200, headers: { "content-type": "application/json", "request-id": "req_ok" } },
  );
const overloaded = () => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy (test)" } }), { status: 529, headers: { "content-type": "application/json", "request-id": "req_529" } });
let handler: Handler = ok;
let networkCalls = 0;
/** The JSON body and `anthropic-beta` header of the last request sent to the provider. */
let lastBody: Record<string, unknown> = {};
let lastBeta = "";
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("https://api.anthropic.com/")) throw new Error(`unexpected host in test: ${url}`);
  networkCalls++;
  lastBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  lastBeta = new Headers(init?.headers).get("anthropic-beta") ?? "";
  const signal = init?.signal;
  return new Promise<Response>((resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")), { once: true });
    Promise.resolve(handler()).then(resolve, reject);
  });
}) as typeof fetch;

const { getDb, schema } = await import("./db/client");
const { llm } = await import("./ai/llm");
const { classify, AIAccountingError } = await import("./ai/errors");
const { resetCircuits } = await import("./ai/circuit");
const spend = await import("./ai/spend-cap");
const { requestLog } = await import("./ai/billing");
const { sql } = await import("drizzle-orm");

const ask = () => llm().structured({ route: "brand.qa", system: "s", prompt: "Reply ok", schema: z.object({ answer: z.string() }), effort: "low", maxTokens: 1024, mock: () => ({ answer: "demo" }) });
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => e);
const rowsSince = async (since: Date) => {
  const db = await getDb();
  const e = schema.usageEvents;
  return db.select().from(e).where(and(gte(e.createdAt, since), eq(e.provider, "anthropic"))).orderBy(e.createdAt);
};
/** Takes the ledger table away (and back), as a database failure would. */
const ledgerOffline = async (off: boolean) => {
  const db = await getDb();
  await db.execute(off ? sql`alter table usage_events rename to usage_events_offline` : sql`alter table usage_events_offline rename to usage_events`);
};
let worst = 0;
/** The reserve of one `ask()` under a cap: Opus 5.5 alone (its fallback list isn't confirmed, so no fallbacks are sent). */
let cappedWorst = 0;

beforeAll(async () => {
  // The worst-case reserve of one `ask()` (input estimate + full output limit), from a first, uncapped call.
  const since = new Date();
  await ask();
  const [row] = await rowsSince(since);
  worst = row.reserveUsd!;
  expect(worst).toBeGreaterThan(0);
  const capSince = new Date();
  process.env.AI_SPEND_CAP_USD = "1000";
  process.env.AI_SPEND_CAP_SINCE = capSince.toISOString();
  await ask();
  delete process.env.AI_SPEND_CAP_USD;
  delete process.env.AI_SPEND_CAP_SINCE;
  cappedWorst = (await rowsSince(capSince))[0].reserveUsd!;
  expect(cappedWorst).toBeGreaterThan(0);
  expect(cappedWorst).toBeLessThan(worst);
});
afterAll(async () => {
  if (!PG_ADMIN || !pgDatabase) return;
  const { default: postgres } = await import("postgres");
  const admin = postgres(PG_ADMIN, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${pgDatabase} with (force)`);
  await admin.end();
});
beforeEach(() => {
  handler = ok;
  networkCalls = 0;
  resetCircuits();
  spend.resetSpendCapState();
  for (const k of Object.keys(process.env)) if (/^AI_SPEND_CAP_|^AI_TEXT_TIMEOUT_MS$|^AI_MAX_ATTEMPTS$/.test(k)) delete process.env[k];
  process.env.AI_MAX_ATTEMPTS = "1";
});

describe("accounting before sending", () => {
  it("a successful request: one row, written as pending before sending and settled in place", async () => {
    const since = new Date();
    let seenPending = 0;
    handler = async () => {
      seenPending = (await rowsSince(since)).filter((r) => r.outcome === "pending").length; // at send time
      return ok();
    };
    expect(await outcome(ask())).toBe("ok");
    expect(seenPending).toBe(1);
    const rows = await rowsSince(since);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "success", providerRequestId: "req_ok" });
    expect(rows[0].costUsd).toBeGreaterThan(0);
    expect(rows[0].settledAt).toBeInstanceOf(Date);
    expect((await spend.committedSpendUsd(since)).usd).toBeCloseTo(rows[0].costUsd!, 9); // the cost, not cost + reserve
  });

  it("database unavailable: the request is refused and nothing is sent", async () => {
    const g = globalThis as unknown as { __db?: Promise<unknown> };
    const saved = g.__db;
    const down = Promise.reject(new Error("connection refused (test)"));
    down.catch(() => {});
    g.__db = down;
    let err: unknown;
    try {
      err = await outcome(ask());
    } finally {
      g.__db = saved;
    }
    expect(err).toBeInstanceOf(AIAccountingError);
    expect(classify(err).kind).toBe("spend_cap");
    expect(networkCalls).toBe(0);
    expect(spend.activeReservations()).toBe(0);
  });

  it("the pending usage row can't be written: the request is refused and nothing is sent", async () => {
    await ledgerOffline(true);
    let err: unknown;
    try {
      err = await outcome(ask());
    } finally {
      await ledgerOffline(false);
    }
    expect(err).toBeInstanceOf(AIAccountingError);
    expect(networkCalls).toBe(0);
  });

  it("the settlement can't be written: the row stays pending at its reserve, further requests are refused until it is written, then it is settled once", async () => {
    const since = new Date();
    handler = async () => {
      await ledgerOffline(true); // the database goes away while the request is in flight
      return ok();
    };
    expect(await outcome(ask())).toBe("ok"); // already paid for: the result is still returned
    expect(spend.unsettledAttempts()).toBe(1);
    expect(spend.activeReservations()).toBe(0);
    handler = ok;
    // Still offline: the next request is refused before sending.
    expect(await outcome(ask())).toBeInstanceOf(AIAccountingError);
    expect(networkCalls).toBe(1);
    await ledgerOffline(false);
    // Back online, but the earlier settlement hasn't been written yet: the row still counts at its reserve.
    let rows = await rowsSince(since);
    expect(rows.map((r) => r.outcome)).toEqual(["pending"]);
    expect((await spend.committedSpendUsd(since)).usd).toBeCloseTo(worst, 9);
    // The next request first writes the outstanding settlement, then proceeds.
    expect(await outcome(ask())).toBe("ok");
    expect(spend.unsettledAttempts()).toBe(0);
    expect(networkCalls).toBe(2);
    rows = await rowsSince(since);
    expect(rows.map((r) => r.outcome)).toEqual(["success", "success"]);
    expect((await spend.committedSpendUsd(since)).usd).toBeCloseTo(rows[0].costUsd! + rows[1].costUsd!, 9); // each counted once
  });
});

describe("interrupted executions", () => {
  it("a process that dies mid-request leaves a pending row that keeps counting at its reserve", async () => {
    const since = new Date();
    // Open an attempt as the executor does just before sending, then "crash" (forget process state).
    await spend.openAttempt({ kind: "text", key: "brand.qa", provider: "anthropic", model: "claude-opus-5-5" }, { attempt: 1 }, worst);
    spend.resetSpendCapState();
    const spent = await spend.committedSpendUsd(since);
    expect(spent.pendingAttempts).toBe(1);
    expect(spent.usd).toBeCloseTo(worst, 9);
    const log = await requestLog(since, null, 10);
    expect(log.map((r) => r.outcome)).toEqual(["pending"]);
    expect(log[0].countedUsd).toBeCloseTo(worst, 9);
    // A cap with room for less than one more request: the interrupted attempt still counts, so the next request is refused unsent.
    process.env.AI_SPEND_CAP_USD = String(worst + cappedWorst * 0.5);
    process.env.AI_SPEND_CAP_SINCE = since.toISOString();
    expect(classify(await outcome(ask())).kind).toBe("spend_cap");
    expect(networkCalls).toBe(0);
  });

  it("a timed-out request (sent, no response) is settled as unknown and counted once, at its reserve", async () => {
    const since = new Date();
    process.env.AI_TEXT_TIMEOUT_MS = "30";
    handler = () => new Promise<Response>(() => {});
    const err = await outcome(ask());
    expect(classify(err).kind).toBe("timeout");
    expect(networkCalls).toBe(1);
    const rows = await rowsSince(since);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "unknown", costUsd: null });
    expect((await spend.committedSpendUsd(since)).usd).toBeCloseTo(worst, 9);
  });
});

describe("the assistant's tool-use loop (formerly a direct client call)", () => {
  it("each step goes through the executor: recorded on advisor.chat, and refused unsent when the ledger can't record it", async () => {
    const db = await getDb();
    const [ws] = await db.insert(schema.workspaces).values({ name: "Acct", plan: "growth" }).returning();
    const [brand] = await db.insert(schema.brands).values({ workspaceId: ws.id, name: "Kora" }).returning();
    const { chat } = await import("./agents/assistant");
    const scope = { brandId: brand.id, userId: "u-acct" };
    handler = () =>
      new Response(
        JSON.stringify({ id: "msg_a", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Here is a plan." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 50, output_tokens: 5 } }),
        { status: 200, headers: { "content-type": "application/json", "request-id": "req_chat" } },
      );
    const since = new Date();
    const res = await chat(scope, brand, "What should we post this week?");
    expect(res.text).toBe("Here is a plan.");
    expect(networkCalls).toBe(1);
    const rows = await rowsSince(since);
    expect(rows.map((r) => [r.route, r.outcome, r.providerRequestId])).toEqual([["advisor.chat", "success", "req_chat"]]);
    expect(rows[0].costUsd).toBeGreaterThan(0);
    // Ledger unavailable: the assistant's request is refused before sending.
    await ledgerOffline(true);
    let err: unknown;
    try {
      err = await outcome(chat(scope, brand, "And next week?"));
    } finally {
      await ledgerOffline(false);
    }
    expect(classify(err).kind).toBe("spend_cap");
    expect(networkCalls).toBe(1);
  });
});

describe("concurrency and retries", () => {
  /**
   * Starts `n` concurrent `ask()`s while the provider holds every request it receives. Resolves once
   * each request has either reached the provider or been refused, so every cap check has run while
   * the sent requests' full reserves still count. Only then may the test release the provider: if a
   * held request settled earlier, its reserve would drop to its (much smaller) actual cost and a
   * later request could legitimately fit, which a fixed delay can't rule out on a loaded machine.
   * No timer decides the outcome; a 10 s guard fails the test instead of letting it hang.
   */
  async function concurrentAsks(n: number) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let arrived = 0;
    let allArrived!: () => void;
    const barrier = new Promise<void>((r) => (allArrived = r));
    const arrive = () => {
      if (++arrived === n) allArrived();
    };
    handler = async () => {
      arrive(); // reached the provider: its pending reserve is committed
      await gate;
      return ok();
    };
    const all = Array.from({ length: n }, () =>
      outcome(ask()).then((r) => {
        if (r !== "ok") arrive(); // refused before sending (a sent request only finishes after release)
        return r;
      }),
    );
    let guard: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      barrier,
      new Promise((_, reject) => (guard = setTimeout(() => reject(new Error(`only ${arrived} of ${n} requests reached the cap check`)), 10_000))),
    ]).finally(() => clearTimeout(guard));
    return { release, all };
  }

  it("concurrent requests: only those whose worst cases fit under the cap are sent", async () => {
    const since = new Date();
    process.env.AI_SPEND_CAP_USD = String(cappedWorst * 1.5); // room for one worst case, not two
    process.env.AI_SPEND_CAP_SINCE = since.toISOString();
    const { release, all } = await concurrentAsks(5);
    // Every request has been decided while the sent one is still in flight, holding its full reserve.
    expect(networkCalls).toBe(1);
    const held = await spend.committedSpendUsd(since);
    expect(held.pendingAttempts).toBe(1);
    expect(held.usd).toBeCloseTo(cappedWorst, 9);
    release();
    const results = await Promise.all(all);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r !== "ok").every((e) => classify(e).kind === "spend_cap")).toBe(true);
    expect(networkCalls).toBe(1);
    expect((await spend.committedSpendUsd(since)).pendingAttempts).toBe(0);
    const rows = await rowsSince(since);
    expect(rows.filter((r) => r.outcome === "success")).toHaveLength(1);
    expect(rows.filter((r) => r.outcome === "blocked" && r.errorKind === "spend_cap" && r.reserveUsd === null)).toHaveLength(4);
  });

  it("concurrent requests: as many are sent as their worst cases fit (two of five), the rest refused", async () => {
    const since = new Date();
    process.env.AI_SPEND_CAP_USD = String(cappedWorst * 2.5); // room for two worst cases, not three
    process.env.AI_SPEND_CAP_SINCE = since.toISOString();
    const { release, all } = await concurrentAsks(5);
    expect(networkCalls).toBe(2);
    const held = await spend.committedSpendUsd(since);
    expect(held.pendingAttempts).toBe(2);
    expect(held.usd).toBeCloseTo(cappedWorst * 2, 9);
    expect(held.usd).toBeLessThanOrEqual(cappedWorst * 2.5);
    release();
    const results = await Promise.all(all);
    expect(results.filter((r) => r === "ok")).toHaveLength(2);
    expect(results.filter((r) => r !== "ok").every((e) => classify(e).kind === "spend_cap")).toBe(true);
    expect(networkCalls).toBe(2);
    const rows = await rowsSince(since);
    expect(rows.filter((r) => r.outcome === "success")).toHaveLength(2);
    expect(rows.filter((r) => r.outcome === "blocked" && r.errorKind === "spend_cap")).toHaveLength(3);
    expect((await spend.committedSpendUsd(since)).pendingAttempts).toBe(0);
  });

  it("another process's in-flight request counts: its pending row holds its reserve", async () => {
    const since = new Date();
    process.env.AI_SPEND_CAP_USD = String(cappedWorst * 1.5);
    process.env.AI_SPEND_CAP_SINCE = since.toISOString();
    const other = await spend.openAttempt({ kind: "text", key: "brand.qa", provider: "anthropic", model: "claude-opus-5-5" }, { attempt: 1 }, cappedWorst);
    spend.resetSpendCapState(); // as seen from a different process
    expect(classify(await outcome(ask())).kind).toBe("spend_cap");
    expect(networkCalls).toBe(0);
    await spend.settleAttempt(other, { outcome: "failed", errorKind: "server" }); // not billed
    expect(await outcome(ask())).toBe("ok");
    expect(networkCalls).toBe(1);
  });

  it("a timed-out attempt that is retried still counts at its reserve (it may have been billed)", async () => {
    const since = new Date();
    process.env.AI_MAX_ATTEMPTS = "2";
    process.env.AI_TEXT_TIMEOUT_MS = "30";
    let n = 0;
    handler = () => (++n === 1 ? new Promise<Response>(() => {}) : ok());
    expect(await outcome(ask())).toBe("ok");
    expect(networkCalls).toBe(2);
    const rows = await rowsSince(since);
    expect(rows.map((r) => [r.outcome, r.priceSource])).toEqual([
      ["retried", "unknown"],
      ["success", expect.any(String)],
    ]);
    expect((await spend.committedSpendUsd(since)).usd).toBeCloseTo(worst + rows[1].costUsd!, 9);
    const log = await requestLog(since, null, null);
    expect(log[0].countedUsd).toBeCloseTo(worst, 9);
  });

  it("the worst case with server-side fallbacks covers the routed model and every fallback target", async () => {
    const { routeWorstCaseUsd, textWorstCaseUsd } = await import("./ai/llm");
    const { textCost } = await import("./ai/pricing");
    const { TEXT_MODELS, SERVER_FALLBACK_TARGETS } = await import("./ai/catalog");
    const req = { chars: 3000, maxTokens: 4000 };
    for (const m of Object.keys(TEXT_MODELS)) {
      const w = routeWorstCaseUsd(m, req, textCost)!;
      const own = textWorstCaseUsd(m, req, textCost)!;
      if (!TEXT_MODELS[m].serverFallback) {
        expect(w).toBeCloseTo(own, 12);
        continue;
      }
      // Every target is priced (none falls back to "unpriced"), and the bound is the sum of all of them.
      const targets = SERVER_FALLBACK_TARGETS[m];
      expect(targets.length).toBeGreaterThan(0);
      const each = targets.map((t) => textWorstCaseUsd(t, req, textCost));
      expect(each.every((v) => v !== null && v > 0)).toBe(true);
      expect(w).toBeCloseTo(own + each.reduce<number>((s, v) => s + (v ?? 0), 0), 12);
    }
  });

  it("a retried request: one row per attempt, each settled once; settling twice changes nothing", async () => {
    const since = new Date();
    process.env.AI_MAX_ATTEMPTS = "2";
    let n = 0;
    handler = () => (++n === 1 ? overloaded() : ok());
    expect(await outcome(ask())).toBe("ok");
    expect(networkCalls).toBe(2);
    const rows = await rowsSince(since);
    expect(rows.map((r) => [r.attempt, r.outcome])).toEqual([
      [1, "retried"],
      [2, "success"],
    ]);
    expect((await spend.committedSpendUsd(since)).usd).toBeCloseTo(rows[1].costUsd!, 9);
    // A repeated settlement (e.g. a recovery retry) only ever applies to a pending row.
    await spend.settleAttempt({ id: rows[1].id, reserveUsd: worst }, { outcome: "unknown", errorKind: "timeout" });
    const again = await rowsSince(since);
    expect(again[1]).toMatchObject({ outcome: "success", costUsd: rows[1].costUsd });
  });
});

/**
 * Server-side fallbacks (`fallbacks: "default"`): the routed model declines and another model answers
 * in the same request. Anthropic reports each attempt in `usage.iterations` (the declined one as a
 * `message` entry, the serving one as `fallback_message`); the top-level `usage` covers only the
 * serving attempt, and each attempt is billed at its own model's rates. The response below is a
 * deterministic stand-in with that shape; nothing is sent to Anthropic.
 */
describe("server-side fallback accounting", () => {
  // Claude Opus 5.5 declines mid-output; Claude Opus 5 answers.
  const PRIMARY = { model: "claude-opus-5-5", input: 300, output: 200, cacheRead: 0 };
  const FALLBACK = { model: "claude-opus-5", input: 300, output: 40, cacheRead: 1000 };
  // List prices per MTok: Opus 5.5 $4 in / $20 out; Opus 5 $5 in / $25 out / $0.50 cache read.
  const PRIMARY_USD = (300 * 4 + 200 * 20) / 1e6; // 0.0052
  const FALLBACK_USD = (300 * 5 + 40 * 25 + 1000 * 0.5) / 1e6; // 0.003
  const fallbackServed = (iterations = true, primary = PRIMARY, fallback = FALLBACK) =>
    new Response(
      JSON.stringify({
        id: "msg_fallback",
        type: "message",
        role: "assistant",
        model: fallback.model,
        content: [
          { type: "fallback", from: { model: primary.model }, to: { model: fallback.model }, trigger: { type: "refusal", category: "cyber" } },
          { type: "text", text: JSON.stringify({ answer: "ok" }) },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        // Top level: the serving attempt only.
        usage: {
          input_tokens: fallback.input,
          output_tokens: fallback.output,
          cache_read_input_tokens: fallback.cacheRead,
          cache_creation_input_tokens: 0,
          iterations: iterations
            ? [
                { type: "message", model: primary.model, input_tokens: primary.input, output_tokens: primary.output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
                { type: "fallback_message", model: fallback.model, input_tokens: fallback.input, output_tokens: fallback.output, cache_read_input_tokens: fallback.cacheRead, cache_creation_input_tokens: 0, cache_creation: null },
              ]
            : null,
        },
      }),
      { status: 200, headers: { "content-type": "application/json", "request-id": "req_fallback" } },
    );

  it("both attempts are counted, each at its own model's rates; the reservation is settled once", async () => {
    const since = new Date();
    let seenPending = 0;
    handler = async () => {
      seenPending = (await rowsSince(since)).filter((r) => r.outcome === "pending").length;
      return fallbackServed();
    };
    expect(await outcome(ask())).toBe("ok");
    expect(networkCalls).toBe(1);
    expect(seenPending).toBe(1); // reserved before sending
    const rows = await rowsSince(since);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ outcome: "success", model: FALLBACK.model, providerRequestId: "req_fallback" });
    // Totals across both attempts, and each model's own tokens.
    expect(row.units).toMatchObject({
      inputTokens: PRIMARY.input + FALLBACK.input,
      outputTokens: PRIMARY.output + FALLBACK.output,
      cacheReadTokens: FALLBACK.cacheRead,
      "claude-opus-5-5:inputTokens": PRIMARY.input,
      "claude-opus-5-5:outputTokens": PRIMARY.output,
      "claude-opus-5:inputTokens": FALLBACK.input,
      "claude-opus-5:outputTokens": FALLBACK.output,
      "claude-opus-5:cacheReadTokens": FALLBACK.cacheRead,
    });
    expect(row.costUsd).toBeCloseTo(PRIMARY_USD + FALLBACK_USD, 9);
    // Each model's price source: Opus 5.5 from the catalog list, Opus 5 from the fallback-model list.
    expect(row.priceSource).toBe("anthropic-list-2026-11-10; anthropic-list-2026-11-03");
    // The reserve covered the real cost; settled: nothing pending, the cap counts the real cost.
    expect(row.reserveUsd!).toBeGreaterThanOrEqual(row.costUsd!);
    expect(row.settledAt).not.toBeNull();
    const spent = await spend.committedSpendUsd(since);
    expect(spent.pendingAttempts).toBe(0);
    expect(spent.usd).toBeCloseTo(PRIMARY_USD + FALLBACK_USD, 9);
  });

  it("a fallback-served response without iterations is unpriced (counted at its reserve), not priced as its last attempt", async () => {
    // The top-level usage covers only the serving attempt ($0.003 here); the `fallback` block shows a
    // declined attempt ran too. Without per-attempt usage it can't be priced, so it counts at its reserve.
    const since = new Date();
    handler = () => fallbackServed(false);
    expect(await outcome(ask())).toBe("ok");
    const [row] = await rowsSince(since);
    expect(row).toMatchObject({ outcome: "success", costUsd: null, priceSource: "unpriced" });
    expect(row.units).toMatchObject({ inputTokens: FALLBACK.input, outputTokens: FALLBACK.output });
    const spent = await spend.committedSpendUsd(since);
    expect(spent.usd).toBeCloseTo(row.reserveUsd!, 9);
    expect(spent.usd).toBeGreaterThan(PRIMARY_USD + FALLBACK_USD);
  });

  it("per-model parts are priced separately, kept through aggregation, and unpriced if any model is unknown", async () => {
    const { textCost, addUsage, estimateCost } = await import("./ai/pricing");
    const parts = [
      { model: PRIMARY.model, inputTokens: PRIMARY.input, outputTokens: PRIMARY.output },
      { model: FALLBACK.model, inputTokens: FALLBACK.input, outputTokens: FALLBACK.output, cacheReadTokens: FALLBACK.cacheRead },
    ];
    expect(textCost({ model: FALLBACK.model, byModel: parts }).usd).toBeCloseTo(PRIMARY_USD + FALLBACK_USD, 9);
    // Blending the totals at the served model's rates would be wrong (here, too high).
    const blended = textCost({ model: FALLBACK.model, inputTokens: 600, outputTokens: 240, cacheReadTokens: 1000 }).usd!;
    expect(blended).not.toBeCloseTo(PRIMARY_USD + FALLBACK_USD, 6);
    // A run that makes a normal request and then a fallback-served one: each part keeps its rates.
    const plain = { model: PRIMARY.model, inputTokens: 100, outputTokens: 10 };
    const run = addUsage(addUsage({}, plain), { model: FALLBACK.model, inputTokens: 600, outputTokens: 240, cacheReadTokens: 1000, byModel: parts });
    expect(estimateCost(run)).toBeCloseTo((100 * 4 + 10 * 20) / 1e6 + PRIMARY_USD + FALLBACK_USD, 9);
    // A part whose model isn't reported, or has no price, makes the whole attempt unpriced (never guessed).
    expect(textCost({ model: FALLBACK.model, byModel: [{ inputTokens: 10 }, parts[1]] })).toEqual({ usd: null, source: "unpriced" });
    expect(textCost({ model: "claude-opus-4-1", byModel: [{ model: "claude-opus-4-1", inputTokens: 10 }] }).usd).toBeNull();
  });

  it("the reserve covers a worst-case fallback chain that a single-model reserve would not", async () => {
    const { routeWorstCaseUsd, textWorstCaseUsd } = await import("./ai/llm");
    const { textCost } = await import("./ai/pricing");
    const req = { chars: 3000, maxTokens: 4000 };
    // Worst chain: Opus 5.5 declines after its full output, Opus 5 declines after its full output, Opus 4.8 answers.
    const chain = ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"].reduce((s, m) => s + textWorstCaseUsd(m, req, textCost)!, 0);
    const reserve = routeWorstCaseUsd("claude-opus-5-5", req, textCost)!;
    expect(reserve).toBeGreaterThanOrEqual(chain - 1e-12);
    // The previous bound (the most expensive catalog model, once) is below even one Opus 5 attempt.
    const previous = textWorstCaseUsd("claude-opus-5-5", req, textCost)!;
    expect(previous).toBeLessThan(textWorstCaseUsd("claude-opus-5", req, textCost)!);
    expect(previous).toBeLessThan(chain);
  });


  // R1: every model in the chain refuses. There is no `fallback_message` entry; the iterations name both models.
  it("a chain in which every model refuses: each attempt counted once, at its own model's rates", async () => {
    const since = new Date();
    const it = (model: string, input: number, output: number) => ({ type: "message", model, input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null });
    handler = () =>
      new Response(
        JSON.stringify({
          id: "msg_refused",
          type: "message",
          role: "assistant",
          model: FALLBACK.model,
          content: [{ type: "fallback", from: { model: PRIMARY.model }, to: { model: FALLBACK.model }, trigger: { type: "refusal", category: "cyber" } }],
          stop_reason: "refusal",
          stop_sequence: null,
          // Top level: the last attempt only (which also appears in the iterations; it must not be added twice).
          usage: { input_tokens: 300, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, iterations: [it(PRIMARY.model, 300, 200), it(FALLBACK.model, 300, 50)] },
        }),
        { status: 200, headers: { "content-type": "application/json", "request-id": "req_refused" } },
      );
    expect(classify(await outcome(ask())).kind).toBe("refusal");
    expect(networkCalls).toBe(1); // a refusal isn't retried
    const rows = await rowsSince(since);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ outcome: "refused", errorKind: "refusal" });
    // Both attempts, once each: 600 in / 250 out (not 900 / 300, which would add the top level again).
    expect(row.units).toMatchObject({
      inputTokens: 600,
      outputTokens: 250,
      "claude-opus-5-5:inputTokens": 300,
      "claude-opus-5-5:outputTokens": 200,
      "claude-opus-5:inputTokens": 300,
      "claude-opus-5:outputTokens": 50,
    });
    const expected = (300 * 4 + 200 * 20) / 1e6 + (300 * 5 + 50 * 25) / 1e6; // 0.0052 + 0.00275
    expect(row.costUsd).toBeCloseTo(expected, 9);
    expect(row.reserveUsd!).toBeGreaterThanOrEqual(row.costUsd!);
    const spent = await spend.committedSpendUsd(since);
    expect(spent.usd).toBeCloseTo(expected, 9);
    expect(spent.pendingAttempts).toBe(0);
  });

  // R1: one model's server-tool loop (e.g. web search) reports several `message` iterations of the same model;
  // the top-level usage already covers them, so it is used as before, with no per-model breakdown.
  it("a single model's multi-iteration tool loop keeps its top-level usage", async () => {
    const since = new Date();
    const it = (input: number, output: number) => ({ type: "message", model: PRIMARY.model, input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null });
    handler = () =>
      new Response(
        JSON.stringify({
          id: "msg_loop",
          type: "message",
          role: "assistant",
          model: PRIMARY.model,
          content: [{ type: "text", text: JSON.stringify({ answer: "ok" }) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, iterations: [it(400, 60), it(500, 60)] },
        }),
        { status: 200, headers: { "content-type": "application/json", "request-id": "req_loop" } },
      );
    expect(await outcome(ask())).toBe("ok");
    const [row] = await rowsSince(since);
    expect(row).toMatchObject({ outcome: "success", model: PRIMARY.model });
    // The top-level totals as before (zero counts aren't stored), and no per-model keys.
    expect(row.units).toEqual({ inputTokens: 900, outputTokens: 120 });
    expect(row.costUsd).toBeCloseTo((900 * 4 + 120 * 20) / 1e6, 9);
  });

  // R2: raw Messages calls (the assistant's tool loop) reserve for the fallback chain only when the body asks for
  // fallbacks and the routed model supports them.
  it("raw Messages calls reserve per the routed model's fallback configuration", async () => {
    const { anthropicMessage, routeWorstCaseUsd } = await import("./ai/llm");
    const { textCost } = await import("./ai/pricing");
    const system = "You are a test.";
    const messages = [{ role: "user" as const, content: "Hello" }];
    const req = { chars: JSON.stringify({ system, messages, tools: undefined }).length, maxTokens: 1024 };
    const reply = (model: string) => () =>
      new Response(
        JSON.stringify({ id: "msg_raw", type: "message", role: "assistant", model, content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } }),
        { status: 200, headers: { "content-type": "application/json", "request-id": "req_raw" } },
      );
    const reserveOf = async (body: Record<string, unknown>) => {
      const since = new Date();
      await anthropicMessage("advisor.chat", { max_tokens: 1024, system, messages, ...body });
      const [row] = await rowsSince(since);
      return row.reserveUsd!;
    };
    const opusOwn = routeWorstCaseUsd("claude-opus-5-5", req, textCost, false)!;
    const opusChain = routeWorstCaseUsd("claude-opus-5-5", req, textCost, true)!;
    const haikuOwn = routeWorstCaseUsd("claude-haiku-5-5", req, textCost, false)!;
    expect(opusChain).toBeGreaterThan(opusOwn);
    // Opus 5.5 (supports fallbacks): with fallbacks requested, the whole chain; without, its own worst case.
    handler = reply("claude-opus-5-5");
    expect(await reserveOf({ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })).toBeCloseTo(opusChain, 12);
    expect(await reserveOf({})).toBeCloseTo(opusOwn, 12);
    // Routed to Haiku 5.5 (no server-side fallbacks): only its own worst case, even if the body asks for fallbacks.
    process.env.ANTHROPIC_MODEL = "claude-haiku-5-5";
    try {
      handler = reply("claude-haiku-5-5");
      expect(await reserveOf({ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })).toBeCloseTo(haikuOwn, 12);
    } finally {
      delete process.env.ANTHROPIC_MODEL;
    }
    expect(networkCalls).toBe(3);
  });

  // Fail-closed reservation: a fallback chain whose cost can't be fully priced has no worst case (null),
  // and with a cap in force the request is refused before anything is sent.
  it("worst case is unknown (null), not under-estimated, when a fallback target's price calculation returns null", async () => {
    const { routeWorstCaseUsd } = await import("./ai/llm");
    const { textCost } = await import("./ai/pricing");
    const req = { chars: 3000, maxTokens: 4000 };
    const noOpus48 = (u: Parameters<typeof textCost>[0]) => (u.model === "claude-opus-4-8" ? { usd: null } : textCost(u));
    expect(routeWorstCaseUsd("claude-opus-5-5", req, noOpus48)).toBeNull();
    // The routed model itself unpriced: also null.
    const noPrimary = (u: Parameters<typeof textCost>[0]) => (u.model === "claude-opus-5-5" ? { usd: null } : textCost(u));
    expect(routeWorstCaseUsd("claude-opus-5-5", req, noPrimary)).toBeNull();
    // Fully priced: a positive number covering the chain.
    expect(routeWorstCaseUsd("claude-opus-5-5", req, textCost)).toBeGreaterThan(0);
  });



  it("without a cap (local development), an unpriced worst case still uses the fallback reserve and is recorded", async () => {
    const { FALLBACK_TEXT_MODELS } = await import("./ai/catalog");
    const saved = FALLBACK_TEXT_MODELS["claude-opus-4-8"];
    const since = new Date();
    handler = () => fallbackServed();
    delete FALLBACK_TEXT_MODELS["claude-opus-4-8"];
    try {
      expect(await outcome(ask())).toBe("ok");
      const [row] = await rowsSince(since);
      expect(row.reserveUsd).toBeCloseTo(0.5, 9); // AI_SPEND_CAP_TEXT_RESERVE_USD default; no cap to enforce
    } finally {
      FALLBACK_TEXT_MODELS["claude-opus-4-8"] = saved;
    }
  });

  // R1 audit: a model switch the iterations can't break down is left unpriced (counted at its reserve), never under-counted.
  it("a model switch with iterations that don't name the models, or no iterations, is unpriced and counted at its reserve", async () => {
    const { usageOf } = await import("./ai/llm");
    const { textCost } = await import("./ai/pricing");
    const block = { type: "fallback", from: { model: PRIMARY.model }, to: { model: FALLBACK.model }, trigger: { type: "refusal", category: null } };
    const iter = (input: number, output: number) => ({ type: "message", model: null, input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null });
    const msg = (usage: Record<string, unknown>) => ({ id: "m", type: "message", role: "assistant", model: FALLBACK.model, content: [block], stop_reason: "refusal", stop_sequence: null, usage }) as never;
    // Iterations without model names: both attempts counted once, but unpriced.
    const unnamed = usageOf(msg({ input_tokens: 300, output_tokens: 50, iterations: [iter(300, 200), iter(300, 50)] }));
    expect([unnamed.inputTokens, unnamed.outputTokens]).toEqual([600, 250]);
    expect(textCost(unnamed)).toEqual({ usd: null, source: "unpriced" });
    // No iterations at all: the top level (the last attempt) is kept as the totals, unpriced.
    const bare = usageOf(msg({ input_tokens: 300, output_tokens: 50 }));
    expect([bare.inputTokens, bare.outputTokens]).toEqual([300, 50]);
    expect(textCost(bare)).toEqual({ usd: null, source: "unpriced" });
    // Through the executor: recorded as unpriced, so the cap counts it at its reserve.
    const since = new Date();
    handler = () => new Response(JSON.stringify(msg({ input_tokens: 300, output_tokens: 50 })), { status: 200, headers: { "content-type": "application/json", "request-id": "req_bare" } });
    expect(classify(await outcome(ask())).kind).toBe("refusal");
    const [row] = await rowsSince(since);
    expect(row).toMatchObject({ outcome: "refused", costUsd: null, priceSource: "unpriced" });
    expect((await spend.committedSpendUsd(since)).usd).toBeCloseTo(row.reserveUsd!, 9);
  });

  // R2 audit: every valid value of the SDK's `fallbacks` (omitted, null, "default", a list), plus fast mode.
  it("raw-call worst case for every form of `fallbacks`, never below what may run", async () => {
    const { rawMessageWorstCaseUsd, routeWorstCaseUsd, textWorstCaseUsd } = await import("./ai/llm");
    const { textCost } = await import("./ai/pricing");
    const req = { chars: 2000, maxTokens: 1024 };
    const own = (m: string, maxTokens = req.maxTokens) => textWorstCaseUsd(m, { ...req, maxTokens }, textCost)!;
    const opus = "claude-opus-5-5";
    const chain = routeWorstCaseUsd(opus, req, textCost, true)!;
    expect(rawMessageWorstCaseUsd(opus, {}, req, textCost)).toBeCloseTo(own(opus), 12);
    expect(rawMessageWorstCaseUsd(opus, { fallbacks: null }, req, textCost)).toBeCloseTo(own(opus), 12);
    expect(rawMessageWorstCaseUsd(opus, { fallbacks: "default" }, req, textCost)).toBeCloseTo(chain, 12);
    expect(rawMessageWorstCaseUsd(opus, { fallbacks: [] }, req, textCost)).toBeCloseTo(chain, 12);
    // A list names its own models, each with its own max_tokens: a model outside the catalog list and a
    // larger output limit are both covered.
    const listed = rawMessageWorstCaseUsd(opus, { fallbacks: [{ model: "claude-opus-4-8", max_tokens: 8000 }, { model: "claude-sonnet-5-5" }] }, req, textCost)!;
    expect(listed).toBeCloseTo(own(opus) + own("claude-opus-4-8", 8000) + own("claude-sonnet-5-5"), 12);
    expect(listed).toBeGreaterThan(own(opus) + own("claude-opus-4-8"));
    // A listed model without a price, or fast mode anywhere: unknown.
    expect(rawMessageWorstCaseUsd(opus, { fallbacks: [{ model: "claude-opus-4-1" }] }, req, textCost)).toBeNull();
    expect(rawMessageWorstCaseUsd(opus, { fallbacks: [{ model: "claude-opus-5", speed: "fast" }] }, req, textCost)).toBeNull();
    expect(rawMessageWorstCaseUsd(opus, { speed: "fast" }, req, textCost)).toBeNull();
    // A routed model without server-side fallbacks: its own worst case whatever the body asks.
    expect(rawMessageWorstCaseUsd("claude-haiku-5-5", { fallbacks: "default" }, req, textCost)).toBeCloseTo(own("claude-haiku-5-5"), 12);
  });

  it("a raw call whose worst case is unknown (fast mode) is refused before any network call while a cap is in force", async () => {
    const { anthropicMessage } = await import("./ai/llm");
    const since = new Date();
    process.env.AI_SPEND_CAP_USD = "10";
    process.env.AI_SPEND_CAP_SINCE = since.toISOString();
    const err = await outcome(anthropicMessage("advisor.chat", { max_tokens: 1024, messages: [{ role: "user", content: "Hi" }], speed: "fast" }));
    expect(classify(err).kind).toBe("spend_cap");
    expect(networkCalls).toBe(0);
    const rows = await rowsSince(since);
    expect(rows.map((r) => [r.route, r.outcome, r.errorKind])).toEqual([["advisor.chat", "blocked", "spend_cap"]]);
  });
});

/**
 * Fallback eligibility under a spending cap. Opus 5.5's fallback targets aren't confirmed (the Claude API
 * reference only says to "expect" Opus 5 and Opus 4.8 and to read `allowed_fallback_models` from the
 * Models API), so under a cap Opus 5.5 is sent without server-side fallbacks, and a request that still
 * asks for them with "default" is refused before it is sent. Sonnet 5.5's list is confirmed (Sonnet 5
 * only), so its fallback chain is still sent and reserved under a cap.
 */
describe("fallback eligibility under a spending cap", () => {
  const SON = { model: "claude-sonnet-5-5", input: 300, output: 200, cacheRead: 0 };
  const SON5 = { model: "claude-sonnet-5", input: 300, output: 40, cacheRead: 1000 };
  const SON_USD = (300 * 2 + 200 * 10) / 1e6 + (300 * 2 + 40 * 10 + 1000 * 0.2) / 1e6; // 0.0026 + 0.0012
  const OPUS = { model: "claude-opus-5-5", input: 300, output: 200, cacheRead: 0 };
  const OPUS5 = { model: "claude-opus-5", input: 300, output: 40, cacheRead: 1000 };
  const served = (primary: { model: string; input: number; output: number; cacheRead: number }, fallback: typeof primary) => () =>
    new Response(
      JSON.stringify({
        id: "msg_fb",
        type: "message",
        role: "assistant",
        model: fallback.model,
        content: [
          { type: "fallback", from: { model: primary.model }, to: { model: fallback.model }, trigger: { type: "refusal", category: "cyber" } },
          { type: "text", text: JSON.stringify({ answer: "ok" }) },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: fallback.input,
          output_tokens: fallback.output,
          cache_read_input_tokens: fallback.cacheRead,
          cache_creation_input_tokens: 0,
          iterations: [
            { type: "message", model: primary.model, input_tokens: primary.input, output_tokens: primary.output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
            { type: "fallback_message", model: fallback.model, input_tokens: fallback.input, output_tokens: fallback.output, cache_read_input_tokens: fallback.cacheRead, cache_creation_input_tokens: 0, cache_creation: null },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json", "request-id": "req_fb" } },
    );
  const sonnetRoute = async <T>(fn: () => Promise<T>) => {
    process.env.ANTHROPIC_MODEL = "claude-sonnet-5-5";
    try {
      return await fn();
    } finally {
      delete process.env.ANTHROPIC_MODEL;
    }
  };
  const cap = (usd: number | string, since: Date, required = false) => {
    process.env.AI_SPEND_CAP_USD = String(usd);
    process.env.AI_SPEND_CAP_SINCE = since.toISOString();
    if (required) process.env.AI_SPEND_CAP_REQUIRED = "true";
  };

  it("serverFallbacksAllowed: a confirmed list always; an unconfirmed list only without a cap; never on a model without fallbacks", async () => {
    const { serverFallbacksAllowed } = await import("./ai/llm");
    const capped = { AI_SPEND_CAP_USD: "10" };
    const required = { AI_SPEND_CAP_REQUIRED: "true" };
    const staging = { DEPLOY_ENV: "staging" };
    expect(serverFallbacksAllowed("claude-opus-5-5", {})).toBe(true);
    for (const env of [capped, required, staging]) expect(serverFallbacksAllowed("claude-opus-5-5", env)).toBe(false);
    for (const env of [{}, capped, required, staging]) expect(serverFallbacksAllowed("claude-sonnet-5-5", env)).toBe(true);
    for (const env of [{}, capped]) expect(serverFallbacksAllowed("claude-haiku-5-5", env)).toBe(false);
  });

  it("Opus 5.5 under a cap: sent without server-side fallbacks and reserved for Opus 5.5 alone", async () => {
    const since = new Date();
    cap(10, since, true);
    expect(await outcome(ask())).toBe("ok");
    expect(networkCalls).toBe(1);
    expect(lastBody.model).toBe("claude-opus-5-5");
    expect(lastBody.fallbacks).toBeUndefined();
    expect(lastBeta).not.toContain("server-side-fallback");
    const [row] = await rowsSince(since);
    expect(row).toMatchObject({ outcome: "success", model: "claude-opus-5-5" });
    expect(row.reserveUsd).toBeCloseTo(cappedWorst, 12);
    expect(row.reserveUsd!).toBeLessThan(worst); // the uncapped reserve includes the expected chain
  });

  it("Opus 5.5 under a cap: the unconfirmed fallback chain has no worst case, and a request that asks for it is refused before any provider call", async () => {
    const { anthropicMessage, routeWorstCaseUsd } = await import("./ai/llm");
    const { textCost } = await import("./ai/pricing");
    const req = { chars: 2000, maxTokens: 1024 };
    expect(routeWorstCaseUsd("claude-opus-5-5", req, textCost, true)).not.toBeNull(); // no cap: the expected chain
    const since = new Date();
    cap(10, since, true);
    expect(routeWorstCaseUsd("claude-opus-5-5", req, textCost, true)).toBeNull();
    const err = await outcome(
      anthropicMessage("advisor.chat", { max_tokens: 1024, messages: [{ role: "user", content: "Hi" }], betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }),
    );
    expect(classify(err).kind).toBe("spend_cap");
    expect(String((err as Error).message)).toMatch(/worst-case cost is unknown/);
    expect(networkCalls).toBe(0);
    const rows = await rowsSince(since);
    expect(rows.map((r) => [r.route, r.outcome, r.errorKind, r.reserveUsd])).toEqual([["advisor.chat", "blocked", "spend_cap", null]]);
  });

  it("Opus 5.5 under a cap: an explicit fallback list is refused before any provider call, never sent without its fallbacks", async () => {
    const { anthropicMessage, rawMessageWorstCaseUsd } = await import("./ai/llm");
    const { textCost } = await import("./ai/pricing");
    const messages = [{ role: "user" as const, content: "Hi" }];
    const fallbacks = [{ model: "claude-opus-5" }];
    const req = { chars: JSON.stringify({ messages }).length, maxTokens: 1024 };
    // Without a cap the list is priced and allowed (unchanged).
    expect(rawMessageWorstCaseUsd("claude-opus-5-5", { fallbacks }, req, textCost)).not.toBeNull();
    const since = new Date();
    cap(10, since, true);
    expect(rawMessageWorstCaseUsd("claude-opus-5-5", { fallbacks }, req, textCost)).toBeNull();
    handler = served(OPUS, OPUS5);
    const err = await outcome(anthropicMessage("advisor.chat", { max_tokens: 1024, messages, betas: ["server-side-fallback-2026-07-01"], fallbacks }));
    expect(classify(err).kind).toBe("spend_cap");
    expect(String((err as Error).message)).toMatch(/worst-case cost is unknown/);
    expect(networkCalls).toBe(0);
    const rows = await rowsSince(since);
    expect(rows.map((r) => [r.route, r.model, r.outcome, r.errorKind, r.reserveUsd])).toEqual([["advisor.chat", "claude-opus-5-5", "blocked", "spend_cap", null]]);
    expect((await spend.committedSpendUsd(since)).pendingAttempts).toBe(0);
  });

  it("Opus 5.5 under a cap: every other way of asking for server-side fallbacks is refused before any provider call", async () => {
    const { anthropicMessage } = await import("./ai/llm");
    const since = new Date();
    cap(10, since, true);
    const messages = [{ role: "user" as const, content: "Hi" }];
    const asks: Record<string, unknown>[] = [
      { fallbacks: [{ model: "claude-opus-4-8", max_tokens: 2048 }, { model: "claude-opus-5" }] }, // a longer list, per-entry limits
      { fallbacks: [] }, // an empty list
      { betas: ["server-side-fallback-2026-07-01"] }, // the fallback beta alone
      { fallbacks: "default" }, // "default" without the beta header
    ];
    for (const extra of asks) {
      const err = await outcome(anthropicMessage("advisor.chat", { max_tokens: 1024, messages, ...extra } as never));
      expect(classify(err).kind).toBe("spend_cap");
    }
    expect(networkCalls).toBe(0);
    const rows = await rowsSince(since);
    expect(rows).toHaveLength(asks.length);
    expect(rows.every((r) => r.outcome === "blocked" && r.errorKind === "spend_cap" && r.reserveUsd === null)).toBe(true);
  });

  it("Opus 5.5 under a cap: a normal raw request (no fallbacks asked for) is sent without fallback parameters or beta, reserved for Opus 5.5 alone", async () => {
    const { anthropicMessage, rawMessageWorstCaseUsd } = await import("./ai/llm");
    const { textCost } = await import("./ai/pricing");
    const since = new Date();
    cap(10, since, true);
    handler = () =>
      new Response(
        JSON.stringify({ id: "msg_raw", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } }),
        { status: 200, headers: { "content-type": "application/json", "request-id": "req_raw" } },
      );
    const messages = [{ role: "user" as const, content: "Hi" }];
    // The assistant's opt-in, too: under a cap it adds nothing for Opus 5.5.
    await anthropicMessage("advisor.chat", { max_tokens: 1024, messages }, { serverFallbacks: true });
    expect(networkCalls).toBe(1);
    expect(lastBody.fallbacks).toBeUndefined();
    expect(lastBeta).not.toContain("server-side-fallback");
    const [row] = await rowsSince(since);
    expect(row.outcome).toBe("success");
    expect(row.reserveUsd).toBeCloseTo(rawMessageWorstCaseUsd("claude-opus-5-5", {}, { chars: JSON.stringify({ messages }).length, maxTokens: 1024 }, textCost)!, 12);
  });

  it("Sonnet 5.5 (confirmed list) under a cap: an explicit fallback list is still allowed, reserved in full and sent", async () => {
    const { anthropicMessage, rawMessageWorstCaseUsd } = await import("./ai/llm");
    const { textCost } = await import("./ai/pricing");
    const since = new Date();
    cap(10, since, true);
    handler = served(SON, SON5);
    const messages = [{ role: "user" as const, content: "Hi" }];
    const fallbacks = [{ model: "claude-sonnet-5" }];
    await sonnetRoute(() => anthropicMessage("advisor.chat", { max_tokens: 1024, messages, betas: ["server-side-fallback-2026-07-01"], fallbacks }));
    expect(networkCalls).toBe(1);
    expect(lastBody.fallbacks).toEqual(fallbacks);
    const [row] = await rowsSince(since);
    expect(row.reserveUsd).toBeCloseTo(rawMessageWorstCaseUsd("claude-sonnet-5-5", { fallbacks }, { chars: JSON.stringify({ messages }).length, maxTokens: 1024 }, textCost)!, 12);
    expect(row.costUsd).toBeCloseTo(SON_USD, 9);
  });

  it("Opus 5.5 without a cap: server-side fallbacks are sent and the expected chain reserved (unchanged)", async () => {
    const since = new Date();
    expect(await outcome(ask())).toBe("ok");
    expect(lastBody.fallbacks).toBe("default");
    expect(lastBeta).toContain("server-side-fallback-2026-07-01");
    const [row] = await rowsSince(since);
    expect(row.reserveUsd).toBeCloseTo(worst, 12);
  });

  it("the assistant asks for server-side fallbacks only when allowed: not for Opus 5.5 under a cap, yes without one", async () => {
    const db = await getDb();
    const [ws] = await db.insert(schema.workspaces).values({ name: "Fallbacks", plan: "growth" }).returning();
    const [brand] = await db.insert(schema.brands).values({ workspaceId: ws.id, name: "Kora" }).returning();
    const { chat } = await import("./agents/assistant");
    handler = () =>
      new Response(
        JSON.stringify({ id: "msg_a", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Plan." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 50, output_tokens: 5 } }),
        { status: 200, headers: { "content-type": "application/json", "request-id": "req_chat" } },
      );
    await chat({ brandId: brand.id, userId: "u-fb" }, brand, "What now?");
    expect(lastBody.fallbacks).toBe("default");
    expect(lastBeta).toContain("server-side-fallback-2026-07-01");
    cap(10, new Date(), true);
    await chat({ brandId: brand.id, userId: "u-fb" }, brand, "And then?");
    expect(lastBody.fallbacks).toBeUndefined();
    expect(lastBeta).not.toContain("server-side-fallback");
    expect(networkCalls).toBe(2);
  });

  it("Sonnet 5.5 (confirmed list) under a cap: fallbacks are sent; a chain whose worst case doesn't fit is refused unsent, one that fits is sent and counted in full", async () => {
    handler = served(SON, SON5);
    // The reserve of one Sonnet 5.5 request with its chain, under a generous cap.
    const first = new Date();
    cap(1000, first);
    await sonnetRoute(ask);
    expect(lastBody.fallbacks).toBe("default");
    const chain = (await rowsSince(first))[0].reserveUsd!;
    const { routeWorstCaseUsd } = await import("./ai/llm");
    const { textCost } = await import("./ai/pricing");
    expect(chain).toBeGreaterThan(routeWorstCaseUsd("claude-sonnet-5-5", { chars: 1, maxTokens: 1 }, textCost, false)!);
    spend.resetSpendCapState();
    const since = new Date();
    const calls = networkCalls;
    cap(chain * 0.9, since);
    expect(classify(await outcome(sonnetRoute(ask))).kind).toBe("spend_cap");
    expect(networkCalls).toBe(calls);
    cap(chain * 1.5, since);
    expect(await outcome(sonnetRoute(ask))).toBe("ok");
    expect(networkCalls).toBe(calls + 1);
    const spent = await spend.committedSpendUsd(since);
    expect(spent.usd).toBeCloseTo(SON_USD, 9);
    expect(spent.pendingAttempts).toBe(0);
    cap(spent.usd + chain * 0.5, since);
    expect(classify(await outcome(sonnetRoute(ask))).kind).toBe("spend_cap");
    expect(networkCalls).toBe(calls + 1);
  });

  it("Sonnet 5.5 under a required cap: a configured fallback target with no available price is refused before any provider call", async () => {
    const { FALLBACK_TEXT_MODELS } = await import("./ai/catalog");
    const saved = FALLBACK_TEXT_MODELS["claude-sonnet-5"];
    const since = new Date();
    cap(10, since, true);
    handler = served(SON, SON5);
    delete FALLBACK_TEXT_MODELS["claude-sonnet-5"]; // still the configured target, now without a price
    try {
      const err = await outcome(sonnetRoute(ask));
      expect(classify(err).kind).toBe("spend_cap");
      expect(String((err as Error).message)).toMatch(/worst-case cost is unknown/);
      expect(networkCalls).toBe(0);
      const rows = await rowsSince(since);
      expect(rows.map((r) => [r.outcome, r.errorKind, r.reserveUsd])).toEqual([["blocked", "spend_cap", null]]);
    } finally {
      FALLBACK_TEXT_MODELS["claude-sonnet-5"] = saved;
    }
  });

  it("Sonnet 5.5 under a required cap: a fully priced, confirmed chain still works", async () => {
    const since = new Date();
    cap(10, since, true);
    handler = served(SON, SON5);
    expect(await outcome(sonnetRoute(ask))).toBe("ok");
    expect(lastBody.fallbacks).toBe("default");
    const [row] = await rowsSince(since);
    expect(row).toMatchObject({ outcome: "success", model: "claude-sonnet-5" });
    expect(row.costUsd).toBeCloseTo(SON_USD, 9);
    expect(row.reserveUsd!).toBeGreaterThanOrEqual(row.costUsd!);
  });
});
