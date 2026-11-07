import "server-only";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import type { AiTaskStep, Brand } from "../db/schema";
import { admitBackgroundAi } from "../ai-guard";
import { friendlyAIError } from "../ai/llm";
import { releaseAiSlot, renewAiSlot } from "../ratelimit";
import type { BrandAccess } from "../auth/guard";
import { log } from "../log";
import { SECTION_KEYS, SECTION_META, missingSections, type SectionKey } from "@/lib/strategy";
import { SECTION_RUNNERS, regenerateEntry, type AgentCtx } from "./agents";
import { STALE_TASK_MS, StrategyError, activeTask, docOf, getStrategy, replaceEntryFromAi, writeAiSection } from "./store";

const LEASE_SEC = 15 * 60;
const HEARTBEAT_MS = 20_000;


export type StartOpts = { sections: SectionKey[]; instruction?: string; kind?: string };

/**
 * Start a background strategist task for some sections of a strategy. Admission (plan quota,
 * rate limits, concurrency lease) happens synchronously so the user gets a clear error now; the
 * work itself runs after the response (Next.js `after`), reporting progress on the ai_tasks row.
 */
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
      const running = await tx
        .select({ id: schema.aiTasks.id, heartbeatAt: schema.aiTasks.heartbeatAt, createdAt: schema.aiTasks.createdAt })
        .from(schema.aiTasks)
        .where(and(eq(schema.aiTasks.brandId, brandId), eq(schema.aiTasks.strategyId, strategyId), inArray(schema.aiTasks.status, ["queued", "running"])));
      if (running.some((r) => Date.now() - (r.heartbeatAt ?? r.createdAt).getTime() <= STALE_TASK_MS)) throw new StrategyError("The AI is already working on this strategy.");
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
  const job = () => runTask(taskId, leaseId);
  if (opts.inline) await job();
  else schedule(job);
  return taskId;
}

