import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import type { AiTaskStep, Brand } from "../db/schema";
import type { BrandAccess } from "../auth/guard";
import { enqueueJob, jobErrorMessage, jobStatus, recoverDueTasks as recoverJobs, refreshTaskUsage as refreshUsage, registerJobKind, runJob } from "../jobs/engine";
import { SECTION_KEYS, SECTION_META, missingSections, type SectionKey } from "@/lib/strategy";
import { SECTION_RUNNERS, regenerateEntry, type AgentCtx } from "./agents";
import { StrategyError, activeTask, docOf, getStrategy, replaceEntryFromAi, writeAiSection } from "./store";

/**
 * Strategist jobs run on the persistent job engine (src/server/jobs/engine.ts): admission once,
 * atomic claim, heartbeats, recovery after restarts, retries with backoff, cost from agent runs.
 * This module supplies the strategist-specific step: generate one section, idempotently.
 */

export type StartOpts = { sections: SectionKey[]; instruction?: string; kind?: string };
type StrategistInput = { sections?: SectionKey[]; instruction?: string };
const KINDS = ["strategy_workflow", "regenerate_section", "resume"];

registerJobKind(KINDS, {
  name: "strategist",
  interruptedMessage: "The task was interrupted repeatedly and stopped. Completed sections were saved; resume to finish the rest.",
  async runStep(step, ctx) {
    const t = ctx.task;
    const key = step.id as SectionKey;
    const row = await getStrategy(t.brandId, t.strategyId!);
    if (!row) throw new StrategyError("The strategy was deleted.");
    const doc = docOf(row);
    // Written by this task before a crash, but the step wasn't marked done: don't pay for it again.
    if (doc.sections[key]?.taskId === ctx.taskId) return;
    const instruction = String((t.input as StrategistInput).instruction ?? "");
    const agentCtx: AgentCtx = { scope: { brandId: t.brandId, userId: t.userId, taskId: ctx.taskId }, brand: ctx.brand as Brand, doc, strategyId: row.id, instruction: instruction || undefined, reviewerNote: row.revisionNote };
    const out = await SECTION_RUNNERS[key](agentCtx);
    if (ctx.isLost()) return;
    await writeAiSection(t.brandId, row.id, key, out.data as never, { runId: out.runIds.at(-1) ?? null, provider: out.provider, actorId: t.userId, taskId: ctx.taskId, claimToken: ctx.token });
  },
});

export async function startTask(access: BrandAccess, strategyId: string, opts: StartOpts & { inline?: boolean }) {
  const row = await getStrategy(access.brand.id, strategyId);
  if (!row) throw new StrategyError("Strategy not found.");
  if (row.status !== "draft" && row.status !== "under_review") throw new StrategyError(row.status === "approved" ? "This strategy is approved and locked. Create a new version to regenerate sections." : "This strategy is archived.");
  docOf(row);
  const sections = SECTION_KEYS.filter((k) => opts.sections.includes(k));
  if (!sections.length) throw new StrategyError("Nothing to generate.");
  const steps: AiTaskStep[] = sections.map((k) => ({ id: k, label: SECTION_META[k].step, status: "pending" }));
  return enqueueJob(access, {
    kind: opts.kind ?? "strategy_workflow",
    strategyId,
    steps,
    input: { sections, instruction: opts.instruction?.slice(0, 1000) ?? "" },
    lockKey: `strategy:${strategyId}`,
    busyMessage: "The AI is already working on this strategy.",
    inline: opts.inline,
  });
}

export const runTask = runJob;
export const recoverDueTasks = recoverJobs;
export const refreshTaskUsage = refreshUsage;
export const taskErrorMessage = jobErrorMessage;

/** Task progress for the UI. A due or abandoned task is (re)started from here too. */
export async function taskStatus(brandId: string, taskId: string) {
  return jobStatus(brandId, taskId, () => new StrategyError("Task not found."));
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
      unknown: sql<number>`coalesce(sum((${schema.agentRuns.usage}->>'unknownUsageAttempts')::numeric), 0)`,
    })
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.brandId, brandId), sql`${schema.agentRuns.input}->>'strategyId' = ${strategyId}`));
  return { costUsd: Number(r?.cost ?? 0), inputTokens: Number(r?.inTok ?? 0), outputTokens: Number(r?.outTok ?? 0), webSearches: Number(r?.searches ?? 0), unknownUsageCalls: Number(r?.unknown ?? 0) };
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
