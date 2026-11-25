/**
 * F12: the AI kill switch and the spending tripwire (ai/controls.ts), checked in openAttempt()
 * before anything is sent. The provider is a stub that counts requests: none is ever real.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, gte } from "drizzle-orm";
import { z } from "zod";

for (const k of Object.keys(process.env)) if (/^(AI_SPEND_CAP_|AI_STOP$|AI_TRIPWIRE_|AI_PROVIDER$|DATABASE_URL$|ANTHROPIC_|OPENAI_|VOYAGE_|DEPLOY_ENV$)/.test(k)) delete process.env[k];
const PG_ADMIN = process.env.TEST_DATABASE_URL;
let pgDatabase: string | null = null;
if (PG_ADMIN) {
  const { default: postgres } = await import("postgres");
  pgDatabase = `bp_controls_${Date.now().toString(36)}`;
  const admin = postgres(PG_ADMIN, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${pgDatabase}`);
  await admin.end();
  const u = new URL(PG_ADMIN);
  u.pathname = `/${pgDatabase}`;
  process.env.DATABASE_URL = u.toString();
} else {
  process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-controls-pg-"));
}
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-controls-store-"));
process.env.ANTHROPIC_API_KEY = "placeholder-not-a-real-key";
process.env.AI_MAX_ATTEMPTS = "1";

let sent = 0;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("https://api.anthropic.com/")) throw new Error(`unexpected host in test: ${url}`);
  sent++;
  return new Response(
    JSON.stringify({ id: "msg_t", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: JSON.stringify({ answer: "ok" }) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } }),
    { status: 200, headers: { "content-type": "application/json", "request-id": "req_ok" } },
  );
}) as typeof fetch;

const { getDb, schema } = await import("./db/client");
const { llm } = await import("./ai/llm");
const { AIStoppedError, classify, friendlyAIError } = await import("./ai/errors");
const { resetCircuits } = await import("./ai/circuit");
const spend = await import("./ai/spend-cap");
const controls = await import("./ai/controls");
const { checkConfig } = await import("./config");
const monitoring = await import("./monitoring");

const reported: string[] = [];
monitoring.addErrorReporter((e) => {
  reported.push(e instanceof Error ? e.message : String(e));
});

const ask = () => llm().structured({ route: "brand.qa", system: "s", prompt: "Reply ok", schema: z.object({ answer: z.string() }), effort: "low", maxTokens: 1024, mock: () => ({ answer: "demo" }) });
const rows = async (since: Date) => {
  const db = await getDb();
  const e = schema.usageEvents;
  return db.select().from(e).where(and(gte(e.createdAt, since), eq(e.provider, "anthropic"))).orderBy(e.createdAt);
};

beforeEach(async () => {
  sent = 0;
  resetCircuits();
  spend.resetSpendCapState();
  delete process.env.AI_STOP;
  delete process.env.AI_TRIPWIRE_USD;
  delete process.env.AI_TRIPWIRE_WINDOW_MIN;
  const db = await getDb();
  await db.delete(schema.aiControls);
});
afterAll(async () => {
  if (!PG_ADMIN || !pgDatabase) return;
  const { default: postgres } = await import("postgres");
  const admin = postgres(PG_ADMIN, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${pgDatabase} with (force)`);
  await admin.end();
});

describe("kill switch", () => {
  it("stopping all, the provider or the model refuses before sending; resuming lets requests through; audited", async () => {
    await ask();
    expect(sent).toBe(1);
    for (const scope of ["all", "anthropic", "model:claude-opus-5-5"]) {
      await controls.stopAi(scope, "incident drill", "ops");
      const since = new Date();
      sent = 0;
      const e = await ask().then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(AIStoppedError);
      expect(classify(e).kind).toBe("spend_cap");
      expect(friendlyAIError(e)).toMatch(/paused by the BrandPilot team/);
      expect(friendlyAIError(e)).not.toMatch(/incident drill/); // the operator's reason stays internal
      expect(sent).toBe(0);
      const r = await rows(since);
      expect(r.map((x) => [x.outcome, x.errorKind])).toEqual([["blocked", "stopped"]]);
      expect(await controls.resumeAi(scope, "ops")).toBe(true);
    }
    sent = 0;
    await ask();
    expect(sent).toBe(1);
    const db = await getDb();
    const ev = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.targetType, "ai_scope"));
    expect(ev.filter((x) => x.action === "ai.stop")).toHaveLength(3);
    expect(ev.filter((x) => x.action === "ai.resume")).toHaveLength(3);
  });

  it("a stop on another provider or model doesn't affect this one", async () => {
    await controls.stopAi("openai", "image incident", "ops");
    await controls.stopAi("model:claude-haiku-4-5", "x", "ops");
    await ask();
    expect(sent).toBe(1);
  });

  it("AI_STOP stops from the environment; an unreadable value fails closed and is a config error", async () => {
    process.env.AI_STOP = "anthropic";
    await expect(ask()).rejects.toBeInstanceOf(AIStoppedError);
    process.env.AI_STOP = "antropic";
    await expect(ask()).rejects.toBeInstanceOf(AIStoppedError);
    expect(sent).toBe(0);
    expect(checkConfig({ AI_STOP: "antropic" }).some((p) => p.key === "AI_STOP" && p.level === "error")).toBe(true);
    expect(checkConfig({ AI_STOP: "all, openai, model:gpt-image-1" }).some((p) => p.key === "AI_STOP")).toBe(false);
  });

  it("rejects unknown scopes and missing reasons", async () => {
    await expect(controls.stopAi("everything", "r", "ops")).rejects.toThrow("Unknown scope");
    await expect(controls.stopAi("all", " ", "ops")).rejects.toThrow("reason");
    expect(await controls.resumeAi("all", "ops")).toBe(false);
  });
});

describe("tripwire", () => {
  it("when recent spend would pass the threshold, the provider is stopped, monitoring is told, and it stays stopped until a person resumes it", async () => {
    // Recent spend for this provider, as the ledger records it.
    const db = await getDb();
    await db.insert(schema.usageEvents).values({ route: "brand.qa", provider: "anthropic", model: "claude-opus-5-5", kind: "text", outcome: "success", costUsd: 4.999, settledAt: new Date() });
    process.env.AI_TRIPWIRE_USD = "5";
    process.env.AI_TRIPWIRE_WINDOW_MIN = "15";
    reported.length = 0;
    await expect(ask()).rejects.toBeInstanceOf(AIStoppedError);
    expect(sent).toBe(0);
    const [stop] = await controls.listStops();
    expect(stop).toMatchObject({ scope: "provider:anthropic", source: "tripwire", setBy: "tripwire" });
    expect(stop.reason).toMatch(/in the last 15 min/);
    expect(reported.some((m) => /AI spending tripwire: provider:anthropic stopped/.test(m))).toBe(true);
    // Raising the threshold doesn't clear it: only a person does.
    process.env.AI_TRIPWIRE_USD = "1000";
    await expect(ask()).rejects.toBeInstanceOf(AIStoppedError);
    expect(await controls.resumeAi("anthropic", "ops")).toBe(true);
    await ask();
    expect(sent).toBe(1);
    const ev = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, "ai.stop"), eq(schema.auditEvents.targetId, "provider:anthropic")));
    expect(ev.some((x) => (x.details as { source?: string }).source === "tripwire")).toBe(true);
  });

  it("spend outside the window, or on another provider, doesn't count", async () => {
    const db = await getDb();
    await db.delete(schema.usageEvents);
    const old = new Date(Date.now() - 60 * 60_000);
    await db.insert(schema.usageEvents).values([
      { route: "brand.qa", provider: "anthropic", model: "m", kind: "text", outcome: "success", costUsd: 100, settledAt: old, createdAt: old },
      { route: "image.generate", provider: "openai", model: "gpt-image-1", kind: "image", outcome: "success", costUsd: 100, settledAt: new Date() },
    ]);
    process.env.AI_TRIPWIRE_USD = "5";
    await ask();
    expect(sent).toBe(1);
    expect(await controls.listStops()).toEqual([]);
  });

  it("configuration: invalid values are errors; production without a tripwire is warned", () => {
    expect(controls.tripwireConfig({ AI_TRIPWIRE_USD: "25" })).toEqual({ usd: 25, windowMin: 15 });
    expect(controls.tripwireConfig({})).toBeNull();
    const keys = (env: Record<string, string>) => checkConfig(env).map((p) => `${p.level}:${p.key}`);
    expect(keys({ AI_TRIPWIRE_USD: "-1" })).toContain("error:AI_TRIPWIRE_USD");
    expect(keys({ AI_TRIPWIRE_USD: "5", AI_TRIPWIRE_WINDOW_MIN: "0" })).toContain("error:AI_TRIPWIRE_WINDOW_MIN");
    expect(keys({ DEPLOY_ENV: "production", NODE_ENV: "production" })).toContain("warning:AI_TRIPWIRE_USD");
  });
});
