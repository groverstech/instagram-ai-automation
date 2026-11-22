import "server-only";
import { and, eq, gte } from "drizzle-orm";
import { subDays } from "date-fns";
import { getDb, schema } from "../db/client";
import { llm } from "../ai/llm";
import { AGENTS } from "./registry";
import { runAgent, type RunScope } from "./orchestrator";
import { buildContext, renderContext } from "./context";
import { Insights } from "./schemas";
import type { Brand } from "../db/schema";
import { remember } from "../memory";

export type PostPerformance = {
  postId: string;
  platform: string;
  pillar: string | null;
  objective: string | null;
  style: string | null;
  layout: string | null;
  captionLength: number;
  publishedAt: Date | null;
  hour: number | null;
  campaign: string | null;
  reach: number | null;
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  videoViews: number | null;
  engagementRate: number | null;
};

/** Latest platform-sourced metrics per published post in the window. Estimates are excluded. */
export async function performanceDataset(brandId: string, days = 30): Promise<PostPerformance[]> {
  const db = await getDb();
  const since = subDays(new Date(), days);
  const rows = await db
    .select({
      post: schema.posts,
      m: schema.postMetrics,
      style: schema.creatives.style,
      concept: schema.creatives.concept,
      campaign: schema.campaigns.name,
    })
    .from(schema.posts)
    .innerJoin(schema.postMetrics, and(eq(schema.postMetrics.postId, schema.posts.id), eq(schema.postMetrics.source, "platform")))
    .leftJoin(schema.creatives, eq(schema.creatives.id, schema.posts.creativeId))
    .leftJoin(schema.campaigns, eq(schema.campaigns.id, schema.posts.campaignId))
    .where(and(eq(schema.posts.brandId, brandId), eq(schema.posts.status, "published"), gte(schema.posts.publishedAt, since)));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const cur = latest.get(r.post.id);
    if (!cur || r.m.capturedAt > cur.m.capturedAt) latest.set(r.post.id, r);
  }
  return [...latest.values()].map(({ post, m, style, concept, campaign }) => ({
    postId: post.id,
    platform: post.platform,
    pillar: post.pillar,
    objective: post.objective,
    style: style ?? null,
    layout: ((concept as { layout?: string } | null)?.layout as string) ?? null,
    captionLength: post.caption?.length ?? 0,
    publishedAt: post.publishedAt,
    hour: post.publishedAt ? post.publishedAt.getHours() : null,
    campaign: campaign ?? null,
    reach: m.reach,
    impressions: m.impressions,
    likes: m.likes,
    comments: m.comments,
    shares: m.shares,
    saves: m.saves,
    videoViews: m.videoViews,
    engagementRate: m.engagementRate,
  }));
}

/** Deterministic aggregation so the UI and the agent see the same numbers. */
export function aggregate(data: PostPerformance[], key: (p: PostPerformance) => string | null) {
  const groups = new Map<string, { n: number; reach: number; er: number; erN: number }>();
  for (const p of data) {
    const k = key(p);
    if (!k) continue;
    const g = groups.get(k) ?? { n: 0, reach: 0, er: 0, erN: 0 };
    g.n++;
    g.reach += p.reach ?? 0;
    if (p.engagementRate != null) {
      g.er += p.engagementRate;
      g.erN++;
    }
    groups.set(k, g);
  }
  return [...groups.entries()]
    .map(([k, g]) => ({ key: k, posts: g.n, avgReach: g.n ? Math.round(g.reach / g.n) : 0, avgEngagementRate: g.erN ? g.er / g.erN : null }))
    .sort((a, b) => (b.avgEngagementRate ?? -1) - (a.avgEngagementRate ?? -1));
}

export function summarize(data: PostPerformance[]) {
  return {
    posts: data.length,
    byPillar: aggregate(data, (p) => p.pillar),
    byStyle: aggregate(data, (p) => p.style),
    byPlatform: aggregate(data, (p) => p.platform),
    byHour: aggregate(data, (p) => (p.hour == null ? null : `${String(p.hour).padStart(2, "0")}:00`)),
    byCampaign: aggregate(data, (p) => p.campaign),
    byCaptionLength: aggregate(data, (p) => (p.captionLength < 125 ? "short (<125)" : p.captionLength < 400 ? "medium (125-400)" : "long (400+)")),
  };
}

export async function analyzePerformance(scope: RunScope, brand: Brand, days = 30) {
  const data = await performanceDataset(brand.id, days);
  const summary = summarize(data);
  const ctx = await buildContext(brand, "performance analysis engagement");
  const prompt = `${renderContext(ctx)}

<platform_metrics window_days="${days}" source="connected platform APIs" posts="${data.length}">
${JSON.stringify(summary)}
</platform_metrics>

Analyse performance over the last ${days} days. Answer where the data allows: which pillars, creative styles, caption lengths, posting times, platforms and campaigns perform best, and what to create next.
${data.length < 5 ? "IMPORTANT: there are fewer than 5 posts with real metrics. Say clearly that conclusions are preliminary, keep confidence low, and lean recommendations on the brand strategy." : ""}`;

  const result = await runAgent(scope, "analytics", `Analyse last ${days} days`, { days, posts: data.length }, () =>
    llm().structured({ route: "analytics.insights",
      system: AGENTS.analytics.system,
      prompt,
      schema: Insights,
      effort: AGENTS.analytics.effort,
      mock: () => ({
        summary: data.length ? `Analysed ${data.length} posts.` : "No platform metrics are available yet.",
        findings: summary.byPillar.slice(0, 2).map((g) => ({ title: `${g.key} leads`, detail: `${g.posts} posts`, evidence: `avg ER ${g.avgEngagementRate ?? "n/a"}`, confidence: "low" as const })),
        recommendations: [{ action: "Connect an account and publish consistently for 2 weeks", why: "Builds a baseline", expectedImpact: "Reliable insights" }],
        nextContent: [],
        dataNotes: "Mock provider.",
      }),
    }),
  );
  if (data.length >= 5) {
    await remember(
      brand.id,
      result.data.findings.filter((f) => f.confidence !== "low").map((f) => ({ kind: "insight" as const, content: `${f.title}: ${f.detail} (${f.evidence})`, source: "analytics", weight: 1.4 })),
    );
  }
  return { ...result, summary, posts: data.length };
}
