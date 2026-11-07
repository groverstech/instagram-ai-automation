"use client";
import { useMemo, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Check, FileText, Pencil, RefreshCw, Sparkles, Trash2, Upload, X } from "lucide-react";
import { approveBrandProfile, addBrandNote, deleteAsset, deleteMemory, runBrandIntelligence, saveProfile, updateBrand, uploadAssets } from "@/app/actions/brand";
import { Badge, Button, Card, CardBody, CardHeader, Empty, Field, Input, Notice, PageHeader, Segmented, Select, Textarea } from "@/components/ui";
import { Rationale } from "@/components/bits";
import { useRun } from "@/components/hooks";
import type { BrandProfile } from "@/server/agents/schemas";
import type { Brand } from "@/server/db/schema";
import { OBJECTIVES, PLATFORMS, STYLES, objectiveLabel, styleById } from "@/lib/domain";
import { roleAtLeast, type Role } from "@/lib/roles";
import { cn } from "@/lib/utils";

type Tab = "profile" | "inputs" | "assets" | "memory";

export function BrandWorkspace(props: {
  role: Role;
  brand: Brand;
  profile: { id: string; version: number; status: string; data: BrandProfile } | null;
  approvedVersion: number | null;
  history: { id: string; version: number; status: string; createdAt: Date }[];
  assets: { id: string; kind: string; name: string; mime: string; analysis: Record<string, unknown> | null }[];
  memories: { id: string; kind: string; content: string; source: string; createdAt: Date }[];
  analysisError?: string;
  fresh: boolean;
}) {
  const [tab, setTab] = useState<Tab>("profile");
  const { run, busy } = useRun();
  const canEdit = roleAtLeast(props.role, "editor");
  const canApprove = roleAtLeast(props.role, "admin");
  const p = props.profile;

  return (
    <div>
      <PageHeader
        eyebrow="Brand Intelligence"
        title={props.brand.name}
        description="Your brand's source of truth. Every agent reads this profile and the memory it builds from your approvals and edits."
        actions={
          canEdit ? (
            <>
              <Button variant="secondary" loading={busy("gen")} onClick={() => run(() => runBrandIntelligence(props.brand.id), { key: "gen", success: "New profile draft generated" })}>
                <RefreshCw /> {p ? "Regenerate" : "Generate profile"}
              </Button>
              {p && p.status === "draft" && canApprove ? (
                <Button variant="accent" loading={busy("approve")} onClick={() => run(() => approveBrandProfile(props.brand.id, p.id), { key: "approve", success: "Profile approved and saved to brand memory" })}>
                  <Check /> Approve v{p.version}
                </Button>
              ) : null}
            </>
          ) : null
        }
      />

      {props.analysisError ? (
        <Notice tone="warn" className="mb-6">
          Your brand was saved, but analysis didn&apos;t finish: {props.analysisError}
        </Notice>
      ) : null}
      {props.fresh && p?.status === "draft" ? (
        <Notice tone="info" className="mb-6">
          Your Brand Intelligence Profile is ready. Review it, edit anything that&apos;s off, then approve it so every agent uses it.
        </Notice>
      ) : null}

      <div className="mb-6 flex items-center justify-between gap-3">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "profile", label: "Intelligence profile" },
            { value: "inputs", label: "Business details" },
            { value: "assets", label: `Assets (${props.assets.length})` },
            { value: "memory", label: `Memory (${props.memories.length})` },
          ]}
        />
        {p ? (
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <Badge tone={p.status === "approved" ? "success" : "warn"}>{p.status === "approved" ? "Approved" : "Draft"}</Badge>v{p.version}
            {props.approvedVersion && props.approvedVersion !== p.version ? <span>· agents use approved v{props.approvedVersion}</span> : null}
          </div>
        ) : null}
      </div>

      {tab === "profile" ? (
        p ? (
          <ProfileView key={p.id} brandId={props.brand.id} profile={p} canEdit={canEdit} />
        ) : (
          <Empty icon={<Sparkles />} title="No profile yet" action={canEdit ? <Button loading={busy("gen")} onClick={() => run(() => runBrandIntelligence(props.brand.id), { key: "gen", success: "Profile generated" })}><Sparkles /> Generate brand intelligence</Button> : null}>
            The Brand Intelligence agent reads your answers, website and uploaded assets to build your profile.
          </Empty>
        )
      ) : null}
      {tab === "inputs" ? <InputsForm brand={props.brand} canEdit={canEdit} /> : null}
      {tab === "assets" ? <Assets brandId={props.brand.id} assets={props.assets} canEdit={canEdit} /> : null}
      {tab === "memory" ? <Memory brandId={props.brand.id} memories={props.memories} canEdit={canEdit} /> : null}
    </div>
  );
}

