/**
 * Credit enforcement (PR 4.6; ai/credit-gate.ts), checked in openAttempt()'s locked transaction.
 * The provider is a stub that counts requests: nothing real is ever sent. On Postgres when
 * TEST_DATABASE_URL is set (real concurrency), otherwise PGlite.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

for (const k of Object.keys(process.env)) if (/^(AI_SPEND_CAP_|AI_STOP$|AI_TRIPWIRE_|AI_PROVIDER$|DATABASE_URL$|ANTHROPIC_|OPENAI_|VOYAGE_|DEPLOY_ENV$|CREDITS_MODE$)/.test(k)) delete process.env[k];
const PG_ADMIN = process.env.TEST_DATABASE_URL;
let pgDatabase: string | null = null;
if (PG_ADMIN) {
  const { default: postgres } = await import("postgres");
  pgDatabase = `bp_credits_${Date.now().toString(36)}`;
  const admin = postgres(PG_ADMIN, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${pgDatabase}`);
  await admin.end();
  const u = new URL(PG_ADMIN);
  u.pathname = `/${pgDatabase}`;
  process.env.DATABASE_URL = u.toString();
} else {
  process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-credits-pg-"));
}
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-credits-store-"));
process.env.ANTHROPIC_API_KEY = "placeholder-not-a-real-key";
process.env.AI_MAX_ATTEMPTS = "1";

let sent = 0;
let respond: () => Promise<Response> = async () => ok();
const ok = () =>
  new Response(
    JSON.stringify({ id: "msg_t", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: JSON.stringify({ answer: "ok" }) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } }),
    { status: 200, headers: { "content-type": "application/json", "request-id": "req_ok" } },
  );
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("https://api.anthropic.com/")) throw new Error(`unexpected host in test: ${url}`);
  sent++;
  return respond();
}) as typeof fetch;

const { getDb, schema } = await import("./db/client");
const { llm } = await import("./ai/llm");
const { AICreditLimitError, classify, friendlyAIError } = await import("./ai/errors");
const { resetCircuits } = await import("./ai/circuit");
const { withAiContext } = await import("./ai/context");
const spend = await import("./ai/spend-cap");
const { creditGate, creditPositions, exceeded } = await import("./ai/credit-gate");
const credits = await import("./credits");

const ask = (ws: string, brandId: string | null = null) =>
  withAiContext({ workspaceId: ws, brandId, userId: null, taskId: null, runId: null }, () =>
    llm().structured({ route: "brand.qa", system: "s", prompt: "Reply ok", schema: z.object({ answer: z.string() }), effort: "low", maxTokens: 1024, mock: () => ({ answer: "demo" }) }),
  );

let n = 0;
async function org(opts: { cap?: number | null } = {}) {
  const db = await getDb();
  const [w] = await db.insert(schema.workspaces).values({ name: `Credits ${n++}`, plan: "growth" }).returning();
  const [a] = await db.insert(schema.brands).values({ workspaceId: w.id, name: "A" }).returning();
  const [b] = await db.insert(schema.brands).values({ workspaceId: w.id, name: "B" }).returning();
  if (opts.cap !== undefined && opts.cap !== null) await db.insert(schema.creditLimits).values({ workspaceId: w.id, brandId: "", monthlyCapCredits: opts.cap });
  return { ws: w.id, a: a.id, b: b.id };
}
/** A usage row as the ledger writes it ($0.01 = 1 credit at the default credit value). */
async function usage(ws: string, o: { usd: number; outcome?: "success" | "failed" | "retried" | "pending"; brandId?: string | null; provider?: string; at?: Date }) {
  const db = await getDb();
  const pending = o.outcome === "pending";
  await db.insert(schema.usageEvents).values({ workspaceId: ws, brandId: o.brandId ?? null, route: "brand.qa", provider: o.provider ?? "anthropic", model: "m", kind: "text", outcome: o.outcome ?? "success", costUsd: pending ? null : o.usd, reserveUsd: pending ? o.usd : null, createdAt: o.at ?? new Date(), settledAt: pending ? null : new Date() });
}
const gate = async (ws: string, brandId: string | null, reserveUsd: number, mode = "enforce") => {
  const db = await getDb();
  return db.transaction((tx) => creditGate(tx, { workspaceId: ws, brandId }, "anthropic", reserveUsd, { CREDITS_MODE: mode }));
};

