"use server";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db/client";
import { requireBrand } from "@/server/auth/guard";
import { safe } from "@/server/action";
import { guardedAi } from "@/server/ai-guard";
import { UserFacingError } from "@/server/jobs/engine";
import { creativeTaskStatus, produceFromCalendar, startCreativeBatch } from "@/server/creative/jobs";
import { writeCreativeCopy, editCreativeCopy } from "@/server/creative/copy";
import { runBrandCheck } from "@/server/creative/brand-check";
import { assertBrandPhoto, generateVisual, pruneCreativeFiles } from "@/server/creative/visuals";
import { FORMAT_IDS, OBJECTIVES, STYLE_IDS } from "@/lib/domain";

const Id = z.string().min(1).max(64);
const VisualSource = z.enum(["ai", "brand_photo", "typographic"]);
const LogoPlacement = z.enum(["top_left", "top_right", "bottom_left", "bottom_right", "none"]);

const StudioRequest = z.object({
  brief: z.string().trim().min(3, "Describe what the creative should say").max(2000),
  format: z.enum(FORMAT_IDS),
  style: z.enum(STYLE_IDS),
  count: z.number().int().min(1).max(6),
  objective: z.enum(OBJECTIVES).optional(),
  campaignId: Id.optional(),
  kind: z.enum(["single", "carousel"]).default("single"),
  slideCount: z.number().int().min(3).max(8).optional(),
  visualSource: VisualSource,
  sourceAssetIds: z.array(Id).max(8).optional(),
  logoPlacement: LogoPlacement.default("top_left"),
  slideVisuals: z.boolean().default(false),
});

async function own(brandId: string, creativeId: string) {
  const db = await getDb();
  const [c] = await db.select().from(schema.creatives).where(and(eq(schema.creatives.id, creativeId), eq(schema.creatives.brandId, brandId)));
  if (!c) throw new UserFacingError("Creative not found.");
  return c;
}
const done = () => revalidatePath("/creative-studio");

/** Start a background creative job from the studio form. */
export async function startCreativesAction(brandId: string, raw: unknown) {
  return safe(async () => {
    const access = await requireBrand(brandId, "editor");
    const { slideVisuals, ...req } = StudioRequest.parse(raw);
    if (req.campaignId) {
      const db = await getDb();
      const [c] = await db.select({ id: schema.campaigns.id }).from(schema.campaigns).where(and(eq(schema.campaigns.id, req.campaignId), eq(schema.campaigns.brandId, brandId)));
      if (!c) throw new UserFacingError("Campaign not found.");
    }
    const taskId = await startCreativeBatch(access, [req], { slideVisuals });
    done();
    return { taskId };
  });
}

/** Produce creatives (with copy and brand check) from approved-strategy calendar entries. */
export async function produceFromCalendarAction(brandId: string, strategyId: string, entryIds: string[], opts: unknown) {
  return safe(async () => {
    const access = await requireBrand(brandId, "editor");
    const o = z.object({ style: z.enum(STYLE_IDS), visualSource: VisualSource, logoPlacement: LogoPlacement.default("top_left") }).parse(opts);
    const ids = z.array(Id).min(1).max(7).parse(entryIds);
    const taskId = await produceFromCalendar(access, Id.parse(strategyId), ids, o);
    done();
    revalidatePath("/strategist");
    return { taskId };
  });
}

export async function creativeTaskStatusAction(brandId: string, taskId: string) {
  return safe(async () => {
    await requireBrand(brandId, "viewer");
    const t = await creativeTaskStatus(brandId, Id.parse(taskId));
    return { id: t.id, status: t.status, steps: t.steps, error: t.error, costUsd: t.costUsd, attempts: t.attempts, maxAttempts: t.maxAttempts, recovering: t.recovering };
  });
}

/** Change where a creative's visual comes from, then produce it (one image at most: synchronous). */
export async function setVisualSourceAction(brandId: string, creativeId: string, raw: unknown) {
  return safe(async () => {
    const access = await requireBrand(brandId, "editor");
    const { visualSource, sourceAssetId } = z.object({ visualSource: VisualSource, sourceAssetId: Id.nullable().optional() }).parse(raw);
    if (sourceAssetId) await assertBrandPhoto(brandId, sourceAssetId);
    const db = await getDb();
    const cur = await own(brandId, creativeId);
    await db
      .update(schema.creatives)
      .set({ visualSource, sourceAssetId: visualSource === "brand_photo" ? (sourceAssetId ?? null) : null, imagePath: null, imageError: null, brandCheck: cur.brandCheck ? { ...cur.brandCheck, stale: true } : null, updatedAt: new Date() })
      .where(eq(schema.creatives.id, creativeId));
    const updated = await own(brandId, creativeId);
    try {
      await guardedAi(access, "ai_heavy", () => generateVisual({ brandId, userId: access.session.user.id }, access.brand, updated));
    } finally {
      // The previous visual was replaced above (or cleared, if generation failed): drop its files.
      await pruneCreativeFiles(cur, await own(brandId, creativeId));
    }
    done();
  });
}

export async function writeCopyAction(brandId: string, creativeId: string) {
  return safe(async () => {
    const access = await requireBrand(brandId, "editor");
    const c = await own(brandId, creativeId);
    const pack = await guardedAi(access, "ai", () => writeCreativeCopy({ brandId, userId: access.session.user.id }, access.brand, c));
    done();
    return pack;
  });
}

export async function editCopyAction(brandId: string, creativeId: string, raw: unknown) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    const pack = await editCreativeCopy(brandId, creativeId, raw);
    done();
    return pack;
  });
}

export async function brandCheckAction(brandId: string, creativeId: string) {
  return safe(async () => {
    const access = await requireBrand(brandId, "editor");
    const c = await own(brandId, creativeId);
    const check = await guardedAi(access, "ai", () => runBrandCheck({ brandId, userId: access.session.user.id }, access.brand, c));
    done();
    return check;
  });
}
