import "server-only";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb, schema, type DB } from "../db/client";
import { audit } from "../audit";
import { log } from "../log";
import { captureError } from "../monitoring";
import { AIStoppedError } from "./errors";

/**
 * AI kill switch and spending tripwire (F12; docs/AI_SPEND_CONTROLS.md §2.1). Both are checked in
 * openAttempt()'s transaction, before the usage row is written, so a stopped request is never sent.
 *
 * Kill switch: a row in `ai_controls` stops every paid request in its scope, in every process,
 * from the next attempt on, without a deploy:
 *   all                  everything
 *   provider:anthropic   one provider (also provider:openai)
 *   model:<id>           one model
 * `npm run ai:controls -- stop|resume|status` changes it; each change is audited. AI_STOP (a comma
 * list of the same scopes; "anthropic" and "openai" are accepted for the provider scopes) stops
 * requests from the environment as well, e.g. when the database itself is suspect.
 *
 * Tripwire: if a provider's committed spend over the last AI_TRIPWIRE_WINDOW_MIN minutes (default 15)
 * plus this request's worst case would exceed AI_TRIPWIRE_USD, the provider is stopped (a
 * `tripwire` row), the error is reported to monitoring (page the on-call engineer), and the request
 * is refused. It never clears itself: a person resumes it after looking. Unset AI_TRIPWIRE_USD
 * means no tripwire.
 */
type Env = Record<string, string | undefined>;
type Executor = Pick<DB, "select" | "insert" | "execute">;
export type Scope = string;

export function scopesFor(route: { provider: string; model?: string | null }): Scope[] {
  return ["all", `provider:${route.provider}`, ...(route.model ? [`model:${route.model}`] : [])];
}

/** Normalises an operator-typed scope; null if it isn't one. */
export function parseScope(s: string): Scope | null {
  const v = s.trim();
  if (v === "all") return v;
  if (v === "anthropic" || v === "openai") return `provider:${v}`;
  if (/^provider:(anthropic|openai)$/.test(v)) return v;
  if (/^model:[\w.\-:/]{1,100}$/.test(v)) return v;
  return null;
}

export function envStops(env: Env = process.env): Scope[] {
  return (env.AI_STOP ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseScope(s) ?? `invalid:${s}`);
}

export type Tripwire = { usd: number; windowMin: number } | null;
export function tripwireConfig(env: Env = process.env): Tripwire {
  const raw = (env.AI_TRIPWIRE_USD ?? "").trim();
  if (!raw) return null;
  const usd = Number(raw);
  const w = Number((env.AI_TRIPWIRE_WINDOW_MIN ?? "").trim() || "15");
  if (!(usd > 0) || !Number.isFinite(usd) || !(w >= 1 && w <= 1440)) return null;
  return { usd, windowMin: w };
}

/** Throws AIStoppedError if a stop applies to this route. Inside openAttempt()'s transaction. */
export async function assertNotStopped(tx: Executor, route: { provider: string; model?: string | null }, env: Env = process.env) {
  const scopes = scopesFor(route);
  const fromEnv = envStops(env);
  // An unreadable AI_STOP fails closed (config validation also reports it).
  const envHit = fromEnv.find((s) => s.startsWith("invalid:") || scopes.includes(s));
  if (envHit) throw new AIStoppedError(envHit, "env");
  const [row] = await tx.select().from(schema.aiControls).where(inArray(schema.aiControls.scope, scopes)).limit(1);
  if (row) throw new AIStoppedError(row.scope, row.source);
}

/**
 * Inside openAttempt()'s transaction (under the ledger lock): would this request take the
 * provider's recent spend over the tripwire? Returns the details if so; the caller trips it after
 * the transaction (so the stop row is committed even though the request is refused).
 */
export async function tripwireExceeded(tx: Executor, provider: string, reserveUsd: number, env: Env = process.env, now = Date.now()) {
  const t = tripwireConfig(env);
  if (!t || provider === "mock") return null;
  const { committedSpendUsd } = await import("./spend-cap");
  const since = new Date(now - t.windowMin * 60_000);
  const { usd } = await committedSpendUsd(since, env, tx as DB, provider);
  return usd + reserveUsd > t.usd + 1e-9 ? { provider, recentUsd: usd, reserveUsd, thresholdUsd: t.usd, windowMin: t.windowMin } : null;
}

export async function tripTripwire(d: NonNullable<Awaited<ReturnType<typeof tripwireExceeded>>>) {
  const scope = `provider:${d.provider}`;
  const reason = `Tripwire: $${d.recentUsd.toFixed(2)} in the last ${d.windowMin} min (+ $${d.reserveUsd.toFixed(2)} requested) exceeds $${d.thresholdUsd.toFixed(2)}`;
  try {
    const db = await getDb();
    const ins = await db.insert(schema.aiControls).values({ scope, reason, source: "tripwire", setBy: "tripwire" }).onConflictDoNothing().returning({ scope: schema.aiControls.scope });
    if (ins.length) {
      await audit({ action: "ai.stop", actorType: "system", targetType: "ai_scope", targetId: scope, details: { source: "tripwire", recentUsd: Math.round(d.recentUsd * 100) / 100, thresholdUsd: d.thresholdUsd, windowMin: d.windowMin } });
      log.error("ai.tripwire", { scope, recentUsd: d.recentUsd, thresholdUsd: d.thresholdUsd, windowMin: d.windowMin });
      captureError(new Error(`AI spending tripwire: ${scope} stopped. ${reason}`), { where: "ai_tripwire" });
    }
  } catch (e) {
    // The request is refused regardless (the caller throws); report that the stop couldn't be saved.
    captureError(e, { where: "ai_tripwire_write" });
  }
}

export async function listStops() {
  const db = await getDb();
  return db.select().from(schema.aiControls).orderBy(schema.aiControls.setAt);
}

export async function stopAi(scope: Scope, reason: string, by: string) {
  const s = parseScope(scope);
  if (!s) throw new Error(`Unknown scope "${scope}". Use all, anthropic, openai, provider:<name> or model:<id>.`);
  if (!reason.trim()) throw new Error("A reason is required.");
  if (!by.trim()) throw new Error("--by is required.");
  const db = await getDb();
  await db
    .insert(schema.aiControls)
    .values({ scope: s, reason: reason.trim().slice(0, 500), source: "operator", setBy: by.trim() })
    .onConflictDoUpdate({ target: schema.aiControls.scope, set: { reason: reason.trim().slice(0, 500), source: "operator", setBy: by.trim(), setAt: sql`now()` } });
  await audit({ action: "ai.stop", actorType: "system", targetType: "ai_scope", targetId: s, details: { source: "operator", by: by.trim(), reason: reason.trim().slice(0, 200) } });
  log.warn("ai.stopped", { scope: s, by: by.trim() });
  return s;
}

export async function resumeAi(scope: Scope, by: string) {
  const s = parseScope(scope);
  if (!s) throw new Error(`Unknown scope "${scope}".`);
  if (!by.trim()) throw new Error("--by is required.");
  const db = await getDb();
  const gone = await db.delete(schema.aiControls).where(eq(schema.aiControls.scope, s)).returning();
  if (!gone.length) return false;
  await audit({ action: "ai.resume", actorType: "system", targetType: "ai_scope", targetId: s, details: { by: by.trim(), was: gone[0].source } });
  log.warn("ai.resumed", { scope: s, by: by.trim() });
  return true;
}
