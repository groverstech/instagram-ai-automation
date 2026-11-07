import Link from "next/link";
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { format, formatDistanceToNow, subDays } from "date-fns";
import { ArrowRight, Brain, CalendarDays, CheckCircle2, CircleDashed, Megaphone, Palette, Share2, Sparkles, XCircle } from "lucide-react";
import { requireActiveBrand } from "@/server/auth/guard";
import { getDb, schema } from "@/server/db/client";
import { latestProfile } from "@/server/agents/context";
import { latestStrategy } from "@/server/agents/strategy";
import { recentRuns } from "@/server/agents/orchestrator";
import { performanceDataset, summarize } from "@/server/agents/analytics";
import { Badge, Card, CardBody, CardHeader, Empty } from "@/components/ui";
import { CreativeThumb, PlatformTag, SourceTag, StatusBadge } from "@/components/bits";
import { AskButton } from "@/components/dashboard/ask";
import type { BrandProfile, Strategy } from "@/server/agents/schemas";
import { compact, pct } from "@/lib/utils";

export default async function Dashboard() {
  const { brand, session } = await requireActiveBrand();
  const db = await getDb();
  const now = new Date();
  const [{ latest, approved }, strategy, upcoming, campaigns, creatives, approvals, runs, accounts, perf] = await Promise.all([
    latestProfile(brand.id),
    latestStrategy(brand.id),
    db.select().from(schema.posts).where(and(eq(schema.posts.brandId, brand.id), gte(schema.posts.scheduledAt, now))).orderBy(asc(schema.posts.scheduledAt)).limit(6),
    db.select().from(schema.campaigns).where(and(eq(schema.campaigns.brandId, brand.id), inArray(schema.campaigns.status, ["planning", "active"]))).orderBy(desc(schema.campaigns.createdAt)).limit(4),
    db.select().from(schema.creatives).where(eq(schema.creatives.brandId, brand.id)).orderBy(desc(schema.creatives.createdAt)).limit(6),
    db.select().from(schema.posts).where(and(eq(schema.posts.brandId, brand.id), eq(schema.posts.status, "pending_approval"))).orderBy(asc(schema.posts.scheduledAt)).limit(5),
    recentRuns(brand.id, 8),
    db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.brandId, brand.id)),
    performanceDataset(brand.id, 30),
  ]);
  const profile = (approved ?? latest)?.data as BrandProfile | undefined;
  const strat = strategy?.data as Strategy | undefined;
  const summary = summarize(perf);
  const totalReach = perf.reduce((s, p) => s + (p.reach ?? 0), 0);
  const ers = perf.filter((p) => p.engagementRate != null);
  const avgEr = ers.length ? ers.reduce((s, p) => s + p.engagementRate!, 0) / ers.length : null;

  const steps = [
    { done: Boolean(latest), label: "Generate brand intelligence", href: "/brand" },
    { done: Boolean(approved), label: "Approve your brand profile", href: "/brand" },
    { done: Boolean(strategy), label: "Create this month's strategy", href: "/strategist" },
    { done: accounts.length > 0, label: "Connect a social account", href: "/accounts" },
    { done: upcoming.length > 0, label: "Plan your content calendar", href: "/calendar" },
  ];
  const progress = steps.filter((s) => s.done).length;

  const recs = [
    ...(strat?.campaignIdeas ?? []).slice(0, 2).map((c) => ({ title: c.name, body: c.concept, prompt: `Create a 14-day campaign: ${c.name}. ${c.concept}` })),
    ...(profile?.contentOpportunities ?? []).slice(0, 3).map((o) => ({ title: o.title, body: o.why, prompt: `Generate three creatives for: ${o.title}` })),
    ...(strat?.moments ?? []).filter((m) => new Date(m.date) >= subDays(now, 1)).slice(0, 2).map((m) => ({ title: `${m.name} · ${m.date}`, body: m.idea, prompt: `Generate five premium creatives for ${m.name}: ${m.idea}` })),
  ].slice(0, 5);

  const hour = now.getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{format(now, "EEEE, MMMM d")}</p>
          <h1 className="mt-1 font-display text-[38px] leading-tight">
            {greet}, {session.user.name.split(" ")[0]}
          </h1>
          <p className="mt-1 text-muted">Here&apos;s what your AI marketing team is working on for {brand.name}.</p>
        </div>
        <AskButton prompt="Create a weekly content calendar">
          <Sparkles /> Ask your team
        </AskButton>
      </div>

      {progress < steps.length ? (
        <Card className="overflow-hidden">
          <div className="grid gap-0 md:grid-cols-[1fr_1.4fr]">
            <div className="ai-gradient p-6">
              <p className="text-[12px] font-medium text-ink-2">Setup</p>
              <p className="mt-1 font-display text-[28px] leading-tight">
                {progress} of {steps.length} complete
              </p>
              <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/70">
                <div className="h-full rounded-full bg-ink" style={{ width: `${(progress / steps.length) * 100}%` }} />
              </div>
            </div>
            <ul className="divide-y divide-line">
              {steps.map((s) => (
                <li key={s.label}>
                  <Link href={s.href} className="flex items-center gap-3 px-5 py-3 text-[13px] hover:bg-sunken/40">
                    {s.done ? <CheckCircle2 className="size-4 text-success" /> : <CircleDashed className="size-4 text-faint" />}
                    <span className={s.done ? "text-muted line-through" : ""}>{s.label}</span>
                    {!s.done ? <ArrowRight className="ml-auto size-4 text-faint" /> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Brand overview" description={profile ? profile.summary : "Your Brand Intelligence Profile will appear here."} action={<Badge tone={approved ? "success" : latest ? "warn" : "neutral"}>{approved ? "Approved" : latest ? "Draft profile" : "Not generated"}</Badge>} />
          <CardBody>
            {profile ? (
              <div className="grid gap-5 md:grid-cols-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">Positioning</p>
                  <p className="mt-1 text-[13px]">{profile.positioning.statement}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">Voice</p>
                  <p className="mt-1 text-[13px]">{profile.voice.description}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">Palette</p>
                  <div className="mt-2 flex gap-1.5">
                    {profile.visualIdentity.palette.slice(0, 6).map((c) => (
                      <span key={c.hex} title={`${c.name} · ${c.usage}`} className="size-7 rounded-lg border border-black/5" style={{ background: c.hex }} />
                    ))}
                  </div>
                </div>
                {strat ? (
                  <div className="md:col-span-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">Content pillars · {strategy?.month}</p>
                    <div className="mt-2 flex h-2 overflow-hidden rounded-full">
                      {strat.pillars.map((p, i) => (
                        <div key={p.name} style={{ width: `${p.sharePercent}%`, background: ["#1b1a17", "#5b4fd1", "#b08d57", "#7cc5a8", "#f0a37c"][i % 5] }} />
                      ))}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
                      {strat.pillars.map((p, i) => (
                        <span key={p.name} className="flex items-center gap-1.5">
                          <span className="size-2 rounded-full" style={{ background: ["#1b1a17", "#5b4fd1", "#b08d57", "#7cc5a8", "#f0a37c"][i % 5] }} />
                          {p.name} {p.sharePercent}%
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <Empty icon={<Brain />} title="Let the Brand Intelligence agent study your brand" action={<Link className="text-[13px] font-medium underline-offset-4 hover:underline" href="/brand">Go to My Brand →</Link>} />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="AI recommendations" description="From your brand profile and strategy" action={<SourceTag source="ai" />} />
          <CardBody className="space-y-2">
            {recs.length ? (
              recs.map((r) => (
                <div key={r.title} className="rounded-xl border border-line p-3">
                  <p className="text-[13px] font-medium">{r.title}</p>
                  <p className="mt-0.5 line-clamp-2 text-[12px] text-muted">{r.body}</p>
                  <AskButton prompt={r.prompt} variant="link">
                    Do this <ArrowRight className="size-3" />
                  </AskButton>
                </div>
              ))
            ) : (
              <p className="text-[13px] text-muted">Generate your brand profile and strategy to get tailored recommendations.</p>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Upcoming posts" action={<Link href="/calendar" className="text-[12px] font-medium text-muted hover:text-ink">Open calendar →</Link>} />
          <CardBody className="pt-3">
            {upcoming.length ? (
              <ul className="divide-y divide-line">
                {upcoming.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 py-2.5">
                    {p.creativeId ? <CreativeThumb id={p.creativeId} className="size-11 rounded-lg" /> : <div className="grid size-11 place-items-center rounded-lg bg-sunken text-faint"><Palette className="size-4" /></div>}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{p.title ?? p.caption?.slice(0, 60) ?? "Untitled post"}</p>
                      <div className="mt-0.5 flex items-center gap-3 text-[12px] text-muted">
                        <PlatformTag platform={p.platform} />
                        {p.pillar ? <span>{p.pillar}</span> : null}
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-[12px] font-medium">{p.scheduledAt ? format(p.scheduledAt, "EEE d MMM · HH:mm") : "—"}</p>
                      <div className="mt-0.5">
                        <StatusBadge status={p.status} />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty icon={<CalendarDays />} title="Nothing scheduled yet">
                Ask the Content Strategist to populate your calendar from your strategy.
              </Empty>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Pending approvals" description="Nothing publishes without sign-off" />
          <CardBody className="pt-3">
            {approvals.length ? (
              <ul className="space-y-2">
                {approvals.map((p) => (
                  <li key={p.id}>
                    <Link href={`/calendar?post=${p.id}`} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-sunken">
                      <PlatformTag platform={p.platform} className="w-24 shrink-0" />
                      <span className="truncate">{p.title ?? p.caption?.slice(0, 50)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted">You&apos;re all caught up.</p>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader title="Active campaigns" action={<Link href="/campaigns" className="text-[12px] font-medium text-muted hover:text-ink">All →</Link>} />
          <CardBody className="space-y-2 pt-3">
            {campaigns.length ? (
              campaigns.map((c) => (
                <Link key={c.id} href={`/campaigns/${c.id}`} className="block rounded-xl border border-line p-3 transition hover:border-line-strong">
                  <div className="flex items-center justify-between">
                    <p className="text-[13px] font-medium">{c.name}</p>
                    <Badge tone={c.status === "active" ? "success" : "neutral"} className="capitalize">{c.status}</Badge>
                  </div>
                  <p className="mt-0.5 text-[12px] text-muted">
                    {format(c.startDate, "d MMM")} – {format(c.endDate, "d MMM")} · {c.objective}
                  </p>
                </Link>
              ))
            ) : (
              <Empty icon={<Megaphone />} title="No campaigns yet" />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Content performance" description="Last 30 days" action={perf.length ? <SourceTag source="platform" /> : null} />
          <CardBody className="pt-3">
            {perf.length ? (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3">
                  <Stat label="Posts" value={String(perf.length)} />
                  <Stat label="Reach" value={compact(totalReach)} />
                  <Stat label="Avg. ER" value={pct(avgEr)} />
                </div>
                {summary.byPillar[0] ? (
                  <p className="text-[12px] text-muted">
                    Top pillar: <span className="font-medium text-ink">{summary.byPillar[0].key}</span> ({pct(summary.byPillar[0].avgEngagementRate)} ER)
                  </p>
                ) : null}
              </div>
            ) : (
              <Empty icon={<Share2 />} title="No platform metrics yet">
                {accounts.length ? "Metrics appear once published posts have been synced." : "Connect an account to see real performance."}
              </Empty>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Agent activity" />
          <CardBody className="pt-3">
            {runs.length ? (
              <ul className="space-y-2.5">
                {runs.map((r) => (
                  <li key={r.id} className="flex items-start gap-2.5 text-[12px]">
                    {r.status === "succeeded" ? <CheckCircle2 className="mt-0.5 size-3.5 text-success" /> : r.status === "failed" ? <XCircle className="mt-0.5 size-3.5 text-danger" /> : <CircleDashed className="mt-0.5 size-3.5 animate-spin text-accent" />}
                    <div className="min-w-0">
                      <p>
                        <span className="font-medium">{r.agentName}</span> <span className="text-muted">· {r.task}</span>
                      </p>
                      <p className="text-faint">{formatDistanceToNow(r.startedAt, { addSuffix: true })}{r.error ? ` · ${r.error.slice(0, 80)}` : ""}</p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted">Agent runs will appear here.</p>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Recent creatives" action={<Link href="/creative-studio" className="text-[12px] font-medium text-muted hover:text-ink">Creative Studio →</Link>} />
        <CardBody>
          {creatives.length ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {creatives.map((c) => (
                <Link key={c.id} href={`/creative-studio?c=${c.id}`} className="group overflow-hidden rounded-xl border border-line">
                  <CreativeThumb id={c.id} className="aspect-square w-full transition group-hover:scale-[1.02]" />
                </Link>
              ))}
            </div>
          ) : (
            <Empty icon={<Palette />} title="No creatives yet">
              Generate on-brand creatives in the Creative Studio.
            </Empty>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] text-faint">{label}</p>
      <p className="text-[20px] font-semibold tracking-tight">{value}</p>
    </div>
  );
}