beforeEach(async () => {
  sent = 0;
  respond = async () => ok();
  resetCircuits();
  spend.resetSpendCapState();
  const db = await getDb();
  await db.update(schema.creditSettings).set({ creditValueUsd: 0.01, chargeFailedAttempts: false }).where(eq(schema.creditSettings.id, "default"));
});
afterEach(() => {
  delete process.env.CREDITS_MODE;
});
afterAll(async () => {
  if (!PG_ADMIN || !pgDatabase) return;
  const { default: postgres } = await import("postgres");
  const admin = postgres(PG_ADMIN, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${pgDatabase} with (force)`);
  await admin.end();
});

describe("credit gate: accounting", () => {
  it("boundary: exactly at the cap is allowed; a cent over is refused. Charged usage and open reservations both count", async () => {
    const o = await org({ cap: 100 });
    await usage(o.ws, { usd: 0.5 }); // 50 credits charged
    await usage(o.ws, { usd: 0.3, outcome: "pending" }); // 30 reserved
    await expect(gate(o.ws, null, 0.2)).resolves.toBeUndefined(); // 50 + 30 + 20 = 100
    const e = await gate(o.ws, null, 0.21).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AICreditLimitError);
    expect((e as Error).message).toMatch(/20 AI credits left this month/);
    expect(exceeded([{ scope: "organisation", cap: null, used: 1e9 }], 1e9)).toBeNull(); // no cap, no limit
  });

  it("failed and retried attempts aren't charged unless the policy says so; demo calls and last month never count", async () => {
    const o = await org({ cap: 10 });
    await usage(o.ws, { usd: 0.08, outcome: "failed" });
    await usage(o.ws, { usd: 0.08, outcome: "retried" });
    await usage(o.ws, { usd: 5, provider: "mock" });
    const last = new Date();
    last.setMonth(last.getMonth() - 1);
    await usage(o.ws, { usd: 5, at: last });
    await expect(gate(o.ws, null, 0.1)).resolves.toBeUndefined();
    const db = await getDb();
    await db.update(schema.creditSettings).set({ chargeFailedAttempts: true }).where(eq(schema.creditSettings.id, "default"));
    await expect(gate(o.ws, null, 0.1)).rejects.toBeInstanceOf(AICreditLimitError); // 16 + 10 > 10
  });

  it("grants raise this month's cap (idempotent per reference); a negative adjustment lowers it", async () => {
    const o = await org({ cap: 10 });
    await usage(o.ws, { usd: 0.1 });
    await expect(gate(o.ws, null, 0.05)).rejects.toBeInstanceOf(AICreditLimitError);
    expect((await credits.grantCredits({ workspaceId: o.ws, credits: 50, kind: "topup", reason: "Top-up pack", by: "ops", reference: "inv_1" })).granted).toBe(true);
    expect((await credits.grantCredits({ workspaceId: o.ws, credits: 50, kind: "topup", reason: "Top-up pack", by: "ops", reference: "inv_1" })).granted).toBe(false);
    await expect(gate(o.ws, null, 0.05)).resolves.toBeUndefined();
    await credits.grantCredits({ workspaceId: o.ws, credits: -45, kind: "adjustment", reason: "Correction", by: "ops" });
    await expect(gate(o.ws, null, 0.06)).rejects.toBeInstanceOf(AICreditLimitError); // 10 + 6 > 15
    const st = await credits.creditStatus(o.ws);
    expect(st.granted).toBe(5);
    expect(st.org?.cap).toBe(15);
    await expect(credits.grantCredits({ workspaceId: o.ws, credits: 1.5, kind: "topup", reason: "x", by: "ops" })).rejects.toThrow(/whole number/);
    const db = await getDb();
    expect((await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, "config.credits_grant"), eq(schema.auditEvents.workspaceId, o.ws)))).length).toBe(2);
  });

  it("a brand cap refuses that brand only; the plan's included credits apply when the organisation has no cap of its own", async () => {
    const o = await org();
    const db = await getDb();
    await db.update(schema.plans).set({ includedCredits: 1000 }).where(eq(schema.plans.key, "growth"));
    await db.insert(schema.creditLimits).values({ workspaceId: o.ws, brandId: o.a, monthlyCapCredits: 5 });
    await usage(o.ws, { usd: 0.05, brandId: o.a });
    await expect(gate(o.ws, o.a, 0.01)).rejects.toThrow(/This brand has 0 AI credits left/);
    await expect(gate(o.ws, o.b, 0.01)).resolves.toBeUndefined();
    const { positions } = await creditPositions(db, o.ws, o.a);
    expect(positions.map((p) => [p.scope, p.cap])).toEqual([["organisation", 1000], ["brand", 5]]);
    await db.update(schema.plans).set({ includedCredits: null }).where(eq(schema.plans.key, "growth"));
  });

  it("shadow (the default) and off never refuse; a request without an organisation isn't attributable and is allowed", async () => {
    const o = await org({ cap: 1 });
    await usage(o.ws, { usd: 1 });
    await expect(gate(o.ws, null, 1, "shadow")).resolves.toBeUndefined();
    await expect(gate(o.ws, null, 1, "off")).resolves.toBeUndefined();
    await expect(gate(o.ws, null, 1, "")).resolves.toBeUndefined();
    const db = await getDb();
    await expect(db.transaction((tx) => creditGate(tx, {}, "anthropic", 1, { CREDITS_MODE: "enforce" }))).resolves.toBeUndefined();
    expect(credits.creditsMode({})).toBe("shadow");
  });
});

describe("credit gate: through the real request path (stub provider)", () => {
  it("enforce: a refused request is never sent and never charged; it's recorded as blocked with a clear message", async () => {
    process.env.CREDITS_MODE = "enforce";
    const o = await org({ cap: 1 });
    await usage(o.ws, { usd: 0.01 });
    const e = await ask(o.ws).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(AICreditLimitError);
    expect(classify(e).kind).toBe("spend_cap");
    expect(friendlyAIError(e)).toMatch(/AI credits left this month/);
    expect(sent).toBe(0);
    const db = await getDb();
    const rows = await db.select().from(schema.usageEvents).where(and(eq(schema.usageEvents.workspaceId, o.ws), eq(schema.usageEvents.outcome, "blocked")));
    expect(rows.map((r) => [r.errorKind, r.costUsd])).toEqual([["credits", null]]);
  });

  it("reservation → settlement: the worst case is held while in flight and replaced by the real cost (released) afterwards", async () => {
    process.env.CREDITS_MODE = "enforce";
    const o = await org({ cap: 100000 });
    const db = await getDb();
    let during = -1;
    respond = async () => {
      during = (await creditPositions(db, o.ws, null)).positions[0].used;
      return ok();
    };
    await ask(o.ws);
    const after = (await creditPositions(db, o.ws, null)).positions[0].used;
    const [row] = await db.select().from(schema.usageEvents).where(and(eq(schema.usageEvents.workspaceId, o.ws), eq(schema.usageEvents.outcome, "success")));
    expect(during).toBeCloseTo(row.reserveUsd! / 0.01, 6); // the reservation, at its worst case
    expect(after).toBeCloseTo(row.costUsd! / 0.01, 6); // the real cost
    expect(row.costUsd!).toBeLessThan(row.reserveUsd!); // the difference was released
    const r = await credits.reconcileCredits(o.ws);
    expect(r).toMatchObject({ consistent: true, stalePending: 0, reserved: 0 });
    expect(r.charged).toBeCloseTo(after, 6);
  });

  it("a provider failure releases the reservation (not charged under the default policy)", async () => {
    process.env.CREDITS_MODE = "enforce";
    const o = await org({ cap: 100000 });
    respond = async () => new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }), { status: 500, headers: { "content-type": "application/json" } });
    await expect(ask(o.ws)).rejects.toBeTruthy();
    const db = await getDb();
    expect((await creditPositions(db, o.ws, null)).positions[0].used).toBe(0);
    const rows = await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.workspaceId, o.ws));
    expect(rows.map((r) => r.outcome)).toEqual(["failed"]);
  });

  it("concurrency: parallel requests can't overspend: each sees the others' reservations under the ledger lock", async () => {
    process.env.CREDITS_MODE = "enforce";
    const db = await getDb();
    // Measure one request's worst case, then allow room for exactly two.
    const probe = await org({ cap: 1_000_000 });
    await ask(probe.ws);
    const [p] = await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.workspaceId, probe.ws));
    const reserveCredits = p.reserveUsd! / 0.01;
    const o = await org({ cap: Math.floor(reserveCredits * 2.5) });
    sent = 0;
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    respond = async () => {
      await hold; // keep every admitted request in flight, so its reservation stays open
      return ok();
    };
    const all = Promise.allSettled(Array.from({ length: 6 }, () => ask(o.ws)));
    await new Promise((r) => setTimeout(r, 400));
    release();
    const results = await all;
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected" && r.reason instanceof AICreditLimitError)).toHaveLength(4);
    expect(sent).toBe(2);
    const r = await credits.reconcileCredits(o.ws);
    expect(r.consistent).toBe(true);
    expect(r.charged).toBeLessThanOrEqual(r.cap!);
  });

  it("shadow mode: the same over-cap request is sent, as before (nothing enforced)", async () => {
    const o = await org({ cap: 1 });
    await usage(o.ws, { usd: 0.01 });
    await ask(o.ws);
    expect(sent).toBe(1);
  });
});

describe("reconciliation", () => {
  it("flags stale reservations (pending for over an hour) and unpriced attempts", async () => {
    const o = await org({ cap: 100 });
    const db = await getDb();
    await db.insert(schema.usageEvents).values({ workspaceId: o.ws, route: "brand.qa", provider: "anthropic", model: "m", kind: "text", outcome: "pending", reserveUsd: 0.1, createdAt: new Date(Date.now() - 2 * 3600_000) });
    await db.insert(schema.usageEvents).values({ workspaceId: o.ws, route: "brand.qa", provider: "anthropic", model: "m", kind: "text", outcome: "success", costUsd: null, settledAt: new Date() });
    const r = await credits.reconcileCredits(o.ws);
    expect(r).toMatchObject({ stalePending: 1, unpriced: 1, consistent: true });
    expect(r.reserved).toBeCloseTo(10, 6);
  });
});