function ProfileView({ brandId, profile, canEdit }: { brandId: string; profile: { id: string; data: BrandProfile }; canEdit: boolean }) {
  const [d, setD] = useState<BrandProfile>(profile.data);
  const [editing, setEditing] = useState(false);
  const { run, busy } = useRun();
  const dirty = useMemo(() => JSON.stringify(d) !== JSON.stringify(profile.data), [d, profile.data]);
  const set = <K extends keyof BrandProfile>(k: K, v: BrandProfile[K]) => setD((x) => ({ ...x, [k]: v }));

  return (
    <div className="space-y-6">
      {canEdit ? (
        <div className="flex justify-end gap-2">
          {editing ? (
            <>
              <Button variant="ghost" onClick={() => (setD(profile.data), setEditing(false))}>
                Cancel
              </Button>
              <Button disabled={!dirty} loading={busy()} onClick={() => run(() => saveProfile(brandId, profile.id, d), { success: "Profile saved", onOk: () => setEditing(false) })}>
                Save changes
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <Pencil /> Edit profile
            </Button>
          )}
        </div>
      ) : null}

      <Card className="overflow-hidden">
        <div className="ai-gradient p-6 md:p-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-2/70">{d.personality.archetype}</p>
          {editing ? (
            <Textarea className="mt-2 bg-white/80 font-display text-[22px]" value={d.summary} onChange={(e) => set("summary", e.target.value)} />
          ) : (
            <p className="mt-2 max-w-3xl font-display text-[28px] leading-[1.2]">{d.summary}</p>
          )}
          <div className="mt-4 flex flex-wrap gap-1.5">
            {d.personality.traits.map((t) => (
              <span key={t} className="rounded-full bg-white/70 px-2.5 py-1 text-[12px]">
                {t}
              </span>
            ))}
          </div>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Positioning" description={d.positioning.category} />
          <CardBody className="space-y-4">
            {editing ? (
              <Textarea value={d.positioning.statement} onChange={(e) => set("positioning", { ...d.positioning, statement: e.target.value })} />
            ) : (
              <p className="text-[15px] leading-relaxed">{d.positioning.statement}</p>
            )}
            <ListBlock title="Differentiators" items={d.positioning.differentiators} editing={editing} onChange={(v) => set("positioning", { ...d.positioning, differentiators: v })} />
            <ListBlock title="Unique selling propositions" items={d.usps} editing={editing} onChange={(v) => set("usps", v)} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Voice & communication" />
          <CardBody className="space-y-4">
            {editing ? <Textarea value={d.voice.description} onChange={(e) => set("voice", { ...d.voice, description: e.target.value })} /> : <p className="text-[15px]">{d.voice.description}</p>}
            <div className="grid gap-4 sm:grid-cols-2">
              <ListBlock title="Do" items={d.voice.do} editing={editing} tone="success" onChange={(v) => set("voice", { ...d.voice, do: v })} />
              <ListBlock title="Don't" items={d.voice.dont} editing={editing} tone="danger" onChange={(v) => set("voice", { ...d.voice, dont: v })} />
            </div>
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">Sounds like</p>
              <div className="space-y-1.5">
                {d.voice.sampleLines.map((l) => (
                  <p key={l} className="border-l-2 border-accent/40 pl-3 font-display text-[18px] italic text-ink-2">
                    “{l}”
                  </p>
                ))}
              </div>
            </div>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Audience personas" />
        <CardBody className="grid gap-4 md:grid-cols-3">
          {d.personas.map((p) => (
            <div key={p.name} className="rounded-xl border border-line p-4">
              <p className="font-medium">{p.name}</p>
              <p className="mt-1 text-[13px] text-muted">{p.snapshot}</p>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-faint">Goals</p>
              <ul className="mt-1 space-y-0.5 text-[12px]">{p.goals.map((g) => <li key={g}>· {g}</li>)}</ul>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-faint">Pain points</p>
              <ul className="mt-1 space-y-0.5 text-[12px]">{p.painPoints.map((g) => <li key={g}>· {g}</li>)}</ul>
              <div className="mt-3 flex flex-wrap gap-1">{p.channels.map((c) => <Badge key={c}>{c}</Badge>)}</div>
            </div>
          ))}
        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <Card>
          <CardHeader title="Visual identity" />
          <CardBody className="space-y-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {d.visualIdentity.palette.map((c, i) => (
                <div key={i} className="overflow-hidden rounded-xl border border-line">
                  <div className="h-16" style={{ background: c.hex }} />
                  <div className="p-2.5">
                    {editing ? (
                      <Input value={c.hex} onChange={(e) => set("visualIdentity", { ...d.visualIdentity, palette: d.visualIdentity.palette.map((x, j) => (j === i ? { ...x, hex: e.target.value } : x)) })} className="h-7 font-mono text-[12px]" />
                    ) : (
                      <p className="font-mono text-[12px] uppercase">{c.hex}</p>
                    )}
                    <p className="text-[12px] font-medium">{c.name}</p>
                    <p className="text-[11px] text-muted">{c.usage}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Kv k="Headings" v={d.visualIdentity.typography.heading} />
              <Kv k="Body" v={d.visualIdentity.typography.body} />
              <Kv k="Imagery" v={d.visualIdentity.imagery} />
              <Kv k="Layout" v={d.visualIdentity.layout} />
              <Kv k="Logo usage" v={d.visualIdentity.logoUsage} />
              <Kv k="Type notes" v={d.visualIdentity.typography.notes} />
            </div>
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">Preferred creative styles</p>
              {editing ? (
                <div className="flex flex-wrap gap-1.5">
                  {STYLES.map((s) => {
                    const on = d.preferredStyles.includes(s.id);
                    return (
                      <button key={s.id} type="button" onClick={() => set("preferredStyles", on ? d.preferredStyles.filter((x) => x !== s.id) : [...d.preferredStyles, s.id])} className={cn("rounded-full border px-2.5 py-1 text-[12px]", on ? "border-ink bg-ink text-white" : "border-line")}>
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">{d.preferredStyles.map((s) => <Badge key={s} tone="accent">{styleById(s).label}</Badge>)}</div>
              )}
            </div>
          </CardBody>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Content opportunities" />
            <CardBody className="space-y-2.5">
              {d.contentOpportunities.map((o) => (
                <div key={o.title}>
                  <p className="text-[13px] font-medium">{o.title}</p>
                  <p className="text-[12px] text-muted">{o.why}</p>
                </div>
              ))}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Customer pain points" />
            <CardBody>
              <ListBlock title="" items={d.painPoints} editing={editing} onChange={(v) => set("painPoints", v)} />
            </CardBody>
          </Card>
        </div>
      </div>

      {d.competitorPositioning.length ? (
        <Card>
          <CardHeader title="Competitive positioning" />
          <CardBody className="grid gap-3 md:grid-cols-2">
            {d.competitorPositioning.map((c) => (
              <div key={c.name} className="rounded-xl border border-line p-4">
                <p className="font-medium">{c.name}</p>
                <p className="mt-1 text-[12px] text-muted">{c.positioning}</p>
                <p className="mt-2 text-[13px]">
                  <span className="font-medium text-accent-ink">How we differ: </span>
                  {c.howWeDiffer}
                </p>
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <Rationale>{d.rationale}</Rationale>
    </div>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">{k}</p>
      <p className="mt-0.5 text-[13px]">{v}</p>
    </div>
  );
}

function ListBlock({ title, items, editing, onChange, tone }: { title: string; items: string[]; editing: boolean; onChange: (v: string[]) => void; tone?: "success" | "danger" }) {
  return (
    <div>
      {title ? <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">{title}</p> : null}
      {editing ? (
        <Textarea value={items.join("\n")} onChange={(e) => onChange(e.target.value.split("\n"))} onBlur={(e) => onChange(e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))} rows={Math.max(3, items.length)} />
      ) : (
        <ul className="space-y-1 text-[13px]">
          {items.map((i) => (
            <li key={i} className="flex gap-2">
              <span className={cn("mt-2 size-1.5 shrink-0 rounded-full", tone === "success" ? "bg-success" : tone === "danger" ? "bg-danger" : "bg-faint")} />
              {i}
            </li>
          ))}
        </ul>
      )}
    </div>
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
        run(() => updateBrand(brand.id, fd), { success: "Business details saved. Regenerate the profile to apply them." });
      }}
    >
      <fieldset disabled={!canEdit} className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Business" />
          <CardBody className="space-y-4">
            <Field label="Name"><Input name="name" defaultValue={brand.name} required /></Field>
            <Field label="Website"><Input name="website" defaultValue={brand.website ?? ""} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Industry"><Input name="industry" defaultValue={brand.industry ?? ""} /></Field>
              <Field label="Category"><Input name="category" defaultValue={brand.category ?? ""} /></Field>
            </div>
            <Field label="Products & services"><Textarea name="products" defaultValue={brand.products ?? ""} /></Field>
            <Field label="Target audience"><Textarea name="targetAudience" defaultValue={brand.targetAudience ?? ""} /></Field>
            <Field label="Geographic market"><Input name="geography" defaultValue={brand.geography ?? ""} /></Field>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Identity & goals" />
          <CardBody className="space-y-4">
            <Field label="Positioning"><Textarea name="positioning" defaultValue={brand.positioning ?? ""} /></Field>
            <Field label="Personality"><Input name="personality" defaultValue={brand.personality ?? ""} /></Field>
            <Field label="Tone of voice"><Textarea name="tone" defaultValue={brand.tone ?? ""} /></Field>
            <Field label="Marketing goals"><Textarea name="marketingGoals" defaultValue={brand.marketingGoals ?? ""} /></Field>
            <Checks name="objectives" options={OBJECTIVES.map((o) => [o, objectiveLabel(o)])} values={brand.objectives} label="Objectives" />
            <Checks name="platforms" options={PLATFORMS.map((p) => [p.id, p.label])} values={brand.platforms} label="Platforms" />
            <Field label="Competitors" hint="Comma or line separated"><Textarea name="competitors" defaultValue={brand.competitors.join("\n")} /></Field>
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

function Assets({ brandId, assets, canEdit }: { brandId: string; assets: { id: string; kind: string; name: string; mime: string; analysis: Record<string, unknown> | null }[]; canEdit: boolean }) {
  const [kind, setKind] = useState("product");
  const input = useRef<HTMLInputElement>(null);
  const { run, busy } = useRun();
  return (
    <div className="space-y-6">
      {canEdit ? (
        <Card>
          <CardBody className="flex flex-wrap items-end gap-3">
            <Field label="Asset type" className="w-56">
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="logo">Logo</option>
                <option value="guideline">Brand guidelines</option>
                <option value="product">Product photography</option>
                <option value="creative">Marketing creative</option>
                <option value="post">Previous social post</option>
                <option value="reference">Reference design</option>
              </Select>
            </Field>
            <input
              ref={input}
              type="file"
              multiple
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => {
                const fd = new FormData();
                for (const f of Array.from(e.target.files ?? [])) fd.append(`asset_${kind}`, f);
                run(() => uploadAssets(brandId, fd), { success: (n) => `${n} file(s) uploaded. Regenerate the profile to analyse them.` });
                e.target.value = "";
              }}
            />
            <Button variant="secondary" loading={busy()} onClick={() => input.current?.click()}>
              <Upload /> Upload files
            </Button>
            <p className="text-[12px] text-faint">PNG, JPG, WebP, SVG or PDF · up to 15 MB</p>
          </CardBody>
        </Card>
      ) : null}
      {assets.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {assets.map((a) => (
            <Card key={a.id} className="group overflow-hidden">
              {a.mime.startsWith("image/") ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/assets/${a.id}`} alt={a.name} className="aspect-[4/3] w-full bg-sunken object-contain p-2" />
              ) : (
                <div className="grid aspect-[4/3] place-items-center bg-sunken text-muted">
                  <FileText className="size-8" />
                </div>
              )}
              <div className="p-3">
                <div className="flex items-center justify-between gap-2">
                  <Badge className="capitalize">{a.kind}</Badge>
                  {canEdit ? (
                    <button onClick={() => run(() => deleteAsset(brandId, a.id), { success: "Asset removed" })} className="text-faint opacity-0 transition hover:text-danger group-hover:opacity-100" aria-label="Delete asset">
                      <Trash2 className="size-4" />
                    </button>
                  ) : null}
                </div>
                <p className="mt-2 truncate text-[13px] font-medium">{a.name}</p>
                {a.analysis ? <p className="mt-1 line-clamp-3 text-[12px] text-muted">{String(a.analysis.aesthetic ?? a.analysis.description ?? "")}</p> : <p className="mt-1 text-[12px] text-faint">Not analysed yet</p>}
                {Array.isArray(a.analysis?.palette) ? (
                  <div className="mt-2 flex gap-1">
                    {(a.analysis!.palette as string[]).slice(0, 6).map((c) => (
                      <span key={c} className="size-4 rounded" style={{ background: c }} />
                    ))}
                  </div>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Empty icon={<Upload />} title="No assets yet">
          Upload your logo, guidelines and product photos so creatives match your visual identity.
        </Empty>
      )}
    </div>
  );
}

function Memory({ brandId, memories, canEdit }: { brandId: string; memories: { id: string; kind: string; content: string; source: string; createdAt: Date }[]; canEdit: boolean }) {
  const [note, setNote] = useState("");
  const { run, busy } = useRun();
  const tone: Record<string, string> = { fact: "neutral", preference: "accent", feedback: "warn", approval: "success", insight: "info", competitor: "outline" };
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <Card>
        <CardHeader title="What your AI team has learned" description="Retrieved by semantic search for every task. Remove anything that's wrong." />
        <CardBody>
          {memories.length ? (
            <ul className="divide-y divide-line">
              {memories.map((m) => (
                <li key={m.id} className="group flex items-start gap-3 py-2.5">
                  <Badge tone={tone[m.kind] ?? "neutral"} className="mt-0.5 w-20 justify-center capitalize">{m.kind}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px]">{m.content}</p>
                    <p className="text-[11px] text-faint">{m.source} · {formatDistanceToNow(m.createdAt, { addSuffix: true })}</p>
                  </div>
                  {canEdit ? (
                    <button onClick={() => run(() => deleteMemory(brandId, m.id), { success: "Memory removed" })} className="text-faint opacity-0 transition hover:text-danger group-hover:opacity-100" aria-label="Forget">
                      <X className="size-4" />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">Memory grows as you approve the profile, edit captions, approve posts and sync analytics.</p>
          )}
        </CardBody>
      </Card>
      {canEdit ? (
        <Card className="h-fit">
          <CardHeader title="Teach your team" description="Rules every agent should follow" />
          <CardBody className="space-y-3">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Never use the word 'luxury'. Always mention free shipping over ₹2,000." />
            <Button className="w-full" disabled={!note.trim()} loading={busy()} onClick={() => run(() => addBrandNote(brandId, note), { success: "Saved to brand memory", onOk: () => setNote("") })}>
              Add to memory
            </Button>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
