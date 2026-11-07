import "server-only";
import { and, desc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import type { AiTask, AiTaskStep, Brand } from "../db/schema";
import { admitBackgroundAi } from "../ai-guard";
import { friendlyAIError, isServiceError } from "../ai/llm";
import { RateLimitError, acquireAiSlot, releaseAiSlot, renewAiSlot } from "../ratelimit";
import { planOf } from "../ai-guard";
import type { BrandAccess } from "../auth/guard";
import { log } from "../log";
import { SECTION_KEYS, SECTION_META, missingSections, type SectionKey } from "@/lib/strategy";
import { SECTION_RUNNERS, regenerateEntry, type AgentCtx } from "./agents";
import { STALE_TASK_MS, StrategyError, activeTask, docOf, getStrategy, isLiveTask, replaceEntryFromAi, writeAiSection } from "./store";

/**
 * Strategist jobs are persistent rows in ai_tasks.
 *
 *  - startTask admits the work (quota → rate limit → concurrency lease) and inserts a `queued` task.
 *  - Any process can run it: right after the request (Next.js `after`), the in-process scheduler /
 *    `npm run worker` / `/api/cron/tick` (recoverDueTasks), or a status poll from the page.
 *  - A worker must **claim** the task first: a single conditional UPDATE that sets a fresh
 *    claim token. Only queued tasks whose run_after has passed, or running tasks whose worker
 *    stopped heartbeating, can be claimed, so two workers never run one task at the same time.
 *  - Heartbeats and section writes check the claim token; a worker that lost its claim stops
 *    without writing.
 *  - Sections record the task that generated them, so a recovered task skips steps it already
 *    finished: completed AI work is never paid for twice.
 *  - Transient AI-service failures (network, 429, 5xx) are retried automatically with backoff,
 *    up to max_attempts. Unusable-output and configuration errors fail the task (resumable).
 *  - Recovery never re-charges rate limits or quota; it only needs a concurrency slot.
 */

const LEASE_SEC = 15 * 60;
const HEARTBEAT_MS = 20_000;
const RETRY_BASE_MS = 30_000;

export type StartOpts = { sections: SectionKey[]; instruction?: string; kind?: string };
type TaskInput = { sections?: SectionKey[]; instruction?: string; leaseId?: string | null };

export async function startTask(access: BrandAccess, strategyId: string, opts: StartOpts & { inline?: boolean }) {
  const brandId = access.brand.id;
  const row = await getStrategy(brandId, strategyId);
  if (!row) throw new StrategyError("Strategy not found.");
  if (row.status !== "draft" && row.status !== "under_review") throw new StrategyError(row.status === "approved" ? "This strategy is approved and locked. Create a new version to regenerate sections." : "This strategy is archived.");
  docOf(row);
  const sections = SECTION_KEYS.filter((k) => opts.sections.includes(k));
  if (!sections.length) throw new StrategyError("Nothing to generate.");

  const leaseId = await admitBackgroundAi(access, "ai_heavy", "strategy_workflow", LEASE_SEC);
  const db = await getDb();
  let taskId: string;
  try {
    const steps: AiTaskStep[] = sections.map((k) => ({ id: k, label: SECTION_META[k].step, status: "pending" }));
    // Check-and-insert under a per-strategy lock, so two clicks can't start two tasks on one strategy.
    taskId = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"strategy-task:" + strategyId}))`);
      const open = await tx.select().from(schema.aiTasks).where(and(eq(schema.aiTasks.brandId, brandId), eq(schema.aiTasks.strategyId, strategyId), inArray(schema.aiTasks.status, ["queued", "running"])));
      if (open.some(isLiveTask)) throw new StrategyError("The AI is already working on this strategy.");
      const [t] = await tx
        .insert(schema.aiTasks)
        .values({ brandId, workspaceId: access.brand.workspaceId, userId: access.session.user.id, kind: opts.kind ?? "strategy_workflow", strategyId, steps, input: { sections, instruction: opts.instruction?.slice(0, 1000) ?? "", leaseId }, heartbeatAt: new Date() })
        .returning({ id: schema.aiTasks.id });
      return t.id;
    });
  } catch (e) {
    await releaseAiSlot(leaseId);
    throw e;
  }
  if (opts.inline) await runTask(taskId);
  else schedule(() => runTask(taskId));
  return taskId;
}

/** Run after the response when inside a request (keeps serverless functions alive), else now. */
function schedule(fn: () => Promise<unknown>) {
  const safeFn = () => fn().catch((e) => log.error("strategist.task_crashed", { error: e instanceof Error ? e.message : String(e) }));
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

export function taskErrorMessage(e: unknown): string {
  if (e instanceof StrategyError) return e.message;
  const ai = friendlyAIError(e);
  if (ai) return ai;
  if (e instanceof Error && e.name === "ZodError") return "The AI returned output in an unexpected shape. Please try again.";
  return "Something went wrong while generating this section. Please try again.";
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

/** Claim a task for this worker. Returns the claimed row, or null if it isn't claimable now. */
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

async function owns(taskId: string, token: string) {
  const db = await getDb();
  const [t] = await db.select({ token: schema.aiTasks.claimToken }).from(schema.aiTasks).where(eq(schema.aiTasks.id, taskId));
  return t?.token === token;
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

/** Agent runs left "running" by a dead worker: close them so logs and totals are honest. */
async function closeOrphanRuns(taskId: string) {
  const db = await getDb();
  await db
    .update(schema.agentRuns)
    .set({ status: "failed", error: "Interrupted: the worker stopped during this run; no usage was reported.", finishedAt: new Date() })
    .where(and(eq(schema.agentRuns.taskId, taskId), eq(schema.agentRuns.status, "running")));
}

/** The concurrency slot for a (re)claimed task: keep the original lease if it's still held, else take a new one. */
async function ensureLease(t: AiTask, token: string): Promise<string | null> {
  const db = await getDb();
  const input = t.input as TaskInput;
  if (input.leaseId) {
    const [l] = await db.select({ id: schema.aiTaskLeases.id }).from(schema.aiTaskLeases).where(eq(schema.aiTaskLeases.id, input.leaseId));
    if (l) {
      await renewAiSlot(l.id, LEASE_SEC);
      return l.id;
    }
  }
  try {
    const leaseId = await acquireAiSlot({ userId: t.userId, workspaceId: t.workspaceId, plan: await planOf(t.workspaceId) }, "strategy_workflow", LEASE_SEC);
    await save(t.id, token, { input: { ...input, leaseId } });
    return leaseId;
  } catch (e) {
    if (e instanceof RateLimitError) return null;
    throw e;
  }
}

/**
 * Claim and run a task. Safe to call from anywhere, any number of times: only one caller wins
 * the claim. Returns what happened, for logs and tests.
 */
export async function runTask(taskId: string): Promise<"claimed_elsewhere" | "waiting_for_slot" | "succeeded" | "failed" | "retrying" | "lost_claim"> {
  const db = await getDb();
  const t = await claim(taskId);
  if (!t) return "claimed_elsewhere";
  const token = t.token;
  if (t.attempts > 1) {
    await closeOrphanRuns(taskId);
    log.info("strategist.task_recovered", { taskId, attempt: t.attempts });
  }
  const leaseId = await ensureLease(t, token);
  if (!leaseId) {
    // The user is at their concurrency limit right now: put the task back, without using up an attempt.
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
  const instruction = String((t.input as TaskInput).instruction ?? "");
  let outcome: Awaited<ReturnType<typeof runTask>> = "succeeded";
  try {
    const [brand] = await db.select().from(schema.brands).where(eq(schema.brands.id, t.brandId));
    if (!brand) throw new StrategyError("Brand not found.");
    for (const step of steps) {
      if (step.status === "done") continue;
      if (lost) return (outcome = "lost_claim");
      const key = step.id as SectionKey;
      const row = await getStrategy(t.brandId, t.strategyId!);
      if (!row) throw new StrategyError("The strategy was deleted.");
      const doc = docOf(row);
      // Written by this task before a crash, but the step wasn't marked done: don't pay for it again.
      if (doc.sections[key]?.taskId === taskId) {
        step.status = "done";
        step.finishedAt ??= new Date().toISOString();
        await save(taskId, token, { steps });
        continue;
      }
      step.status = "running";
      step.startedAt = new Date().toISOString();
      if (!(await save(taskId, token, { steps }))) return (outcome = "lost_claim");
      try {
        const ctx: AgentCtx = { scope: { brandId: t.brandId, userId: t.userId, taskId }, brand: brand as Brand, doc, strategyId: row.id, instruction: instruction || undefined, reviewerNote: row.revisionNote };
        const out = await SECTION_RUNNERS[key](ctx);
        if (lost || !(await owns(taskId, token))) return (outcome = "lost_claim");
        await writeAiSection(t.brandId, row.id, key, out.data as never, { runId: out.runIds.at(-1) ?? null, provider: out.provider, actorId: t.userId, taskId });
        step.status = "done";
        step.finishedAt = new Date().toISOString();
        await save(taskId, token, { steps });
      } catch (e) {
        const retry = isServiceError(e) && !(e instanceof StrategyError) && t.attempts < t.maxAttempts && !/rejected the API key|not configured/i.test(friendlyAIError(e) ?? "");
        log.error("strategist.step_failed", { taskId, step: key, attempt: t.attempts, retry, error: e instanceof Error ? e.message : String(e) });
        if (retry) {
          const delay = RETRY_BASE_MS * 2 ** (t.attempts - 1);
          step.status = "pending";
          step.error = "Temporary AI service problem; retrying automatically.";
          await save(taskId, token, { status: "queued", claimToken: null, steps, runAfter: new Date(Date.now() + delay), error: `${taskErrorMessage(e).replace(/\s*Please try again[^.]*\.$/, "")} Retrying automatically (attempt ${t.attempts + 1} of ${t.maxAttempts}).` });
          setTimeout(() => void runTask(taskId).catch(() => {}), delay + 500).unref?.();
          return (outcome = "retrying");
        }
        step.status = "failed";
        step.error = taskErrorMessage(e);
        step.finishedAt = new Date().toISOString();
        for (const s of steps) if (s.status === "pending") s.status = "skipped";
        await save(taskId, token, { status: "failed", steps, error: step.error, finishedAt: new Date(), claimToken: null });
        return (outcome = "failed");
      }
    }
    await save(taskId, token, { status: "succeeded", steps, finishedAt: new Date(), claimToken: null, error: null });
    return outcome;
  } catch (e) {
    await save(taskId, token, { status: "failed", steps, error: taskErrorMessage(e), finishedAt: new Date(), claimToken: null });
    return (outcome = "failed");
  } finally {
    clearInterval(beat);
    // A retrying task gives its slot back while it waits; a lost claim means another worker has it.
    if (outcome !== "lost_claim") await releaseAiSlot(leaseId);
    await refreshTaskUsage(taskId).catch(() => {});
  }
}

const inFlight = new Set<string>();

/**
 * Find tasks that need a worker (queued and due, or running with a dead worker) and run them.
 * Called by the scheduler tick, the worker, the cron route and on server start. Tasks that have
 * used all their attempts are failed permanently (the user can resume them).
 */
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
    if (t.attempts >= t.maxAttempts) {
      await giveUp(t);
      continue;
    }
    if (inFlight.has(t.id)) continue;
    inFlight.add(t.id);
    started.push(runTask(t.id).catch((e) => log.error("strategist.recover_failed", { taskId: t.id, error: e instanceof Error ? e.message : String(e) })).finally(() => inFlight.delete(t.id)));
  }
  if (opts.wait) await Promise.all(started);
  return due.length;
}

async function giveUp(t: AiTask) {
  const db = await getDb();
  const steps = t.steps.map((s) => (s.status === "running" ? { ...s, status: "failed" as const, error: "Interrupted" } : s.status === "pending" ? { ...s, status: "skipped" as const } : s));
  const error = t.status === "queued" ? (t.error ?? "The AI service kept failing.") + " Gave up after the maximum number of attempts; resume to try again." : "The task was interrupted repeatedly and stopped. Completed sections were saved; resume to finish the rest.";
  const [done] = await db
    .update(schema.aiTasks)
    .set({ status: "failed", steps, error, finishedAt: new Date(), claimToken: null })
    .where(and(eq(schema.aiTasks.id, t.id), inArray(schema.aiTasks.status, ["queued", "running"])))
    .returning({ id: schema.aiTasks.id });
  if (!done) return;
  const leaseId = (t.input as TaskInput).leaseId;
  if (leaseId) await releaseAiSlot(leaseId);
  await closeOrphanRuns(t.id);
  await refreshTaskUsage(t.id);
}

/** Task progress for the UI. A due or abandoned task is (re)started from here too. */
export async function taskStatus(brandId: string, taskId: string) {
  const db = await getDb();
  const [t] = await db.select().from(schema.aiTasks).where(and(eq(schema.aiTasks.id, taskId), eq(schema.aiTasks.brandId, brandId)));
  if (!t) throw new StrategyError("Task not found.");
  const stale = t.status === "running" && Date.now() - (t.heartbeatAt ?? t.createdAt).getTime() > STALE_TASK_MS;
  const due = t.status === "queued" && t.runAfter.getTime() <= Date.now() && Date.now() - t.createdAt.getTime() > 5_000;
  if (stale || due) {
    if (t.attempts >= t.maxAttempts) {
      await giveUp(t);
      const [after] = await db.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, taskId));
      return { ...after, recovering: false };
    }
    if (!inFlight.has(t.id)) {
      inFlight.add(t.id);
      schedule(() => runTask(t.id).finally(() => inFlight.delete(t.id)));
    }
    return { ...t, recovering: true };
  }
  return { ...t, recovering: false };
}

export async function latestTask(brandId: string, strategyId: string) {
  const db = await getDb();
  const [t] = await db.select().from(schema.aiTasks).where(and(eq(schema.aiTasks.brandId, brandId), eq(schema.aiTasks.strategyId, strategyId))).orderBy(desc(schema.aiTasks.createdAt)).limit(1);
  return t ? taskStatus(brandId, t.id) : null;
}

/** AI usage and estimated cost for a strategy: every agent run for it, including failed attempts. */
export async function strategyCost(brandId: string, strategyId: string) {
  const db = await getDb();
  const [r] = await db
    .select({
      cost: sql<number>`coalesce(sum(${schema.agentRuns.costUsd}), 0)`,
      inTok: sql<number>`coalesce(sum((${schema.agentRuns.usage}->>'inputTokens')::numeric), 0)`,
      outTok: sql<number>`coalesce(sum((${schema.agentRuns.usage}->>'outputTokens')::numeric), 0)`,
      searches: sql<number>`coalesce(sum((${schema.agentRuns.usage}->>'webSearches')::numeric), 0)`,
    })
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.brandId, brandId), sql`${schema.agentRuns.input}->>'strategyId' = ${strategyId}`));
  return { costUsd: Number(r?.cost ?? 0), inputTokens: Number(r?.inTok ?? 0), outputTokens: Number(r?.outTok ?? 0), webSearches: Number(r?.searches ?? 0) };
}

/** Sections a resumed workflow should (re)generate: anything missing. */
export async function resumeSections(brandId: string, strategyId: string): Promise<SectionKey[]> {
  const row = await getStrategy(brandId, strategyId);
  if (!row) throw new StrategyError("Strategy not found.");
  return missingSections(docOf(row));
}

/** Regenerate one calendar entry (short synchronous AI call; caller wraps it in guardedAi). */
export async function regenerateCalendarEntry(brand: Brand, userId: string, strategyId: string, entryId: string, instruction: string, expectRev: number) {
  const row = await getStrategy(brand.id, strategyId);
  if (!row) throw new StrategyError("Strategy not found.");
  if (row.status !== "draft" && row.status !== "under_review") throw new StrategyError("This strategy is locked. Create a new version to change it.");
  if (row.rev !== expectRev) throw new StrategyError("This strategy was changed since you opened it. Reload to see the latest version.");
  if (await activeTask(brand.id, strategyId)) throw new StrategyError("The AI is still working on this strategy.");
  const doc = docOf(row);
  const entry = doc.sections.calendar?.data.entries.find((e) => e.id === entryId);
  if (!entry) throw new StrategyError("Entry not found.");
  const out = await regenerateEntry({ scope: { brandId: brand.id, userId }, brand, doc, strategyId }, entry, instruction.slice(0, 500));
  return replaceEntryFromAi(brand.id, strategyId, userId, out.data, out.runIds[0]);
}