/** Run after the response when inside a request (keeps serverless functions alive), else now. */
function schedule(fn: () => Promise<void>) {
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

async function setSteps(taskId: string, steps: AiTaskStep[], extra: Partial<typeof schema.aiTasks.$inferInsert> = {}) {
  const db = await getDb();
  await db.update(schema.aiTasks).set({ steps, heartbeatAt: new Date(), ...extra }).where(eq(schema.aiTasks.id, taskId));
}

export function taskErrorMessage(e: unknown): string {
  if (e instanceof StrategyError) return e.message;
  const ai = friendlyAIError(e);
  if (ai) return ai;
  if (e instanceof Error && e.name === "ZodError") return "The AI returned output in an unexpected shape. Please try again.";
  return "Something went wrong while generating this section. Please try again.";
}

export async function runTask(taskId: string, leaseId: string) {
  const db = await getDb();
  const [task] = await db.update(schema.aiTasks).set({ status: "running", startedAt: new Date(), heartbeatAt: new Date() }).where(and(eq(schema.aiTasks.id, taskId), eq(schema.aiTasks.status, "queued"))).returning();
  if (!task) return;
  const beat = setInterval(() => {
    void db.update(schema.aiTasks).set({ heartbeatAt: new Date() }).where(eq(schema.aiTasks.id, taskId)).catch(() => {});
    void renewAiSlot(leaseId, LEASE_SEC);
  }, HEARTBEAT_MS);
  beat.unref?.();
  const steps = task.steps.map((s) => ({ ...s }));
  const instruction = String((task.input as { instruction?: string }).instruction ?? "");
  try {
    const [brand] = await db.select().from(schema.brands).where(eq(schema.brands.id, task.brandId));
    if (!brand) throw new StrategyError("Brand not found.");
    for (const step of steps) {
      if (step.status === "done") continue;
      step.status = "running";
      step.startedAt = new Date().toISOString();
      await setSteps(taskId, steps);
      const key = step.id as SectionKey;
      try {
        // Re-read the document before each step so later agents build on earlier results.
        const row = await getStrategy(task.brandId, task.strategyId!);
        if (!row) throw new StrategyError("The strategy was deleted.");
        const ctx: AgentCtx = { scope: { brandId: task.brandId, userId: task.userId }, brand: brand as Brand, doc: docOf(row), strategyId: row.id, instruction: instruction || undefined, reviewerNote: row.revisionNote };
        // Each agent retrieves brand context for its own task (memories are ranked per task).
        const out = await SECTION_RUNNERS[key](ctx);
        await writeAiSection(task.brandId, row.id, key, out.data as never, { runId: out.runIds.at(-1) ?? null, provider: out.provider, actorId: task.userId });
        step.status = "done";
        step.finishedAt = new Date().toISOString();
        await setSteps(taskId, steps, {
          inputTokens: sql`${schema.aiTasks.inputTokens} + ${out.usage.inputTokens ?? 0}`,
          outputTokens: sql`${schema.aiTasks.outputTokens} + ${out.usage.outputTokens ?? 0}`,
          webSearches: sql`${schema.aiTasks.webSearches} + ${out.usage.webSearches ?? 0}`,
          costUsd: sql`${schema.aiTasks.costUsd} + ${out.costUsd}`,
        } as never);
      } catch (e) {
        step.status = "failed";
        step.error = taskErrorMessage(e);
        step.finishedAt = new Date().toISOString();
        for (const s of steps) if (s.status === "pending") s.status = "skipped";
        log.error("strategist.step_failed", { taskId, step: key, error: e instanceof Error ? e.message : String(e) });
        await setSteps(taskId, steps, { status: "failed", error: step.error, finishedAt: new Date() });
        return;
      }
    }
    await setSteps(taskId, steps, { status: "succeeded", finishedAt: new Date() });
  } catch (e) {
    await setSteps(taskId, steps, { status: "failed", error: taskErrorMessage(e), finishedAt: new Date() });
  } finally {
    clearInterval(beat);
    await releaseAiSlot(leaseId);
  }
}

/** Task progress for the UI. A task whose worker stopped heartbeating is reported (and stored) as interrupted. */
export async function taskStatus(brandId: string, taskId: string) {
  const db = await getDb();
  const [t] = await db.select().from(schema.aiTasks).where(and(eq(schema.aiTasks.id, taskId), eq(schema.aiTasks.brandId, brandId)));
  if (!t) throw new StrategyError("Task not found.");
  if ((t.status === "running" || t.status === "queued") && Date.now() - (t.heartbeatAt ?? t.createdAt).getTime() > STALE_TASK_MS) {
    const steps = t.steps.map((s) => (s.status === "running" ? { ...s, status: "failed" as const, error: "Interrupted" } : s.status === "pending" ? { ...s, status: "skipped" as const } : s));
    const error = "The task was interrupted (the server restarted or timed out). Completed sections were saved; resume to finish the rest.";
    await db.update(schema.aiTasks).set({ status: "failed", steps, error, finishedAt: new Date() }).where(eq(schema.aiTasks.id, t.id));
    // The worker died holding a concurrency lease; free it so the user can resume right away.
    const leaseId = (t.input as { leaseId?: string }).leaseId;
    if (leaseId) await releaseAiSlot(leaseId);
    // Close the agent run that was in flight, so the activity log doesn't show it running forever.
    if (t.strategyId) {
      await db
        .update(schema.agentRuns)
        .set({ status: "failed", error: "Interrupted: the server stopped during this run.", finishedAt: new Date() })
        .where(and(eq(schema.agentRuns.brandId, brandId), eq(schema.agentRuns.status, "running"), sql`${schema.agentRuns.input}->>'strategyId' = ${t.strategyId}`, lt(schema.agentRuns.startedAt, new Date(Date.now() - STALE_TASK_MS))));
    }
    return { ...t, status: "failed" as const, steps, error };
  }
  return t;
}

export async function latestTask(brandId: string, strategyId: string) {
  const db = await getDb();
  const [t] = await db.select().from(schema.aiTasks).where(and(eq(schema.aiTasks.brandId, brandId), eq(schema.aiTasks.strategyId, strategyId))).orderBy(desc(schema.aiTasks.createdAt)).limit(1);
  return t ? taskStatus(brandId, t.id) : null;
}

export async function strategyCost(brandId: string, strategyId: string) {
  const db = await getDb();
  const [r] = await db
    .select({ cost: sql<number>`coalesce(sum(${schema.aiTasks.costUsd}), 0)`, inTok: sql<number>`coalesce(sum(${schema.aiTasks.inputTokens}), 0)`, outTok: sql<number>`coalesce(sum(${schema.aiTasks.outputTokens}), 0)`, searches: sql<number>`coalesce(sum(${schema.aiTasks.webSearches}), 0)` })
    .from(schema.aiTasks)
    .where(and(eq(schema.aiTasks.brandId, brandId), eq(schema.aiTasks.strategyId, strategyId), inArray(schema.aiTasks.status, ["succeeded", "failed", "running"])));
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
