"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { differenceInCalendarDays, format } from "date-fns";
import { Palette, Pause, Play, Sparkles, Trash2 } from "lucide-react";
import { deleteCampaign, producePostAction, setCampaignStatus } from "@/app/actions/ai";
import { Badge, Button, Card, CardBody, CardHeader, PageHeader, Select } from "@/components/ui";
import { CreativeThumb, PlatformTag, Rationale, SourceTag, StatusBadge } from "@/components/bits";
import { useRun } from "@/components/hooks";
import { STYLES } from "@/lib/domain";
import { roleAtLeast, type Role } from "@/lib/roles";
import { compact, pct } from "@/lib/utils";

type Brief = { userBrief?: string; theme?: string; bigIdea?: string; audience?: string; keyMessages?: string[]; phases?: { name: string; startDay: number; endDay: number; goal: string }[]; kpis?: string[]; rationale?: string };
type P = { id: string; title: string | null; platform: string; format: string; pillar: string | null; status: string; scheduledAt: Date | null; creativeId: string | null; caption: string | null; metrics: { reach: number | null; likes: number | null; comments: number | null; saves: number | null; engagementRate: number | null } | null };

export function CampaignDetail({ brandId, role, campaign, posts }: { brandId: string; role: Role; campaign: { id: string; name: string; type: string; objective: string; status: string; startDate: Date; endDate: Date; brief: Brief }; posts: P[] }) {
  const { run, busy } = useRun();
  const router = useRouter();
  const [style, setStyle] = useState("premium_editorial");
  const canEdit = roleAtLeast(role, "editor");
  const b = campaign.brief;
  const total = differenceInCalendarDays(campaign.endDate, campaign.startDate) + 1;
  const withMetrics = posts.filter((p) => p.metrics);
  const reach = withMetrics.reduce((s, p) => s + (p.metrics!.reach ?? 0), 0);
  const ers = withMetrics.filter((p) => p.metrics!.engagementRate != null);
  const er = ers.length ? ers.reduce((s, p) => s + p.metrics!.engagementRate!, 0) / ers.length : null;

  return (
    <div>
      <PageHeader
        eyebrow={`${campaign.type} campaign · ${campaign.objective}`}
        title={campaign.name}
        description={`${format(campaign.startDate, "d MMM")} – ${format(campaign.endDate, "d MMM yyyy")} · ${posts.length} posts`}
        actions={
          canEdit ? (
            <>
              {campaign.status === "active" ? (
                <Button variant="secondary" loading={busy("st")} onClick={() => run(() => setCampaignStatus(brandId, campaign.id, "paused"), { key: "st" })}><Pause /> Pause</Button>
              ) : (
                <Button variant="secondary" loading={busy("st")} onClick={() => run(() => setCampaignStatus(brandId, campaign.id, "active"), { key: "st", success: "Campaign marked active" })}><Play /> Mark active</Button>
              )}
              {roleAtLeast(role, "admin") ? (
                <Button variant="danger" loading={busy("del")} onClick={() => confirm("Delete this campaign and its draft posts?") && run(() => deleteCampaign(brandId, campaign.id), { key: "del", success: "Campaign deleted", onOk: () => router.push("/campaigns") })}><Trash2 /></Button>
              ) : null}
            </>
          ) : null
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="overflow-hidden lg:col-span-2">
          <div className="ai-gradient p-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-2/70">Big idea · {b.theme}</p>
            <p className="mt-2 font-display text-[28px] leading-[1.2]">{b.bigIdea}</p>
            {b.audience ? <p className="mt-2 text-[13px] text-ink-2">For: {b.audience}</p> : null}
          </div>
          <CardBody className="space-y-5">
            {b.keyMessages?.length ? (
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">Key messages</p>
                <div className="flex flex-wrap gap-2">{b.keyMessages.map((m) => <span key={m} className="rounded-lg bg-sunken px-3 py-1.5 text-[13px]">{m}</span>)}</div>
              </div>
            ) : null}
            {b.phases?.length ? (
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">Timeline</p>
                <div className="relative h-14 rounded-xl bg-sunken">
                  {b.phases.map((ph, i) => (
                    <div
                      key={ph.name}
                      title={ph.goal}
                      className="absolute top-1.5 bottom-1.5 flex flex-col justify-center overflow-hidden rounded-lg px-2.5 text-[11px] text-white"
                      style={{ left: `${(ph.startDay / total) * 100}%`, width: `calc(${((ph.endDay - ph.startDay + 1) / total) * 100}% - 4px)`, background: ["#1b1a17", "#5b4fd1", "#b08d57", "#5fae8c", "#e08a5f"][i % 5] }}
                    >
                      <span className="truncate font-medium">{ph.name}</span>
                      <span className="truncate opacity-75">{ph.goal}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {b.userBrief ? <p className="text-[12px] text-faint">Original brief: {b.userBrief}</p> : null}
          </CardBody>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Performance" action={withMetrics.length ? <SourceTag source="platform" /> : null} />
            <CardBody>
              {withMetrics.length ? (
                <div className="grid grid-cols-2 gap-3">
                  <div><p className="text-[11px] text-faint">Reach</p><p className="text-[22px] font-semibold">{compact(reach)}</p></div>
                  <div><p className="text-[11px] text-faint">Avg. engagement</p><p className="text-[22px] font-semibold">{pct(er)}</p></div>
                </div>
              ) : (
                <p className="text-[13px] text-muted">Metrics appear after posts are published and synced from the platform.</p>
              )}
            </CardBody>
          </Card>
          {b.kpis?.length ? (
            <Card>
              <CardHeader title="Target KPIs" />
              <CardBody><ul className="space-y-1 text-[13px]">{b.kpis.map((k) => <li key={k}>· {k}</li>)}</ul></CardBody>
            </Card>
          ) : null}
        </div>
      </div>

      <Card className="mt-6">
        <CardHeader
          title="Post plan"
          description="Posts without creatives can be produced by the Creative Director + Copywriter"
          action={
            canEdit ? (
              <div className="flex items-center gap-2">
                <Select value={style} onChange={(e) => setStyle(e.target.value)} className="h-8 w-48 text-[12px]">
                  {STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </Select>
                <Link href="/calendar" className="text-[12px] font-medium text-muted hover:text-ink">Calendar →</Link>
              </div>
            ) : null
          }
        />
        <CardBody className="pt-3">
          <ul className="divide-y divide-line">
            {posts.map((p) => (
              <li key={p.id} className="flex items-center gap-4 py-3">
                <div className="w-20 shrink-0 text-[12px]">
                  <p className="font-medium">{p.scheduledAt ? format(p.scheduledAt, "EEE d MMM") : "—"}</p>
                  <p className="text-faint">{p.scheduledAt ? format(p.scheduledAt, "HH:mm") : ""}</p>
                </div>
                {p.creativeId ? <CreativeThumb id={p.creativeId} className="size-12 rounded-lg" /> : <div className="grid size-12 place-items-center rounded-lg border border-dashed border-line-strong text-faint"><Palette className="size-4" /></div>}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{p.title}</p>
                  <div className="flex items-center gap-3 text-[12px] text-muted">
                    <PlatformTag platform={p.platform} />
                    {p.pillar ? <Badge>{p.pillar}</Badge> : null}
                    {p.caption ? <span className="truncate">{p.caption.slice(0, 70)}</span> : <span className="text-faint">No caption yet</span>}
                  </div>
                </div>
                {p.metrics ? <span className="text-[12px] text-muted">{compact(p.metrics.reach)} reach</span> : null}
                <StatusBadge status={p.status} />
                {canEdit && !p.creativeId ? (
                  <Button size="sm" variant="ai" loading={busy(p.id)} onClick={() => run(() => producePostAction(brandId, p.id, style), { key: p.id, success: "Creative and caption produced" })}>
                    <Sparkles /> Produce
                  </Button>
                ) : (
                  <Link href={`/calendar?post=${p.id}`} className="text-[12px] font-medium text-muted hover:text-ink">Open</Link>
                )}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
      <Rationale>{b.rationale}</Rationale>
    </div>
  );
}
