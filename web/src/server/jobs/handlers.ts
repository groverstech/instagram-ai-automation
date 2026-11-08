import "server-only";
import { and, eq, gte } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { publishPost, syncMetrics } from "../social/service";
import { runDueJobs, enqueue } from "./queue";

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

let lastSyncPlan = 0;

/** One scheduler tick: run due jobs and plan metric syncs every 6h for brands with accounts. */
export async function tick() {
  if (Date.now() - lastSyncPlan > 6 * 3600 * 1000) {
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
  // Persistent AI jobs (strategist, creative studio) live in ai_tasks: pick up queued/abandoned ones.
  await import("./all").then((m) => m.recoverDueTasks()).catch((e) => console.error("[jobs] recovery failed", e));
  return runDueJobs(handlers);
}
