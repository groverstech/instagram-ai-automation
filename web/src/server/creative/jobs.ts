import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import type { AiTaskStep, Creative } from "../db/schema";
import type { BrandAccess } from "../auth/guard";
import { imageProvider } from "../ai/image";
import { UserFacingError, enqueueJob, jobStatus, registerJobKind } from "../jobs/engine";
import { createConcepts, type CreativeRequest } from "../agents/creative";
import { generateVisual, assertBrandPhoto, brandPhotos } from "./visuals";
import { writeCreativeCopy } from "./copy";
import { runBrandCheck } from "./brand-check";
import { getStrategy, docOf } from "../strategist/store";
import { FORMAT_IDS, STYLE_IDS, formatById, objectiveLabel, platformLabel } from "@/lib/domain";
import type { CalendarEntry } from "@/lib/strategy";

/**
 * Creative Studio jobs (kind "creative_batch") on the persistent job engine.
 * Steps: concepts:<item> → per creative: visual:<id> → copy:<id> → check:<id>.
 * Every step is idempotent (rows and results are stamped with the task id), so a job recovered
 * after a restart never creates, renders or bills finished work twice.
 */

export const BATCH_KIND = "creative_batch";
export const MAX_ITEMS = 7;
export const MAX_CREATIVES = 12;

type BatchInput = { items: CreativeRequest[]; slideVisuals?: boolean };

async function creativeOf(brandId: string, taskId: string, id: string) {
  const db = await getDb();
  const [c] = await db.select().from(schema.creatives).where(and(eq(schema.creatives.id, id), eq(schema.creatives.brandId, brandId), eq(schema.creatives.taskId, taskId)));
  if (!c) throw new UserFacingError("The creative was deleted while it was being produced.");
  return c;
}

function titleOf(c: Creative) {
  return String((c.concept as { title?: string }).title ?? "creative");
}

registerJobKind([BATCH_KIND], {
  name: "creative",
  interruptedMessage: "Creative production was interrupted repeatedly and stopped. Finished creatives were saved.",
  async runStep(step, ctx) {
    const t = ctx.task;
    const input = t.input as unknown as BatchInput;
    const scope = { brandId: t.brandId, userId: t.userId, taskId: ctx.taskId };
    const [kind, ref] = step.id.split(":");
    if (kind === "concepts") {
      const i = Number(ref);
      const db = await getDb();
      let rows = await db
        .select()
        .from(schema.creatives)
        .where(and(eq(schema.creatives.brandId, t.brandId), eq(schema.creatives.taskId, ctx.taskId), sql`(${schema.creatives.concept}->>'batchItem')::int = ${i}`));
      if (!rows.length) {
        if (ctx.isLost()) return;
        rows = await createConcepts(scope, ctx.brand, { ...input.items[i], batchItem: i });
      }
      const more: AiTaskStep[] = rows.flatMap((c) => [
        { id: `visual:${c.id}`, label: `Visual · ${titleOf(c)}`, status: "pending" as const },
        { id: `copy:${c.id}`, label: `Copy · ${titleOf(c)}`, status: "pending" as const },
        { id: `check:${c.id}`, label: `Brand check · ${titleOf(c)}`, status: "pending" as const },
      ]);
      await ctx.addSteps(more);
      return;
    }
    const c = await creativeOf(t.brandId, ctx.taskId, ref);
    if (kind === "visual") {
      const done = c.visualSource === "typographic" ? c.imageProvider === "none" : Boolean(c.imagePath) && !c.imageError;
      if (done || ctx.isLost()) return;
      const rotation = Number((c.concept as { batchItem?: number }).batchItem ?? 0) + ctx.steps.filter((s) => s.id.startsWith("visual:")).findIndex((s) => s.id === step.id);
      await generateVisual(scope, ctx.brand, c, { rotation, slideVisuals: input.slideVisuals });
      return;
    }
    if (kind === "copy") {
      if ((c.copy as { taskId?: string } | null)?.taskId === ctx.taskId || ctx.isLost()) return;
      await writeCreativeCopy(scope, ctx.brand, c);
      return;
    }
    if (kind === "check") {
      if ((c.brandCheck as { taskId?: string } | null)?.taskId === ctx.taskId || ctx.isLost()) return;
      await runBrandCheck(scope, ctx.brand, c);
      return;
    }
    throw new UserFacingError(`Unknown step ${step.id}.`);
  },
});

