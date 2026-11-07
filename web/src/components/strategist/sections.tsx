"use client";
import { useState } from "react";
import { format, parseISO } from "date-fns";
import { Check, ExternalLink, Info, Plus, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { editSectionAction, itemApprovalAction } from "@/app/actions/strategist";
import { Badge, Button, Card, CardBody, Notice, Select } from "@/components/ui";
import { PlatformTag } from "@/components/bits";
import { useRun } from "@/components/hooks";
import { OBJECTIVES, PLATFORMS, objectiveLabel } from "@/lib/domain";
import {
  CAMPAIGN_KINDS,
  PILLAR_MAX,
  PILLAR_MIN,
  researchCategoryLabel,
  type AudienceSection,
  type CampaignsSection,
  type EditableSection,
  type Envelope,
  type ObjectivesSection,
  type PillarsSection,
  type ResearchSection,
  type StrategyCore,
} from "@/lib/strategy";
import { cn } from "@/lib/utils";
import { Bullets, Kicker, ListField, Pill, SaveBar, SectionFrame, TextField, useCtx } from "./kit";
import { PillarShare, SERIES } from "./charts";

function useSave(section: EditableSection) {
  const ctx = useCtx();
  const { run, busy } = useRun();
  return {
    saving: busy("save"),
    save: (data: unknown, close: () => void) => run(() => editSectionAction(ctx.brandId, ctx.strategyId, section, data, ctx.rev), { key: "save", success: "Saved", onOk: close }),
  };
}

function ApproveToggle({ section, id, approved }: { section: "audience" | "pillars" | "campaigns"; id: string; approved: boolean }) {
  const ctx = useCtx();
  const { run, busy } = useRun();
  if (!ctx.canApprove) return approved ? <Badge tone="success"><Check /> Approved</Badge> : <Badge>Not approved</Badge>;
  return (
    <Button size="sm" variant={approved ? "secondary" : "ghost"} loading={busy()} onClick={() => run(() => itemApprovalAction(ctx.brandId, ctx.strategyId, section, id, !approved, ctx.rev), { success: approved ? "Approval removed" : "Approved" })}>
      {approved ? (
        <>
          <Check className="text-success" /> Approved
        </>
      ) : (
        "Approve"
      )}
    </Button>
  );
}

const fmtDate = (d: string) => {
  try {
    return format(parseISO(d), "d MMM yyyy");
  } catch {
    return d;
  }
};

// ---------------------------------------------------------------------------
// Research & competitors
// ---------------------------------------------------------------------------

export function ResearchMode({ r }: { r: ResearchSection }) {
  const verified = r.findings.filter((f) => f.verified).length;
  return r.mode === "web_search" ? (
    <Notice tone="success" className="flex items-start gap-2">
      <ShieldCheck className="mt-0.5 size-4 shrink-0" />
      <span>
        Web research: {r.webSearches} search{r.webSearches === 1 ? "" : "es"}, {r.sources.length} sources. {verified} of {r.findings.length} findings are verified against a source; the rest are labelled hypotheses.
      </span>
    </Notice>
  ) : (
    <Notice tone="warn" className="flex items-start gap-2">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span>No web research was performed. {r.modeNote} Treat every finding as a hypothesis to validate.</span>
    </Notice>
  );
}

function SourceLinks({ urls, sources }: { urls: string[]; sources: ResearchSection["sources"] }) {
  if (!urls.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {urls.map((u) => {
        const s = sources.find((x) => x.url === u);
        let host = u;
        try {
          host = new URL(u).hostname.replace(/^www\./, "");
        } catch {}
        return (
          <a key={u} href={u} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex max-w-full items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-[11px] text-ink-2 hover:text-ink" title={s?.title ?? u}>
            <ExternalLink className="size-3 shrink-0" />
            <span className="truncate">{host}</span>
            {s?.publishedAt ? <span className="text-faint">· {s.publishedAt}</span> : null}
          </a>
        );
      })}
    </div>
  );
}

export function ResearchView({ env }: { env?: Envelope<ResearchSection> }) {
  const { save, saving } = useSave("research");
  const [filter, setFilter] = useState<"all" | "verified" | "hypothesis">("all");
  const r = env?.data;
  return (
    <SectionFrame
      section="research"
      env={env}
      description="Industry, trends, customer behaviour and content opportunities. Verified findings link to the source they came from."
      editor={(close) => <ResearchEditor r={r!} saving={saving} onCancel={close} onSave={(d) => save(d, close)} />}
    >
      {r ? (
        <div className="space-y-5">
          <ResearchMode r={r} />
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <Kicker>Summary</Kicker>
              <p className="text-[14px] leading-relaxed">{r.summary}</p>
            </div>
            <div>
              <Kicker>Industry overview</Kicker>
              <p className="text-[13px] leading-relaxed text-ink-2">{r.industryOverview}</p>
            </div>
          </div>
          <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <Kicker>Findings</Kicker>
              <Select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="h-8 w-44 text-[12px]" aria-label="Filter findings">
                <option value="all">All findings ({r.findings.length})</option>
                <option value="verified">Verified ({r.findings.filter((f) => f.verified).length})</option>
                <option value="hypothesis">Hypotheses ({r.findings.filter((f) => !f.verified).length})</option>
              </Select>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {r.findings
                .filter((f) => filter === "all" || (filter === "verified" ? f.verified : !f.verified))
                .map((f) => (
                  <div key={f.id} className="rounded-xl border border-line p-4">
                    <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                      <Pill>{researchCategoryLabel(f.category)}</Pill>
                      {f.verified ? <Badge tone="success"><ShieldCheck /> Verified</Badge> : <Badge tone="warn">Hypothesis</Badge>}
                      <span className="text-[11px] text-faint">{f.confidence} confidence</span>
                    </div>
                    <p className="text-[13px] font-medium">{f.title}</p>
                    <p className="mt-1 text-[13px] text-ink-2">{f.detail}</p>
                    <p className="mt-1.5 text-[12px] text-muted">{f.evidence}</p>
                    {f.unsourcedFigure ? <p className="mt-1.5 flex items-center gap-1 text-[11px] text-warn"><TriangleAlert className="size-3" /> Contains a figure that isn&apos;t backed by a source. Don&apos;t publish it as fact.</p> : null}
                    {f.unmatchedUrls.length ? <p className="mt-1 text-[11px] text-faint">{f.unmatchedUrls.length} cited link(s) removed: not among the search results.</p> : null}
                    <SourceLinks urls={f.sourceUrls} sources={r.sources} />
                  </div>
                ))}
            </div>
          </div>
          {r.openQuestions.length ? (
            <div>
              <Kicker>To confirm with the brand</Kicker>
              <Bullets items={r.openQuestions} />
            </div>
          ) : null}
          {r.sources.length ? (
            <details className="rounded-xl bg-sunken/60 px-4 py-3">
              <summary className="cursor-pointer text-[12px] font-medium text-muted">All {r.sources.length} sources returned by web search</summary>
              <ul className="mt-2 space-y-1.5 text-[12px]">
                {r.sources.map((s) => (
                  <li key={s.url} className="min-w-0">
                    <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="text-ink-2 underline-offset-2 hover:underline">
                      {s.title || s.url}
                    </a>
                    <span className="text-faint"> · {s.publishedAt ? `published ${s.publishedAt}` : "date unknown"} · retrieved {fmtDate(s.retrievedAt.slice(0, 10))}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </SectionFrame>
  );
}

function ResearchEditor({ r, onSave, onCancel, saving }: { r: ResearchSection; onSave: (d: unknown) => void; onCancel: () => void; saving: boolean }) {
  const [d, setD] = useState(() => structuredClone(r));
  return (
    <div className="space-y-4">
      <TextField label="Summary" area value={d.summary} onChange={(v) => setD({ ...d, summary: v })} />
      <TextField label="Industry overview" area rows={4} value={d.industryOverview} onChange={(v) => setD({ ...d, industryOverview: v })} />
      <div className="space-y-3">
        <Kicker>Findings · you can reword or remove findings; verification can&apos;t be changed by hand</Kicker>
        {d.findings.map((f, i) => (
          <div key={f.id} className="rounded-xl border border-line bg-surface p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              {f.verified ? <Badge tone="success">Verified</Badge> : <Badge tone="warn">Hypothesis</Badge>}
              <Button size="sm" variant="ghost" onClick={() => setD({ ...d, findings: d.findings.filter((_, j) => j !== i) })} aria-label="Remove finding">
                <Trash2 />
              </Button>
            </div>
            <div className="space-y-2">
              <TextField label="Title" value={f.title} onChange={(v) => setD({ ...d, findings: d.findings.map((x, j) => (j === i ? { ...x, title: v } : x)) })} />
              <TextField label="Detail" area rows={2} value={f.detail} onChange={(v) => setD({ ...d, findings: d.findings.map((x, j) => (j === i ? { ...x, detail: v } : x)) })} />
            </div>
          </div>
        ))}
      </div>
      <ListField label="Open questions" value={d.openQuestions} onChange={(v) => setD({ ...d, openQuestions: v })} />
      <SaveBar loading={saving} onCancel={onCancel} onSave={() => onSave({ summary: d.summary, industryOverview: d.industryOverview, openQuestions: d.openQuestions, findings: d.findings.map((f) => ({ id: f.id, title: f.title, detail: f.detail })), competitors: d.competitors })} />
    </div>
  );
}

export function CompetitorsView({ env }: { env?: Envelope<ResearchSection> }) {
  const { save, saving } = useSave("research");
  const r = env?.data;
  const label = { sourced: "From sources", brand_data: "From your data", hypothesis: "Hypothesis" } as const;
  return (
    <SectionFrame
      section="research"
      title="Competitor insights"
      env={env}
      description="How competitors position themselves and show up on social, and where you can win."
      editor={(close) => <CompetitorEditor r={r!} saving={saving} onCancel={close} onSave={(d) => save(d, close)} />}
    >
      {r ? (
        r.competitors.length ? (
          <div className="grid gap-4 md:grid-cols-2">
            {r.competitors.map((c) => (
              <div key={c.id} className="flex flex-col rounded-xl border border-line p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">{c.name}</p>
                  <Badge tone={c.verified ? "success" : c.basis === "brand_data" ? "info" : "warn"}>{label[c.basis]}</Badge>
                </div>
                <p className="mt-1 text-[13px] text-ink-2">{c.positioning}</p>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <Kicker>Strengths</Kicker>
                    <Bullets items={c.strengths} />
                  </div>
                  <div>
                    <Kicker>Weaknesses</Kicker>
                    <Bullets items={c.weaknesses} />
                  </div>
                </div>
                <p className="mt-3 text-[12px] text-muted">
                  <span className="font-medium text-ink-2">Content: </span>
                  {c.contentApproach}
                </p>
                <p className="mt-2 rounded-lg bg-accent-soft/60 px-3 py-2 text-[12px] text-accent-ink">
                  <span className="font-semibold">Your opening: </span>
                  {c.opportunity}
                </p>
                <SourceLinks urls={c.sourceUrls} sources={r.sources} />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-muted">No competitors identified. Add competitors to your brand details and regenerate research.</p>
        )
      ) : null}
    </SectionFrame>
  );
}

function CompetitorEditor({ r, onSave, onCancel, saving }: { r: ResearchSection; onSave: (d: unknown) => void; onCancel: () => void; saving: boolean }) {
  const [cs, setCs] = useState(() => structuredClone(r.competitors));
  const set = (i: number, patch: Partial<(typeof cs)[number]>) => setCs(cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="space-y-4">
      {cs.map((c, i) => (
        <div key={c.id} className="space-y-2 rounded-xl border border-line bg-surface p-3">
          <div className="flex items-center justify-between">
            <p className="font-medium">{c.name}</p>
            <Button size="sm" variant="ghost" onClick={() => setCs(cs.filter((_, j) => j !== i))} aria-label="Remove competitor">
              <Trash2 />
            </Button>
          </div>
          <TextField label="Positioning" area rows={2} value={c.positioning} onChange={(v) => set(i, { positioning: v })} />
          <div className="grid gap-2 sm:grid-cols-2">
            <ListField label="Strengths" value={c.strengths} onChange={(v) => set(i, { strengths: v })} />
            <ListField label="Weaknesses" value={c.weaknesses} onChange={(v) => set(i, { weaknesses: v })} />
          </div>
          <TextField label="Content approach" area rows={2} value={c.contentApproach} onChange={(v) => set(i, { contentApproach: v })} />
          <TextField label="Your opening" area rows={2} value={c.opportunity} onChange={(v) => set(i, { opportunity: v })} />
        </div>
      ))}
      <SaveBar
        loading={saving}
        onCancel={onCancel}
        onSave={() => onSave({ summary: r.summary, industryOverview: r.industryOverview, openQuestions: r.openQuestions, findings: r.findings.map((f) => ({ id: f.id, title: f.title, detail: f.detail })), competitors: cs.map((c) => ({ id: c.id, positioning: c.positioning, contentApproach: c.contentApproach, opportunity: c.opportunity, strengths: c.strengths, weaknesses: c.weaknesses })) })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------

const BASIS_LABEL = { brand_data: "From your data", research: "From research", assumption: "Assumption" } as const;

export function AudienceView({ env }: { env?: Envelope<AudienceSection> }) {
  const { save, saving } = useSave("audience");
  const a = env?.data;
  return (
    <SectionFrame section="audience" env={env} description="Segments and personas the strategy is built for. Approve the personas you recognise; edit anything that's off." editor={(close) => <AudienceEditor a={a!} saving={saving} onCancel={close} onSave={(d) => save(d, close)} />}>
      {a ? (
        <div className="space-y-6">
          <p className="max-w-3xl text-[14px] leading-relaxed">{a.overview}</p>
          {a.segments.length ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {a.segments.map((s) => (
                <div key={s.name} className="rounded-xl bg-sunken/60 p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[13px] font-medium">{s.name}</p>
                    <Pill className="capitalize">{s.priority}</Pill>
                  </div>
                  <p className="mt-1 text-[12px] text-muted">{s.description}</p>
                </div>
              ))}
            </div>
          ) : null}
          <div className="grid gap-4 lg:grid-cols-2">
            {a.personas.map((p) => (
              <div key={p.id} className={cn("rounded-2xl border p-5", p.approved ? "border-success/40" : "border-line")}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-display text-[20px] leading-tight">{p.name}</p>
                    <p className="mt-1 text-[13px] text-ink-2">{p.summary}</p>
                  </div>
                  <ApproveToggle section="audience" id={p.id} approved={p.approved} />
                </div>
                <p className="mt-3 text-[12px] text-muted">
                  <span className="font-medium text-ink-2">Demographics: </span>
                  {p.demographics} <Badge tone={p.demographicsBasis === "assumption" ? "warn" : "info"} className="ml-1">{BASIS_LABEL[p.demographicsBasis]}</Badge>
                </p>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  {(
                    [
                      ["Needs", p.needs],
                      ["Pain points", p.painPoints],
                      ["Motivations", p.motivations],
                      ["Objections", p.objections],
                      ["Interests", p.interests],
                      ["Content they want", p.contentPreferences],
                    ] as const
                  ).map(([k, v]) => (
                    <div key={k}>
                      <Kicker>{k}</Kicker>
                      <Bullets items={[...v]} />
                    </div>
                  ))}
                </div>
                <div className="mt-4 border-t border-line pt-3">
                  <Kicker>Engagement opportunities</Kicker>
                  <Bullets items={p.engagementOpportunities} />
                  <div className="mt-3 flex flex-wrap gap-3">{p.platforms.map((x) => <PlatformTag key={x} platform={x} />)}</div>
                </div>
              </div>
            ))}
          </div>
          {a.insights.length ? (
            <div>
              <Kicker>Audience insights</Kicker>
              <Bullets items={a.insights} />
            </div>
          ) : null}
        </div>
      ) : null}
    </SectionFrame>
  );
}

type PersonaDraft = Omit<AudienceSection["personas"][number], "id" | "approved"> & { id?: string };
const blankPersona = (): PersonaDraft => ({ name: "New persona", summary: "", demographics: "Not established", demographicsBasis: "assumption", interests: [], needs: [], painPoints: [], motivations: [], objections: [], contentPreferences: [], platforms: [], engagementOpportunities: [] });

function AudienceEditor({ a, onSave, onCancel, saving }: { a: AudienceSection; onSave: (d: unknown) => void; onCancel: () => void; saving: boolean }) {
  const [d, setD] = useState(() => ({ ...structuredClone(a), personas: a.personas.map(({ approved: _a, ...p }) => (void _a, p)) as PersonaDraft[] }));
  const setP = (i: number, patch: Partial<PersonaDraft>) => setD({ ...d, personas: d.personas.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  return (
    <div className="space-y-4">
      <TextField label="Overview" area value={d.overview} onChange={(v) => setD({ ...d, overview: v })} />
      <ListField label="Insights" value={d.insights} onChange={(v) => setD({ ...d, insights: v })} />
      {d.personas.map((p, i) => (
        <div key={p.id ?? i} className="space-y-2 rounded-xl border border-line bg-surface p-3">
          <div className="flex items-center justify-between gap-2">
            <Kicker>Persona {i + 1}</Kicker>
            <Button size="sm" variant="ghost" disabled={d.personas.length <= 1} onClick={() => setD({ ...d, personas: d.personas.filter((_, j) => j !== i) })} aria-label="Remove persona">
              <Trash2 />
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <TextField label="Name" value={p.name} onChange={(v) => setP(i, { name: v })} />
            <TextField label="Demographics (only what you know)" value={p.demographics} onChange={(v) => setP(i, { demographics: v })} />
          </div>
          <TextField label="Summary" area rows={2} value={p.summary} onChange={(v) => setP(i, { summary: v })} />
          <div className="grid gap-2 sm:grid-cols-2">
            <ListField label="Needs" value={p.needs} onChange={(v) => setP(i, { needs: v })} />
            <ListField label="Pain points" value={p.painPoints} onChange={(v) => setP(i, { painPoints: v })} />
            <ListField label="Motivations" value={p.motivations} onChange={(v) => setP(i, { motivations: v })} />
            <ListField label="Objections" value={p.objections} onChange={(v) => setP(i, { objections: v })} />
            <ListField label="Interests" value={p.interests} onChange={(v) => setP(i, { interests: v })} />
            <ListField label="Content preferences" value={p.contentPreferences} onChange={(v) => setP(i, { contentPreferences: v })} />
          </div>
          <ListField label="Engagement opportunities" value={p.engagementOpportunities} onChange={(v) => setP(i, { engagementOpportunities: v })} />
          <PlatformPicker value={p.platforms} onChange={(v) => setP(i, { platforms: v as PersonaDraft["platforms"] })} />
          <label className="block text-[12px]">
            <span className="mb-1 block font-medium text-ink-2">Demographics basis</span>
            <Select value={p.demographicsBasis} onChange={(e) => setP(i, { demographicsBasis: e.target.value as PersonaDraft["demographicsBasis"] })} className="w-48">
              <option value="brand_data">From our data</option>
              <option value="research">From research</option>
              <option value="assumption">Assumption</option>
            </Select>
          </label>
        </div>
      ))}
      {d.personas.length < 8 ? (
        <Button variant="secondary" size="sm" onClick={() => setD({ ...d, personas: [...d.personas, blankPersona()] })}>
          <Plus /> Add persona
        </Button>
      ) : null}
      <SaveBar loading={saving} onCancel={onCancel} onSave={() => onSave(d)} note="Edited personas need re-approval." />
    </div>
  );
}

export function PlatformPicker({ value, onChange, allowed }: { value: string[]; onChange: (v: string[]) => void; allowed?: string[] }) {
  const list = PLATFORMS.filter((p) => !allowed || allowed.includes(p.id));
  return (
    <div>
      <span className="mb-1 block text-[12px] font-medium text-ink-2">Platforms</span>
      <div className="flex flex-wrap gap-1.5">
        {list.map((p) => {
          const on = value.includes(p.id);
          return (
            <button key={p.id} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== p.id) : [...value, p.id])} className={cn("rounded-full border px-2.5 py-1 text-[12px] transition", on ? "border-ink bg-ink text-white" : "border-line text-ink-2 hover:border-line-strong")}>
              {p.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Objectives
// ---------------------------------------------------------------------------

export function ObjectivesView({ env }: { env?: Envelope<ObjectivesSection> }) {
  const { save, saving } = useSave("objectives");
  const o = env?.data;
  return (
    <SectionFrame section="objectives" title="Business & marketing objectives" env={env} description="What the business needs (2) and what marketing will deliver toward it (3)." editor={(close) => <ObjectivesEditor o={o!} saving={saving} onCancel={close} onSave={(d) => save(d, close)} />}>
      {o ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_1.6fr]">
          <div>
            <Kicker>Business objectives</Kicker>
            <ol className="space-y-2.5">
              {o.businessObjectives.map((b, i) => (
                <li key={i} className="rounded-xl bg-sunken/60 p-3.5">
                  <p className="text-[13px] font-medium">{b.objective}</p>
                  <p className="mt-0.5 text-[12px] text-muted">Measured by: {b.measure}</p>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <Kicker>Marketing objectives</Kicker>
            <div className="space-y-2.5">
              {o.marketingObjectives.map((m) => (
                <div key={m.id} className="rounded-xl border border-line p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[14px] font-medium">{m.objective}</p>
                    <Badge tone="accent">{objectiveLabel(m.category)}</Badge>
                  </div>
                  <p className="mt-1 text-[12px] text-muted">Supports: {m.supports}</p>
                  <div className="mt-3 grid gap-2 text-[12px] sm:grid-cols-3">
                    <p><span className="text-faint">Metric </span>{m.metric}</p>
                    <p>
                      <span className="text-faint">Target </span>
                      {m.target} {m.targetBasis === "suggested" ? <Badge tone="warn" className="ml-1">Suggested</Badge> : <Badge tone="success" className="ml-1">Your target</Badge>}
                    </p>
                    <p><span className="text-faint">Timeframe </span>{m.timeframe}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </SectionFrame>
  );
}

function ObjectivesEditor({ o, onSave, onCancel, saving }: { o: ObjectivesSection; onSave: (d: unknown) => void; onCancel: () => void; saving: boolean }) {
  const [d, setD] = useState(() => structuredClone(o));
  type MO = ObjectivesSection["marketingObjectives"][number];
  const setM = (i: number, patch: Partial<MO>) => setD({ ...d, marketingObjectives: d.marketingObjectives.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  return (
    <div className="space-y-4">
      <Kicker>Business objectives</Kicker>
      {d.businessObjectives.map((b, i) => (
        <div key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <TextField label="Objective" value={b.objective} onChange={(v) => setD({ ...d, businessObjectives: d.businessObjectives.map((x, j) => (j === i ? { ...x, objective: v } : x)) })} />
          <TextField label="Measured by" value={b.measure} onChange={(v) => setD({ ...d, businessObjectives: d.businessObjectives.map((x, j) => (j === i ? { ...x, measure: v } : x)) })} />
          <Button variant="ghost" size="icon" onClick={() => setD({ ...d, businessObjectives: d.businessObjectives.filter((_, j) => j !== i) })} aria-label="Remove">
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button size="sm" variant="secondary" onClick={() => setD({ ...d, businessObjectives: [...d.businessObjectives, { objective: "New objective", measure: "" }] })}>
        <Plus /> Add business objective
      </Button>
      <Kicker>Marketing objectives</Kicker>
      {d.marketingObjectives.map((m, i) => (
        <div key={m.id ?? i} className="space-y-2 rounded-xl border border-line bg-surface p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_180px_auto]">
            <TextField label="Objective" value={m.objective} onChange={(v) => setM(i, { objective: v })} />
            <label className="block text-[12px]">
              <span className="mb-1 block font-medium text-ink-2">Type</span>
              <Select value={m.category} onChange={(e) => setM(i, { category: e.target.value as MO["category"] })}>
                {OBJECTIVES.map((x) => <option key={x} value={x}>{objectiveLabel(x)}</option>)}
              </Select>
            </label>
            <Button variant="ghost" size="icon" className="self-end" onClick={() => setD({ ...d, marketingObjectives: d.marketingObjectives.filter((_, j) => j !== i) })} aria-label="Remove">
              <Trash2 />
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-4">
            <TextField label="Supports" value={m.supports} onChange={(v) => setM(i, { supports: v })} />
            <TextField label="Metric" value={m.metric} onChange={(v) => setM(i, { metric: v })} />
            <TextField label="Target" value={m.target} onChange={(v) => setM(i, { target: v, targetBasis: "user_target" })} />
            <TextField label="Timeframe" value={m.timeframe} onChange={(v) => setM(i, { timeframe: v })} />
          </div>
        </div>
      ))}
      <Button size="sm" variant="secondary" onClick={() => setD({ ...d, marketingObjectives: [...d.marketingObjectives, { id: "", objective: "New objective", category: "engagement", supports: "", metric: "", target: "", targetBasis: "user_target", timeframe: "30 days" }] })}>
        <Plus /> Add marketing objective
      </Button>
      <SaveBar loading={saving} onCancel={onCancel} onSave={() => onSave({ ...d, marketingObjectives: d.marketingObjectives.map((m) => ({ ...m, id: m.id || undefined })) })} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Marketing strategy (parts 1, 5–11, 13) and KPIs (12)
// ---------------------------------------------------------------------------

function Part({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line pt-5 first:border-t-0 first:pt-0" id={`part-${n}`}>
      <p className="mb-2 flex items-baseline gap-2">
        <span className="text-[11px] font-semibold tabular-nums text-faint">{String(n).padStart(2, "0")}</span>
        <span className="text-[15px] font-semibold">{title}</span>
      </p>
      {children}
    </section>
  );
}

export function StrategyView({ env, accountType }: { env?: Envelope<StrategyCore>; accountType: string }) {
  const { save, saving } = useSave("strategy");
  const s = env?.data;
  return (
    <SectionFrame section="strategy" title="Marketing strategy" env={env} description="Parts 2–4 live in Objectives and Audience; KPIs have their own tab." editor={(close) => <StrategyEditor s={s!} saving={saving} onCancel={close} onSave={(d) => save(d, close)} />}>
      {s ? (
        <div className="space-y-6">
          <Part n={1} title="Executive summary">
            <p className="max-w-3xl text-[14px] leading-relaxed">{s.executiveSummary}</p>
            {s.accountTypeNotes ? (
              <p className="mt-2 flex items-start gap-1.5 text-[12px] text-muted">
                <Info className="mt-0.5 size-3.5 shrink-0" /> {s.accountTypeNotes} <span className="text-faint">({accountType})</span>
              </p>
            ) : null}
          </Part>
          <Part n={5} title="Positioning">
            <p className="font-display text-[22px] leading-snug">“{s.positioning.statement}”</p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <Kicker>Points of difference</Kicker>
                <Bullets items={s.positioning.pointsOfDifference} />
              </div>
              <div>
                <Kicker>Proof points</Kicker>
                <Bullets items={s.positioning.proofPoints} />
              </div>
            </div>
          </Part>
          <Part n={6} title="Differentiation">
            <div className="grid gap-3 md:grid-cols-2">
              {s.differentiation.map((d, i) => (
                <div key={i} className="rounded-xl bg-sunken/60 p-3.5 text-[13px]">
                  <p className="font-medium">{d.point}</p>
                  <p className="mt-0.5 text-[12px] text-muted">vs. {d.versus}</p>
                  <p className="mt-1.5 text-ink-2">{d.howToShow}</p>
                </div>
              ))}
            </div>
          </Part>
          <Part n={7} title="Channels">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-[13px]">
                <thead className="text-[11px] uppercase tracking-wider text-faint">
                  <tr>
                    <th className="py-2 pr-4 font-semibold">Platform</th>
                    <th className="py-2 pr-4 font-semibold">Role</th>
                    <th className="py-2 pr-4 font-semibold">Posts/wk</th>
                    <th className="py-2 pr-4 font-semibold">Best times</th>
                    <th className="py-2 font-semibold">Approach</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {s.channels.map((c) => (
                    <tr key={c.platform} className="align-top">
                      <td className="py-3 pr-4"><PlatformTag platform={c.platform} /></td>
                      <td className="py-3 pr-4 text-ink-2">{c.role}<p className="text-[11px] text-faint">{c.audience}</p></td>
                      <td className="py-3 pr-4 font-medium tabular-nums">{c.postsPerWeek}</td>
                      <td className="py-3 pr-4 text-ink-2">{c.bestTimes.join(", ")}</td>
                      <td className="py-3 text-ink-2">{c.approach}<p className="mt-1 text-[11px] text-faint">{c.formats.join(" · ")}</p></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] text-faint">Best times are recommendations until Analytics has enough of your own data to confirm them.</p>
          </Part>
          <Part n={8} title="Content strategy">
            <p className="text-[13px] text-ink-2">{s.contentStrategy.approach}</p>
            <p className="mt-2 text-[12px] text-muted"><span className="font-medium text-ink-2">Tone: </span>{s.contentStrategy.toneGuidance}</p>
            {s.contentStrategy.mix.length ? <div className="mt-4 max-w-xl"><PillarShare pillars={s.contentStrategy.mix.map((m) => ({ name: m.type, sharePercent: m.sharePercent }))} /></div> : null}
            {s.contentStrategy.avoid.length ? <div className="mt-4"><Kicker>Avoid</Kicker><Bullets items={s.contentStrategy.avoid} /></div> : null}
          </Part>
          <Part n={9} title="Campaign strategy">
            <p className="text-[13px] text-ink-2">{s.campaignStrategy.approach}</p>
            <p className="mt-1 text-[12px] text-muted">Rhythm: {s.campaignStrategy.rhythm}</p>
          </Part>
          <Part n={10} title="Engagement strategy">
            <p className="text-[13px] text-ink-2">{s.engagementStrategy.approach}</p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div><Kicker>Tactics</Kicker><Bullets items={s.engagementStrategy.tactics} /></div>
              <div><Kicker>Community guidelines</Kicker><Bullets items={s.engagementStrategy.communityGuidelines} /></div>
            </div>
          </Part>
          <Part n={11} title="Lead generation">
            {s.leadGeneration.notApplicableReason ? <p className="text-[13px] text-muted">{s.leadGeneration.notApplicableReason}</p> : null}
            <p className="text-[13px] text-ink-2">{s.leadGeneration.approach}</p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div><Kicker>Tactics</Kicker><Bullets items={s.leadGeneration.tactics} /></div>
              <div><Kicker>Offers</Kicker><Bullets items={s.leadGeneration.offers} /></div>
            </div>
          </Part>
          <Part n={13} title="Roadmap">
            <ol className="relative space-y-4 border-l border-line pl-5">
              {s.roadmap.map((r, i) => (
                <li key={i}>
                  <span className="absolute -left-[5px] mt-1.5 size-2.5 rounded-full border-2 border-surface bg-accent" />
                  <p className="text-[13px] font-medium">{r.phase} <span className="font-normal text-faint">· {r.timing}</span></p>
                  <p className="text-[13px] text-ink-2">{r.focus}</p>
                  <Bullets items={r.milestones} />
                </li>
              ))}
            </ol>
          </Part>
          {s.assumptions.length || s.risks.length ? (
            <div className="grid gap-4 rounded-xl bg-sunken/60 p-4 sm:grid-cols-2">
              <div><Kicker>Assumptions</Kicker><Bullets items={s.assumptions} /></div>
              <div><Kicker>Risks</Kicker><Bullets items={s.risks} /></div>
            </div>
          ) : null}
        </div>
      ) : null}
    </SectionFrame>
  );
}

function StrategyEditor({ s, onSave, onCancel, saving }: { s: StrategyCore; onSave: (d: unknown) => void; onCancel: () => void; saving: boolean }) {
  const [d, setD] = useState(() => structuredClone(s));
  const set = <K extends keyof StrategyCore>(k: K, v: StrategyCore[K]) => setD({ ...d, [k]: v });
  return (
    <div className="space-y-4">
      <TextField label="1 · Executive summary" area rows={5} value={d.executiveSummary} onChange={(v) => set("executiveSummary", v)} />
      <TextField label="5 · Positioning statement" area rows={2} value={d.positioning.statement} onChange={(v) => set("positioning", { ...d.positioning, statement: v })} />
      <div className="grid gap-2 sm:grid-cols-2">
        <ListField label="Points of difference" value={d.positioning.pointsOfDifference} onChange={(v) => set("positioning", { ...d.positioning, pointsOfDifference: v })} />
        <ListField label="Proof points" value={d.positioning.proofPoints} onChange={(v) => set("positioning", { ...d.positioning, proofPoints: v })} />
      </div>
      <Kicker>6 · Differentiation</Kicker>
      {d.differentiation.map((x, i) => (
        <div key={i} className="grid gap-2 rounded-xl border border-line bg-surface p-3 sm:grid-cols-[1fr_1fr_1.4fr_auto]">
          <TextField label="Point" value={x.point} onChange={(v) => set("differentiation", d.differentiation.map((y, j) => (j === i ? { ...y, point: v } : y)))} />
          <TextField label="Versus" value={x.versus} onChange={(v) => set("differentiation", d.differentiation.map((y, j) => (j === i ? { ...y, versus: v } : y)))} />
          <TextField label="How to show it" value={x.howToShow} onChange={(v) => set("differentiation", d.differentiation.map((y, j) => (j === i ? { ...y, howToShow: v } : y)))} />
          <Button variant="ghost" size="icon" className="self-end" onClick={() => set("differentiation", d.differentiation.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 /></Button>
        </div>
      ))}
      <Button size="sm" variant="secondary" onClick={() => set("differentiation", [...d.differentiation, { point: "", versus: "", howToShow: "" }])}><Plus /> Add</Button>
      <Kicker>7 · Channels</Kicker>
      {d.channels.map((c, i) => (
        <div key={c.platform} className="space-y-2 rounded-xl border border-line bg-surface p-3">
          <PlatformTag platform={c.platform} />
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_110px]">
            <TextField label="Role" value={c.role} onChange={(v) => set("channels", d.channels.map((y, j) => (j === i ? { ...y, role: v } : y)))} />
            <TextField label="Audience" value={c.audience} onChange={(v) => set("channels", d.channels.map((y, j) => (j === i ? { ...y, audience: v } : y)))} />
            <TextField label="Posts / week" value={String(c.postsPerWeek)} onChange={(v) => set("channels", d.channels.map((y, j) => (j === i ? { ...y, postsPerWeek: Math.max(0, Math.min(50, Number(v) || 0)) } : y)))} />
          </div>
          <TextField label="Approach" area rows={2} value={c.approach} onChange={(v) => set("channels", d.channels.map((y, j) => (j === i ? { ...y, approach: v } : y)))} />
          <div className="grid gap-2 sm:grid-cols-2">
            <ListField label="Formats" value={c.formats} onChange={(v) => set("channels", d.channels.map((y, j) => (j === i ? { ...y, formats: v } : y)))} />
            <ListField label="Best times" value={c.bestTimes} onChange={(v) => set("channels", d.channels.map((y, j) => (j === i ? { ...y, bestTimes: v } : y)))} />
          </div>
        </div>
      ))}
      <TextField label="8 · Content approach" area value={d.contentStrategy.approach} onChange={(v) => set("contentStrategy", { ...d.contentStrategy, approach: v })} />
      <TextField label="Tone guidance" area rows={2} value={d.contentStrategy.toneGuidance} onChange={(v) => set("contentStrategy", { ...d.contentStrategy, toneGuidance: v })} />
      <ListField label="Avoid" value={d.contentStrategy.avoid} onChange={(v) => set("contentStrategy", { ...d.contentStrategy, avoid: v })} />
      <div className="grid gap-2 sm:grid-cols-2">
        <TextField label="9 · Campaign approach" area value={d.campaignStrategy.approach} onChange={(v) => set("campaignStrategy", { ...d.campaignStrategy, approach: v })} />
        <TextField label="Campaign rhythm" area value={d.campaignStrategy.rhythm} onChange={(v) => set("campaignStrategy", { ...d.campaignStrategy, rhythm: v })} />
      </div>
      <TextField label="10 · Engagement approach" area value={d.engagementStrategy.approach} onChange={(v) => set("engagementStrategy", { ...d.engagementStrategy, approach: v })} />
      <div className="grid gap-2 sm:grid-cols-2">
        <ListField label="Engagement tactics" value={d.engagementStrategy.tactics} onChange={(v) => set("engagementStrategy", { ...d.engagementStrategy, tactics: v })} />
        <ListField label="Community guidelines" value={d.engagementStrategy.communityGuidelines} onChange={(v) => set("engagementStrategy", { ...d.engagementStrategy, communityGuidelines: v })} />
      </div>
      <TextField label="11 · Lead generation approach" area value={d.leadGeneration.approach} onChange={(v) => set("leadGeneration", { ...d.leadGeneration, approach: v })} />
      <div className="grid gap-2 sm:grid-cols-2">
        <ListField label="Lead-gen tactics" value={d.leadGeneration.tactics} onChange={(v) => set("leadGeneration", { ...d.leadGeneration, tactics: v })} />
        <ListField label="Offers" value={d.leadGeneration.offers} onChange={(v) => set("leadGeneration", { ...d.leadGeneration, offers: v })} />
      </div>
      <Kicker>13 · Roadmap</Kicker>
      {d.roadmap.map((r, i) => (
        <div key={i} className="space-y-2 rounded-xl border border-line bg-surface p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <TextField label="Phase" value={r.phase} onChange={(v) => set("roadmap", d.roadmap.map((y, j) => (j === i ? { ...y, phase: v } : y)))} />
            <TextField label="Timing" value={r.timing} onChange={(v) => set("roadmap", d.roadmap.map((y, j) => (j === i ? { ...y, timing: v } : y)))} />
            <Button variant="ghost" size="icon" className="self-end" onClick={() => set("roadmap", d.roadmap.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 /></Button>
          </div>
          <TextField label="Focus" area rows={2} value={r.focus} onChange={(v) => set("roadmap", d.roadmap.map((y, j) => (j === i ? { ...y, focus: v } : y)))} />
          <ListField label="Milestones" value={r.milestones} onChange={(v) => set("roadmap", d.roadmap.map((y, j) => (j === i ? { ...y, milestones: v } : y)))} />
        </div>
      ))}
      <Button size="sm" variant="secondary" onClick={() => set("roadmap", [...d.roadmap, { phase: "", timing: "", focus: "", milestones: [] }])}><Plus /> Add phase</Button>
      <div className="grid gap-2 sm:grid-cols-2">
        <ListField label="Assumptions" value={d.assumptions} onChange={(v) => set("assumptions", v)} />
        <ListField label="Risks" value={d.risks} onChange={(v) => set("risks", v)} />
      </div>
      <TextField label="Account-type notes" area rows={2} value={d.accountTypeNotes} onChange={(v) => set("accountTypeNotes", v)} />
      <SaveBar loading={saving} onCancel={onCancel} onSave={() => onSave(d)} />
    </div>
  );
}

export function KpisView({ env }: { env?: Envelope<StrategyCore> }) {
  const { save, saving } = useSave("strategy");
  const s = env?.data;
  return (
    <SectionFrame section="strategy" title="KPIs" env={env} description="Part 12. How success is measured. Suggested targets are starting points until you have a baseline." editor={(close) => <KpiEditor s={s!} saving={saving} onCancel={close} onSave={(d) => save(d, close)} />}>
      {s ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {s.kpis.map((k, i) => (
            <div key={i} className="rounded-2xl border border-line p-4">
              <p className="text-[12px] text-muted">{k.name}</p>
              <p className="mt-1 font-display text-[22px] leading-tight">{k.target}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {k.targetBasis === "suggested" ? <Badge tone="warn">Suggested target</Badge> : <Badge tone="success">Your target</Badge>}
                <Pill>{k.frequency}</Pill>
              </div>
              <p className="mt-3 text-[12px] text-ink-2">{k.metric}</p>
              <p className="mt-1 text-[11px] text-faint">Objective: {k.objective}</p>
            </div>
          ))}
        </div>
      ) : null}
    </SectionFrame>
  );
}

function KpiEditor({ s, onSave, onCancel, saving }: { s: StrategyCore; onSave: (d: unknown) => void; onCancel: () => void; saving: boolean }) {
  const [k, setK] = useState(() => structuredClone(s.kpis));
  const set = (i: number, patch: Partial<StrategyCore["kpis"][number]>) => setK(k.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div className="space-y-3">
      {k.map((x, i) => (
        <div key={i} className="grid gap-2 rounded-xl border border-line bg-surface p-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_120px_auto]">
          <TextField label="KPI" value={x.name} onChange={(v) => set(i, { name: v })} />
          <TextField label="Metric" value={x.metric} onChange={(v) => set(i, { metric: v })} />
          <TextField label="Target" value={x.target} onChange={(v) => set(i, { target: v, targetBasis: "user_target" })} />
          <TextField label="Frequency" value={x.frequency} onChange={(v) => set(i, { frequency: v })} />
          <Button variant="ghost" size="icon" className="self-end" onClick={() => setK(k.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 /></Button>
        </div>
      ))}
      <Button size="sm" variant="secondary" onClick={() => setK([...k, { name: "New KPI", metric: "", target: "", targetBasis: "user_target", frequency: "Weekly", objective: "" }])}><Plus /> Add KPI</Button>
      <SaveBar loading={saving} onCancel={onCancel} onSave={() => onSave({ ...s, kpis: k })} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pillars
// ---------------------------------------------------------------------------

export function PillarsView({ env }: { env?: Envelope<PillarsSection> }) {
  const { save, saving } = useSave("pillars");
  const p = env?.data;
  const n = p?.pillars.length ?? 0;
  return (
    <SectionFrame section="pillars" env={env} description={`${PILLAR_MIN}–${PILLAR_MAX} themes your content rotates through. Approve, edit, add or remove pillars.`} editor={(close) => <PillarsEditor p={p!} saving={saving} onCancel={close} onSave={(d) => save(d, close)} />}>
      {p ? (
        <div className="space-y-5">
          {n < PILLAR_MIN ? <Notice tone="warn">A strategy needs at least {PILLAR_MIN} pillars before it can be approved.</Notice> : null}
          <PillarShare pillars={p.pillars} />
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {p.pillars.map((x, i) => (
              <div key={x.id} className={cn("flex flex-col rounded-2xl border p-4", x.approved ? "border-success/40" : "border-line")}>
                <div className="flex items-start justify-between gap-2">
                  <p className="flex items-center gap-2 font-medium">
                    <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: SERIES[i % SERIES.length] }} />
                    {x.name}
                  </p>
                  <span className="text-[12px] tabular-nums text-muted">{x.sharePercent}%</span>
                </div>
                <p className="mt-1.5 text-[13px] text-ink-2">{x.description}</p>
                <p className="mt-2 text-[12px] text-muted"><span className="font-medium text-ink-2">Purpose: </span>{x.purpose}</p>
                <p className="mt-1 text-[12px] text-muted"><span className="font-medium text-ink-2">For: </span>{x.audience}</p>
                <div className="mt-3">
                  <Kicker>Topics</Kicker>
                  <Bullets items={x.topics} />
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Badge tone="accent">{objectiveLabel(x.objective)}</Badge>
                  <Pill>{x.frequency}</Pill>
                  {x.formats.map((f) => <Pill key={f}>{f}</Pill>)}
                </div>
                <div className="mt-auto pt-3">
                  <ApproveToggle section="pillars" id={x.id} approved={x.approved} />
                </div>
              </div>
            ))}
          </div>
          {p.rationale ? <p className="text-[12px] text-muted">{p.rationale}</p> : null}
        </div>
      ) : null}
    </SectionFrame>
  );
}

type PillarDraft = Omit<PillarsSection["pillars"][number], "id" | "approved"> & { id?: string };

function PillarsEditor({ p, onSave, onCancel, saving }: { p: PillarsSection; onSave: (d: unknown) => void; onCancel: () => void; saving: boolean }) {
  const [list, setList] = useState<PillarDraft[]>(() => p.pillars.map(({ approved: _a, ...x }) => (void _a, structuredClone(x))));
  const [rationale, setRationale] = useState(p.rationale);
  const set = (i: number, patch: Partial<PillarDraft>) => setList(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const total = list.reduce((s, x) => s + (x.sharePercent || 0), 0);
  return (
    <div className="space-y-3">
      {list.map((x, i) => (
        <div key={x.id ?? `new-${i}`} className="space-y-2 rounded-xl border border-line bg-surface p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_100px_180px_auto]">
            <TextField label="Name" value={x.name} onChange={(v) => set(i, { name: v })} />
            <TextField label="Share %" value={String(x.sharePercent)} onChange={(v) => set(i, { sharePercent: Math.max(0, Math.min(100, Number(v) || 0)) })} />
            <label className="block text-[12px]">
              <span className="mb-1 block font-medium text-ink-2">Objective</span>
              <Select value={x.objective} onChange={(e) => set(i, { objective: e.target.value as PillarDraft["objective"] })}>
                {OBJECTIVES.map((o) => <option key={o} value={o}>{objectiveLabel(o)}</option>)}
              </Select>
            </label>
            <Button variant="ghost" size="icon" className="self-end" disabled={list.length <= 1} onClick={() => setList(list.filter((_, j) => j !== i))} aria-label="Remove pillar"><Trash2 /></Button>
          </div>
          <TextField label="Description" area rows={2} value={x.description} onChange={(v) => set(i, { description: v })} />
          <div className="grid gap-2 sm:grid-cols-3">
            <TextField label="Purpose" value={x.purpose} onChange={(v) => set(i, { purpose: v })} />
            <TextField label="Audience" value={x.audience} onChange={(v) => set(i, { audience: v })} />
            <TextField label="Frequency" value={x.frequency} onChange={(v) => set(i, { frequency: v })} />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <ListField label="Topics" value={x.topics} onChange={(v) => set(i, { topics: v })} />
            <ListField label="Formats" value={x.formats} onChange={(v) => set(i, { formats: v })} />
          </div>
        </div>
      ))}
      {list.length < PILLAR_MAX ? (
        <Button size="sm" variant="secondary" onClick={() => setList([...list, { name: `New pillar ${list.length + 1}`, description: "", purpose: "", audience: "", formats: [], topics: [], frequency: "1 post / week", sharePercent: 10, objective: "engagement" }])}>
          <Plus /> Add pillar
        </Button>
      ) : null}
      <TextField label="Rationale" area rows={2} value={rationale} onChange={setRationale} />
      <SaveBar loading={saving} onCancel={onCancel} onSave={() => onSave({ rationale, pillars: list })} note={`Shares total ${total}% and are rescaled to 100% on save. Edited pillars need re-approval.`} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<string, string> = { seasonal: "Seasonal", launch: "Launch", promotional: "Promotional", awareness: "Awareness", engagement: "Engagement", evergreen: "Evergreen" };

export function CampaignsView({ env, platforms }: { env?: Envelope<CampaignsSection>; platforms: string[] }) {
  const { save, saving } = useSave("campaigns");
  const c = env?.data;
  return (
    <SectionFrame section="campaigns" env={env} description="Campaign concepts for the window ahead: seasonal, launch, promotional and awareness." editor={(close) => <CampaignsEditor c={c!} platforms={platforms} saving={saving} onCancel={close} onSave={(d) => save(d, close)} />}>
      {c ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {c.campaigns.map((x) => (
            <Card key={x.id} className={cn("overflow-hidden", x.approved && "border-success/40")}>
              <div className="ai-gradient px-5 py-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="accent">{KIND_LABEL[x.kind] ?? x.kind}</Badge>
                  <Badge>{objectiveLabel(x.objective)}</Badge>
                  <span className="text-[11px] text-ink-2/70">{fmtDate(x.startDate)} · {x.durationDays} days</span>
                </div>
                <p className="mt-2 font-display text-[22px] leading-tight">{x.name}</p>
                <p className="mt-1 text-[13px] text-ink-2">“{x.keyMessage}”</p>
              </div>
              <CardBody className="space-y-3 text-[13px]">
                <p className="text-ink-2">{x.concept}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div><Kicker>Audience</Kicker><p className="text-ink-2">{x.audience}</p></div>
                  <div><Kicker>Call to action</Kicker><p className="text-ink-2">{x.cta}</p></div>
                </div>
                <div><Kicker>Creative direction</Kicker><p className="text-ink-2">{x.creativeDirection}</p></div>
                <div className="flex flex-wrap items-center gap-3">{x.platforms.map((p) => <PlatformTag key={p} platform={p} />)}</div>
                <div className="flex flex-wrap gap-1.5">{x.formats.map((f) => <Pill key={f}>{f}</Pill>)}</div>
                <div><Kicker>Success metrics</Kicker><Bullets items={x.metrics} /></div>
                <div className="pt-1"><ApproveToggle section="campaigns" id={x.id} approved={x.approved} /></div>
              </CardBody>
            </Card>
          ))}
        </div>
      ) : null}
    </SectionFrame>
  );
}

type CampaignDraft = Omit<CampaignsSection["campaigns"][number], "id" | "approved"> & { id?: string };

function CampaignsEditor({ c, platforms, onSave, onCancel, saving }: { c: CampaignsSection; platforms: string[]; onSave: (d: unknown) => void; onCancel: () => void; saving: boolean }) {
  const [list, setList] = useState<CampaignDraft[]>(() => c.campaigns.map(({ approved: _a, ...x }) => (void _a, structuredClone(x))));
  const set = (i: number, patch: Partial<CampaignDraft>) => setList(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div className="space-y-3">
      {list.map((x, i) => (
        <div key={x.id ?? `new-${i}`} className="space-y-2 rounded-xl border border-line bg-surface p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_150px_170px_auto]">
            <TextField label="Name" value={x.name} onChange={(v) => set(i, { name: v })} />
            <label className="block text-[12px]">
              <span className="mb-1 block font-medium text-ink-2">Type</span>
              <Select value={x.kind} onChange={(e) => set(i, { kind: e.target.value as CampaignDraft["kind"] })}>
                {CAMPAIGN_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </Select>
            </label>
            <label className="block text-[12px]">
              <span className="mb-1 block font-medium text-ink-2">Objective</span>
              <Select value={x.objective} onChange={(e) => set(i, { objective: e.target.value as CampaignDraft["objective"] })}>
                {OBJECTIVES.map((o) => <option key={o} value={o}>{objectiveLabel(o)}</option>)}
              </Select>
            </label>
            <Button variant="ghost" size="icon" className="self-end" onClick={() => setList(list.filter((_, j) => j !== i))} aria-label="Remove campaign"><Trash2 /></Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_160px_120px]">
            <TextField label="Key message" value={x.keyMessage} onChange={(v) => set(i, { keyMessage: v })} />
            <label className="block text-[12px]">
              <span className="mb-1 block font-medium text-ink-2">Start</span>
              <input type="date" value={x.startDate} onChange={(e) => set(i, { startDate: e.target.value })} className="h-9 w-full rounded-lg border border-line bg-surface px-3 text-[13px]" />
            </label>
            <TextField label="Days" value={String(x.durationDays)} onChange={(v) => set(i, { durationDays: Math.max(1, Math.min(120, Number(v) || 1)) })} />
          </div>
          <TextField label="Concept" area rows={2} value={x.concept} onChange={(v) => set(i, { concept: v })} />
          <TextField label="Creative direction" area rows={2} value={x.creativeDirection} onChange={(v) => set(i, { creativeDirection: v })} />
          <div className="grid gap-2 sm:grid-cols-2">
            <TextField label="Audience" value={x.audience} onChange={(v) => set(i, { audience: v })} />
            <TextField label="CTA" value={x.cta} onChange={(v) => set(i, { cta: v })} />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <ListField label="Formats" value={x.formats} onChange={(v) => set(i, { formats: v })} />
            <ListField label="Success metrics" value={x.metrics} onChange={(v) => set(i, { metrics: v })} />
          </div>
          <PlatformPicker value={x.platforms} allowed={platforms} onChange={(v) => set(i, { platforms: v as CampaignDraft["platforms"] })} />
        </div>
      ))}
      <Button size="sm" variant="secondary" onClick={() => setList([...list, { name: "New campaign", kind: "awareness", objective: "awareness", audience: "", concept: "", keyMessage: "", creativeDirection: "", formats: [], platforms: platforms as CampaignDraft["platforms"], startDate: new Date().toISOString().slice(0, 10), durationDays: 14, cta: "", metrics: [] }])}>
        <Plus /> Add campaign
      </Button>
      <SaveBar loading={saving} onCancel={onCancel} onSave={() => onSave({ campaigns: list })} note="Edited campaigns need re-approval." />
    </div>
  );
}

