"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireBrand, type BrandAccess } from "@/server/auth/guard";
import { safe } from "@/server/action";
import { guardedAi } from "@/server/ai-guard";
import { getDb, schema } from "@/server/db/client";
import { and, eq } from "drizzle-orm";
import { preflight } from "@/server/strategist/preflight";
import {
  StrategyError,
  applyCalendar,
  approveStrategy,
  archiveStrategy,
  compare,
  createStrategy,
  deleteEntry,
  editSection,
  newVersionFrom,
  requestRevisions,
  restoreRevision,
  setItemApproval,
  submitForReview,
  upsertEntry,
} from "@/server/strategist/store";
import { regenerateCalendarEntry, resumeSections, startTask, taskStatus } from "@/server/strategist/workflow";
import { askAdvisor, clearAdvisor } from "@/server/strategist/advisor";
import { SECTION_KEYS, StrategyInputs, type EditableSection, type SectionKey } from "@/lib/strategy";

const Section = z.enum(SECTION_KEYS);
const Editable = z.enum(["research", "audience", "objectives", "strategy", "pillars", "campaigns"]);
const Id = z.string().min(1).max(64);
const Rev = z.number().int().min(0);

const actor = (a: BrandAccess) => ({ userId: a.session.user.id, role: a.role });
const done = () => revalidatePath("/strategist");

/** Steps 1–4 of the workflow: validate inputs against the approved profile, then start generation. */
export async function startStrategyAction(brandId: string, raw: unknown) {
  return safe(async () => {
    const access = await requireBrand(brandId, "editor");
    const inputs = StrategyInputs.parse(raw);
    const pf = await preflight(access.brand);
    if (pf.blocked || !pf.profile) throw new StrategyError(pf.blocked ?? "An approved Brand Intelligence Profile is required.");
    if (!inputs.businessObjectives.length) throw new StrategyError("Add at least one business objective.");
    const unanswered = pf.questions.filter((q) => q.critical && !inputs.answers[q.id]?.trim() && !inputs.assumeFor.includes(q.id));
    if (unanswered.length) throw new StrategyError(`Answer or let the AI assume: ${unanswered.map((q) => q.question).join(" / ")}`);
    const assumptions = pf.questions.filter((q) => inputs.assumeFor.includes(q.id) && !inputs.answers[q.id]?.trim()).map((q) => q.assumption);
    const row = await createStrategy(brandId, access.session.user.id, inputs, assumptions, pf.profile);
    try {
      const taskId = await startTask(access, row.id, { sections: [...SECTION_KEYS], kind: "strategy_workflow" });
      done();
      return { strategyId: row.id, taskId };
    } catch (e) {
      // Not admitted (quota, rate limit, concurrency): don't leave an empty draft behind.
      const db = await getDb();
      await db.delete(schema.strategies).where(and(eq(schema.strategies.id, row.id), eq(schema.strategies.brandId, brandId)));
      throw e;
    }
  });
}

export async function taskStatusAction(brandId: string, taskId: string) {
  return safe(async () => {
    await requireBrand(brandId, "viewer");
    const t = await taskStatus(brandId, Id.parse(taskId));
    return { id: t.id, status: t.status, steps: t.steps, error: t.error, costUsd: t.costUsd, inputTokens: t.inputTokens, outputTokens: t.outputTokens, webSearches: t.webSearches, strategyId: t.strategyId, attempts: t.attempts, maxAttempts: t.maxAttempts, runAfter: t.runAfter, recovering: t.recovering };
  });
}

export async function regenerateSectionAction(brandId: string, strategyId: string, section: SectionKey, instruction = "") {
  return safe(async () => {
    const access = await requireBrand(brandId, "editor");
    const taskId = await startTask(access, Id.parse(strategyId), { sections: [Section.parse(section)], instruction: z.string().max(1000).parse(instruction), kind: "regenerate_section" });
    done();
    return { taskId };
  });
}

export async function resumeAction(brandId: string, strategyId: string) {
  return safe(async () => {
    const access = await requireBrand(brandId, "editor");
    const sections = await resumeSections(brandId, Id.parse(strategyId));
    if (!sections.length) throw new StrategyError("Every section has already been generated.");
    const taskId = await startTask(access, strategyId, { sections, kind: "resume" });
    done();
    return { taskId };
  });
}

export async function editSectionAction(brandId: string, strategyId: string, section: EditableSection, data: unknown, rev: number) {
  return safe(async () => {
    const access = await requireBrand(brandId, "editor");
    const row = await editSection(brandId, Id.parse(strategyId), actor(access), Editable.parse(section), data, Rev.parse(rev));
    done();
    return { rev: row.rev };
  });
}

