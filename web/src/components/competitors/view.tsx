"use client";
import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ExternalLink, Plus, Radar, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { addCompetitor, analyzeCompetitorAction, deleteCompetitor } from "@/app/actions/ai";
import { Badge, Button, Card, CardBody, CardHeader, Empty, Field, Input, PageHeader } from "@/components/ui";
import { useRun } from "@/components/hooks";
import { roleAtLeast, type Role } from "@/lib/roles";
import type { CompetitorAnalysis } from "@/server/agents/schemas";

type Comp = { id: string; name: string; url: string | null; handles: string[]; analyzedAt: Date | null; analysis: (CompetitorAnalysis & { sources?: string[] }) | null };

export function CompetitorsView({ brandId, role, competitors, suggestions }: { brandId: string; role: Role; competitors: Comp[]; suggestions: string[] }) {
  const canEdit = roleAtLeast(role, "editor");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [handles, setHandles] = useState("");
  const { run, busy } = useRun();
  const add = (n: string, u?: string, h?: string) =>
    run(() => addCompetitor(brandId, { name: n, url: u, handles: h }), {
      key: "add",
      success: "Competitor added",
      onOk: (d) => {
        setName("");
        setUrl("");
        setHandles("");
        run(() => analyzeCompetitorAction(brandId, d.id), { key: d.id, success: `Research on ${n} complete` });
      },
    });

  return (
    <div>
      <PageHeader eyebrow="Competitor Intelligence" title="Competitors" description="The Competitor Research agent studies publicly available information (websites, public social presence, press) and finds gaps your brand can own." />

      {canEdit ? (
        <Card className="mb-6">
          <CardBody className="space-y-3">
            <div className="grid gap-3 md:grid-cols-[1fr_1.3fr_1fr_auto] md:items-end">
              <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Claymen" /></Field>
              <Field label="Website or profile URL"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://claymen.in" /></Field>
              <Field label="Social handles"><Input value={handles} onChange={(e) => setHandles(e.target.value)} placeholder="@claymen" /></Field>
              <Button variant="accent" disabled={!name.trim()} loading={busy("add")} onClick={() => add(name, url, handles)}><Sparkles /> Add & research</Button>
            </div>
            {suggestions.length ? (
              <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
                From onboarding:
                {suggestions.map((s) => (
                  <button key={s} onClick={() => add(s, /^https?:\/\//.test(s) ? s : undefined)} className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-0.5 hover:bg-sunken"><Plus className="size-3" /> {s}</button>
                ))}
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {competitors.length ? (
        <div className="space-y-6">
          {competitors.map((c) => (
            <Card key={c.id}>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    {c.name}
                    {c.url ? <a href={c.url.startsWith("http") ? c.url : `https://${c.url}`} target="_blank" rel="noreferrer" className="text-faint hover:text-ink"><ExternalLink className="size-3.5" /></a> : null}
                  </span>
                }
                description={c.analyzedAt ? `Researched ${formatDistanceToNow(c.analyzedAt, { addSuffix: true })}` : busy(c.id) ? "Researching…" : "Not researched yet"}
                action={
                  canEdit ? (
                    <div className="flex gap-1">
                      <Button size="sm" variant="secondary" loading={busy(c.id)} onClick={() => run(() => analyzeCompetitorAction(brandId, c.id), { key: c.id, success: "Research updated" })}>
                        <RefreshCw /> {c.analysis ? "Refresh" : "Research"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => run(() => deleteCompetitor(brandId, c.id), { success: "Removed" })} aria-label="Remove"><Trash2 /></Button>
                    </div>
                  ) : null
                }
              />
              {c.analysis ? (
                <CardBody className="space-y-5">
                  <p className="text-[15px]">{c.analysis.summary}</p>
                  <div className="grid gap-5 md:grid-cols-3">
                    <Sec title="Positioning"><p>{c.analysis.positioning}</p></Sec>
                    <Sec title="Posting patterns"><p>{c.analysis.postingPatterns}</p></Sec>
                    <Sec title="Engagement patterns"><p>{c.analysis.engagementPatterns}</p></Sec>
                    <Sec title="Content themes"><Chips items={c.analysis.contentThemes} /></Sec>
                    <Sec title="Creative styles"><Chips items={c.analysis.creativeStyles} /></Sec>
                    <Sec title="Campaign approaches"><Chips items={c.analysis.campaignApproaches} /></Sec>
                    <Sec title="Strengths"><List items={c.analysis.strengths} /></Sec>
                    <Sec title="Weaknesses"><List items={c.analysis.weaknesses} /></Sec>
                    <Sec title="Content gaps"><List items={c.analysis.contentGaps} /></Sec>
                  </div>
                  <div className="rounded-xl ai-gradient p-4">
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-2/70">How to differentiate</p>
                    <div className="grid gap-3 md:grid-cols-2">
                      {c.analysis.differentiation.map((d) => (
                        <div key={d.move} className="rounded-lg bg-white/70 p-3">
                          <p className="text-[13px] font-medium">{d.move}</p>
                          <p className="text-[12px] text-muted">{d.why}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                  <p className="text-[12px] text-faint">{c.analysis.confidenceNote}</p>
                  {c.analysis.sources?.length ? (
                    <details className="text-[12px] text-muted">
                      <summary className="cursor-pointer">Sources ({c.analysis.sources.length})</summary>
                      <ul className="mt-1 space-y-0.5">{c.analysis.sources.map((s) => <li key={s}><a href={s} target="_blank" rel="noreferrer" className="hover:underline">{s}</a></li>)}</ul>
                    </details>
                  ) : null}
                </CardBody>
              ) : null}
            </Card>
          ))}
        </div>
      ) : (
        <Empty icon={<Radar />} title="No competitors yet">Add a competitor to see their positioning, content patterns and the gaps you can own.</Empty>
      )}
    </div>
  );
}

function Sec({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="text-[13px]">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">{title}</p>
      {children}
    </div>
  );
}
const Chips = ({ items }: { items: string[] }) => <div className="flex flex-wrap gap-1">{items.map((i) => <Badge key={i}>{i}</Badge>)}</div>;
const List = ({ items }: { items: string[] }) => <ul className="space-y-0.5">{items.map((i) => <li key={i}>· {i}</li>)}</ul>;
