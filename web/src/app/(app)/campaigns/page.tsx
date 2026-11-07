import Link from "next/link";
import { desc, eq, inArray } from "drizzle-orm";
import { format } from "date-fns";
import { Megaphone } from "lucide-react";
import { requireActiveBrand } from "@/server/auth/guard";
import { getDb, schema } from "@/server/db/client";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { NewCampaign } from "@/components/campaigns/new";
import { roleAtLeast } from "@/lib/roles";

export default async function Page() {
  const { brand, role } = await requireActiveBrand();
  const db = await getDb();
  const campaigns = await db.select().from(schema.campaigns).where(eq(schema.campaigns.brandId, brand.id)).orderBy(desc(schema.campaigns.createdAt));
  const posts = campaigns.length
    ? await db.select({ campaignId: schema.posts.campaignId, status: schema.posts.status }).from(schema.posts).where(inArray(schema.posts.campaignId, campaigns.map((c) => c.id)))
    : [];
  const stats = (id: string) => {
    const ps = posts.filter((p) => p.campaignId === id);
    return { total: ps.length, published: ps.filter((p) => p.status === "published").length, ready: ps.filter((p) => ["approved", "scheduled"].includes(p.status)).length };
  };
  return (
    <div>
      <PageHeader
        eyebrow="Campaign Manager"
        title="Campaigns"
        description="From one brief to a full campaign: big idea, phases, a dated post plan, creatives and captions. You approve before anything goes live."
        actions={roleAtLeast(role, "editor") ? <NewCampaign brandId={brand.id} platforms={brand.platforms} /> : null}
      />
      {campaigns.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {campaigns.map((c) => {
            const s = stats(c.id);
            const brief = c.brief as { bigIdea?: string; theme?: string };
            return (
              <Link key={c.id} href={`/campaigns/${c.id}`}>
                <Card className="h-full p-5 transition hover:-translate-y-0.5 hover:shadow-pop">
                  <div className="flex items-center justify-between">
                    <Badge className="capitalize">{c.type}</Badge>
                    <Badge tone={c.status === "active" ? "success" : c.status === "completed" ? "info" : "neutral"} className="capitalize">{c.status}</Badge>
                  </div>
                  <p className="mt-3 font-display text-[24px] leading-tight">{c.name}</p>
                  <p className="mt-1 line-clamp-2 text-[13px] text-muted">{brief.bigIdea ?? brief.theme}</p>
                  <p className="mt-4 text-[12px] text-ink-2">
                    {format(c.startDate, "d MMM")} – {format(c.endDate, "d MMM yyyy")} · {c.objective}
                  </p>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-sunken">
                    <div className="h-full bg-success" style={{ width: `${s.total ? (s.published / s.total) * 100 : 0}%` }} />
                  </div>
                  <p className="mt-1.5 text-[11px] text-faint">
                    {s.total} posts · {s.ready} approved/scheduled · {s.published} published
                  </p>
                </Card>
              </Link>
            );
          })}
        </div>
      ) : (
        <Empty icon={<Megaphone />} title="No campaigns yet">
          Start with a brief, e.g. &quot;15-day Instagram launch for our new product&quot;.
        </Empty>
      )}
    </div>
  );
}
