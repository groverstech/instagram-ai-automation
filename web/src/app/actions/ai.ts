"use server";
import { audit } from "@/server/audit";
import { pruneCreativeFiles } from "@/server/creative/visuals";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { parseISO, startOfDay, addDays } from "date-fns";
import { getDb, schema } from "@/server/db/client";
import { requireBrand, type BrandAccess } from "@/server/auth/guard";
import { safe } from "@/server/action";
import { guardedAi } from "@/server/ai-guard";
import { planCalendar, suggestIdeas, writeCopy } from "@/server/agents/strategy";
import { generateCreatives, createVariation, generateCreativeImage, updateConcept, setCreativeStatus } from "@/server/agents/creative";
import { createCampaign, producePost } from "@/server/agents/campaign";
import { analyzePerformance } from "@/server/agents/analytics";
import { analyzeCompetitor } from "@/server/agents/competitor";
import { chat } from "@/server/agents/assistant";

/** Editor access + plan quota + rate limits + concurrency lease around an AI action. */
function aiAction<T>(brandId: string, kind: "ai" | "ai_heavy", fn: (a: BrandAccess & { scope: { brandId: string; userId: string } }) => Promise<T>) {
  return safe(async () => {
    const access = await requireBrand(brandId, "editor");
    return guardedAi(access, kind, () => fn({ ...access, scope: { brandId, userId: access.session.user.id } }));
  });
}

const day = (s: string | undefined, fallback: Date) => {
  const d = s ? parseISO(s) : fallback;
  return Number.isNaN(d.getTime()) ? fallback : startOfDay(d);
};

// ---------- Calendar ----------
export async function planCalendarAction(brandId: string, input: { start?: string; days: number; platforms: string[]; postsPerWeek?: number; note?: string }) {
  return aiAction(brandId, "ai_heavy", async ({ brand, scope }) => {
    const r = await planCalendar(scope, brand, { start: day(input.start, addDays(new Date(), 1)), days: Math.min(Math.max(input.days, 1), 60), platforms: input.platforms, postsPerWeek: input.postsPerWeek, note: input.note });
    revalidatePath("/calendar");
    revalidatePath("/dashboard");
    return { count: r.postIds.length };
  });
}

// ---------- Content ----------
export async function writeCopyAction(brandId: string, input: { brief: string; platform: string; objective: string; pillar?: string }) {
  return aiAction(brandId, "ai", async ({ brand, scope }) => {
    return (await writeCopy(scope, brand, input)).data;
  });
}

export async function suggestIdeasAction(brandId: string, goal: string) {
  return aiAction(brandId, "ai", async ({ brand, scope }) => {
    return (await suggestIdeas(scope, brand, goal)).data;
  });
}

/** Turn an idea or copy pack into a draft post on the calendar. */
export async function createDraftPost(brandId: string, input: { platform: string; format?: string; title: string; caption?: string; hashtags?: string[]; objective?: string; pillar?: string; date?: string; creativeId?: string; brief?: string }) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    const db = await getDb();
    const when = input.date ? parseISO(input.date) : addDays(new Date(), 2);
    if (Number.isNaN(when.getTime())) throw new Error("Invalid date");
    const [p] = await db
      .insert(schema.posts)
      .values({
        brandId,
        platform: input.platform,
        format: input.format ?? "instagram_post",
        title: input.title,
        caption: input.caption ?? null,
        hashtags: input.hashtags ?? [],
        objective: input.objective ?? null,
        pillar: input.pillar ?? null,
        creativeId: input.creativeId ?? null,
        scheduledAt: when,
        copy: input.brief ? { brief: input.brief } : {},
      })
      .returning({ id: schema.posts.id });
    revalidatePath("/calendar");
    return { id: p.id };
  });
}

// ---------- Creative ----------
export async function generateCreativesAction(brandId: string, input: { brief: string; format: string; style: string; count: number; objective?: string; campaignId?: string }) {
  return aiAction(brandId, "ai_heavy", async ({ brand, scope }) => {
    const ids = await generateCreatives(scope, brand, { ...input, campaignId: input.campaignId || null });
    revalidatePath("/creative-studio");
    return { ids };
  });
}

async function ownCreative(brandId: string, creativeId: string) {
  const db = await getDb();
  const [c] = await db.select().from(schema.creatives).where(and(eq(schema.creatives.id, creativeId), eq(schema.creatives.brandId, brandId)));
  if (!c) throw new Error("Creative not found");
  return c;
}

export async function variationAction(brandId: string, creativeId: string, direction: string) {
  return aiAction(brandId, "ai_heavy", async ({ brand, scope }) => {
    const ids = await createVariation(scope, brand, await ownCreative(brandId, creativeId), direction);
    revalidatePath("/creative-studio");
    return { ids };
  });
}

export async function regenerateImageAction(brandId: string, creativeId: string) {
  return aiAction(brandId, "ai_heavy", async ({ brand, scope }) => {
    await generateCreativeImage(scope, brand, await ownCreative(brandId, creativeId));
    revalidatePath("/creative-studio");
  });
}

