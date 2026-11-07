import "server-only";
import { and, count, eq, gte, inArray } from "drizzle-orm";
import { startOfMonth } from "date-fns";
import { getDb, schema } from "./db/client";
import { PLANS, type PlanId } from "@/lib/plans";

export class QuotaError extends Error {}

async function workspaceOf(brandId: string) {
  const db = await getDb();
  const [r] = await db
    .select({ ws: schema.workspaces })
    .from(schema.brands)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.brands.workspaceId))
    .where(eq(schema.brands.id, brandId));
  return r.ws;
}

export async function usage(workspaceId: string) {
  const db = await getDb();
  const brands = await db.select({ id: schema.brands.id }).from(schema.brands).where(eq(schema.brands.workspaceId, workspaceId));
  const ids = brands.map((b) => b.id);
  const [seats] = await db.select({ n: count() }).from(schema.workspaceMembers).where(eq(schema.workspaceMembers.workspaceId, workspaceId));
  const [runs] = ids.length
    ? await db.select({ n: count() }).from(schema.agentRuns).where(and(inArray(schema.agentRuns.brandId, ids), gte(schema.agentRuns.startedAt, startOfMonth(new Date()))))
    : [{ n: 0 }];
  const [accts] = ids.length ? await db.select({ n: count() }).from(schema.socialAccounts).where(inArray(schema.socialAccounts.brandId, ids)) : [{ n: 0 }];
  return { brands: ids.length, seats: seats.n, aiRuns: runs.n, socialAccounts: accts.n };
}

export async function assertAiQuota(brandId: string) {
  const ws = await workspaceOf(brandId);
  const plan = PLANS[ws.plan as PlanId] ?? PLANS.starter;
  const u = await usage(ws.id);
  if (u.aiRuns >= plan.aiRunsPerMonth) throw new QuotaError(`Your ${plan.label} plan includes ${plan.aiRunsPerMonth} AI runs per month. Upgrade in Settings to keep going.`);
}

export async function assertCanAdd(workspaceId: string, what: "brands" | "seats" | "socialAccounts") {
  const db = await getDb();
  const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  const plan = PLANS[ws.plan as PlanId] ?? PLANS.starter;
  const u = await usage(workspaceId);
  if (u[what] >= plan[what]) throw new QuotaError(`Your ${plan.label} plan allows ${plan[what]} ${what === "socialAccounts" ? "social accounts" : what}. Upgrade in Settings.`);
}
