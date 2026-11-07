import { notFound } from "next/navigation";
import { and, asc, eq, inArray } from "drizzle-orm";
import { requireActiveBrand } from "@/server/auth/guard";
import { getDb, schema } from "@/server/db/client";
import { CampaignDetail } from "@/components/campaigns/detail";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { brand, role } = await requireActiveBrand();
  const db = await getDb();
  const [c] = await db.select().from(schema.campaigns).where(and(eq(schema.campaigns.id, id), eq(schema.campaigns.brandId, brand.id)));
  if (!c) notFound();
  const posts = await db.select().from(schema.posts).where(eq(schema.posts.campaignId, c.id)).orderBy(asc(schema.posts.scheduledAt));
  const metrics = posts.length
    ? await db.select().from(schema.postMetrics).where(and(inArray(schema.postMetrics.postId, posts.map((p) => p.id)), eq(schema.postMetrics.source, "platform")))
    : [];
  const latest = new Map<string, (typeof metrics)[number]>();
  for (const m of metrics) {
    const cur = latest.get(m.postId);
    if (!cur || m.capturedAt > cur.capturedAt) latest.set(m.postId, m);
  }
  return (
    <CampaignDetail
      brandId={brand.id}
      role={role}
      campaign={{ id: c.id, name: c.name, type: c.type, objective: c.objective, status: c.status, startDate: c.startDate, endDate: c.endDate, brief: c.brief as never }}
      posts={posts.map((p) => ({ id: p.id, title: p.title, platform: p.platform, format: p.format, pillar: p.pillar, status: p.status, scheduledAt: p.scheduledAt, creativeId: p.creativeId, caption: p.caption, metrics: latest.get(p.id) ?? null }))}
    />
  );
}
