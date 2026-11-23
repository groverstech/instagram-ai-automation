import "server-only";
import { and, count, eq, gt, inArray, lt } from "drizzle-orm";
import { getDb, schema } from "../db/client";

/**
 * Background-job health for monitoring (launch gate O4): what an uptime monitor should alert on.
 *   overdue   queued jobs whose run time passed more than 15 minutes ago: nothing is running the
 *             scheduler (worker down, cron not calling /api/cron/tick)
 *   stuck     jobs or AI tasks still "running" after 15 minutes of no progress
 *   dead24h   jobs that failed permanently in the last 24 hours (each one is also reported to the
 *             error monitor as `jobs.dead`)
 * Healthy when nothing is overdue or stuck. Dead jobs are reported but don't make it unhealthy:
 * the scheduler is working; a person needs to look at those jobs.
 */
export const JOB_LAG_MS = 15 * 60 * 1000;

export async function jobHealth(now = new Date()) {
  const db = await getDb();
  const lag = new Date(now.getTime() - JOB_LAG_MS);
  const day = new Date(now.getTime() - 24 * 3600 * 1000);
  const j = schema.jobs;
  const t = schema.aiTasks;
  const [[overdue], [stuckJobs], [dead], [stuckTasks], [queuedTasks]] = await Promise.all([
    db.select({ n: count() }).from(j).where(and(eq(j.status, "queued"), lt(j.runAt, lag))),
    db.select({ n: count() }).from(j).where(and(eq(j.status, "running"), lt(j.lockedAt, lag))),
    db.select({ n: count() }).from(j).where(and(eq(j.status, "failed"), gt(j.runAt, day))),
    db.select({ n: count() }).from(t).where(and(eq(t.status, "running"), lt(t.heartbeatAt, lag))),
    db.select({ n: count() }).from(t).where(and(inArray(t.status, ["queued"]), lt(t.runAfter, lag))),
  ]);
  const out = { overdue: overdue.n + queuedTasks.n, stuck: stuckJobs.n + stuckTasks.n, dead24h: dead.n };
  return { ok: out.overdue === 0 && out.stuck === 0, ...out };
}
