import "server-only";
import { and, eq, gte, isNull, ne, sql } from "drizzle-orm";
import { getDb, schema, type DB } from "../db/client";
import type { UsageOutcome } from "../db/schema";
import { log } from "../log";
import { aiContext } from "./context";
import { AIAccountingError, AISpendCapConfigError, AISpendCapError, AIStoppedError } from "./errors";
import { assertNotStopped, tripTripwire, tripwireExceeded } from "./controls";
import type { ResolvedRoute } from "./routes";

/**
 * Fail-closed usage accounting and the hard AI spending cap (docs/AI_PROVIDERS.md).
 *
 * Every paid provider attempt goes through openAttempt() **before** it is sent, and settleAttempt()
 * after. openAttempt(), in one database transaction under an advisory lock:
 *   1. if a cap is set (AI_SPEND_CAP_USD), checks
 *        committed spend since AI_SPEND_CAP_SINCE + this request's worst-case cost <= cap,
 *      where committed spend includes every attempt still pending (in flight in any process, or
 *      interrupted) at its reserved worst case;
 *   2. writes the attempt's usage row with outcome `pending` and its reserve.
 * If the database is unavailable or the row can't be written, the request is refused and nothing is
 * sent (AIAccountingError). settleAttempt() then updates that same row in place to the final outcome,
 * units and estimated cost, so an attempt is never counted twice. If settling fails, the row stays
 * pending (still counted at its reserve), the failure is logged, and no further request is sent by
 * this process until the settlement has been written.
 *
 * A row left pending by a process that died (an interrupted execution) keeps counting at its
 * reserve: the request may have been billed. `npm run ai:billing -- log` lists such rows.
 *
 * Committed spend = estimated cost of priced attempts + the reserve of attempts that may have been
 * billed without a price (pending, unknown outcome, unpriced). Worst cases come from the caller
 * (text: estimated input at the cache-write rate plus the full output limit; images:
 * AI_SPEND_CAP_IMAGE_RESERVE_USD, default $1.00). Unset AI_SPEND_CAP_USD means no cap, but the
 * accounting above still applies to every attempt.
 */
type Env = Record<string, string | undefined>;
const numOr = (v: string | undefined, d: number | null) => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
const isSet = (v: string | undefined) => v !== undefined && v.trim() !== "";

/** AI_SPEND_CAP_SINCE's documented format (docs/AI_PROVIDERS.md, config.ts): ISO 8601 in UTC, e.g. 2026-11-14T00:00:00Z. */
export const SPEND_CAP_SINCE_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * When true, a provider request is refused unless a valid cap is configured (AISpendCapConfigError).
 * Always on in staging (DEPLOY_ENV=staging), and turned on by paid operator commands
 * (`npm run test:live`, `npm run ai:check-anthropic`, paid-run-guard.ts). A deployment can set
 * AI_SPEND_CAP_REQUIRED=true anywhere else.
 */
export const spendCapRequired = (env: Env = process.env) =>
  /^(1|true|yes)$/i.test(env.AI_SPEND_CAP_REQUIRED?.trim() ?? "") || (env.DEPLOY_ENV ?? "").trim().toLowerCase() === "staging";

/** A spending cap applies to this process: one is required, or AI_SPEND_CAP_USD is set. */
export const spendCapInForce = (env: Env = process.env) => spendCapRequired(env) || isSet(env.AI_SPEND_CAP_USD);

/**
 * Reads and validates the cap. Fails closed: a cap that is set but malformed, or a start time that
 * is set but malformed, is an error (never "no cap" or "start of month"). In required mode the cap
 * and AI_SPEND_CAP_SINCE must both be set, the start in the documented UTC format and not in the future.
 */
