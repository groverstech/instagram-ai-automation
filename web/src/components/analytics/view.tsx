"use client";
import Link from "next/link";
import { useState } from "react";
import { format } from "date-fns";
import { BarChart3, ExternalLink, RefreshCw, Sparkles } from "lucide-react";
import { analyzeAction } from "@/app/actions/ai";
import { syncMetricsAction } from "@/app/actions/posts";
import { Badge, Button, Card, CardBody, CardHeader, Empty, Notice, PageHeader } from "@/components/ui";
import { CreativeThumb, PlatformTag, SourceTag } from "@/components/bits";
import { useRun } from "@/components/hooks";
import { roleAtLeast, type Role } from "@/lib/roles";
import { compact, pct } from "@/lib/utils";
import { platformLabel, styleById } from "@/lib/domain";
import type { Insights } from "@/server/agents/schemas";

type Group = { key: string; posts: number; avgReach: number; avgEngagementRate: number | null };
type Row = {
  postId: string;
  platform: string;
  pillar: string | null;
  reach: number | null;
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  videoViews: number | null;
  engagementRate: number | null;
  publishedAt: string | null;
  title?: string | null;
  creativeId?: string | null;
  externalUrl?: string | null;
};

export function AnalyticsView(props: {
  brandId: string;
  role: Role;
  days: number;
  accounts: { id: string; platform: string; name: string }[];
  accountMetrics: { accountId: string; date: string; followers: number | null; profileVisits: number | null; reach: number | null }[];
  data: Row[];
  summary: { posts: number; byPillar: Group[]; byStyle: Group[]; byPlatform: Group[]; byHour: Group[]; byCampaign: Group[]; byCaptionLength: Group[] };
}) {
  const { run, busy } = useRun();
  const [insights, setInsights] = useState<{ insights: Insights; posts: number } | null>(null);
  const canEdit = roleAtLeast(props.role, "editor");
  const d = props.data;
  const sum = (k: keyof Row) => d.reduce((s, r) => s + (typeof r[k] === "number" ? (r[k] as number) : 0), 0);
  const has = (k: keyof Row) => d.some((r) => typeof r[k] === "number");
  const ers = d.filter((r) => r.engagementRate != null);
  const avgEr = ers.length ? ers.reduce((s, r) => s + r.engagementRate!, 0) / ers.length : null;

  const latestFollowers = props.accounts.map((a) => {
    const rows = props.accountMetrics.filter((m) => m.accountId === a.id && m.followers != null);
    return { ...a, followers: rows[0]?.followers ?? null, date: rows[0]?.date };
  });

  const tiles = [
    { label: "Reach", value: has("reach") ? compact(sum("reach")) : null },
    { label: "Impressions / views", value: has("impressions") ? compact(sum("impressions")) : null },
    { label: "Engagement rate", value: avgEr != null ? pct(avgEr) : null },
    { label: "Likes", value: has("likes") ? compact(sum("likes")) : null },
    { label: "Comments", value: has("comments") ? compact(sum("comments")) : null },
    { label: "Shares", value: has("shares") ? compact(sum("shares")) : null },
    { label: "Saves", value: has("saves") ? compact(sum("saves")) : null },
    { label: "Video views", value: has("videoViews") ? compact(sum("videoViews")) : null },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="AI Performance Analyst"
        title="Analytics"
        description="Real metrics from your connected accounts. AI insights are clearly marked and only use the data shown here."
        actions={
          <>
            <div className="flex rounded-lg border border-line bg-sunken p-0.5">
              {[7, 30, 90].map((n) => (
                <Link key={n} href={`/analytics?days=${n}`} className={`rounded-md px-3 py-1 text-[12px] font-medium ${props.days === n ? "bg-surface shadow-sm" : "text-muted"}`}>
                  {n}d
                </Link>
              ))}
            </div>
            {canEdit && props.accounts.length ? (
              <Button variant="secondary" loading={busy("sync")} onClick={() => run(() => syncMetricsAction(props.brandId), { key: "sync", success: (r) => `Synced ${r.posts} posts and ${r.accounts} accounts${r.errors.length ? ` · ${r.errors.length} errors` : ""}` })}>
                <RefreshCw /> Sync metrics
              </Button>
            ) : null}
            {canEdit ? (
              <Button variant="accent" loading={busy("ai")} onClick={() => run(() => analyzeAction(props.brandId, props.days), { key: "ai", onOk: setInsights, refresh: false })}>
                <Sparkles /> Analyse with AI
              </Button>
            ) : null}
          </>
        }
      />

      {!props.accounts.length ? (
        <Notice tone="info" className="mb-6">
          No social accounts are connected, so there is no performance data yet. <Link href="/accounts" className="font-medium underline">Connect an account</Link> and publish through BrandPilot to start measuring.
        </Notice>
      ) : null}

      {insights ? <InsightsCard data={insights.insights} posts={insights.posts} /> : null}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label} className="p-4">
            <p className="text-[12px] text-muted">{t.label}</p>
            <p className="mt-1 text-[26px] font-semibold tracking-tight">{t.value ?? <span className="text-faint">—</span>}</p>
            <p className="mt-0.5 text-[11px] text-faint">{t.value ? `${d.length} posts · ${props.days}d` : "Not available"}</p>
          </Card>
        ))}
      </div>

      {latestFollowers.length ? (
        <Card className="mb-6">
          <CardHeader title="Audience" action={<SourceTag source="platform" />} />
          <CardBody className="grid gap-3 md:grid-cols-3">
            {latestFollowers.map((a) => (
              <div key={a.id} className="rounded-xl border border-line p-4">
                <PlatformTag platform={a.platform} />
                <p className="mt-1 text-[13px] text-muted">{a.name}</p>
                <p className="mt-2 text-[24px] font-semibold">{a.followers != null ? compact(a.followers) : <span className="text-faint">—</span>}</p>
                <p className="text-[11px] text-faint">{a.date ? `Followers · synced ${a.date}` : "Not synced yet"}</p>
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {d.length ? (
        <>
          <div className="mb-6 grid gap-6 lg:grid-cols-2">
            <Breakdown title="By content pillar" groups={props.summary.byPillar} />
            <Breakdown title="By creative style" groups={props.summary.byStyle} label={(k) => styleById(k).label} />
            <Breakdown title="By posting time" groups={props.summary.byHour} />
            <Breakdown title="By caption length" groups={props.summary.byCaptionLength} />
            <Breakdown title="By platform" groups={props.summary.byPlatform} label={platformLabel} />
            <Breakdown title="By campaign" groups={props.summary.byCampaign} />
          </div>
          <Card>
            <CardHeader title="Published posts" action={<SourceTag source="platform" />} />
            <CardBody className="overflow-x-auto pt-3">
              <table className="w-full text-left text-[13px]">
                <thead className="text-[11px] uppercase tracking-wider text-faint">
                  <tr>
                    {["Post", "Published", "Reach", "Likes", "Comments", "Saves", "Shares", "ER"].map((h) => <th key={h} className="py-2 pr-4 font-semibold">{h}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {[...d].sort((a, b) => (b.engagementRate ?? 0) - (a.engagementRate ?? 0)).map((r) => (
                    <tr key={r.postId}>
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-2.5">
                          {r.creativeId ? <CreativeThumb id={r.creativeId} className="size-9 rounded-md" /> : null}
                          <div className="min-w-0">
                            <p className="max-w-[240px] truncate font-medium">{r.title ?? "Post"}</p>
                            <PlatformTag platform={r.platform} />
                          </div>
                          {r.externalUrl ? <a href={r.externalUrl} target="_blank" rel="noreferrer" className="text-faint hover:text-ink"><ExternalLink className="size-3.5" /></a> : null}
                        </div>
                      </td>
                      <td className="py-2.5 pr-4 text-muted">{r.publishedAt ? format(new Date(r.publishedAt), "d MMM HH:mm") : "—"}</td>
                      <td className="py-2.5 pr-4 tabular-nums">{compact(r.reach)}</td>
                      <td className="py-2.5 pr-4 tabular-nums">{compact(r.likes)}</td>
                      <td className="py-2.5 pr-4 tabular-nums">{compact(r.comments)}</td>
                      <td className="py-2.5 pr-4 tabular-nums">{compact(r.saves)}</td>
                      <td className="py-2.5 pr-4 tabular-nums">{compact(r.shares)}</td>
                      <td className="py-2.5 pr-4 tabular-nums font-medium">{pct(r.engagementRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          </Card>
        </>
      ) : (
        <Empty icon={<BarChart3 />} title="No platform metrics in this period">
          Metrics come only from posts published through BrandPilot to a connected account, synced from the platform&apos;s API. Nothing here is estimated.
        </Empty>
      )}
    </div>
  );
}

/** Single-series ranked bars: one hue, value printed beside every bar, hover shows detail. */
function Breakdown({ title, groups, label = (k) => k }: { title: string; groups: Group[]; label?: (k: string) => string }) {
  const max = Math.max(...groups.map((g) => g.avgEngagementRate ?? 0), 0.0001);
  return (
    <Card>
      <CardHeader title={title} description="Average engagement rate" />
      <CardBody className="space-y-2.5">
        {groups.length ? (
          groups.slice(0, 8).map((g) => (
            <div key={g.key} className="group grid grid-cols-[140px_1fr_64px] items-center gap-3 text-[12px]" title={`${label(g.key)} · ${g.posts} posts · avg reach ${compact(g.avgReach)} · ER ${pct(g.avgEngagementRate)}`}>
              <span className="truncate text-ink-2">{label(g.key)}</span>
              <div className="h-2.5 rounded-r bg-sunken">
                <div className="h-full rounded-r bg-accent transition-opacity group-hover:opacity-80" style={{ width: `${((g.avgEngagementRate ?? 0) / max) * 100}%`, minWidth: 2 }} />
              </div>
              <span className="text-right tabular-nums text-ink">
                {pct(g.avgEngagementRate)} <span className="text-faint">· {g.posts}</span>
              </span>
            </div>
          ))
        ) : (
          <p className="text-[13px] text-muted">Not enough data.</p>
        )}
      </CardBody>
    </Card>
  );
}

function InsightsCard({ data, posts }: { data: Insights; posts: number }) {
  const tone = { high: "success", medium: "info", low: "neutral" } as const;
  return (
    <Card className="mb-6 overflow-hidden">
      <div className="ai-gradient p-5">
        <div className="flex items-center gap-2">
          <SourceTag source="ai" />
          <span className="text-[12px] text-ink-2">Based on {posts} posts with platform metrics</span>
        </div>
        <p className="mt-2 font-display text-[24px] leading-snug">{data.summary}</p>
      </div>
      <CardBody className="grid gap-6 lg:grid-cols-3">
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">Findings</p>
          <div className="space-y-3">
            {data.findings.map((f) => (
              <div key={f.title}>
                <div className="flex items-center gap-2">
                  <p className="text-[13px] font-medium">{f.title}</p>
                  <Badge tone={tone[f.confidence]}>{f.confidence}</Badge>
                </div>
                <p className="text-[12px] text-muted">{f.detail}</p>
                <p className="text-[11px] text-faint">Evidence: {f.evidence}</p>
              </div>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">Recommendations</p>
          <div className="space-y-3">
            {data.recommendations.map((r) => (
              <div key={r.action}>
                <p className="text-[13px] font-medium">{r.action}</p>
                <p className="text-[12px] text-muted">{r.why}</p>
                <p className="text-[11px] text-faint">Expected: {r.expectedImpact}</p>
              </div>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">Create next</p>
          <div className="space-y-3">
            {data.nextContent.map((n) => (
              <div key={n.title}>
                <p className="text-[13px] font-medium">{n.title}</p>
                <p className="text-[12px] text-muted">{platformLabel(n.platform)} · {n.pillar}</p>
                <p className="text-[12px]">{n.why}</p>
              </div>
            ))}
          </div>
        </div>
        <p className="text-[12px] text-faint lg:col-span-3">{data.dataNotes}</p>
      </CardBody>
    </Card>
  );
}
