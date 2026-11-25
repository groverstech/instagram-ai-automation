import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "./db/client";
import { requireWorkspaceRoleForUser } from "./auth/guard";
import { requireRecentSecondFactor } from "./auth/step-up";
import type { SessionUser } from "./auth/session";
import { audit } from "./audit";
import { creditStatus, evaluateCreditAlerts, type CreditStatus } from "./credits";

export class CreditCapError extends Error {}

const MAX_CAP = 10_000_000;

/** Settings → AI credits for owners and admins with access to every brand. */
export async function creditStatusFor(session: SessionUser, workspaceId: string): Promise<CreditStatus & { brandNames: Record<string, string> }> {
  await requireWorkspaceRoleForUser(session, workspaceId, "admin");
  const st = await creditStatus(workspaceId);
  const db = await getDb();
  const brands = await db.select({ id: schema.brands.id, name: schema.brands.name }).from(schema.brands).where(eq(schema.brands.workspaceId, workspaceId));
  return { ...st, brandNames: Object.fromEntries(brands.map((b) => [b.id, b.name])) };
}

/**
 * Set or clear (null) the organisation's monthly credit cap (brandId null) or one brand's.
 * Admins and owners; a spending control, so it needs a recent second factor like billing.
 */
export async function setCreditCapFor(session: SessionUser, workspaceId: string, brandId: string | null, credits: number | null) {
  await requireWorkspaceRoleForUser(session, workspaceId, "admin");
  await requireRecentSecondFactor(session);
  if (credits !== null && (!Number.isInteger(credits) || credits < 0 || credits > MAX_CAP)) throw new CreditCapError(`Enter a whole number of credits from 0 to ${MAX_CAP.toLocaleString("en")}.`);
  const db = await getDb();
  if (brandId) {
    const [b] = await db.select({ id: schema.brands.id }).from(schema.brands).where(and(eq(schema.brands.id, brandId), eq(schema.brands.workspaceId, workspaceId)));
    if (!b) throw new CreditCapError("That brand isn't in this workspace.");
  }
  const scope = brandId ?? "";
  const where = and(eq(schema.creditLimits.workspaceId, workspaceId), eq(schema.creditLimits.brandId, scope));
  const [before] = await db.select().from(schema.creditLimits).where(where);
  if (credits === null) await db.delete(schema.creditLimits).where(where);
  else
    await db
      .insert(schema.creditLimits)
      .values({ workspaceId, brandId: scope, monthlyCapCredits: credits, updatedBy: session.user.id })
      .onConflictDoUpdate({ target: [schema.creditLimits.workspaceId, schema.creditLimits.brandId], set: { monthlyCapCredits: credits, updatedBy: session.user.id, updatedAt: new Date() } });
  await audit({
    action: "credits.cap_change",
    workspaceId,
    brandId,
    actorUserId: session.user.id,
    targetType: brandId ? "brand" : "workspace",
    targetId: brandId ?? workspaceId,
    details: { before: before?.monthlyCapCredits ?? null, after: credits },
  });
  // A lower cap may already be crossed: alert now rather than at the next AI action.
  await evaluateCreditAlerts(workspaceId);
}
