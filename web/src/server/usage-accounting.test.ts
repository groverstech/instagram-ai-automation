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
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("https://api.anthropic.com/")) throw new Error(`unexpected host in test: ${url}`);
  networkCalls++;
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

beforeAll(async () => {
  // The worst-case reserve of one `ask()` (input estimate + full output limit), from a first, uncapped call.
  const since = new Date();
  await ask();
  const [row] = await rowsSince(since);
  worst = row.reserveUsd!;
  expect(worst).toBeGreaterThan(0);
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
    // A cap that fits one more worst case but not two: the interrupted attempt still counts, so the next request is refused unsent.
    process.env.AI_SPEND_CAP_USD = String(worst * 1.5);
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
  it("concurrent requests: only those whose worst cases fit under the cap are sent", async () => {
    const since = new Date();
    process.env.AI_SPEND_CAP_USD = String(worst * 1.5); // room for one worst case, not two
    process.env.AI_SPEND_CAP_SINCE = since.toISOString();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    handler = async () => {
      await gate; // hold the first request in flight while the others try
      return ok();
    };
    const all = Array.from({ length: 5 }, () => outcome(ask()));
    await new Promise((r) => setTimeout(r, 50));
    release();
    const results = await Promise.all(all);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r !== "ok").every((e) => classify(e).kind === "spend_cap")).toBe(true);
    expect(networkCalls).toBe(1);
    expect((await spend.committedSpendUsd(since)).pendingAttempts).toBe(0);
  });

  it("another process's in-flight request counts: its pending row holds its reserve", async () => {
    const since = new Date();
    process.env.AI_SPEND_CAP_USD = String(worst * 1.5);
    process.env.AI_SPEND_CAP_SINCE = since.toISOString();
    const other = await spend.openAttempt({ kind: "text", key: "brand.qa", provider: "anthropic", model: "claude-opus-5-5" }, { attempt: 1 }, worst);
    spend.resetSpendCapState(); // as seen from a different process
    expect(classify(await outcome(ask())).kind).toBe("spend_cap");
    expect(networkCalls).toBe(0);
    await spend.settleAttempt(other, { outcome: "failed", errorKind: "server" }); // not billed
    expect(await outcome(ask())).toBe("ok");
    expect(networkCalls).toBe(1);
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
