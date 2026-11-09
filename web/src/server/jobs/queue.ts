import "server-only";
import { and, eq, lte, sql, inArray } from "drizzle-orm";
import { getDb, schema } from "../db/client";

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

/** Claim and run due jobs. Safe to call concurrently: claim is a single conditional UPDATE. */
export async function runDueJobs(handlers: Record<string, Handler>, limit = 10, onInterrupted: Record<string, InterruptedHook> = {}) {
  const db = await getDb();
  const staleLock = new Date(Date.now() - 10 * 60 * 1000);
  const due = await db
    .select({ id: schema.jobs.id, status: schema.jobs.status })
    .from(schema.jobs)
    .where(and(lte(schema.jobs.runAt, new Date()), sql`(${schema.jobs.status} = 'queued' or (${schema.jobs.status} = 'running' and ${schema.jobs.lockedAt} < ${staleLock}))`))
    .limit(limit);
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const { id, status: before } of due) {
    const [job] = await db
      .update(schema.jobs)
      .set({ status: "running", lockedAt: new Date(), attempts: sql`${schema.jobs.attempts} + 1` })
      .where(and(eq(schema.jobs.id, id), sql`(${schema.jobs.status} = 'queued' or ${schema.jobs.lockedAt} < ${staleLock})`))
      .returning();
    if (!job) continue;
    // Re-claimed from a worker that stopped mid-run: let the type decide whether re-running is safe.
    const interrupted = before === "running" ? onInterrupted[job.type] : undefined;
    if (interrupted && (await interrupted(job.payload).catch(() => true))) {
      await db.update(schema.jobs).set({ status: "failed", lastError: "Interrupted; not retried automatically (outcome unknown).", lockedAt: null }).where(eq(schema.jobs.id, id));
      results.push({ id, ok: false, error: "interrupted" });
      continue;
    }
    const handler = handlers[job.type];
    try {
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      await handler(job.payload);
      await db.update(schema.jobs).set({ status: "done", lockedAt: null }).where(eq(schema.jobs.id, id));
      results.push({ id, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retry = job.attempts < job.maxAttempts;
      await db
        .update(schema.jobs)
        .set({ status: retry ? "queued" : "failed", lastError: msg, lockedAt: null, runAt: new Date(Date.now() + 60_000 * job.attempts) })
        .where(eq(schema.jobs.id, id));
      results.push({ id, ok: false, error: msg });
    }
  }
  return results;
}