export function parseSpendCap(env: Env = process.env, now = new Date()): { ok: true; capUsd: number | null; since: Date } | { ok: false; reason: string } {
  const required = spendCapRequired(env);
  const rawCap = env.AI_SPEND_CAP_USD;
  const rawSince = env.AI_SPEND_CAP_SINCE?.trim();
  let capUsd: number | null = null;
  if (isSet(rawCap)) {
    const t = rawCap!.trim();
    const n = Number(t);
    if (!/^\d+(\.\d+)?$/.test(t) || !Number.isFinite(n)) return { ok: false, reason: "invalid (AI_SPEND_CAP_USD must be a non-negative number of US dollars)" };
    capUsd = n;
  } else if (required) {
    return { ok: false, reason: "not set (AI_SPEND_CAP_USD is required for this command)" };
  }
  let since: Date;
  if (rawSince) {
    if (required && !SPEND_CAP_SINCE_FORMAT.test(rawSince)) return { ok: false, reason: "invalid (AI_SPEND_CAP_SINCE must be a UTC time such as 2026-11-14T00:00:00Z)" };
    const ms = Date.parse(rawSince);
    if (Number.isNaN(ms)) return { ok: false, reason: "invalid (AI_SPEND_CAP_SINCE must be a date and time such as 2026-11-14T00:00:00Z)" };
    if (required && ms > now.getTime()) return { ok: false, reason: "invalid (AI_SPEND_CAP_SINCE is in the future, so earlier spending would not be counted)" };
    since = new Date(ms);
  } else if (required) {
    return { ok: false, reason: "not set (AI_SPEND_CAP_SINCE is required for this command)" };
  } else {
    since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
  return { ok: true, capUsd, since };
}

export function spendCapConfig(env: Env = process.env) {
  const parsed = parseSpendCap(env);
  const now = new Date();
  return {
    capUsd: parsed.ok ? parsed.capUsd : null,
    since: parsed.ok ? parsed.since : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    imageReserveUsd: numOr(env.AI_SPEND_CAP_IMAGE_RESERVE_USD, 1) as number,
    textReserveUsd: numOr(env.AI_SPEND_CAP_TEXT_RESERVE_USD, 0.5) as number,
  };
}

type Executor = Pick<DB, "select">;

/**
 * Committed spend since `since`: priced cost, plus the reserve of every attempt that may have been
 * billed without a price (pending — in flight or interrupted —, unknown outcome, or unpriced).
 * A timed-out attempt that was then retried is settled as `retried` with price source `unknown`:
 * it may have been billed, so it counts too.
 */
export async function committedSpendUsd(
  since: Date,
  env: Env = process.env,
  db?: Executor,
  provider?: string,
): Promise<{ usd: number; pricedUsd: number; reservedUsd: number; unpricedAttempts: number; pendingAttempts: number }> {
  const cfg = spendCapConfig(env);
  const e = schema.usageEvents;
  const q = db ?? (await getDb());
  const [priced] = await q
    .select({ usd: sql<number>`coalesce(sum(${e.costUsd}), 0)` })
    .from(e)
    .where(and(gte(e.createdAt, since), ne(e.provider, "mock"), provider ? eq(e.provider, provider) : undefined));
  const fallback = sql`case when ${e.kind} = 'image' then ${cfg.imageReserveUsd}::real else ${cfg.textReserveUsd}::real end`;
  const [held] = await q
    .select({
      usd: sql<number>`coalesce(sum(coalesce(${e.reserveUsd}, ${fallback})), 0)`,
      n: sql<number>`count(*)`,
      pending: sql<number>`count(*) filter (where ${e.outcome} = 'pending')`,
    })
    .from(e)
    .where(and(gte(e.createdAt, since), ne(e.provider, "mock"), provider ? eq(e.provider, provider) : undefined, isNull(e.costUsd), sql`(${e.outcome} in ('pending', 'unknown') or ${e.priceSource} in ('unpriced', 'unknown'))`));
  const pricedUsd = Number(priced?.usd ?? 0);
  const reservedUsd = Number(held?.usd ?? 0);
  return { usd: pricedUsd + reservedUsd, pricedUsd, reservedUsd, unpricedAttempts: Number(held?.n ?? 0), pendingAttempts: Number(held?.pending ?? 0) };
}

// ------------------------------------------------------------------ attempts (process state)

/** Settlement data for an attempt: everything the final usage row holds. */
export type Settlement = {
  outcome: Exclude<UsageOutcome, "pending">;
  model?: string | null;
  errorKind?: string | null;
  httpStatus?: number | null;
  units?: Record<string, number>;
  costUsd?: number | null;
  priceSource?: string | null;
  providerRequestId?: string | null;
  latencyMs?: number | null;
};
export type Ticket = { id: string; reserveUsd: number };

// On globalThis: Next.js can load this module in more than one bundle of the same process.
type State = { reservations: number; unsettled: Map<string, Settlement> };
const g = globalThis as unknown as { __bpSpendState?: State };
const state = (): State => (g.__bpSpendState ??= { reservations: 0, unsettled: new Map() });

/** Serialises cap checks and pending-row writes across processes sharing the database. */
const LEDGER_LOCK = 7_461_287_004;

async function writeSettlement(id: string, s: Settlement): Promise<void> {
  const db = await getDb();
  const e = schema.usageEvents;
  await db
    .update(e)
    .set({
      outcome: s.outcome,
      model: s.model ?? undefined,
      errorKind: s.errorKind ?? null,
      httpStatus: s.httpStatus ?? null,
      units: Object.fromEntries(Object.entries(s.units ?? {}).filter(([, v]) => typeof v === "number" && Number.isFinite(v) && v !== 0)),
      costUsd: s.costUsd ?? null,
      priceSource: s.priceSource ?? null,
      providerRequestId: s.providerRequestId ?? null,
      latencyMs: s.latencyMs ?? null,
      settledAt: new Date(),
    })
    // Only a pending row is settled: retrying a settlement never changes or double-counts it.
    .where(and(eq(e.id, id), eq(e.outcome, "pending")));
}

/** Retries settlements that failed earlier. True when none are outstanding. */
async function flushUnsettled(): Promise<boolean> {
  const st = state();
  for (const [id, s] of [...st.unsettled]) {
    try {
      await writeSettlement(id, s);
      st.unsettled.delete(id);
      log.info("ai.usage_settle_recovered", { id });
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Before a paid request: check the cap and durably record the attempt as pending, or refuse.
 * Throws AISpendCapConfigError (cap missing or invalid), AIAccountingError (the ledger can't record
 * it) or AISpendCapError (the cap would be exceeded). Nothing has been sent when it throws.
 */
export async function openAttempt(
  route: Pick<ResolvedRoute, "kind" | "key" | "provider" | "model">,
  info: { attempt: number; params?: Record<string, string> },
  worstCaseUsd: number | null,
  env: Env = process.env,
): Promise<Ticket> {
  const parsed = parseSpendCap(env);
  if (!parsed.ok) throw new AISpendCapConfigError(parsed.reason);
  if (!(await flushUnsettled())) throw new AIAccountingError("an earlier request's usage couldn't be recorded yet");
  const cfg = spendCapConfig(env);
  const priced = worstCaseUsd !== null && Number.isFinite(worstCaseUsd) && worstCaseUsd >= 0;
  // A text request always has a computed worst case; none means a model it may use (the routed model or
  // a fallback target) has no price. Under a cap, a fixed fallback reserve could under-count it: refuse.
  // Images use their configured reserve (AI_SPEND_CAP_IMAGE_RESERVE_USD) by design.
  if (!priced && route.kind !== "image" && parsed.capUsd !== null) {
    throw new AISpendCapConfigError("unable to cover this request (a model it may use has no price, so its worst-case cost is unknown)");
  }
  const fallback = route.kind === "image" ? cfg.imageReserveUsd : cfg.textReserveUsd;
  const reserve = priced ? worstCaseUsd! : fallback;
  let db: DB;
  try {
    db = await getDb();
  } catch (e) {
    log.error("ai.usage_db_unavailable", { route: route.key, error: e instanceof Error ? e.message : String(e) });
    throw new AIAccountingError("the database is unavailable");
  }
  const ctx = aiContext();
  let id: string | null;
  let tripped: Awaited<ReturnType<typeof tripwireExceeded>> = null;
  try {
    id = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${LEDGER_LOCK})`);
      // Kill switch and tripwire first (controls.ts): a stopped scope is never sent.
      await assertNotStopped(tx, route, env);
      tripped = await tripwireExceeded(tx, route.provider, reserve, env);
      if (tripped) return null;
      if (parsed.capUsd !== null) {
        const { usd } = await committedSpendUsd(parsed.since, env, tx);
        if (usd + reserve > parsed.capUsd + 1e-9) throw new AISpendCapError(parsed.capUsd, usd, reserve);
      }
      const [row] = await tx
        .insert(schema.usageEvents)
        .values({
          workspaceId: ctx.workspaceId ?? null,
          brandId: ctx.brandId ?? null,
          userId: ctx.userId ?? null,
          taskId: ctx.taskId ?? null,
          runId: ctx.runId ?? null,
          route: route.key,
          provider: route.provider,
          model: route.model ?? null,
          kind: route.kind,
          params: info.params ?? {},
          attempt: info.attempt,
          outcome: "pending",
          reserveUsd: reserve,
        })
        .returning({ id: schema.usageEvents.id });
      if (!row?.id) throw new Error("the pending usage row wasn't returned");
      return row.id;
    });
  } catch (e) {
    if (e instanceof AISpendCapError || e instanceof AIStoppedError) throw e;
    log.error("ai.usage_write_failed", { route: route.key, stage: "pending", error: e instanceof Error ? e.message : String(e) });
    throw new AIAccountingError("the usage ledger couldn't be written");
  }
  if (tripped || !id) {
    await tripTripwire(tripped!);
    throw new AIStoppedError(`provider:${route.provider}`, "tripwire");
  }
  state().reservations++;
  return { id, reserveUsd: reserve };
}

/**
 * After the attempt: settle its pending row in place. Never throws. If the write fails, the row
 * stays pending (still counted at its reserve), the failure is logged, and openAttempt() refuses
 * further requests until the settlement is written.
 */
export async function settleAttempt(ticket: Ticket, s: Settlement): Promise<void> {
  const st = state();
  try {
    await writeSettlement(ticket.id, s);
  } catch (e) {
    st.unsettled.set(ticket.id, s);
    log.error("ai.usage_write_failed", { id: ticket.id, stage: "settle", outcome: s.outcome, error: e instanceof Error ? e.message : String(e) });
  } finally {
    st.reservations = Math.max(0, st.reservations - 1);
  }
}

/** Attempts this process has opened and not yet settled (the paid-run network guard checks this). */
export function activeReservations(): number {
  return state().reservations;
}

/** Settlements this process couldn't write yet (their rows stay pending). */
export function unsettledAttempts(): number {
  return state().unsettled.size;
}

/** For tests: forget this process's state (as after a restart). */
export function resetSpendCapState() {
  g.__bpSpendState = { reservations: 0, unsettled: new Map() };
}
