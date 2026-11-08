import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db/client";
import { assertAiQuota } from "./quota";
import { acquireAiSlot, enforce, withAiSlot } from "./ratelimit";
import type { BrandAccess } from "./auth/guard";
import type { PlanId } from "@/lib/plans";

/**
 * Every AI-backed action runs through here, in order:
 *   monthly plan quota → per-user & per-organisation rate limits → concurrency lease.
 */
export async function guardedAi<T>(access: BrandAccess, kind: "ai" | "ai_heavy", fn: () => Promise<T>): Promise<T> {
  const userId = access.session.user.id;
  const workspaceId = access.brand.workspaceId;
  await assertAiQuota(access.brand.id);
  await enforce(kind, { userId, workspaceId });
  return withAiSlot({ userId, workspaceId, plan: await planOf(workspaceId) }, kind, fn);
}

export async function planOf(workspaceId: string): Promise<PlanId> {
  const db = await getDb();
  const [ws] = await db.select({ plan: schema.workspaces.plan }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  return (ws?.plan ?? "starter") as PlanId;
}

/**
 * For background AI work: quota + rate limits now, then a lease that the caller holds for the
 * task's lifetime (renewed by heartbeats) and releases when done.
 */
export async function admitBackgroundAi(access: BrandAccess, kind: "ai" | "ai_heavy", taskKind: string, leaseSec: number) {
  const userId = access.session.user.id;
  const workspaceId = access.brand.workspaceId;
  await assertAiQuota(access.brand.id);
  await enforce(kind, { userId, workspaceId });
  return acquireAiSlot({ userId, workspaceId, plan: await planOf(workspaceId) }, taskKind, leaseSec);
}
