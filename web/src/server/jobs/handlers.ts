import "server-only";
import { and, eq, gte } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { markPublishInterrupted, publishPost, syncMetrics } from "../social/service";
import { runDueJobs, enqueue, type InterruptedHook } from "./queue";
import { log } from "../log";

export const handlers = {
  async publish_post(payload: Record<string, unknown>) {
    const res = await publishPost(String(payload.postId));
    // A recorded platform failure is a final state for this attempt; don't retry blindly.
    return res;
  },
  async sync_metrics(payload: Record<string, unknown>) {
    return syncMetrics(String(payload.brandId));
  },
};

/** What to do when a job's previous run was interrupted mid-flight (see queue.ts). */
export const interruptedHooks: Record<string, InterruptedHook> = {
  // Publishing has an external side effect. If the post had reached "publishing", the platform
  // may already have it: never re-publish automatically; mark it failed with a "check the
  // account" message instead. If it hadn't (the worker died before starting), nothing was sent,
  // so the job runs again; publishPost's atomic claim still stops a post that already went out.
  async publish_post(payload) {
    const post = await markPublishInterrupted(String(payload.postId));
    log.warn("jobs.publish_interrupted", { postId: String(payload.postId), flaggedForCheck: Boolean(post) });
    return Boolean(post);
  },
  // sync_metrics only reads from platforms and overwrites snapshots: safe to simply run again.
};

let lastSyncPlan = 0;

export type TickScope = { jobs?: boolean; ai?: boolean };

/**
 * One scheduler tick. `jobs`: publishing and metric syncs (the jobs table). `ai`: persistent AI
 * tasks (strategist, creative studio) that are queued or abandoned. Both by default; dedicated
 * workers can take one each (WORKER_QUEUES).
 */
export async function tick(scope: TickScope = { jobs: true, ai: true }) {
  if (scope.jobs && Date.now() - lastSyncPlan > 6 * 3600 * 1000) {
    lastSyncPlan = Date.now();
    const db = await getDb();
    const brands = await db.selectDistinct({ brandId: schema.socialAccounts.brandId }).from(schema.socialAccounts).where(eq(schema.socialAccounts.status, "active"));
    const recent = await db
      .select({ payload: schema.jobs.payload })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.type, "sync_metrics"), gte(schema.jobs.createdAt, new Date(Date.now() - 6 * 3600 * 1000))));
    const planned = new Set(recent.map((r) => r.payload.brandId));
    for (const b of brands) if (!planned.has(b.brandId)) await enqueue("sync_metrics", { brandId: b.brandId });
  }
  if (scope.ai) {
    await import("./all").then((m) => m.recoverDueTasks()).catch((e) => log.error("jobs.ai_recovery_failed", { error: e instanceof Error ? e.message : String(e) }));
  }
  return scope.jobs ? runDueJobs(handlers, 10, interruptedHooks) : [];
}
