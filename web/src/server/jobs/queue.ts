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

/** Claim and run due jobs. Safe to call concurrently: claim is a single conditional UPDATE. */
export async function runDueJobs(handlers: Record<string, Handler>, limit = 10) {
  const db = await getDb();
  const staleLock = new Date(Date.now() - 10 * 60 * 1000);
  const due = await db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(and(lte(schema.jobs.runAt, new Date()), sql`(${schema.jobs.status} = 'queued' or (${schema.jobs.status} = 'running' and ${schema.jobs.lockedAt} < ${staleLock}))`))
    .limit(limit);
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const { id } of due) {
    const [job] = await db
      .update(schema.jobs)
      .set({ status: "running", lockedAt: new Date(), attempts: sql`${schema.jobs.attempts} + 1` })
      .where(and(eq(schema.jobs.id, id), sql`(${schema.jobs.status} = 'queued' or ${schema.jobs.lockedAt} < ${staleLock})`))
      .returning();
    if (!job) continue;
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
