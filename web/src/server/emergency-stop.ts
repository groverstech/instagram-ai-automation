import "server-only";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getDb, schema } from "./db/client";
import { cancelJobs } from "./jobs/queue";
import { audit } from "./audit";
import { log } from "./log";

/**
 * Operator emergency stop (review M4): pause publishing for every brand, or every brand of one
 * organisation, at once. It's the brand-level emergency pause (publishing-pause.ts) applied in bulk:
 *
 * - each brand not already paused is paused, with the reason and the operator recorded;
 * - its queued publish jobs are cancelled;
 * - a Security-log event (`publishing.emergency_stop`) is written for each organisation affected.
 *
 * A publish that has already reached the platform can't be recalled. A publish that was claimed just
 * before the stop is checked again immediately before its final request (social/service.ts) and
 * stops there if it hasn't been sent yet.
 *
 * There's deliberately no bulk resume. Each brand is resumed in the app by one of its admins
 * (Content Calendar → Resume publishing), which re-queues future posts and returns missed ones to
 * "approved". Reversing the stop in SQL would strand scheduled posts without jobs.
 */
export async function emergencyStop(input: { by: string; reason: string; workspaceId?: string | null }) {
  const by = input.by.trim();
  const reason = input.reason.trim();
  if (!by) throw new Error("--by <your name> is required: it's recorded with the stop.");
  if (!reason) throw new Error("--reason is required: it's shown on every paused brand and recorded.");
  const db = await getDb();
  const now = new Date();
  const paused = await db
    .update(schema.brands)
    .set({ publishingPausedAt: now, publishingPausedBy: null, publishingPauseReason: `Emergency stop by the BrandPilot team: ${reason}`.slice(0, 300) })
    .where(and(isNull(schema.brands.publishingPausedAt), input.workspaceId ? eq(schema.brands.workspaceId, input.workspaceId) : undefined))
    .returning({ id: schema.brands.id, workspaceId: schema.brands.workspaceId });
  const brandIds = new Set(paused.map((b) => b.id));
  let cancelled = 0;
  if (brandIds.size) {
    const postIds = new Set((await db.select({ id: schema.posts.id }).from(schema.posts).where(inArray(schema.posts.brandId, [...brandIds]))).map((p) => p.id));
    const before = await db.$count(schema.jobs, and(eq(schema.jobs.type, "publish_post"), eq(schema.jobs.status, "queued")));
    await cancelJobs("publish_post", (p) => postIds.has(String(p.postId)));
    cancelled = before - (await db.$count(schema.jobs, and(eq(schema.jobs.type, "publish_post"), eq(schema.jobs.status, "queued"))));
  }
  const perOrg = new Map<string, number>();
  for (const b of paused) perOrg.set(b.workspaceId, (perOrg.get(b.workspaceId) ?? 0) + 1);
  for (const [workspaceId, n] of perOrg) {
    await audit({ action: "publishing.emergency_stop", workspaceId, actorType: "system", targetType: "workspace", targetId: workspaceId, details: { brands: n, by, reason } });
  }
  log.error("publishing.emergency_stop", { brands: paused.length, organisations: perOrg.size, cancelledJobs: cancelled, by, scope: input.workspaceId ?? "all" });
  return { brands: paused.length, organisations: perOrg.size, cancelledJobs: cancelled };
}

/** Brands currently paused, with who or what paused them (for the operator's status view). */
export async function pausedBrands() {
  const db = await getDb();
  return db
    .select({ id: schema.brands.id, name: schema.brands.name, workspace: schema.workspaces.name, at: schema.brands.publishingPausedAt, reason: schema.brands.publishingPauseReason })
    .from(schema.brands)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.brands.workspaceId))
    .where(isNotNull(schema.brands.publishingPausedAt));
}
