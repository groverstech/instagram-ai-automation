import "server-only";
import { and, eq, gte } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { markPublishInterrupted, publishPost, syncMetrics } from "../social/service";
import { isUnsettled, latestAttempt, reconcilePost } from "../social/publish-ledger";
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
    const postId = String(payload.postId);
    const post = await markPublishInterrupted(postId);
    if (!post) {
      log.warn("jobs.publish_interrupted", { postId, flaggedForCheck: false });
      return false;
    }
    // Publish ledger (PR 4.4a): check the platform instead of leaving it to a person where possible.
    const last = await latestAttempt(postId);
    // No ledger rows at all: a publish from before the ledger existed (or one that never recorded
    // its attempt) can't be told apart, so it stays flagged for a person to check the account.
    if (!last) {
      log.warn("jobs.publish_interrupted", { postId, flaggedForCheck: true, ledger: false });
      return true;
    }
    if (!isUnsettled(last)) {
      // Earlier attempts are all settled, and this one was interrupted after the claim but before
      // its attempt was recorded (attempts are recorded before anything is sent): nothing was sent.
      const db = await getDb();
      await db.update(schema.posts).set({ publishError: "The publish was interrupted before anything was sent. You can publish it again." }).where(eq(schema.posts.id, postId));
      log.warn("jobs.publish_interrupted", { postId, flaggedForCheck: false, sent: false });
      return true;
    }
    const check = await reconcilePost(postId);
    log.warn("jobs.publish_interrupted", { postId, flaggedForCheck: check.state !== "published" && check.state !== "not_published", check: check.state });
    return check.state === "published" ? "resolved" : true;
  },
  // sync_metrics only reads from platforms and overwrites snapshots: safe to simply run again.
};

let lastSyncPlan = 0;
let lastRetention = 0;

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
  // Audit-log retention, once a day per process (idempotent, so several instances are harmless).
  if (scope.jobs && Date.now() - lastRetention > 24 * 3600 * 1000) {
    lastRetention = Date.now();
    await import("../audit").then((m) => m.purgeExpiredAuditEvents()).catch((e) => log.error("audit.retention_failed", { error: e instanceof Error ? e.message : String(e) }));
  }
  // Autonomy (docs/AUTONOMY.md): the AI's own complete drafts are scheduled within the brand's
  // rules or sent to a person. Does nothing unless AUTONOMOUS_PUBLISHING=on.
  if (scope.jobs) {
    await import("../autonomy/service").then((m) => m.autonomyTick()).catch((e) => log.error("autonomy.tick_failed", { error: e instanceof Error ? e.message : String(e) }));
  }
  if (scope.ai) {
    await import("./all").then((m) => m.recoverDueTasks()).catch((e) => log.error("jobs.ai_recovery_failed", { error: e instanceof Error ? e.message : String(e) }));
  }
  return scope.jobs ? runDueJobs(handlers, 10, interruptedHooks) : [];
}