export async function updateCreativeAction(brandId: string, creativeId: string, patch: unknown) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    await updateConcept(brandId, creativeId, patch);
    revalidatePath("/creative-studio");
  });
}

export async function setCreativeStatusAction(brandId: string, creativeId: string, status: "approved" | "rejected" | "draft", force = false) {
  return safe(async () => {
    // Approving past blocking brand-check issues is an admin decision.
    const { session, brand } = await requireBrand(brandId, force ? "admin" : "editor");
    await setCreativeStatus(brandId, creativeId, status, { force });
    if (force && status === "approved") await audit({ action: "creative.approve_override", workspaceId: brand.workspaceId, brandId, actorUserId: session.user.id, targetType: "creative", targetId: creativeId });
    revalidatePath("/creative-studio");
  });
}

export async function deleteCreativeAction(brandId: string, creativeId: string) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    const db = await getDb();
    const [gone] = await db.delete(schema.creatives).where(and(eq(schema.creatives.id, creativeId), eq(schema.creatives.brandId, brandId))).returning();
    if (gone) await pruneCreativeFiles(gone, null); // its stored visuals go with it
    revalidatePath("/creative-studio");
  });
}

// ---------- Campaigns ----------
export async function createCampaignAction(brandId: string, input: { brief: string; type: string; objective: string; start: string; days: number; platforms: string[]; style: string; produceFirst: number }) {
  return aiAction(brandId, "ai_heavy", async ({ brand, scope }) => {
    const r = await createCampaign(scope, brand, { brief: input.brief, type: input.type, objective: input.objective, start: day(input.start, addDays(new Date(), 1)), days: input.days, platforms: input.platforms, creativeStyle: input.style, produceFirst: Math.min(input.produceFirst, 6) });
    revalidatePath("/campaigns");
    revalidatePath("/calendar");
    return r;
  });
}

export async function producePostAction(brandId: string, postId: string, style: string) {
  return aiAction(brandId, "ai_heavy", async ({ brand, scope }) => {
    const db = await getDb();
    const [p] = await db.select().from(schema.posts).where(and(eq(schema.posts.id, postId), eq(schema.posts.brandId, brandId)));
    if (!p) throw new Error("Post not found");
    const brief = String((p.copy as { brief?: string }).brief ?? p.title ?? "");
    await producePost(scope, brand, postId, { brief: `${p.title ?? ""}: ${brief}`, format: p.format, style, platform: p.platform, objective: p.objective ?? "engagement", pillar: p.pillar, campaignId: p.campaignId });
    revalidatePath("/calendar");
    revalidatePath(`/campaigns/${p.campaignId}`);
  });
}

export async function setCampaignStatus(brandId: string, campaignId: string, status: "planning" | "active" | "completed" | "paused") {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    const db = await getDb();
    await db.update(schema.campaigns).set({ status }).where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.brandId, brandId)));
    revalidatePath(`/campaigns/${campaignId}`);
    revalidatePath("/campaigns");
  });
}

export async function deleteCampaign(brandId: string, campaignId: string) {
  return safe(async () => {
    await requireBrand(brandId, "admin");
    const db = await getDb();
    await db.delete(schema.posts).where(and(eq(schema.posts.campaignId, campaignId), eq(schema.posts.brandId, brandId), eq(schema.posts.status, "draft")));
    await db.delete(schema.campaigns).where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.brandId, brandId)));
    revalidatePath("/campaigns");
  });
}

// ---------- Analytics & competitors ----------
export async function analyzeAction(brandId: string, days: number) {
  return aiAction(brandId, "ai_heavy", async ({ brand, scope }) => {
    const r = await analyzePerformance(scope, brand, days);
    return { insights: r.data, posts: r.posts, runId: r.runId };
  });
}

export async function addCompetitor(brandId: string, input: { name: string; url?: string; handles?: string }) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    if (!input.name.trim()) throw new Error("Enter a competitor name.");
    const db = await getDb();
    const [c] = await db
      .insert(schema.competitors)
      .values({ brandId, name: input.name.trim(), url: input.url?.trim() || null, handles: (input.handles ?? "").split(/[,\s]+/).filter(Boolean) })
      .returning();
    revalidatePath("/competitors");
    return { id: c.id };
  });
}

export async function analyzeCompetitorAction(brandId: string, competitorId: string) {
  return aiAction(brandId, "ai_heavy", async ({ brand, scope }) => {
    await analyzeCompetitor(scope, brand, competitorId);
    revalidatePath("/competitors");
  });
}

export async function deleteCompetitor(brandId: string, competitorId: string) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    const db = await getDb();
    await db.delete(schema.competitors).where(and(eq(schema.competitors.id, competitorId), eq(schema.competitors.brandId, brandId)));
    revalidatePath("/competitors");
  });
}

// ---------- Assistant ----------
export async function assistantAction(brandId: string, message: string) {
  return aiAction(brandId, "ai", async ({ brand, scope }) => {
    const r = await chat(scope, brand, message.slice(0, 4000));
    revalidatePath("/", "layout");
    return r;
  });
}
