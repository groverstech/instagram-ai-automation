import "server-only";
import { and, gte, isNull, ne, sql } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { AISpendCapConfigError, AISpendCapError } from "./errors";
import type { ResolvedRoute } from "./routes";

/**
 * Hard AI spending cap for a whole deployment (docs/AI_PROVIDERS.md), e.g. a staging validation
 * budget. Unlike the monthly limit (checked after the fact), it is checked **before every
 * provider request**: a request is sent only if
 *
 *   committed spend since AI_SPEND_CAP_SINCE + reserves of requests in flight + this request's
 *   worst-case cost  <=  AI_SPEND_CAP_USD
 *
 * so the cap is never exceeded by a request we send. Committed spend is the ledger's estimated
 * cost of real (non-demo) attempts; an attempt that may have been billed but has no price
 * (unpriced, or an unknown outcome after a timeout) counts at its kind's fallback reserve.
 * Worst-case costs come from the caller (text: estimated input at the cache-write rate plus the
 * full output-token limit; images: AI_SPEND_CAP_IMAGE_RESERVE_USD, default $1.00, well above
 * OpenAI's published per-image output costs). Unset AI_SPEND_CAP_USD means no cap.
 *
 * The in-flight reserve is per process: run validations with one app process (or one worker).
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
 * Paid operator commands (`npm run test:live`, `npm run ai:check-anthropic`) set it for their
 * process (paid-run-guard.ts); a deployment can set it too.
 */
export const spendCapRequired = (env: Env = process.env) => /^(1|true|yes)$/i.test(env.AI_SPEND_CAP_REQUIRED?.trim() ?? "");

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

let inFlight = 0;
let reservations = 0;

/** Committed spend since `since`: priced cost, plus fallback reserves for possibly billed attempts without a price. */
export async function committedSpendUsd(since: Date, env: Env = process.env): Promise<{ usd: number; pricedUsd: number; unpricedAttempts: number }> {
  const cfg = spendCapConfig(env);
  const e = schema.usageEvents;
  const db = await getDb();
  const [priced] = await db
    .select({ usd: sql<number>`coalesce(sum(${e.costUsd}), 0)` })
    .from(e)
    .where(and(gte(e.createdAt, since), ne(e.provider, "mock")));
  const unpriced = await db
    .select({ kind: e.kind, n: sql<number>`count(*)` })
    .from(e)
    .where(and(gte(e.createdAt, since), ne(e.provider, "mock"), isNull(e.costUsd), sql`(${e.priceSource} = 'unpriced' or ${e.outcome} = 'unknown')`))
    .groupBy(e.kind);
  const fallback = unpriced.reduce((s, r) => s + Number(r.n) * (r.kind === "image" ? cfg.imageReserveUsd : cfg.textReserveUsd), 0);
  const pricedUsd = Number(priced?.usd ?? 0);
  return { usd: pricedUsd + fallback, pricedUsd, unpricedAttempts: unpriced.reduce((s, r) => s + Number(r.n), 0) };
}

/**
 * Reserve this request's worst-case cost under the cap, or refuse it (nothing is sent).
 * Returns a release function to call once the attempt is recorded in the ledger.
 */
export async function reserveSpend(route: Pick<ResolvedRoute, "kind" | "key">, worstCaseUsd: number | null, env: Env = process.env): Promise<() => void> {
  const parsed = parseSpendCap(env);
  if (!parsed.ok) throw new AISpendCapConfigError(parsed.reason);
  if (parsed.capUsd === null) return () => {};
  const cfg = spendCapConfig(env);
  const fallback = route.kind === "image" ? cfg.imageReserveUsd : cfg.textReserveUsd;
  const reserve = worstCaseUsd !== null && Number.isFinite(worstCaseUsd) && worstCaseUsd >= 0 ? worstCaseUsd : fallback;
  // Reserve first, then read the ledger: concurrent requests in this process can't both pass the
  // check while one of them is awaiting the database.
  inFlight += reserve;
  reservations++;
  let usd: number;
  try {
    ({ usd } = await committedSpendUsd(parsed.since, env));
  } catch (e) {
    inFlight = Math.max(0, inFlight - reserve);
    reservations = Math.max(0, reservations - 1);
    throw e;
  }
  if (usd + inFlight > parsed.capUsd + 1e-9) {
    inFlight = Math.max(0, inFlight - reserve);
    reservations = Math.max(0, reservations - 1);
    throw new AISpendCapError(parsed.capUsd, usd, reserve);
  }
  let released = false;
  return () => {
    if (!released) {
      released = true;
      inFlight = Math.max(0, inFlight - reserve);
      reservations = Math.max(0, reservations - 1);
    }
  };
}

/** Requests currently holding a reservation under the cap (the paid-run network guard checks this). */
export function activeReservations(): number {
  return reservations;
}

/** For tests. */
export function resetSpendCapState() {
  inFlight = 0;
  reservations = 0;
}
