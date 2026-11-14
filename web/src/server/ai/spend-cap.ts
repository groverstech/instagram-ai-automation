import "server-only";
import { and, gte, isNull, ne, sql } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { AISpendCapError } from "./errors";
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

export function spendCapConfig(env: Env = process.env) {
  const cap = numOr(env.AI_SPEND_CAP_USD, null);
  const sinceRaw = env.AI_SPEND_CAP_SINCE?.trim();
  const now = new Date();
  const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? new Date(sinceRaw) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    capUsd: cap,
    since,
    imageReserveUsd: numOr(env.AI_SPEND_CAP_IMAGE_RESERVE_USD, 1) as number,
    textReserveUsd: numOr(env.AI_SPEND_CAP_TEXT_RESERVE_USD, 0.5) as number,
  };
}

let inFlight = 0;

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
  const cfg = spendCapConfig(env);
  if (cfg.capUsd === null) return () => {};
  const reserve = worstCaseUsd ?? (route.kind === "image" ? cfg.imageReserveUsd : cfg.textReserveUsd);
  const { usd } = await committedSpendUsd(cfg.since, env);
  if (usd + inFlight + reserve > cfg.capUsd + 1e-9) {
    throw new AISpendCapError(cfg.capUsd, usd, reserve);
  }
  inFlight += reserve;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      inFlight = Math.max(0, inFlight - reserve);
    }
  };
}

/** For tests. */
export function resetSpendCapState() {
  inFlight = 0;
}
