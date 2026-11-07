import { desc, eq, inArray } from "drizzle-orm";
import { requireActiveBrand } from "@/server/auth/guard";
import { getDb, schema } from "@/server/db/client";
import { performanceDataset, summarize } from "@/server/agents/analytics";
import { AnalyticsView } from "@/components/analytics/view";

export default async function Page({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const sp = await searchParams;
  const days = [7, 30, 90].includes(Number(sp.days)) ? Number(sp.days) : 30;
  const { brand, role } = await requireActiveBrand();
  const db = await getDb();
  const accounts = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.brandId, brand.id));
  const data = await performanceDataset(brand.id, days);
  const accountMetrics = accounts.length
    ? await db.select().from(schema.accountMetrics).where(inArray(schema.accountMetrics.socialAccountId, accounts.map((a) => a.id))).orderBy(desc(schema.accountMetrics.date)).limit(200)
    : [];
  const postIds = data.map((d) => d.postId);
  const posts = postIds.length ? await db.select({ id: schema.posts.id, title: schema.posts.title, creativeId: schema.posts.creativeId, externalUrl: schema.posts.externalUrl }).from(schema.posts).where(inArray(schema.posts.id, postIds)) : [];
  return (
    <AnalyticsView
      brandId={brand.id}
      role={role}
      days={days}
      accounts={accounts.map((a) => ({ id: a.id, platform: a.platform, name: a.name }))}
      accountMetrics={accountMetrics.map((m) => ({ accountId: m.socialAccountId, date: m.date, followers: m.followers, profileVisits: m.profileVisits, reach: m.reach }))}
      data={data.map((d) => ({ ...d, publishedAt: d.publishedAt?.toISOString() ?? null, ...(posts.find((p) => p.id === d.postId) ?? {}) }))}
      summary={summarize(data)}
    />
  );
}
