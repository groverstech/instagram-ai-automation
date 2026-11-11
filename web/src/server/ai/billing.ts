import "server-only";
import { and, eq, gte, isNotNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../db/client";

/**
 * Estimated versus provider-confirmed AI costs (docs/AI_PROVIDERS.md).
 *
 * - **Estimated:** every attempt in `usage_events` carries a cost computed from the usage the
 *   provider reported and the rates in effect (pricing.ts).
 * - **Confirmed:** what the provider actually billed, imported by an operator from the providers'
 *   cost reports or invoices into `ai_billing` (`npm run ai:billing -- import <file.json>`).
 *
 * Providers bill the BrandPilot account as a whole, so confirmed amounts are platform-level and
 * are compared with the estimates of all organisations together. They are never shown to a
 * customer organisation. Pulling cost reports automatically needs provider admin keys and is a
 * follow-up (docs/FOLLOW_UPS.md).
 */
export const BillingLine = z.object({
  provider: z.enum(["anthropic", "openai"]),
  model: z.string().max(100).default(""),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
  usd: z.number().finite().nonnegative(),
  source: z.string().min(1).max(100),
  reference: z.string().max(200).optional(),
});
export type BillingLine = z.infer<typeof BillingLine>;

/** Record confirmed amounts. Re-importing the same line (provider, model, period, source) updates it. */
export async function importConfirmedBilling(raw: unknown[], importedBy: string) {
  const lines = raw.map((r, i) => {
    const p = BillingLine.safeParse(r);
    if (!p.success) throw new Error(`Line ${i + 1}: ${p.error.issues[0].path.join(".")} ${p.error.issues[0].message}`);
    if (p.data.periodEnd <= p.data.periodStart) throw new Error(`Line ${i + 1}: periodEnd must be after periodStart`);
    return p.data;
  });
  const db = await getDb();
  for (const l of lines) {
    await db
      .insert(schema.aiBilling)
      .values({ provider: l.provider, model: l.model, periodStart: l.periodStart, periodEnd: l.periodEnd, confirmedUsd: l.usd, source: l.source, reference: l.reference ?? null, importedBy })
      .onConflictDoUpdate({
        target: [schema.aiBilling.provider, schema.aiBilling.model, schema.aiBilling.periodStart, schema.aiBilling.periodEnd, schema.aiBilling.source],
        set: { confirmedUsd: l.usd, reference: l.reference ?? null, importedBy, importedAt: new Date() },
      });
  }
  return lines.length;
}

export type ReconciliationRow = {
  provider: string;
  model: string;
  estimatedUsd: number;
  unpricedAttempts: number;
  unknownOutcomeAttempts: number;
  /** null: nothing confirmed for this provider and model in the period yet. */
  confirmedUsd: number | null;
  /** (estimated − confirmed) / confirmed, when both exist. */
  difference: number | null;
};

/**
 * Estimated versus confirmed cost per provider and model for a period, across all
 * organisations (platform-level, for operators). Confirmed lines with no model are matched
 * against the provider's total.
 */
export async function reconcile(periodStart: Date, periodEnd: Date): Promise<ReconciliationRow[]> {
  const db = await getDb();
  const e = schema.usageEvents;
  const est = await db
    .select({
      provider: e.provider,
      model: sql<string>`coalesce(${e.model}, '')`,
      usd: sql<number>`coalesce(sum(${e.costUsd}), 0)`,
      unpriced: sql<number>`count(*) filter (where ${e.priceSource} = 'unpriced')`,
      unknown: sql<number>`count(*) filter (where ${e.outcome} = 'unknown' or (${e.outcome} = 'retried' and ${e.errorKind} in ('timeout', 'network')))`,
    })
    .from(e)
    .where(and(gte(e.createdAt, periodStart), lt(e.createdAt, periodEnd), ne(e.provider, "mock")))
    .groupBy(e.provider, e.model);
  const b = schema.aiBilling;
  const conf = await db
    .select({ provider: b.provider, model: b.model, usd: sql<number>`sum(${b.confirmedUsd})` })
    .from(b)
    .where(and(gte(b.periodStart, periodStart), lt(b.periodStart, periodEnd), isNotNull(b.confirmedUsd)))
    .groupBy(b.provider, b.model);
  const n = (v: unknown) => Number(v ?? 0);
  const rows: ReconciliationRow[] = est.map((r) => ({
    provider: r.provider,
    model: r.model,
    estimatedUsd: n(r.usd),
    unpricedAttempts: n(r.unpriced),
    unknownOutcomeAttempts: n(r.unknown),
    confirmedUsd: null,
    difference: null,
  }));
  for (const c of conf) {
    let row = rows.find((r) => r.provider === c.provider && r.model === c.model);
    if (!row && c.model === "") {
      // A provider-wide confirmed amount: compare against the provider's total estimate.
      const total = rows.filter((r) => r.provider === c.provider);
      row = { provider: c.provider, model: "", estimatedUsd: total.reduce((s, r) => s + r.estimatedUsd, 0), unpricedAttempts: total.reduce((s, r) => s + r.unpricedAttempts, 0), unknownOutcomeAttempts: total.reduce((s, r) => s + r.unknownOutcomeAttempts, 0), confirmedUsd: null, difference: null };
      rows.push(row);
    }
    if (!row) {
      row = { provider: c.provider, model: c.model, estimatedUsd: 0, unpricedAttempts: 0, unknownOutcomeAttempts: 0, confirmedUsd: null, difference: null };
      rows.push(row);
    }
    row.confirmedUsd = n(c.usd);
    row.difference = row.confirmedUsd > 0 ? (row.estimatedUsd - row.confirmedUsd) / row.confirmedUsd : null;
  }
  return rows.sort((a, b2) => a.provider.localeCompare(b2.provider) || a.model.localeCompare(b2.model));
}

/** Delete one imported line (operator correction). */
export async function removeConfirmedBilling(id: string) {
  const db = await getDb();
  await db.delete(schema.aiBilling).where(eq(schema.aiBilling.id, id));
}
