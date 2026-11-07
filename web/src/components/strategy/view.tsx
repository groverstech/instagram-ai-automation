"use client";
import { useState } from "react";
import { addMonths, format, parseISO } from "date-fns";
import { CalendarPlus, Check, Compass, Sparkles, TrendingUp, Users } from "lucide-react";
import { approveStrategyAction, generateStrategyAction, planCalendarAction } from "@/app/actions/ai";
import { Badge, Button, Card, CardBody, CardHeader, Empty, Field, Input, Modal, PageHeader, Select } from "@/components/ui";
import { PlatformTag, Rationale } from "@/components/bits";
import { openAssistant } from "@/components/shell/assistant";
import { useRun } from "@/components/hooks";
import type { Strategy } from "@/server/agents/schemas";
import { objectiveLabel } from "@/lib/domain";
import { roleAtLeast, type Role } from "@/lib/roles";

const COLORS = ["#1b1a17", "#5b4fd1", "#b08d57", "#5fae8c", "#e08a5f", "#8a8580"];

export function StrategyView({ brandId, role, platforms, strategies }: { brandId: string; role: Role; platforms: string[]; strategies: { id: string; month: string; status: string; createdAt: Date; data: Strategy }[] }) {
  const [selected, setSelected] = useState(strategies[0]?.id);
  const [month, setMonth] = useState(format(new Date(), "yyyy-MM"));
  const [focus, setFocus] = useState("");
  const [planOpen, setPlanOpen] = useState(false);
  const { run, busy } = useRun();
  const s = strategies.find((x) => x.id === selected) ?? strategies[0];
  const canEdit = roleAtLeast(role, "editor");

  return (
    <div>
      <PageHeader eyebrow="AI Marketing Strategist" title="Strategy" description="Content pillars, platform playbooks, cadence, trends and cultural moments, built from your brand profile and real performance." />

      {canEdit ? (
        <Card className="mb-6">
          <CardBody className="flex flex-wrap items-end gap-3">
            <Field label="Month" className="w-44">
              <Select value={month} onChange={(e) => setMonth(e.target.value)}>
                {[0, 1, 2].map((i) => {
                  const m = addMonths(new Date(), i);
                  return (
                    <option key={i} value={format(m, "yyyy-MM")}>
                      {format(m, "MMMM yyyy")}
                    </option>
                  );
                })}
              </Select>
            </Field>
            <Field label="Focus (optional)" className="min-w-[260px] flex-1">
              <Input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="e.g. launch the winter collection, grow workshop sign-ups" />
            </Field>
            <Button variant="accent" loading={busy("gen")} onClick={() => run(() => generateStrategyAction(brandId, month, focus), { key: "gen", success: "Strategy ready", onOk: (d) => setSelected(d.id) })}>
              <Sparkles /> Generate strategy
            </Button>
          </CardBody>
        </Card>
      ) : null}

      {!s ? (
        <Empty icon={<Compass />} title="No strategy yet">
          Generate a monthly strategy. The strategist uses your approved brand profile, so approve that first for the best results.
        </Empty>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Select value={s.id} onChange={(e) => setSelected(e.target.value)} className="w-64">
                {strategies.map((x) => (
                  <option key={x.id} value={x.id}>
                    {format(parseISO(`${x.month}-01`), "MMMM yyyy")} · {format(x.createdAt, "d MMM HH:mm")}
                  </option>
                ))}
              </Select>
              <Badge tone={s.status === "approved" ? "success" : "warn"}>{s.status === "approved" ? "Approved" : "Draft"}</Badge>
            </div>
            <div className="flex gap-2">
              {s.status !== "approved" && roleAtLeast(role, "admin") ? (
                <Button variant="secondary" loading={busy("approve")} onClick={() => run(() => approveStrategyAction(brandId, s.id), { key: "approve", success: "Strategy approved" })}>
                  <Check /> Approve
                </Button>
              ) : null}
              {canEdit ? (
                <Button onClick={() => setPlanOpen(true)}>
                  <CalendarPlus /> Populate calendar
                </Button>
              ) : null}
            </div>
          </div>

          <Card className="overflow-hidden">
            <div className="ai-gradient p-6 md:p-8">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-2/70">Monthly focus</p>
              <p className="mt-2 max-w-3xl font-display text-[30px] leading-[1.15]">{s.data.monthlyFocus}</p>
              <p className="mt-3 max-w-3xl text-[14px] text-ink-2">{s.data.summary}</p>
            </div>
          </Card>

          <Card>
            <CardHeader title="Content pillars" />
            <CardBody>
              <div className="mb-5 flex h-3 overflow-hidden rounded-full">
                {s.data.pillars.map((p, i) => (
                  <div key={p.name} style={{ width: `${p.sharePercent}%`, background: COLORS[i % COLORS.length] }} title={`${p.name} ${p.sharePercent}%`} />
                ))}
              </div>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                {s.data.pillars.map((p, i) => (
                  <div key={p.name} className="rounded-xl border border-line p-4">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-2 font-medium">
                        <span className="size-2.5 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                        {p.name}
                      </span>
                      <span className="text-[12px] text-muted">{p.sharePercent}%</span>
                    </div>
                    <p className="mt-1.5 text-[12px] text-muted">{p.description}</p>
                    <ul className="mt-2 space-y-0.5 text-[12px]">{p.exampleIdeas.map((x) => <li key={x}>· {x}</li>)}</ul>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Platform playbooks & cadence" />
            <CardBody className="overflow-x-auto pt-3">
              <table className="w-full text-left text-[13px]">
                <thead className="text-[11px] uppercase tracking-wider text-faint">
                  <tr>
                    <th className="py-2 pr-4 font-semibold">Platform</th>
                    <th className="py-2 pr-4 font-semibold">Posts / week</th>
                    <th className="py-2 pr-4 font-semibold">Best times</th>
                    <th className="py-2 pr-4 font-semibold">Formats</th>
                    <th className="py-2 font-semibold">Approach</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {s.data.cadence.map((c) => (
                    <tr key={c.platform} className="align-top">
                      <td className="py-3 pr-4"><PlatformTag platform={c.platform} /></td>
                      <td className="py-3 pr-4 font-medium">{c.postsPerWeek}</td>
                      <td className="py-3 pr-4 text-ink-2">{c.bestTimes.join(", ")}</td>
                      <td className="py-3 pr-4 text-ink-2">{c.formats.join(", ")}</td>
                      <td className="py-3 text-ink-2">{c.approach}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-[12px] text-faint">Best times are AI recommendations until you have enough published posts for Analytics to confirm them.</p>
            </CardBody>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Seasonal & cultural moments" />
              <CardBody className="space-y-3">
                {s.data.moments.length ? (
                  s.data.moments.map((m) => (
                    <div key={m.name + m.date} className="flex gap-3">
                      <div className="w-14 shrink-0 rounded-lg bg-sunken py-1.5 text-center">
                        <p className="text-[10px] uppercase text-faint">{safeFmt(m.date, "MMM")}</p>
                        <p className="text-[16px] font-semibold leading-none">{safeFmt(m.date, "d")}</p>
                      </div>
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium">{m.name}</p>
                        <p className="text-[12px] text-muted">{m.idea}</p>
                        <button onClick={() => openAssistant(`Generate five premium creatives for ${m.name} (${m.date}): ${m.idea}`)} className="mt-1 text-[12px] font-medium text-accent hover:text-accent-ink">
                          Create creatives →
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-[13px] text-muted">No relevant moments this month.</p>
                )}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Trends to use" action={<TrendingUp className="size-4 text-faint" />} />
              <CardBody className="space-y-3">
                {s.data.trends.map((t) => (
                  <div key={t.trend}>
                    <p className="text-[13px] font-medium">{t.trend}</p>
                    <p className="text-[12px] text-muted">{t.relevance}</p>
                    <p className="mt-0.5 text-[12px]">
                      <span className="text-faint">How: </span>
                      {t.howToUse}
                    </p>
                  </div>
                ))}
              </CardBody>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader title="Campaign ideas" />
              <CardBody className="grid gap-3 md:grid-cols-3">
                {s.data.campaignIdeas.map((c) => (
                  <div key={c.name} className="flex flex-col rounded-xl border border-line p-4">
                    <Badge tone="accent" className="self-start">{objectiveLabel(c.objective)}</Badge>
                    <p className="mt-2 font-medium">{c.name}</p>
                    <p className="mt-1 flex-1 text-[12px] text-muted">{c.concept}</p>
                    <button onClick={() => openAssistant(`Create a 14-day campaign called "${c.name}": ${c.concept}`)} className="mt-3 self-start text-[12px] font-medium text-accent hover:text-accent-ink">
                      Turn into campaign →
                    </button>
                  </div>
                ))}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Collaborations" action={<Users className="size-4 text-faint" />} />
              <CardBody className="space-y-3">
                {s.data.collaborations.map((c) => (
                  <div key={c.idea}>
                    <p className="text-[13px] font-medium">{c.type}</p>
                    <p className="text-[12px] text-muted">{c.profile}</p>
                    <p className="text-[12px]">{c.idea}</p>
                  </div>
                ))}
              </CardBody>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <ListCard title="Promotions" items={s.data.promotions} />
            <ListCard title="Engagement tactics" items={s.data.engagementTactics} />
            <ListCard title="KPIs" items={s.data.kpis} />
          </div>
          <Rationale>{s.data.rationale}</Rationale>
        </div>
      )}

      <PlanCalendarModal open={planOpen} onClose={() => setPlanOpen(false)} brandId={brandId} platforms={platforms} />
    </div>
  );
}

function safeFmt(d: string, f: string) {
  try {
    return format(parseISO(d), f);
  } catch {
    return d;
  }
}

function ListCard({ title, items }: { title: string; items: string[] }) {
  return (
    <Card>
      <CardHeader title={title} />
      <CardBody>
        <ul className="space-y-1.5 text-[13px]">{items.map((i) => <li key={i}>· {i}</li>)}</ul>
      </CardBody>
    </Card>
  );
}

export function PlanCalendarModal({ open, onClose, brandId, platforms }: { open: boolean; onClose: () => void; brandId: string; platforms: string[] }) {
  const [start, setStart] = useState(format(new Date(Date.now() + 864e5), "yyyy-MM-dd"));
  const [days, setDays] = useState(14);
  const [ppw, setPpw] = useState(5);
  const [note, setNote] = useState("");
  const { run, busy } = useRun();
  return (
    <Modal open={open} onClose={onClose} title="Populate the content calendar">
      <div className="space-y-4 p-5">
        <p className="text-[13px] text-muted">The Content Strategist turns your latest strategy into dated draft posts for {platforms.join(", ") || "your platforms"}. Nothing is scheduled until you approve it.</p>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Start"><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="Days"><Input type="number" min={1} max={60} value={days} onChange={(e) => setDays(Number(e.target.value))} /></Field>
          <Field label="Posts / week"><Input type="number" min={1} max={21} value={ppw} onChange={(e) => setPpw(Number(e.target.value))} /></Field>
        </div>
        <Field label="Anything specific?"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="More reels, focus on workshops…" /></Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" loading={busy()} onClick={() => run(() => planCalendarAction(brandId, { start, days, platforms, postsPerWeek: ppw, note }), { success: (d) => `${d.count} draft posts added to the calendar`, onOk: onClose })}>
            <Sparkles /> Plan calendar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
