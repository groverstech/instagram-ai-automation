import "server-only";
import { and, asc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { log } from "../log";

export type JobType = "publish_post" | "sync_metrics";

export async function enqueue(type: JobType, payload: Record<string, unknown>, runAt = new Date()) {
  const db = await getDb();
  const [job] = await db.insert(schema.jobs).values({ type, payload, runAt }).returning({ id: schema.jobs.id });
  return job.id;
}

export async function cancelJobs(type: JobType, match: (p: Record<string, unknown>) => boolean) {
  const db = await getDb();
  const queued = await db.select().from(schema.jobs).where(and(eq(schema.jobs.type, type), eq(schema.jobs.status, "queued")));
  const ids = queued.filter((j) => match(j.payload)).map((j) => j.id);
  if (ids.length) await db.delete(schema.jobs).where(inArray(schema.jobs.id, ids));
}

type Handler = (payload: Record<string, unknown>) => Promise<unknown>;

/**
 * Optional per-type hook for a job whose previous run was interrupted (its worker stopped
 * holding the lock: crash, deploy, kill). Return true to skip re-running it. Used for jobs with
 * external side effects that can't be safely repeated without checking first (publishing).
 */
export type InterruptedHook = (payload: Record<string, unknown>) => Promise<boolean>;

/** A lock older than this means the worker holding it stopped (crash, deploy, kill). */
export const STALE_LOCK_MS = 10 * 60 * 1000;

/**
 * Jobs a runner may claim at `now`: due, and either queued or held by a worker that stopped.
 *
 * Every comparison uses Drizzle's column operators, never a raw `sql` fragment with a value in it:
 * the operators encode a Date for its timestamp column, whereas a raw fragment hands the Date to the
 * driver as is. PGlite accepts that; the production driver (postgres.js) rejects it with
 * "Received an instance of Date", which stopped every jobs tick on Postgres (FOLLOW_UPS F13).
 */
function claimable(now: Date) {
  const staleLock = new Date(now.getTime() - STALE_LOCK_MS);
  return and(
    lte(schema.jobs.runAt, now),
    or(eq(schema.jobs.status, "queued"), and(eq(schema.jobs.status, "running"), lt(schema.jobs.lockedAt, staleLock))),
  );
}

/**
 * Claim and run due jobs, oldest first. Safe to call concurrently (several workers, the in-process
 * scheduler and the cron route at once): each job is claimed with one conditional UPDATE, so only
 * one runner gets it. The claim's `lockedAt` identifies the runner that holds it: the job's outcome
 * is written only while that lock is still in place, so a runner whose job was re-claimed after the
 * stale-lock window can't overwrite what the new owner records.
 */
export async function runDueJobs(handlers: Record<string, Handler>, limit = 10, onInterrupted: Record<string, InterruptedHook> = {}) {
  const db = await getDb();
  const due = await db
    .select({ id: schema.jobs.id, status: schema.jobs.status })
    .from(schema.jobs)
    .where(claimable(new Date()))
    .orderBy(asc(schema.jobs.runAt))
    .limit(limit);
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const { id, status: before } of due) {
    const now = new Date();
    const [job] = await db
      .update(schema.jobs)
      .set({ status: "running", lockedAt: now, attempts: sql`${schema.jobs.attempts} + 1` })
      // Re-checked here: another runner may have claimed, finished or re-scheduled it since the select.
      .where(and(eq(schema.jobs.id, id), claimable(now)))
      .returning();
    if (!job) continue;
    const held = and(eq(schema.jobs.id, id), eq(schema.jobs.status, "running"), eq(schema.jobs.lockedAt, now));
    /** Record the outcome if this runner still holds the job; false if another runner took it over. */
    const settle = async (set: Partial<typeof schema.jobs.$inferInsert>) => (await db.update(schema.jobs).set({ ...set, lockedAt: null }).where(held).returning({ id: schema.jobs.id })).length > 0;
    // Re-claimed from a worker that stopped mid-run: let the type decide whether re-running is safe.
    const interrupted = before === "running" ? onInterrupted[job.type] : undefined;
    if (interrupted && (await interrupted(job.payload).catch(() => true))) {
      await settle({ status: "failed", lastError: "Interrupted; not retried automatically (outcome unknown)." });
      results.push({ id, ok: false, error: "interrupted" });
      continue;
    }
    // The handler's own failure decides retry or failure. A failure to record the outcome is not a
    // handler failure: it propagates (the tick fails and is logged) and the job stays locked until
    // the stale-lock window, rather than re-queuing work that already succeeded.
    let error: string | null = null;
    try {
      const handler = handlers[job.type];
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      await handler(job.payload);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const retry = job.attempts < job.maxAttempts;
    const kept =
      error === null
        ? await settle({ status: "done" })
        : await settle({ status: retry ? "queued" : "failed", lastError: error, runAt: new Date(Date.now() + 60_000 * job.attempts) });
    if (!kept) {
      log.warn("jobs.claim_lost", { id, type: job.type, attempt: job.attempts });
      results.push({ id, ok: false, error: "claim lost" });
      continue;
    }
    if (error !== null) log.warn("jobs.job_failed", { id, type: job.type, attempt: job.attempts, willRetry: retry, error });
    results.push(error === null ? { id, ok: true } : { id, ok: false, error });
  }
  return results;
}
