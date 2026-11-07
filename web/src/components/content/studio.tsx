"use client";
import { useState } from "react";
import { CalendarPlus, Check, Copy, Lightbulb, PenLine, Sparkles } from "lucide-react";
import { createDraftPost, suggestIdeasAction, writeCopyAction } from "@/app/actions/ai";
import { Badge, Button, Card, CardBody, CardHeader, Empty, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { PlatformTag, Rationale } from "@/components/bits";
import { useRun } from "@/components/hooks";
import { OBJECTIVES, PLATFORMS, objectiveLabel, platformLabel } from "@/lib/domain";
import { roleAtLeast, type Role } from "@/lib/roles";
import type { ContentIdeas, Copy as CopyPack } from "@/server/agents/schemas";

export function ContentStudio({ brandId, role, platforms, pillars }: { brandId: string; role: Role; platforms: string[]; pillars: string[] }) {
  const canEdit = roleAtLeast(role, "editor");
  const [brief, setBrief] = useState("");
  const [platform, setPlatform] = useState(platforms[0] ?? "instagram");
  const [objective, setObjective] = useState("engagement");
  const [pillar, setPillar] = useState("");
  const [pack, setPack] = useState<CopyPack | null>(null);
  const [goal, setGoal] = useState("");
  const [ideas, setIdeas] = useState<ContentIdeas["ideas"]>([]);
  const { run, busy } = useRun();

  const write = (b = brief, p = platform, o = objective) =>
    run(() => writeCopyAction(brandId, { brief: b, platform: p, objective: o, pillar: pillar || undefined }), { key: "copy", onOk: setPack, refresh: false });

  return (
    <div>
      <PageHeader eyebrow="Content Studio" title="Captions & copy" description="The Copywriter writes in your brand voice, tuned to each platform and to the post's objective." />

      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Write a post" />
            <CardBody className="space-y-3">
              <Field label="What's the post about?">
                <Textarea rows={4} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Behind the scenes of glazing the winter collection: 3 coats, 2 firings, 1 happy accident." />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Platform">
                  <Select value={platform} onChange={(e) => setPlatform(e.target.value)}>
                    {PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </Select>
                </Field>
                <Field label="Objective">
                  <Select value={objective} onChange={(e) => setObjective(e.target.value)}>
                    {OBJECTIVES.map((o) => <option key={o} value={o}>{objectiveLabel(o)}</option>)}
                  </Select>
                </Field>
              </div>
              {pillars.length ? (
                <Field label="Content pillar">
                  <Select value={pillar} onChange={(e) => setPillar(e.target.value)}>
                    <option value="">Any</option>
                    {pillars.map((p) => <option key={p}>{p}</option>)}
                  </Select>
                </Field>
              ) : null}
              <Button variant="accent" className="w-full" disabled={!canEdit || !brief.trim()} loading={busy("copy")} onClick={() => write()}>
                <PenLine /> Write copy
              </Button>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Need ideas?" />
            <CardBody className="space-y-3">
              <Input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Improve engagement, drive workshop bookings…" />
              <Button variant="secondary" className="w-full" disabled={!canEdit} loading={busy("ideas")} onClick={() => run(() => suggestIdeasAction(brandId, goal || "improve engagement"), { key: "ideas", onOk: (d) => setIdeas(d.ideas), refresh: false })}>
                <Lightbulb /> Suggest ideas
              </Button>
            </CardBody>
          </Card>
        </div>

        <div className="space-y-6">
          {pack ? <PackView pack={pack} brandId={brandId} platform={platform} objective={objective} pillar={pillar} brief={brief} canEdit={canEdit} /> : null}
          {ideas.length ? (
            <Card>
              <CardHeader title="Content ideas" description="Click one to write it" />
              <CardBody className="grid gap-3 md:grid-cols-2">
                {ideas.map((i) => (
                  <button
                    key={i.title}
                    onClick={() => {
                      setBrief(`${i.title}. Hook: ${i.hook}`);
                      setPlatform(i.platform);
                      setObjective(i.objective);
                      write(`${i.title}. Hook: ${i.hook}`, i.platform, i.objective);
                    }}
                    className="rounded-xl border border-line p-4 text-left transition hover:border-line-strong hover:bg-sunken/40"
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <PlatformTag platform={i.platform} />
                      <Badge>{i.pillar}</Badge>
                    </div>
                    <p className="text-[13px] font-medium">{i.title}</p>
                    <p className="mt-1 text-[12px] italic text-ink-2">“{i.hook}”</p>
                    <p className="mt-1.5 text-[12px] text-muted">{i.why}</p>
                  </button>
                ))}
              </CardBody>
            </Card>
          ) : null}
          {!pack && !ideas.length ? (
            <Empty icon={<Sparkles />} title="Your copy will appear here">
              You&apos;ll get a primary caption, alternatives, short and long versions, hooks, a CTA, hashtags and per-platform variants.
            </Empty>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setOk(true);
        setTimeout(() => setOk(false), 1200);
      }}
      className="rounded-md p-1 text-faint hover:bg-sunken hover:text-ink"
      aria-label="Copy"
    >
      {ok ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-xl border border-line p-4">
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">{label}</p>
        <CopyBtn text={text} />
      </div>
      <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{text}</p>
    </div>
  );
}

function PackView({ pack, brandId, platform, objective, pillar, brief, canEdit }: { pack: CopyPack; brandId: string; platform: string; objective: string; pillar: string; brief: string; canEdit: boolean }) {
  const [chosen, setChosen] = useState(pack.primary);
  const { run, busy } = useRun();
  const tags = pack.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ");
  return (
    <Card>
      <CardHeader
        title="Copy pack"
        description={`${platformLabel(platform)} · ${objectiveLabel(objective)}`}
        action={
          canEdit ? (
            <Button
              size="sm"
              loading={busy()}
              onClick={() => run(() => createDraftPost(brandId, { platform, title: brief.slice(0, 80), caption: chosen, hashtags: pack.hashtags, objective, pillar: pillar || undefined, brief }), { success: "Draft post added to the calendar" })}
            >
              <CalendarPlus /> Add to calendar
            </Button>
          ) : null
        }
      />
      <CardBody className="space-y-4">
        <div>
          <p className="mb-2 text-[12px] font-medium text-ink-2">Choose the caption to use</p>
          <div className="space-y-2">
            {[pack.primary, ...pack.alternatives].map((c, i) => (
              <label key={i} className="flex cursor-pointer gap-3 rounded-xl border border-line p-4 transition has-[:checked]:border-ink has-[:checked]:bg-sunken/40">
                <input type="radio" name="caption" checked={chosen === c} onChange={() => setChosen(c)} className="mt-1 accent-ink" />
                <div className="min-w-0 flex-1">
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-faint">{i === 0 ? "Recommended" : `Alternative ${i}`}</p>
                  <p className="whitespace-pre-wrap text-[13px]">{c}</p>
                </div>
                <CopyBtn text={c} />
              </label>
            ))}
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Block label="Short form" text={pack.short} />
          <Block label="Call to action" text={pack.cta} />
        </div>
        <Block label="Long form" text={pack.long} />
        <div className="rounded-xl border border-line p-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">Opening hooks</p>
          <ul className="space-y-1.5">
            {pack.hooks.map((h) => (
              <li key={h} className="flex items-center justify-between gap-2 text-[13px]">
                <span>“{h}”</span>
                <CopyBtn text={h} />
              </li>
            ))}
          </ul>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-line p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">Hashtags</p>
              <CopyBtn text={tags} />
            </div>
            <div className="flex flex-wrap gap-1.5">{pack.hashtags.map((h) => <Badge key={h} tone="accent">#{h.replace(/^#/, "")}</Badge>)}</div>
          </div>
          <div className="rounded-xl border border-line p-4">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">Keywords</p>
            <div className="flex flex-wrap gap-1.5">{pack.keywords.map((h) => <Badge key={h}>{h}</Badge>)}</div>
          </div>
        </div>
        {pack.platformVariants.length ? (
          <div>
            <p className="mb-2 text-[12px] font-medium text-ink-2">Platform-specific versions</p>
            <div className="grid gap-3 md:grid-cols-2">
              {pack.platformVariants.map((v) => (
                <div key={v.platform} className="rounded-xl border border-line p-4">
                  <div className="mb-1.5 flex items-center justify-between">
                    <PlatformTag platform={v.platform} />
                    <CopyBtn text={v.copy} />
                  </div>
                  <p className="whitespace-pre-wrap text-[13px]">{v.copy}</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <Rationale>{pack.rationale}</Rationale>
      </CardBody>
    </Card>
  );
}

