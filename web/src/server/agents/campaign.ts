import "server-only";
import { addDays, format as fmt } from "date-fns";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { llm } from "../ai/llm";
import { AGENTS } from "./registry";
import { runAgent, type RunScope } from "./orchestrator";
import { buildContext, renderContext } from "./context";
import { CampaignPlan } from "./schemas";
import { insertPlannedPosts, writeCopy, latestStrategy } from "./strategy";
import { generateCreatives } from "./creative";
import type { Brand } from "../db/schema";
import { PLATFORM_IDS } from "@/lib/domain";

export type CampaignRequest = {
  brief: string;
  type: string;
  objective: string;
  start: Date;
  days: number;
  platforms?: string[];
  creativeStyle?: string;
  /** How many posts get creatives + captions generated immediately (rest stay as briefs). */
  produceFirst?: number;
};

/**
 * Multi-agent workflow:
 *   Campaign Manager (concept + timeline) → draft posts
 *   → Creative Director + Design Generation (creatives for first N posts)
 *   → Copywriter (captions for the same posts)
 * Everything lands as drafts; nothing is published without approval.
 */
export async function createCampaign(scope: RunScope, brand: Brand, req: CampaignRequest) {
  const days = Math.max(3, Math.min(req.days, 90));
  const platforms = (req.platforms?.length ? req.platforms : brand.platforms).filter((p) => (PLATFORM_IDS as readonly string[]).includes(p));
  const ctx = await buildContext(brand, `campaign ${req.type} ${req.brief}`);
  const strategy = await latestStrategy(brand.id);
  const prompt = `${renderContext(ctx)}
${strategy ? `<current_strategy>${JSON.stringify((strategy.data as Record<string, unknown>).pillars)}</current_strategy>` : ""}

Design a ${days}-day ${req.type} campaign starting ${fmt(req.start, "yyyy-MM-dd")} on ${platforms.join(", ") || "instagram"}.
Primary objective: ${req.objective}.
Brief from the user: ${req.brief}

- posts: a realistic cadence (roughly 3-6 per week per platform depending on the brief), day offsets 0..${days - 1}, local posting times.
- phases must cover the whole campaign.
- name: short and ownable.`;

  const { runId, data } = await runAgent(scope, "campaign_manager", `Campaign: ${req.brief.slice(0, 60)}`, { ...req, days }, () =>
    llm().structured({ system: AGENTS.campaign_manager.system, prompt, schema: CampaignPlan, effort: AGENTS.campaign_manager.effort, mock: () => mockPlan(req, days, platforms) }),
  );

  const db = await getDb();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      brandId: brand.id,
      name: data.name,
      type: req.type,
      objective: req.objective,
      startDate: req.start,
      endDate: addDays(req.start, days - 1),
      brief: { userBrief: req.brief, theme: data.theme, bigIdea: data.bigIdea, audience: data.audience, keyMessages: data.keyMessages, phases: data.phases, kpis: data.kpis, rationale: data.rationale },
      runId,
    })
    .returning();

  const postIds = await insertPlannedPosts(
    brand.id,
    data.posts.map((p) => ({ ...p, date: fmt(addDays(req.start, Math.max(0, Math.min(days - 1, Math.round(p.day)))), "yyyy-MM-dd"), rationale: `Campaign "${data.name}"` })),
    { runId, campaignId: campaign.id },
  );

  const produce = Math.min(req.produceFirst ?? 3, postIds.length);
  const sub = { ...scope, parentId: runId };
  for (let i = 0; i < produce; i++) {
    const planned = data.posts[i];
    await producePost(sub, brand, postIds[i], {
      brief: `${data.bigIdea}. ${planned.title}: ${planned.brief}`,
      format: planned.format,
      style: req.creativeStyle ?? "clean_sophisticated",
      platform: planned.platform,
      objective: planned.objective,
      pillar: planned.pillar,
      campaignId: campaign.id,
    }).catch(() => null);
  }
  return { campaignId: campaign.id, postIds };
}

/** Creative + copy for one planned post. */
export async function producePost(
  scope: RunScope,
  brand: Brand,
  postId: string,
  p: { brief: string; format: string; style: string; platform: string; objective: string; pillar?: string | null; campaignId?: string | null },
) {
  const [creativeId] = await generateCreatives(scope, brand, { brief: p.brief, format: p.format, style: p.style, count: 1, objective: p.objective, campaignId: p.campaignId });
  const db = await getDb();
  const [creative] = await db.select().from(schema.creatives).where(eq(schema.creatives.id, creativeId));
  const concept = creative.concept as { headline?: string; subline?: string };
  const { data: copy } = await writeCopy(scope, brand, { brief: p.brief, platform: p.platform, objective: p.objective, pillar: p.pillar ?? undefined, creative: concept });
  const [existing] = await db.select({ copy: schema.posts.copy }).from(schema.posts).where(eq(schema.posts.id, postId));
  await db
    .update(schema.posts)
    .set({ creativeId, caption: copy.primary, hashtags: copy.hashtags, copy: { ...(existing?.copy ?? {}), ...copy } })
    .where(eq(schema.posts.id, postId));
  return { creativeId };
}

function mockPlan(req: CampaignRequest, days: number, platforms: string[]): CampaignPlan {
  const ps = (platforms.length ? platforms : ["instagram"]) as CampaignPlan["posts"][number]["platform"][];
  const posts: CampaignPlan["posts"] = [];
  for (let d = 0; d < days; d += 2) {
    posts.push({ day: d, time: "19:00", platform: ps[(d / 2) % ps.length], format: "instagram_post", pillar: "Product Spotlight", objective: "awareness", title: `Chapter ${d / 2 + 1}`, brief: req.brief.slice(0, 120) });
  }
  return {
    name: "The Launch Edit",
    theme: "Made for this moment",
    bigIdea: "Tell the story in chapters",
    audience: "Existing followers and look-alikes",
    keyMessages: ["Thoughtfully made", "Available now"],
    phases: [
      { name: "Tease", startDay: 0, endDay: Math.floor(days / 3) },
      { name: "Launch", startDay: Math.floor(days / 3) + 1, endDay: Math.floor((2 * days) / 3) },
      { name: "Sustain", startDay: Math.floor((2 * days) / 3) + 1, endDay: days - 1 },
    ].map((p) => ({ ...p, goal: p.name })),
    posts,
    kpis: ["Reach", "Saves"],
    rationale: "Mock provider.",
  };
}
