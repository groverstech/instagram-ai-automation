import "server-only";
import { and, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { startOfMonth } from "date-fns";
import { schema, type DB } from "../db/client";
import { log } from "../log";
import { AIAccountingError, AICreditLimitError } from "./errors";

/**
 * Credit enforcement (PR 4.6; docs/AI_SPEND_CONTROLS.md §credits). Runs inside openAttempt()'s
 * transaction, under the usage-ledger lock, so concurrent requests are checked one at a time and
 * each sees the others' reservations.
 *
 *   used      = charged credits this month (successful attempts; failed and retried ones too when
 *               the failed-attempt policy charges them) + every open reservation (pending attempts,
 *               at their worst case)
 *   cap       = the organisation's own cap, else the plan's included credits; plus this month's
 *               grants (top-ups and adjustments). A brand cap applies to that brand as well.
 *   refuse    if used + this request's worst case > cap
 *
 * Reservation, settlement and release are the ledger's: the pending row holds the worst case; the
 * settlement replaces it with the real cost (or nothing, for an uncharged failure), which releases
 * the difference. A request that's refused is never sent and never charged.
 *
 * CREDITS_MODE: "enforce" refuses; "shadow" (default) logs `credits.shadow_would_refuse` and allows;
 * "off" skips the check. Mock (demo) requests are never charged or checked. A request with no
 * organisation (platform CLIs, connectivity checks) isn't attributable: it's allowed and logged.
 */
type Env = Record<string, string | undefined>;
type Tx = Pick<DB, "select">;

export type CreditMode = "shadow" | "off" | "enforce";
export function creditMode(env: Env = process.env): CreditMode {
  const v = (env.CREDITS_MODE ?? "").trim().toLowerCase();
  return v === "off" ? "off" : v === "enforce" ? "enforce" : "shadow";
}

export type Position = { cap: number | null; used: number; scope: "organisation" | "brand" };

/** Pure: would this request exceed any applicable cap? Returns the first exceeded position. */
export function exceeded(positions: Position[], reserveCredits: number): Position | null {
  for (const p of positions) if (p.cap !== null && p.used + reserveCredits > p.cap + 1e-9) return p;
  return null;
}

/** The organisation's (and the brand's) credit position this month, with open reservations. */
export async function creditPositions(tx: Tx, workspaceId: string, brandId: string | null, now = new Date()): Promise<{ positions: Position[]; creditValueUsd: number }> {
  const since = startOfMonth(now);
  const period = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, "0")}`;
  const [settingsRow] = await tx.select().from(schema.creditSettings).where(eq(schema.creditSettings.id, "default"));
  const creditValueUsd = settingsRow?.creditValueUsd ?? 0.01;
  const chargeFailed = settingsRow?.chargeFailedAttempts ?? false;
  const [ws] = await tx.select({ plan: schema.workspaces.plan }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  const [plan] = ws ? await tx.select({ included: schema.plans.includedCredits }).from(schema.plans).where(eq(schema.plans.key, ws.plan)) : [];
  const limits = await tx.select().from(schema.creditLimits).where(eq(schema.creditLimits.workspaceId, workspaceId));
  const [{ grants }] = await tx.select({ grants: sql<number>`coalesce(sum(${schema.creditGrants.credits}), 0)` }).from(schema.creditGrants).where(and(eq(schema.creditGrants.workspaceId, workspaceId), eq(schema.creditGrants.period, period)));
  const e = schema.usageEvents;
  const charged: ("success" | "failed" | "retried")[] = chargeFailed ? ["success", "failed", "retried"] : ["success"];
  const base = and(eq(e.workspaceId, workspaceId), gte(e.createdAt, since), ne(e.provider, "mock"));
  // Charged cost, and open reservations (pending rows count at their worst case until settled).
  const amount = sql<number>`coalesce(sum(case when ${e.outcome} = 'pending' then ${e.reserveUsd} else ${e.costUsd} end), 0)`;
  const scoped = (b: string | null) => and(base, b ? eq(e.brandId, b) : undefined, sql`(${e.outcome} = 'pending' or (${inArray(e.outcome, charged)} and ${isNotNull(e.costUsd)}))`);
  const [{ usd: orgUsd }] = await tx.select({ usd: amount }).from(e).where(scoped(null));
  const toCredits = (usd: number) => (creditValueUsd > 0 ? Number(usd) / creditValueUsd : 0);
  const orgLimit = limits.find((l) => l.brandId === "");
  const baseCap = orgLimit?.monthlyCapCredits ?? plan?.included ?? null;
  const positions: Position[] = [{ scope: "organisation", cap: baseCap === null ? null : baseCap + Number(grants), used: toCredits(orgUsd) }];
  const brandLimit = brandId ? limits.find((l) => l.brandId === brandId) : undefined;
  if (brandId && brandLimit) {
    const [{ usd }] = await tx.select({ usd: amount }).from(e).where(scoped(brandId));
    positions.push({ scope: "brand", cap: brandLimit.monthlyCapCredits, used: toCredits(usd) });
  }
  return { positions, creditValueUsd };
}

/**
 * The check in openAttempt(). Throws AICreditLimitError in enforce mode; logs in shadow mode. Any
 * error computing the position fails closed in enforce mode (the request isn't sent) and open in
 * shadow mode (nothing was enforced before either).
 */
export async function creditGate(tx: Tx, ctx: { workspaceId?: string | null; brandId?: string | null }, provider: string, reserveUsd: number, env: Env = process.env, now = new Date()) {
  const mode = creditMode(env);
  if (mode === "off" || provider === "mock") return;
  if (!ctx.workspaceId) {
    if (mode === "enforce") log.warn("credits.unattributed_request", { provider });
    return;
  }
  try {
    const { positions, creditValueUsd } = await creditPositions(tx, ctx.workspaceId, ctx.brandId ?? null, now);
    const reserveCredits = creditValueUsd > 0 ? reserveUsd / creditValueUsd : 0;
    const over = exceeded(positions, reserveCredits);
    if (!over) return;
    if (mode === "enforce") throw new AICreditLimitError(over.scope, over.cap!, over.used, reserveCredits);
    log.warn("credits.shadow_would_refuse", { workspaceId: ctx.workspaceId, brandId: ctx.brandId ?? null, scope: over.scope, cap: over.cap, used: Math.round(over.used * 100) / 100, reserve: Math.round(reserveCredits * 100) / 100 });
  } catch (e) {
    if (e instanceof AICreditLimitError) throw e;
    log.error("credits.gate_failed", { mode, error: e instanceof Error ? e.message : String(e) });
    if (mode === "enforce") throw new AIAccountingError("the credit balance couldn't be checked");
  }
}