/** Validate a batch before admission, so users get a clear error now instead of a failed job. */
async function validate(brandId: string, items: CreativeRequest[]) {
  if (!items.length) throw new UserFacingError("Nothing to produce.");
  if (items.length > MAX_ITEMS) throw new UserFacingError(`Produce at most ${MAX_ITEMS} briefs at a time.`);
  const total = items.reduce((s, x) => s + Math.max(1, Math.min(x.count, 6)), 0);
  if (total > MAX_CREATIVES) throw new UserFacingError(`That's ${total} creatives; produce at most ${MAX_CREATIVES} at a time.`);
  for (const it of items) {
    if (!it.brief.trim()) throw new UserFacingError("Each creative needs a brief.");
    if (!(FORMAT_IDS as readonly string[]).includes(it.format)) throw new UserFacingError(`Unknown format ${it.format}.`);
    if (!(STYLE_IDS as readonly string[]).includes(it.style)) throw new UserFacingError(`Unknown style ${it.style}.`);
    if (it.visualSource === "ai" && !imageProvider()) throw new UserFacingError("AI imagery isn't available: no image provider is configured on this server. Choose brand photos or a type-led layout.");
    if (it.visualSource === "brand_photo") {
      if (it.sourceAssetIds?.length) for (const id of it.sourceAssetIds) await assertBrandPhoto(brandId, id);
      else if (!(await brandPhotos(brandId)).length) throw new UserFacingError("This brand has no approved product or reference photos yet. Upload and approve some in My Brand, or choose another visual source.");
    }
  }
}

export async function startCreativeBatch(access: BrandAccess, items: CreativeRequest[], opts: { slideVisuals?: boolean; inline?: boolean } = {}) {
  await validate(access.brand.id, items);
  const steps: AiTaskStep[] = items.map((it, i) => ({
    id: `concepts:${i}`,
    label: `Concepts · ${Math.max(1, Math.min(it.count, 6))}× ${formatById(it.format).label}${it.kind === "carousel" ? " carousel" : ""}`,
    status: "pending",
  }));
  return enqueueJob(access, { kind: BATCH_KIND, steps, input: { items, slideVisuals: Boolean(opts.slideVisuals) }, inline: opts.inline });
}

export async function creativeTaskStatus(brandId: string, taskId: string) {
  return jobStatus(brandId, taskId, () => new UserFacingError("Task not found."));
}

/** The most recent creative jobs for a brand (for the studio's progress panel). */
export async function recentCreativeTasks(brandId: string, limit = 5) {
  const db = await getDb();
  const rows = await db.select().from(schema.aiTasks).where(and(eq(schema.aiTasks.brandId, brandId), eq(schema.aiTasks.kind, BATCH_KIND))).orderBy(sql`${schema.aiTasks.createdAt} desc`).limit(limit);
  return Promise.all(rows.map((r) => creativeTaskStatus(brandId, r.id)));
}

/** Turn approved-strategy calendar entries into briefs (one creative each), linked back to the entries. */
export function itemsFromCalendar(strategyId: string, entries: CalendarEntry[], opts: { style: string; visualSource: CreativeRequest["visualSource"]; logoPlacement?: CreativeRequest["logoPlacement"] }): CreativeRequest[] {
  return entries.map((e) => ({
    brief: e.creativeConcept,
    format: e.format,
    style: opts.style,
    count: 1,
    objective: e.objective,
    kind: e.format === "instagram_carousel" ? "carousel" : "single",
    slideCount: 5,
    visualSource: opts.visualSource,
    logoPlacement: opts.logoPlacement,
    strategyId,
    calendarEntryId: e.id,
    strategyContext: [
      `Calendar entry ${e.date} ${e.time} on ${platformLabel(e.platform)}.`,
      `Pillar: ${e.pillar}. Objective: ${objectiveLabel(e.objective)}.`,
      `Hook: ${e.hook}`,
      `Caption direction: ${e.captionDirection}`,
      `CTA: ${e.cta}`,
      e.campaign ? `Campaign: ${e.campaign}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  }));
}

export async function produceFromCalendar(access: BrandAccess, strategyId: string, entryIds: string[], opts: { style: string; visualSource: CreativeRequest["visualSource"]; logoPlacement?: CreativeRequest["logoPlacement"]; inline?: boolean }) {
  const row = await getStrategy(access.brand.id, strategyId);
  if (!row) throw new UserFacingError("Strategy not found.");
  const cal = docOf(row).sections.calendar?.data;
  if (!cal) throw new UserFacingError("This strategy has no calendar yet.");
  const entries = entryIds.map((id) => cal.entries.find((e) => e.id === id)).filter((e): e is CalendarEntry => Boolean(e));
  if (entries.length !== entryIds.length) throw new UserFacingError("Some calendar entries no longer exist. Reload and try again.");
  return startCreativeBatch(access, itemsFromCalendar(strategyId, entries, opts), { inline: opts.inline });
}
