import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db/client";
import { assertAiQuota } from "./quota";
import { enforce, withAiSlot } from "./ratelimit";
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
  const db = await getDb();
  const [ws] = await db.select({ plan: schema.workspaces.plan }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  return withAiSlot({ userId, workspaceId, plan: (ws?.plan ?? "starter") as PlanId }, kind, fn);
}
