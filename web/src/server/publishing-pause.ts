import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "./db/client";
import { audit } from "./audit";
import { requireBrandForUser } from "./auth/guard";
import type { SessionUser } from "./auth/session";
import { cancelJobs, enqueue } from "./jobs/queue";

import { operatorStopFor, stoppedMessage } from "./publishing-paused";

export { assertNotPaused, pausedMessage, PublishingPausedError } from "./publishing-paused";

/**
 * Emergency pause (launch gate R2; approved product decision 3): one switch that stops all
 * publishing for a brand at once.
 *
 * - **Pause** (editors and above, so anyone who spots a problem can stop it): queued publish jobs are
 *   cancelled; `publishPost`, scheduling and "publish now" refuse while paused. Posts keep their
 *   status. A publish already sent to the platform when the pause starts can't be recalled.
 * - **Resume** (admins and owners) clears the brand's own pause only, never an operator emergency
 *   stop (emergency-stop.ts). Without a stop in force: posts still due in the future are queued again. Posts whose time
 *   passed during the pause go back to "approved" (unscheduled), so nothing goes out late without a
 *   person rescheduling it.
 */
export async function pausePublishingFor(session: SessionUser, brandId: string, reason: string) {
  const { brand } = await requireBrandForUser(session, brandId, "editor");
  const why = z.string().trim().max(300).parse(reason ?? "");
  if (brand.publishingPausedAt) return { alreadyPaused: true, cancelledJobs: 0 };
  const db = await getDb();
  await db.update(schema.brands).set({ publishingPausedAt: new Date(), publishingPausedBy: session.user.id, publishingPauseReason: why || null }).where(eq(schema.brands.id, brandId));
  const postIds = new Set((await db.select({ id: schema.posts.id }).from(schema.posts).where(eq(schema.posts.brandId, brandId))).map((p) => p.id));
  const before = await db.$count(schema.jobs, and(eq(schema.jobs.type, "publish_post"), eq(schema.jobs.status, "queued")));
  await cancelJobs("publish_post", (p) => postIds.has(String(p.postId)));
  const after = await db.$count(schema.jobs, and(eq(schema.jobs.type, "publish_post"), eq(schema.jobs.status, "queued")));
  await audit({ action: "publishing.pause", workspaceId: brand.workspaceId, brandId, actorUserId: session.user.id, targetType: "brand", targetId: brandId, details: { cancelledJobs: before - after, reason: why ? "given" : "none" } });
  return { alreadyPaused: false, cancelledJobs: before - after };
}

export async function resumePublishingFor(session: SessionUser, brandId: string, now = new Date()) {
  const { brand } = await requireBrandForUser(session, brandId, "admin");
  const db = await getDb();
  // An operator emergency stop is separate and isn't lifted here (review M-3): only the operator
  // command can lift it. The brand's own pause can still be cleared; nothing is queued until the
  // operator lifts the stop (that re-queues this brand's scheduled posts).
  const stop = await operatorStopFor(db, brand.workspaceId);
  if (!brand.publishingPausedAt) return { requeued: 0, unscheduled: 0, operatorStop: stop ? stoppedMessage(stop) : null };
  await db.update(schema.brands).set({ publishingPausedAt: null, publishingPausedBy: null, publishingPauseReason: null }).where(eq(schema.brands.id, brandId));
  if (stop) {
    await audit({ action: "publishing.resume", workspaceId: brand.workspaceId, brandId, actorUserId: session.user.id, targetType: "brand", targetId: brandId, details: { requeued: 0, unscheduled: 0, operatorStopInForce: true } });
    return { requeued: 0, unscheduled: 0, operatorStop: stoppedMessage(stop) };
  }
  const scheduled = await db.select({ id: schema.posts.id, scheduledAt: schema.posts.scheduledAt }).from(schema.posts).where(and(eq(schema.posts.brandId, brandId), eq(schema.posts.status, "scheduled")));
  const future = scheduled.filter((p) => p.scheduledAt && p.scheduledAt > now);
  const missed = scheduled.filter((p) => !p.scheduledAt || p.scheduledAt <= now);
  // A job may still be queued for a post if it was scheduled concurrently with the pause; don't duplicate it.
  await cancelJobs("publish_post", (p) => future.some((f) => f.id === String(p.postId)));
  for (const p of future) await enqueue("publish_post", { postId: p.id }, p.scheduledAt!);
  if (missed.length) await db.update(schema.posts).set({ status: "approved" }).where(inArray(schema.posts.id, missed.map((p) => p.id)));
  await audit({ action: "publishing.resume", workspaceId: brand.workspaceId, brandId, actorUserId: session.user.id, targetType: "brand", targetId: brandId, details: { requeued: future.length, unscheduled: missed.length } });
  return { requeued: future.length, unscheduled: missed.length, operatorStop: null };
}