export async function itemApprovalAction(brandId: string, strategyId: string, section: "audience" | "pillars" | "campaigns", itemId: string, approved: boolean, rev: number) {
  return safe(async () => {
    const access = await requireBrand(brandId, "admin");
    const row = await setItemApproval(brandId, Id.parse(strategyId), actor(access), z.enum(["audience", "pillars", "campaigns"]).parse(section), Id.parse(itemId), z.boolean().parse(approved), Rev.parse(rev));
    done();
    return { rev: row.rev };
  });
}

export async function upsertEntryAction(brandId: string, strategyId: string, entryId: string | null, entry: unknown, rev: number) {
  return safe(async () => {
    const access = await requireBrand(brandId, "editor");
    const row = await upsertEntry(brandId, Id.parse(strategyId), actor(access), entryId ? Id.parse(entryId) : null, entry, Rev.parse(rev));
    done();
    return { rev: row.rev };
  });
}

export async function deleteEntryAction(brandId: string, strategyId: string, entryId: string, rev: number) {
  return safe(async () => {
    const access = await requireBrand(brandId, "editor");
    const row = await deleteEntry(brandId, Id.parse(strategyId), actor(access), Id.parse(entryId), Rev.parse(rev));
    done();
    return { rev: row.rev };
  });
}

export async function regenerateEntryAction(brandId: string, strategyId: string, entryId: string, instruction: string, rev: number) {
  return safe(async () => {
    const access = await requireBrand(brandId, "editor");
    const row = await guardedAi(access, "ai", () => regenerateCalendarEntry(access.brand, access.session.user.id, Id.parse(strategyId), Id.parse(entryId), z.string().max(500).parse(instruction), Rev.parse(rev)));
    done();
    return { rev: row.rev };
  });
}

export async function submitForReviewAction(brandId: string, strategyId: string, rev: number, note = "") {
  return safe(async () => {
    const access = await requireBrand(brandId, "editor");
    await submitForReview(brandId, Id.parse(strategyId), actor(access), Rev.parse(rev), z.string().max(2000).parse(note) || undefined);
    done();
  });
}

export async function approveStrategyV2Action(brandId: string, strategyId: string, rev: number) {
  return safe(async () => {
    const access = await requireBrand(brandId, "admin");
    await approveStrategy(brandId, Id.parse(strategyId), actor(access), Rev.parse(rev));
    done();
    revalidatePath("/dashboard");
  });
}

export async function requestRevisionsAction(brandId: string, strategyId: string, note: string, rev: number) {
  return safe(async () => {
    const access = await requireBrand(brandId, "admin");
    await requestRevisions(brandId, Id.parse(strategyId), actor(access), z.string().max(2000).parse(note), Rev.parse(rev));
    done();
  });
}

export async function archiveStrategyAction(brandId: string, strategyId: string, rev: number) {
  return safe(async () => {
    const access = await requireBrand(brandId, "admin");
    await archiveStrategy(brandId, Id.parse(strategyId), actor(access), Rev.parse(rev));
    done();
  });
}

export async function newVersionAction(brandId: string, fromStrategyId: string, note = "") {
  return safe(async () => {
    const access = await requireBrand(brandId, "editor");
    const row = await newVersionFrom(brandId, Id.parse(fromStrategyId), actor(access), z.string().max(500).parse(note) || undefined);
    done();
    return { strategyId: row.id };
  });
}

export async function restoreRevisionAction(brandId: string, strategyId: string, revisionId: string, rev: number) {
  return safe(async () => {
    const access = await requireBrand(brandId, "editor");
    const row = await restoreRevision(brandId, Id.parse(strategyId), actor(access), Id.parse(revisionId), Rev.parse(rev));
    done();
    return { rev: row.rev };
  });
}

const Ref = z.object({ strategyId: Id, revisionId: Id.optional() });
export async function compareAction(brandId: string, a: unknown, b: unknown) {
  return safe(async () => {
    await requireBrand(brandId, "viewer");
    return compare(brandId, Ref.parse(a), Ref.parse(b));
  });
}

export async function applyCalendarAction(brandId: string, strategyId: string) {
  return safe(async () => {
    const access = await requireBrand(brandId, "editor");
    const r = await applyCalendar(brandId, Id.parse(strategyId), actor(access));
    done();
    revalidatePath("/calendar");
    revalidatePath("/dashboard");
    return r;
  });
}

export async function advisorAction(brandId: string, question: string) {
  return safe(async () => {
    const access = await requireBrand(brandId, "viewer");
    const q = z.string().trim().min(1, "Ask a question").max(4000).parse(question);
    return guardedAi(access, "ai", () => askAdvisor({ brandId, userId: access.session.user.id }, access.brand, q));
  });
}

export async function clearAdvisorAction(brandId: string) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    await clearAdvisor(brandId);
  });
}
