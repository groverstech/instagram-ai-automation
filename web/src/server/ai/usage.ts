import "server-only";
import { and, eq, gte, inArray, isNotNull, ne, sql, sum } from "drizzle-orm";
import { startOfMonth } from "date-fns";
import { getDb, schema } from "../db/client";
import type { UsageOutcome } from "../db/schema";
import { log } from "../log";
import { aiContext } from "./context";

/**
 * The AI usage ledger (`usage_events`, docs/AI_PROVIDERS.md): one row per provider attempt, with
 * its outcome, units, estimated cost, price source and the provider's request ID. Writing a row
 * never breaks the AI call it records.
 */
export type AttemptRecord = {
  route: string;
  provider: string;
  model?: string | null;
  kind: "text" | "research" | "image";
  params?: Record<string, string>;
  attempt: number;
  outcome: UsageOutcome;
  errorKind?: string | null;
  httpStatus?: number | null;
  units?: Record<string, number>;
  costUsd?: number | null;
  priceSource?: string | null;
  providerRequestId?: string | null;
  latencyMs?: number | null;
};

export async function recordAttempt(r: AttemptRecord) {
  const ctx = aiContext();
  try {
    const db = await getDb();
    await db.insert(schema.usageEvents).values({
      workspaceId: ctx.workspaceId ?? null,
      brandId: ctx.brandId ?? null,
      userId: ctx.userId ?? null,
      taskId: ctx.taskId ?? null,
      runId: ctx.runId ?? null,
      route: r.route,
      provider: r.provider,
      model: r.model ?? null,
      kind: r.kind,
      params: r.params ?? {},
      attempt: r.attempt,
      outcome: r.outcome,
      errorKind: r.errorKind ?? null,
      httpStatus: r.httpStatus ?? null,
      units: Object.fromEntries(Object.entries(r.units ?? {}).filter(([, v]) => typeof v === "number" && Number.isFinite(v) && v !== 0)),
      costUsd: r.costUsd ?? null,
      priceSource: r.priceSource ?? null,
      providerRequestId: r.providerRequestId ?? null,
      latencyMs: r.latencyMs ?? null,
    });
  } catch (e) {
    log.error("ai.usage_write_failed", { route: r.route, outcome: r.outcome, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Estimated provider spend for an organisation this month (demo calls excluded). */
export async function monthlyCostUsd(workspaceId: string, now = new Date()): Promise<number> {
  const db = await getDb();
  const e = schema.usageEvents;
  const [row] = await db
    .select({ usd: sum(e.costUsd) })
    .from(e)
    .where(and(eq(e.workspaceId, workspaceId), gte(e.createdAt, startOfMonth(now)), ne(e.provider, "mock"), isNotNull(e.costUsd)));
  return Number(row?.usd ?? 0);
}

export type UsageBreakdownRow = {
  provider: string;
  model: string | null;
  kind: string;
  attempts: number;
  successes: number;
  failed: number;
  retried: number;
  refused: number;
  unknown: number;
  blocked: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  images: number;
  costUsd: number;
  unpricedAttempts: number;
};

export type UsageSummary = {
  since: Date;
  totals: Omit<UsageBreakdownRow, "provider" | "model" | "kind">;
  byModel: UsageBreakdownRow[];
  byBrand: { brandId: string | null; attempts: number; costUsd: number; unpricedAttempts: number }[];
  byRoute: { route: string; attempts: number; costUsd: number }[];
};

const unit = (k: string) => sql<number>`coalesce(sum(((${schema.usageEvents.units}) ->> ${k})::numeric), 0)`;
const outcomeCount = (o: UsageOutcome) => sql<number>`count(*) filter (where ${schema.usageEvents.outcome} = ${o})`;

/**
 * This month's AI usage for an organisation: totals, by provider and model, by brand and by
 * route. `brandIds` limits it to those brands (a brand-scoped view). The caller authorises.
 */
export async function usageSummary(workspaceId: string, opts: { brandIds?: string[] | null; now?: Date } = {}): Promise<UsageSummary> {
  const db = await getDb();
  const e = schema.usageEvents;
  const since = startOfMonth(opts.now ?? new Date());
  if (opts.brandIds && !opts.brandIds.length) {
    return { since, totals: emptyTotals(), byModel: [], byBrand: [], byRoute: [] };
  }
  const where = and(eq(e.workspaceId, workspaceId), gte(e.createdAt, since), opts.brandIds ? inArray(e.brandId, opts.brandIds) : undefined);
  const cols = {
    attempts: sql<number>`count(*)`,
    successes: outcomeCount("success"),
    failed: outcomeCount("failed"),
    retried: outcomeCount("retried"),
    refused: outcomeCount("refused"),
    unknown: outcomeCount("unknown"),
    blocked: outcomeCount("blocked"),
    inputTokens: unit("inputTokens"),
    outputTokens: unit("outputTokens"),
    cacheReadTokens: unit("cacheReadTokens"),
    cacheWriteTokens: unit("cacheWriteTokens"),
    webSearches: unit("webSearches"),
    images: unit("images"),
    costUsd: sql<number>`coalesce(sum(${e.costUsd}), 0)`,
    unpricedAttempts: sql<number>`count(*) filter (where ${e.priceSource} = 'unpriced')`,
  };
  const byModel = await db
    .select({ provider: e.provider, model: e.model, kind: e.kind, ...cols })
    .from(e)
    .where(where)
    .groupBy(e.provider, e.model, e.kind)
    .orderBy(sql`coalesce(sum(${e.costUsd}), 0) desc`);
  const byBrand = await db
    .select({ brandId: e.brandId, attempts: cols.attempts, costUsd: cols.costUsd, unpricedAttempts: cols.unpricedAttempts })
    .from(e)
    .where(where)
    .groupBy(e.brandId);
  const byRoute = await db.select({ route: e.route, attempts: cols.attempts, costUsd: cols.costUsd }).from(e).where(where).groupBy(e.route);
  const n = (v: unknown) => Number(v ?? 0);
  const rows: UsageBreakdownRow[] = byModel.map((r) => ({
    provider: r.provider,
    model: r.model,
    kind: r.kind,
    attempts: n(r.attempts),
    successes: n(r.successes),
    failed: n(r.failed),
    retried: n(r.retried),
    refused: n(r.refused),
    unknown: n(r.unknown),
    blocked: n(r.blocked),
    inputTokens: n(r.inputTokens),
    outputTokens: n(r.outputTokens),
    cacheReadTokens: n(r.cacheReadTokens),
    cacheWriteTokens: n(r.cacheWriteTokens),
    webSearches: n(r.webSearches),
    images: n(r.images),
    costUsd: n(r.costUsd),
    unpricedAttempts: n(r.unpricedAttempts),
  }));
  const totals = emptyTotals();
  for (const r of rows) for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += r[k];
  return {
    since,
    totals,
    byModel: rows,
    byBrand: byBrand.map((b) => ({ brandId: b.brandId, attempts: n(b.attempts), costUsd: n(b.costUsd), unpricedAttempts: n(b.unpricedAttempts) })).sort((a, b) => b.costUsd - a.costUsd || b.attempts - a.attempts),
    byRoute: byRoute.map((r) => ({ route: r.route, attempts: n(r.attempts), costUsd: n(r.costUsd) })).sort((a, b) => b.attempts - a.attempts),
  };
}

function emptyTotals(): UsageSummary["totals"] {
  return { attempts: 0, successes: 0, failed: 0, retried: 0, refused: 0, unknown: 0, blocked: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, images: 0, costUsd: 0, unpricedAttempts: 0 };
}
