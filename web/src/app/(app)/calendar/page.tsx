import { and, desc, eq, gte, lte } from "drizzle-orm";
import { addDays, endOfMonth, endOfWeek, format, parse, startOfMonth, startOfWeek } from "date-fns";
import { requireActiveBrand } from "@/server/auth/guard";
import { getDb, schema } from "@/server/db/client";
import { CalendarView } from "@/components/calendar/view";
import { PROVIDERS } from "@/server/social/registry";

export default async function Page({ searchParams }: { searchParams: Promise<{ m?: string; post?: string }> }) {
  const sp = await searchParams;
  const { brand, role } = await requireActiveBrand();
  const month = sp.m && /^\d{4}-\d{2}$/.test(sp.m) ? parse(`${sp.m}-01`, "yyyy-MM-dd", new Date()) : startOfMonth(new Date());
  const from = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
  const to = addDays(endOfWeek(endOfMonth(month), { weekStartsOn: 1 }), 1);
  const db = await getDb();
  const [posts, accounts, creatives, campaigns] = await Promise.all([
    db.select().from(schema.posts).where(and(eq(schema.posts.brandId, brand.id), gte(schema.posts.scheduledAt, from), lte(schema.posts.scheduledAt, to))),
    db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.brandId, brand.id)),
    db.select({ id: schema.creatives.id, format: schema.creatives.format, status: schema.creatives.status, concept: schema.creatives.concept }).from(schema.creatives).where(eq(schema.creatives.brandId, brand.id)).orderBy(desc(schema.creatives.createdAt)).limit(60),
    db.select({ id: schema.campaigns.id, name: schema.campaigns.name }).from(schema.campaigns).where(eq(schema.campaigns.brandId, brand.id)),
  ]);
  let focus = sp.post ? posts.find((p) => p.id === sp.post) : undefined;
  if (sp.post && !focus) {
    const [p] = await db.select().from(schema.posts).where(and(eq(schema.posts.id, sp.post), eq(schema.posts.brandId, brand.id)));
    if (p) focus = p;
  }
  const all = focus && !posts.some((p) => p.id === focus!.id) ? [...posts, focus] : posts;
  return (
    <CalendarView
      key={format(month, "yyyy-MM")}
      brandId={brand.id}
      role={role}
      month={format(month, "yyyy-MM")}
      platforms={brand.platforms}
      initialPost={focus?.id}
      campaigns={campaigns}
      accounts={accounts.map((a) => ({ id: a.id, platform: a.platform, name: a.name, handle: a.handle, status: a.status, canPublish: PROVIDERS[a.platform]?.capabilities.publishImage ?? "unsupported" }))}
      creatives={creatives.map((c) => ({ id: c.id, format: c.format, status: c.status, title: String((c.concept as { title?: string }).title ?? "Creative") }))}
      posts={all.map((p) => ({
        id: p.id,
        title: p.title,
        platform: p.platform,
        format: p.format,
        pillar: p.pillar,
        objective: p.objective,
        status: p.status,
        scheduledAt: p.scheduledAt?.toISOString() ?? null,
        caption: p.caption,
        hashtags: p.hashtags,
        creativeId: p.creativeId,
        campaignId: p.campaignId,
        socialAccountId: p.socialAccountId,
        externalUrl: p.externalUrl,
        publishError: p.publishError,
        rationale: p.rationale,
        brief: String((p.copy as { brief?: string }).brief ?? ""),
        hooks: ((p.copy as { hooks?: string[] }).hooks ?? []) as string[],
        alternatives: ((p.copy as { alternatives?: string[] }).alternatives ?? []) as string[],
      }))}
    />
  );
}
