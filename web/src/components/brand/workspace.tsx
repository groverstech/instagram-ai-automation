"use client";
import { useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, Check, HelpCircle, Info, RefreshCw, Sparkles, X } from "lucide-react";
import { approveBrandProfile, addBrandNote, deleteMemory, runBrandIntelligence, updateBrand } from "@/app/actions/brand";
import { Badge, Button, Card, CardBody, CardHeader, Empty, Field, Input, Notice, PageHeader, Textarea } from "@/components/ui";
import { Rationale } from "@/components/bits";
import { useRun } from "@/components/hooks";
import { ProfileSections, SourceChip, SourceLegend } from "./profile-sections";
import { BrandChat, type ChatMsg } from "./brand-chat";
import { AssetsPanel, type AssetRow } from "./assets-panel";
import type { Brand } from "@/server/db/schema";
import { OBJECTIVES, PLATFORMS, objectiveLabel } from "@/lib/domain";
import { roleAtLeast, type Role } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { SECTIONS, type BrandProfileV2, type ScorePart, type SectionStatus } from "@/lib/brand-profile";

type Tab = "profile" | "ask" | "assets" | "details" | "memory";

export function BrandWorkspace(props: {
  role: Role;
  brand: Brand;
  ai: { provider: string; ready: boolean };
  profile: { id: string; version: number; status: string; data: BrandProfileV2; sectionStatus: SectionStatus } | null;
  profileUnreadable: boolean;
  approvedVersion: number | null;
  history: { id: string; version: number; status: string; createdAt: Date }[];
  score: { score: number; parts: ScorePart[] };
  assets: AssetRow[];
  memories: { id: string; kind: string; content: string; source: string; createdAt: Date }[];
  chat: { id: string; role: "user" | "assistant"; content: string; meta: Record<string, unknown> | null }[];
  analysisError?: string;
  fresh: boolean;
  initialTab?: string;
}) {
  const tabs: { value: Tab; label: string }[] = [
    { value: "profile", label: "Brand profile" },
    { value: "ask", label: "Ask your brand" },
    { value: "assets", label: `Assets (${props.assets.length})` },
    { value: "details", label: "Business details" },
    { value: "memory", label: "Memory & instructions" },
  ];
  const [tab, setTab] = useState<Tab>(tabs.some((t) => t.value === props.initialTab) ? (props.initialTab as Tab) : "profile");
  const { run, busy } = useRun();
  const canEdit = roleAtLeast(props.role, "editor");
  const canApprove = roleAtLeast(props.role, "admin");
  const p = props.profile;
  const confirmed = p ? SECTIONS.filter((s) => p.sectionStatus[s.id] === "confirmed").length : 0;

  const generate = () =>
    run(() => runBrandIntelligence(props.brand.id), {
      key: "gen",
      success: (d) => `New profile draft generated${d.assetsFailed ? ` · ${d.assetsFailed} asset(s) couldn't be analysed` : ""}`,
    });

  return (
    <div>
      <PageHeader
        eyebrow="Brand Intelligence"
        title={props.brand.name}
        description="Your brand's source of truth. Every agent reads this profile, your instructions and approved assets before creating anything."
        actions={
          canEdit ? (
            <>
              <Button variant="secondary" loading={busy("gen")} onClick={generate} disabled={!props.ai.ready}>
                <RefreshCw /> {p ? "Re-analyse" : "Analyse my brand"}
              </Button>
              {p && p.status === "draft" && canApprove ? (
                <Button variant="accent" loading={busy("approve")} onClick={() => run(() => approveBrandProfile(props.brand.id, p.id), { key: "approve", success: "Profile approved. Agents now use it as the source of truth." })}>
                  <Check /> Approve v{p.version}
                </Button>
              ) : null}
            </>
          ) : null
        }
      />

      {busy("gen") ? (
        <Notice tone="info" className="mb-6">
          The Brand Intelligence agent is reading your answers, website and assets. This usually takes a minute or two.
        </Notice>
      ) : null}
      {props.analysisError ? (
        <Notice tone="warn" className="mb-6">
          Your brand was saved, but the analysis didn&apos;t finish: {props.analysisError}. You can retry with <strong>Analyse my brand</strong>.
        </Notice>
      ) : null}
      {props.profileUnreadable ? (
        <Notice tone="danger" className="mb-6">
          The latest profile couldn&apos;t be read. Re-analyse to create a fresh version; your inputs and assets are safe.
        </Notice>
      ) : null}
      {props.fresh && p?.status === "draft" ? (
        <Notice tone="info" className="mb-6">
          Your Brand Intelligence Profile is ready. Review each section, edit anything that&apos;s off, confirm it, then approve the profile.
        </Notice>
      ) : null}

      <div className="mb-6 grid gap-6 lg:grid-cols-[340px_1fr]">
        <ScoreCard score={props.score} />
        <Card className="overflow-hidden">
          {p ? (
            <div className="flex h-full flex-col">
              <div className="ai-gradient p-6">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={p.status === "approved" ? "success" : "warn"}>{p.status === "approved" ? "Approved" : "Draft"}</Badge>
                  <span className="text-[12px] text-ink-2">
                    v{p.version}
                    {props.approvedVersion && props.approvedVersion !== p.version ? ` · agents currently use approved v${props.approvedVersion}` : ""}
                  </span>
                  {p.data.identity.archetype ? <span className="text-[12px] text-ink-2">· {p.data.identity.archetype}</span> : null}
                </div>
                <p className="mt-3 font-display text-[26px] leading-[1.2]">{p.data.summary || "No summary"}</p>
              </div>
              <div className="flex flex-1 flex-col justify-between gap-4 p-5">
                <div>
                  <div className="mb-2 flex items-center justify-between text-[12px]">
                    <span className="font-medium">Review progress</span>
                    <span className="text-muted">
                      {confirmed} of {SECTIONS.length} sections confirmed
                    </span>
                  </div>
                  <div className="flex gap-1">
                    {SECTIONS.map((s) => (
                      <a key={s.id} href={`#section-${s.id}`} onClick={() => setTab("profile")} title={`${s.label}: ${p.sectionStatus[s.id] === "confirmed" ? "confirmed" : "needs review"}`} className={cn("h-2 flex-1 rounded-full", p.sectionStatus[s.id] === "confirmed" ? "bg-success" : "bg-line-strong")} />
                    ))}
                  </div>
                </div>
                <SourceLegend />
              </div>
            </div>
          ) : (
            <div className="grid h-full place-items-center p-8">
              <Empty icon={<Sparkles />} title="No Brand Intelligence Profile yet" action={canEdit ? <Button variant="accent" loading={busy("gen")} disabled={!props.ai.ready} onClick={generate}><Sparkles /> Analyse my brand</Button> : null}>
                {props.ai.ready ? "The agent reads your answers, website and uploaded assets, then builds a profile you review section by section." : "Configure ANTHROPIC_API_KEY on the server to enable analysis."}
              </Empty>
            </div>
          )}
        </Card>
      </div>

      <div className="scrollbar-thin -mx-4 mb-6 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="inline-flex rounded-lg border border-line bg-sunken p-0.5" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.value}
              role="tab"
              aria-selected={tab === t.value}
              onClick={() => setTab(t.value)}
              className={cn("whitespace-nowrap rounded-md px-3 py-1.5 text-[12px] font-medium transition", tab === t.value ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink")}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "profile" ? (
        p ? (
          <div className="space-y-6">
            {p.data.openQuestions.length ? (
              <Card>
                <CardHeader title={<span className="flex items-center gap-2"><HelpCircle className="size-4 text-accent" /> Questions to sharpen your profile</span>} description="The agent couldn't determine these. Answer them in Business details or as an instruction, then re-analyse." />
                <CardBody className="pt-3">
                  <ul className="space-y-1.5 text-[13px]">{p.data.openQuestions.map((q) => <li key={q}>· {q}</li>)}</ul>
                </CardBody>
              </Card>
            ) : null}
            <ProfileSections key={`${p.id}-${JSON.stringify(p.sectionStatus)}`} brandId={props.brand.id} profileId={p.id} profile={p.data} sectionStatus={p.sectionStatus} canEdit={canEdit} locked={p.status === "superseded"} />
            {p.data.competitors.length ? (
              <Card>
                <CardHeader title="Competitive landscape" />
                <CardBody className="grid gap-3 md:grid-cols-2">
                  {p.data.competitors.map((c) => (
                    <div key={c.name} className="rounded-xl border border-line p-4">
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-medium">{c.name}</p>
                        <SourceChip source={c.source} />
                      </div>
                      {c.positioning ? <p className="mt-1 text-[12px] text-muted">{c.positioning}</p> : null}
                      {c.howWeDiffer ? (
                        <p className="mt-2 text-[13px]">
                          <span className="font-medium text-accent-ink">How we differ: </span>
                          {c.howWeDiffer}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </CardBody>
              </Card>
            ) : null}
            <Rationale>{p.data.rationale}</Rationale>
            {props.history.length > 1 ? (
              <p className="text-[12px] text-faint">
                Versions: {props.history.map((h) => `v${h.version} (${h.status}, ${formatDistanceToNow(h.createdAt, { addSuffix: true })})`).join(" · ")}
              </p>
            ) : null}
          </div>
        ) : (
          <Empty icon={<Info />} title="Generate the profile to see your brand intelligence" />
        )
      ) : null}
      {tab === "ask" ? (
        <BrandChat brandId={props.brand.id} initial={props.chat as ChatMsg[]} canAsk={props.ai.ready} canClear={canEdit} hasProfile={Boolean(p)} />
      ) : null}
      {tab === "assets" ? <AssetsPanel brandId={props.brand.id} assets={props.assets} canEdit={canEdit} /> : null}
      {tab === "details" ? <InputsForm brand={props.brand} canEdit={canEdit} /> : null}
      {tab === "memory" ? <Memory brandId={props.brand.id} memories={props.memories} canEdit={canEdit} /> : null}
    </div>
  );
}

function ScoreCard({ score }: { score: { score: number; parts: ScorePart[] } }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  return (
    <Card>
      <CardBody>
        <div className="flex items-center gap-5">
          <div className="relative size-28 shrink-0">
            <svg viewBox="0 0 100 100" className="size-full -rotate-90">
              <circle cx="50" cy="50" r={r} fill="none" stroke="var(--color-sunken)" strokeWidth="9" />
              <circle cx="50" cy="50" r={r} fill="none" stroke="var(--color-accent)" strokeWidth="9" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - score.score / 100)} />
            </svg>
            <div className="absolute inset-0 grid place-items-center text-center">
              <div>
                <p className="text-[28px] font-semibold leading-none tracking-tight">{score.score}</p>
                <p className="text-[10px] text-faint">/ 100</p>
              </div>
            </div>
          </div>
          <div>
            <p className="text-[14px] font-semibold">Brand Intelligence Score</p>
            <p className="mt-1 text-[12px] text-muted">How completely your AI team knows the brand. An indicative completeness measure, not a quality rating.</p>
          </div>
        </div>
        <ul className="mt-5 space-y-2.5">
          {score.parts.map((p) => (
            <li key={p.id}>
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-ink-2">{p.label}</span>
                <span className="tabular-nums text-muted">
                  {p.earned}/{p.max}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-sunken">
                <div className="h-full rounded-full bg-ink" style={{ width: `${(p.earned / p.max) * 100}%` }} />
              </div>
              {p.tip ? <p className="mt-0.5 text-[11px] text-faint">{p.tip}</p> : null}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function InputsForm({ brand, canEdit }: { brand: Brand; canEdit: boolean }) {
  const ref = useRef<HTMLFormElement>(null);
  const { run, busy } = useRun();
  return (
    <form
      ref={ref}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(ref.current!);
        run(() => updateBrand(brand.id, fd), { success: "Business details saved. Re-analyse to update the profile." });
      }}
    >
      <fieldset disabled={!canEdit} className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Business" />
          <CardBody className="space-y-4">
            <Field label="Brand name"><Input name="name" defaultValue={brand.name} required /></Field>
            <Field label="Website"><Input name="website" defaultValue={brand.website ?? ""} inputMode="url" /></Field>
            <Field label="Business description"><Textarea name="description" rows={4} maxLength={4000} defaultValue={brand.description ?? ""} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Industry"><Input name="industry" defaultValue={brand.industry ?? ""} /></Field>
              <Field label="Category"><Input name="category" defaultValue={brand.category ?? ""} /></Field>
            </div>
            <Field label="Products & services"><Textarea name="products" defaultValue={brand.products ?? ""} /></Field>
            <Field label="Target audience"><Textarea name="targetAudience" defaultValue={brand.targetAudience ?? ""} /></Field>
            <Field label="Target geographical markets"><Input name="geography" defaultValue={brand.geography ?? ""} /></Field>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Identity & goals" />
          <CardBody className="space-y-4">
            <Field label="Brand positioning"><Textarea name="positioning" defaultValue={brand.positioning ?? ""} /></Field>
            <Field label="Brand personality"><Input name="personality" defaultValue={brand.personality ?? ""} /></Field>
            <Field label="Communication tone"><Textarea name="tone" defaultValue={brand.tone ?? ""} /></Field>
            <Field label="Marketing goals"><Textarea name="marketingGoals" defaultValue={brand.marketingGoals ?? ""} /></Field>
            <Checks name="objectives" options={OBJECTIVES.map((o) => [o, objectiveLabel(o)])} values={brand.objectives} label="Marketing objectives" />
            <Checks name="platforms" options={PLATFORMS.map((p) => [p.id, p.label])} values={brand.platforms} label="Preferred platforms" />
            <Field label="Competitors" hint="One per line"><Textarea name="competitors" defaultValue={brand.competitors.join("\n")} /></Field>
            <Field label="Brand colours" hint="Hex, comma separated"><Input name="colors" defaultValue={brand.colors.join(", ")} className="font-mono" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Heading font"><Input name="headingFont" defaultValue={brand.fonts.heading ?? ""} /></Field>
              <Field label="Body font"><Input name="bodyFont" defaultValue={brand.fonts.body ?? ""} /></Field>
            </div>
          </CardBody>
        </Card>
      </fieldset>
      {canEdit ? (
        <div className="mt-6 flex justify-end">
          <Button loading={busy()}>Save details</Button>
        </div>
      ) : null}
    </form>
  );
}

function Checks({ name, options, values, label }: { name: string; options: [string, string][]; values: string[]; label: string }) {
  return (
    <div>
      <p className="mb-1.5 text-[12px] font-medium text-ink-2">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map(([v, l]) => (
          <label key={v} className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12px] has-[:checked]:border-ink has-[:checked]:bg-ink has-[:checked]:text-white">
            <input type="checkbox" name={name} value={v} defaultChecked={values.includes(v)} className="sr-only" />
            {l}
          </label>
        ))}
      </div>
    </div>
  );
}

function Memory({ brandId, memories, canEdit }: { brandId: string; memories: { id: string; kind: string; content: string; source: string; createdAt: Date }[]; canEdit: boolean }) {
  const [note, setNote] = useState("");
  const { run, busy } = useRun();
  const instructions = memories.filter((m) => m.kind === "instruction");
  const learned = memories.filter((m) => m.kind !== "instruction");
  const tone: Record<string, string> = { fact: "neutral", preference: "accent", feedback: "warn", approval: "success", insight: "info", competitor: "outline" };
  const Row = ({ m }: { m: (typeof memories)[number] }) => (
    <li className="group flex items-start gap-3 py-2.5">
      <Badge tone={tone[m.kind] ?? "neutral"} className="mt-0.5 w-20 shrink-0 justify-center capitalize">
        {m.kind}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="text-[13px]">{m.content}</p>
        <p className="text-[11px] text-faint">
          {m.source} · {formatDistanceToNow(m.createdAt, { addSuffix: true })}
        </p>
      </div>
      {canEdit ? (
        <button onClick={() => run(() => deleteMemory(brandId, m.id), { success: "Removed from memory" })} className="text-faint transition hover:text-danger md:opacity-0 md:group-hover:opacity-100" aria-label="Forget">
          <X className="size-4" />
        </button>
      ) : null}
    </li>
  );
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="space-y-6">
        <Card>
          <CardHeader title="Brand instructions" description="Standing rules included in every AI task, regardless of topic." />
          <CardBody className="pt-3">
            {instructions.length ? <ul className="divide-y divide-line">{instructions.map((m) => <Row key={m.id} m={m} />)}</ul> : <p className="text-[13px] text-muted">No instructions yet.</p>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="What your AI team has learned" description="From confirmed profile sections, approvals, edits and analytics. Retrieved by relevance for each task." />
          <CardBody className="pt-3">
            {learned.length ? (
              <ul className="divide-y divide-line">{learned.map((m) => <Row key={m.id} m={m} />)}</ul>
            ) : (
              <p className="text-[13px] text-muted">Memory grows as you confirm profile sections, approve assets and content, and edit AI output.</p>
            )}
          </CardBody>
        </Card>
      </div>
      {canEdit ? (
        <Card className="h-fit">
          <CardHeader title="Add an instruction" description="e.g. compliance rules, words to avoid, mandatory mentions" />
          <CardBody className="space-y-3">
            <Textarea value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Never use the word 'luxury'. Always mention free shipping over ₹2,000." />
            <Button className="w-full" disabled={!note.trim()} loading={busy()} onClick={() => run(() => addBrandNote(brandId, note), { success: "Instruction saved. Every agent will follow it.", onOk: () => setNote("") })}>
              Save instruction
            </Button>
            <p className="flex gap-1.5 text-[11px] text-faint">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" /> Instructions are shared with every agent for this brand only.
            </p>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
