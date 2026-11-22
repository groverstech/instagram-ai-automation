import "server-only";
import { and, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import type { AiTask, AiTaskStep, Brand } from "../db/schema";
import { admitBackgroundAi, planOf } from "../ai-guard";
import { isTransient } from "../ai/llm";
import { friendlyAIError } from "../ai/llm";
import { RateLimitError, acquireAiSlot, releaseAiSlot, renewAiSlot } from "../ratelimit";
import type { BrandAccess } from "../auth/guard";
import { log } from "../log";

/**
 * Persistent AI job engine (ai_tasks). Used by the Marketing Strategist and the Creative Studio.
 *
 *  - enqueueJob admits the work once (quota → rate limit → concurrency lease) and inserts a
 *    `queued` task; an optional lock key makes "one live job per X" atomic.
 *  - Any process can run a job: right after the request (`after`), the scheduler tick, the worker,
 *    the cron route, server start or a status poll. A worker must claim it first with one
 *    conditional UPDATE that sets a fresh claim token, so two workers never run one job.
 *  - Heartbeats and writes check the claim token; a worker that lost its claim stops.
 *  - Handlers make steps idempotent (rows stamped with the task id), so a recovered job skips
 *    finished work and never pays for it twice.
 *  - Transient AI-service failures retry with exponential backoff up to max_attempts.
 *  - Recovery never re-charges rate limits or quota; it only needs a concurrency slot.
 */

export const STALE_TASK_MS = 2 * 60 * 1000;
const LEASE_SEC = 15 * 60;
const HEARTBEAT_MS = 20_000;
const RETRY_BASE_MS = 30_000;

/** An error whose message is safe and useful to show to users as-is. */
export class UserFacingError extends Error {}
/** The worker no longer owns its job (another worker took over). */
export class LostClaimError extends Error {}

export type JobInput = { leaseId?: string | null } & Record<string, unknown>;
export type JobOutcome = "claimed_elsewhere" | "waiting_for_slot" | "succeeded" | "failed" | "retrying" | "lost_claim" | "no_handler";

export type JobCtx = {
  task: AiTask;
  taskId: string;
  token: string;
  brand: Brand;
  steps: AiTaskStep[];
  isLost(): boolean;
  /** Persist progress (steps) while still owning the job. */
  save(): Promise<boolean>;
  /** Append steps discovered while running (e.g. one per creative after concepts). Idempotent by id. */
  addSteps(steps: AiTaskStep[]): Promise<void>;
};

export type JobHandler = {
  /** Log prefix, e.g. "strategist". */
  name: string;
  /** Run one step. Throw to fail it; throw LostClaimError if a write found the claim gone. */
  runStep(step: AiTaskStep, ctx: JobCtx): Promise<void>;
  /** Shown when the job gives up after repeated interruptions. */
  interruptedMessage?: string;
};

const handlers = new Map<string, JobHandler>();
export function registerJobKind(kinds: string[], handler: JobHandler) {
  for (const k of kinds) handlers.set(k, handler);
}

/**
 * A job that is running with a live worker, or that a worker will pick up (queued, or running
 * with a dead worker but attempts left). Such a job blocks duplicate starts.
 */
export function isLiveTask(t: { status: string; heartbeatAt: Date | null; createdAt: Date; attempts: number; maxAttempts: number }) {
  if (t.status === "queued") return t.attempts < t.maxAttempts;
  if (t.status !== "running") return false;
  const fresh = Date.now() - (t.heartbeatAt ?? t.createdAt).getTime() <= STALE_TASK_MS;
  return fresh || t.attempts < t.maxAttempts;
}

export function jobErrorMessage(e: unknown): string {
  if (e instanceof UserFacingError) return e.message;
  const ai = friendlyAIError(e);
  if (ai) return ai;
  if (e instanceof Error && e.name === "ZodError") return "The AI returned output in an unexpected shape. Please try again.";
  return "Something went wrong while running this step. Please try again.";
}

/** Run after the response when inside a request (keeps serverless functions alive), else now. */
export function schedule(fn: () => Promise<unknown>) {
  const safeFn = () => fn().catch((e) => log.error("jobs.task_crashed", { error: e instanceof Error ? e.message : String(e) }));
  import("next/server")
    .then(({ after }) => {
      try {
        after(safeFn);
      } catch {
        void safeFn();
      }
    })
    .catch(() => void safeFn());
}

/**
 * Admit and enqueue a job. With `lockKey`, at most one live job may exist per key (atomic).
 * Returns the task id; the job starts right after the response (or inline for tests).
 */
export async function enqueueJob(
  access: BrandAccess,
  job: { kind: string; steps: AiTaskStep[]; input?: Record<string, unknown>; strategyId?: string | null; lockKey?: string; busyMessage?: string; inline?: boolean },
) {
  const brandId = access.brand.id;
  const leaseId = await admitBackgroundAi(access, "ai_heavy", job.kind, LEASE_SEC);
  const db = await getDb();
  let taskId: string;
  try {
    taskId = await db.transaction(async (tx) => {
      if (job.lockKey) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"job-lock:" + job.lockKey}))`);
        const open = await tx
          .select()
          .from(schema.aiTasks)
          .where(
            and(
              eq(schema.aiTasks.brandId, brandId),
              inArray(schema.aiTasks.status, ["queued", "running"]),
              job.strategyId ? or(sql`${schema.aiTasks.input}->>'lockKey' = ${job.lockKey}`, eq(schema.aiTasks.strategyId, job.strategyId)) : sql`${schema.aiTasks.input}->>'lockKey' = ${job.lockKey}`,
            ),
          );
        if (open.some(isLiveTask)) throw new UserFacingError(job.busyMessage ?? "This job is already running.");
      }
      const [t] = await tx
        .insert(schema.aiTasks)
        .values({ brandId, workspaceId: access.brand.workspaceId, userId: access.session.user.id, kind: job.kind, strategyId: job.strategyId ?? null, steps: job.steps, input: { ...(job.input ?? {}), lockKey: job.lockKey ?? null, leaseId }, heartbeatAt: new Date() })
        .returning({ id: schema.aiTasks.id });
      return t.id;
    });
  } catch (e) {
    await releaseAiSlot(leaseId);
    throw e;
  }
  if (job.inline) await runJob(taskId);
  else schedule(() => runJob(taskId));
  return taskId;
}

/** Recompute a task's token, search and cost totals from its agent runs (single source of truth). */
export async function refreshTaskUsage(taskId: string) {
  const db = await getDb();
  const [u] = await db
    .select({
      inTok: sql<number>`coalesce(sum((${schema.agentRuns.usage}->>'inputTokens')::numeric), 0)`,
      outTok: sql<number>`coalesce(sum((${schema.agentRuns.usage}->>'outputTokens')::numeric), 0)`,
      searches: sql<number>`coalesce(sum((${schema.agentRuns.usage}->>'webSearches')::numeric), 0)`,
      cost: sql<number>`coalesce(sum(${schema.agentRuns.costUsd}), 0)`,
    })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.taskId, taskId));
  await db
    .update(schema.aiTasks)
    .set({ inputTokens: Number(u.inTok), outputTokens: Number(u.outTok), webSearches: Number(u.searches), costUsd: Number(u.cost) })
    .where(eq(schema.aiTasks.id, taskId));
}

async function claim(taskId: string): Promise<(AiTask & { token: string }) | null> {
  const db = await getDb();
  const token = crypto.randomUUID();
  const stale = new Date(Date.now() - STALE_TASK_MS);
  const [t] = await db
    .update(schema.aiTasks)
    .set({ status: "running", claimToken: token, attempts: sql`${schema.aiTasks.attempts} + 1`, heartbeatAt: new Date(), startedAt: sql`coalesce(${schema.aiTasks.startedAt}, now())`, error: null })
    .where(
      and(
        eq(schema.aiTasks.id, taskId),
        lt(schema.aiTasks.attempts, schema.aiTasks.maxAttempts),
        lte(schema.aiTasks.runAfter, new Date()),
        or(eq(schema.aiTasks.status, "queued"), and(eq(schema.aiTasks.status, "running"), lt(schema.aiTasks.heartbeatAt, stale))),
      ),
    )
    .returning();
  return t ? { ...t, token } : null;
}

/** Update the task only while this worker still owns it. Returns false if the claim was lost. */
async function save(taskId: string, token: string, set: Partial<typeof schema.aiTasks.$inferInsert>) {
  const db = await getDb();
  const r = await db
    .update(schema.aiTasks)
    .set({ heartbeatAt: new Date(), ...set })
    .where(and(eq(schema.aiTasks.id, taskId), eq(schema.aiTasks.claimToken, token)))
    .returning({ id: schema.aiTasks.id });
  return r.length > 0;
}

/** Check, inside a write transaction, that a worker still owns its job (locks the task row). */
export async function assertClaim(tx: { select: Awaited<ReturnType<typeof getDb>>["select"] }, taskId: string, token: string) {
  const [t] = await tx.select({ token: schema.aiTasks.claimToken }).from(schema.aiTasks).where(eq(schema.aiTasks.id, taskId)).for("update");
  if (t?.token !== token) throw new LostClaimError("This job is now owned by another worker.");
}

/** Agent runs left "running" by a dead worker: close them as usage-unknown (the provider may have billed them). */
async function closeOrphanRuns(taskId: string) {
  const db = await getDb();
  await db
    .update(schema.agentRuns)
    .set({ status: "failed", error: "Interrupted: the worker stopped while this request was in flight. The provider may have processed and billed it; its usage is unknown.", usage: { unknownUsageAttempts: 1 }, finishedAt: new Date() })
    .where(and(eq(schema.agentRuns.taskId, taskId), eq(schema.agentRuns.status, "running")));
}

async function ensureLease(t: AiTask, token: string): Promise<string | null> {
  const db = await getDb();
  const input = t.input as JobInput;
  if (input.leaseId) {
    const [l] = await db.select({ id: schema.aiTaskLeases.id }).from(schema.aiTaskLeases).where(eq(schema.aiTaskLeases.id, input.leaseId));
    if (l) {
      await renewAiSlot(l.id, LEASE_SEC);
      return l.id;
    }
  }
  try {
    const leaseId = await acquireAiSlot({ userId: t.userId, workspaceId: t.workspaceId, plan: await planOf(t.workspaceId) }, t.kind, LEASE_SEC);
    await save(t.id, token, { input: { ...input, leaseId } });
    return leaseId;
  } catch (e) {
    if (e instanceof RateLimitError) return null;
    throw e;
  }
}

/**
 * Claim and run a job. Safe to call from anywhere, any number of times: only one caller wins
 * the claim. Returns what happened, for logs and tests.
 */
export async function runJob(taskId: string): Promise<JobOutcome> {
  const db = await getDb();
  const [peek] = await db.select({ kind: schema.aiTasks.kind }).from(schema.aiTasks).where(eq(schema.aiTasks.id, taskId));
  const handler = peek ? handlers.get(peek.kind) : undefined;
  if (!handler) return "no_handler";
  const t = await claim(taskId);
  if (!t) return "claimed_elsewhere";
  const token = t.token;
  if (t.attempts > 1) {
    await closeOrphanRuns(taskId);
    log.info(`${handler.name}.task_recovered`, { taskId, attempt: t.attempts });
  }
  const leaseId = await ensureLease(t, token);
  if (!leaseId) {
    // The user is at their concurrency limit right now: put the job back, without using up an attempt.
    await save(taskId, token, { status: "queued", claimToken: null, attempts: t.attempts - 1, runAfter: new Date(Date.now() + 15_000) });
    return "waiting_for_slot";
  }

  let lost = false;
  const beat = setInterval(() => {
    void save(taskId, token, {}).then((ok) => {
      if (!ok) lost = true;
    });
    void renewAiSlot(leaseId, LEASE_SEC);
  }, HEARTBEAT_MS);
  beat.unref?.();

  const steps: AiTaskStep[] = t.steps.map((s) => (s.status === "failed" || s.status === "skipped" || s.status === "running" ? { ...s, status: "pending", error: undefined } : { ...s }));
  let outcome: JobOutcome = "succeeded";
  try {
    const [brand] = await db.select().from(schema.brands).where(eq(schema.brands.id, t.brandId));
    if (!brand) throw new UserFacingError("Brand not found.");
    const ctx: JobCtx = {
      task: t,
      taskId,
      token,
      brand,
      steps,
      isLost: () => lost,
      save: () => save(taskId, token, { steps }),
      addSteps: async (more) => {
        for (const s of more) if (!steps.some((x) => x.id === s.id)) steps.push(s);
        await save(taskId, token, { steps });
      },
    };
    // Steps may be appended while running, so iterate by index.
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.status === "done") continue;
      if (lost) return (outcome = "lost_claim");
      step.status = "running";
      step.startedAt = new Date().toISOString();
      if (!(await save(taskId, token, { steps }))) return (outcome = "lost_claim");
      try {
        await handler.runStep(step, ctx);
        if (lost) return (outcome = "lost_claim");
        step.status = "done";
        step.finishedAt = new Date().toISOString();
        await save(taskId, token, { steps });
      } catch (e) {
        if (e instanceof LostClaimError) return (outcome = "lost_claim");
        // Only failures that can clear by themselves are retried later (ai/errors.ts isTransient).
        const retry = isTransient(e) && !(e instanceof UserFacingError) && t.attempts < t.maxAttempts;
        log.error(`${handler.name}.step_failed`, { taskId, step: step.id, attempt: t.attempts, retry, error: e instanceof Error ? e.message : String(e) });
        if (retry) {
          const delay = RETRY_BASE_MS * 2 ** (t.attempts - 1);
          step.status = "pending";
          step.error = "Temporary AI service problem; retrying automatically.";
          await save(taskId, token, { status: "queued", claimToken: null, steps, runAfter: new Date(Date.now() + delay), error: `${jobErrorMessage(e).replace(/\s*Please try again[^.]*\.$/, "")} Retrying automatically (attempt ${t.attempts + 1} of ${t.maxAttempts}).` });
          setTimeout(() => void runJob(taskId).catch(() => {}), delay + 500).unref?.();
          return (outcome = "retrying");
        }
        step.status = "failed";
        step.error = jobErrorMessage(e);
        step.finishedAt = new Date().toISOString();
        for (const s of steps) if (s.status === "pending") s.status = "skipped";
        await save(taskId, token, { status: "failed", steps, error: step.error, finishedAt: new Date(), claimToken: null });
        return (outcome = "failed");
      }
    }
    await save(taskId, token, { status: "succeeded", steps, finishedAt: new Date(), claimToken: null, error: null });
    return outcome;
  } catch (e) {
    await save(taskId, token, { status: "failed", steps, error: jobErrorMessage(e), finishedAt: new Date(), claimToken: null });
    return (outcome = "failed");
  } finally {
    clearInterval(beat);
    // A retrying job gives its slot back while it waits; a lost claim means another worker has it.
    if (outcome !== "lost_claim") await releaseAiSlot(leaseId);
    await refreshTaskUsage(taskId).catch(() => {});
  }
}

const inFlight = new Set<string>();

/**
 * Find jobs that need a worker (queued and due, or running with a dead worker) and run them.
 * Jobs whose kind has no handler in this process are left for a process that has one.
 */
/** AI tasks this process is running right now (used to drain a worker on shutdown). */
export function inFlightCount() {
  return inFlight.size;
}

export async function recoverDueTasks(opts: { wait?: boolean } = {}) {
  const db = await getDb();
  const now = new Date();
  const stale = new Date(now.getTime() - STALE_TASK_MS);
  const due = await db
    .select()
    .from(schema.aiTasks)
    .where(or(and(eq(schema.aiTasks.status, "queued"), lte(schema.aiTasks.runAfter, now)), and(eq(schema.aiTasks.status, "running"), lt(schema.aiTasks.heartbeatAt, stale))))
    .limit(20);
  const started: Promise<unknown>[] = [];
  for (const t of due) {
    if (!handlers.has(t.kind)) continue;
    if (t.attempts >= t.maxAttempts) {
      await giveUp(t);
      continue;
    }
    if (inFlight.has(t.id)) continue;
    inFlight.add(t.id);
    started.push(runJob(t.id).catch((e) => log.error("jobs.recover_failed", { taskId: t.id, error: e instanceof Error ? e.message : String(e) })).finally(() => inFlight.delete(t.id)));
  }
  if (opts.wait) await Promise.all(started);
  return due.length;
}

async function giveUp(t: AiTask) {
  const db = await getDb();
  const steps = t.steps.map((s) => (s.status === "running" ? { ...s, status: "failed" as const, error: "Interrupted" } : s.status === "pending" ? { ...s, status: "skipped" as const } : s));
  const error =
    t.status === "queued"
      ? (t.error ?? "The AI service kept failing.") + " Gave up after the maximum number of attempts; resume to try again."
      : (handlers.get(t.kind)?.interruptedMessage ?? "The task was interrupted repeatedly and stopped. Completed work was saved; resume to finish the rest.");
  const [done] = await db
    .update(schema.aiTasks)
    .set({ status: "failed", steps, error, finishedAt: new Date(), claimToken: null })
    .where(and(eq(schema.aiTasks.id, t.id), inArray(schema.aiTasks.status, ["queued", "running"])))
    .returning({ id: schema.aiTasks.id });
  if (!done) return;
  const leaseId = (t.input as JobInput).leaseId;
  if (leaseId) await releaseAiSlot(leaseId);
  await closeOrphanRuns(t.id);
  await refreshTaskUsage(t.id);
}

/** Job progress for the UI (brand-scoped). A due or abandoned job is (re)started from here too. */
export async function jobStatus(brandId: string, taskId: string, notFound: () => Error) {
  const db = await getDb();
  const [t] = await db.select().from(schema.aiTasks).where(and(eq(schema.aiTasks.id, taskId), eq(schema.aiTasks.brandId, brandId)));
  if (!t) throw notFound();
  const stale = t.status === "running" && Date.now() - (t.heartbeatAt ?? t.createdAt).getTime() > STALE_TASK_MS;
  const due = t.status === "queued" && t.runAfter.getTime() <= Date.now() && Date.now() - t.createdAt.getTime() > 5_000;
  if ((stale || due) && handlers.has(t.kind)) {
    if (t.attempts >= t.maxAttempts) {
      await giveUp(t);
      const [after] = await db.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, taskId));
      return { ...after, recovering: false };
    }
    if (!inFlight.has(t.id)) {
      inFlight.add(t.id);
      schedule(() => runJob(t.id).finally(() => inFlight.delete(t.id)));
    }
    return { ...t, recovering: true };
  }
  return { ...t, recovering: false };
}
