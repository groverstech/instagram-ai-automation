"use client";
import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Check, Copy, Download, ImageOff, Layers, Palette, RefreshCw, Sparkles, Trash2, Wand2, X } from "lucide-react";
import {
  createDraftPost,
  deleteCreativeAction,
  generateCreativesAction,
  regenerateImageAction,
  setCreativeStatusAction,
  updateCreativeAction,
  variationAction,
} from "@/app/actions/ai";
import { Badge, Button, Card, Empty, Field, Input, Modal, Notice, PageHeader, Segmented, Select, Textarea } from "@/components/ui";
import { Rationale } from "@/components/bits";
import { useRun } from "@/components/hooks";
import { FORMATS, OBJECTIVES, STYLES, formatById, objectiveLabel, styleById } from "@/lib/domain";
import { roleAtLeast, type Role } from "@/lib/roles";
import { cn } from "@/lib/utils";
import type { CreativeConcept } from "@/server/agents/schemas";

type C = {
  id: string;
  format: string;
  style: string;
  status: string;
  campaignId: string | null;
  parentId: string | null;
  hasImage: boolean;
  imageError: string | null;
  imageProvider: string | null;
  createdAt: Date;
  concept: CreativeConcept & { brief?: string; objective?: string | null };
};

const LAYOUTS = [
  ["hero_overlay", "Hero overlay"],
  ["split", "Split"],
  ["frame", "Frame"],
  ["typographic", "Typographic"],
  ["editorial_column", "Editorial column"],
  ["badge", "Product badge"],
] as const;

export function CreativeStudio(props: {
  brandId: string;
  role: Role;
  platforms: string[];
  initialOpen?: string;
  imageProvider: { ready: boolean; provider: string };
  preferredStyles: string[];
  campaigns: { id: string; name: string }[];
  creatives: C[];
}) {
  const canEdit = roleAtLeast(props.role, "editor");
  const [brief, setBrief] = useState("");
  const [fmt, setFmt] = useState<string>("instagram_post");
  const [style, setStyle] = useState<string>(props.preferredStyles[0] ?? "premium_editorial");
  const [count, setCount] = useState(3);
  const [objective, setObjective] = useState("awareness");
  const [campaignId, setCampaignId] = useState("");
  const [filter, setFilter] = useState<"all" | "draft" | "approved">("all");
  const [open, setOpen] = useState<string | undefined>(props.initialOpen);
  const [fresh, setFresh] = useState<string[]>([]);
  const { run, busy } = useRun();

  const list = useMemo(() => props.creatives.filter((c) => filter === "all" || c.status === filter), [props.creatives, filter]);
  const current = props.creatives.find((c) => c.id === open);

  return (
    <div>
      <PageHeader eyebrow="Creative Studio" title="On-brand creatives" description="The Creative Director develops concepts in your visual identity; imagery is generated, then composited with your logo, palette and typography." />

      {!props.imageProvider.ready ? (
        <Notice tone="info" className="mb-6">
          No image generation provider is configured, so creatives render as typographic layouts with brand-colour backgrounds. Set <code className="font-mono">OPENAI_API_KEY</code> (IMAGE_PROVIDER=openai) to generate imagery.
        </Notice>
      ) : null}

      {canEdit ? (
        <Card className="mb-8 overflow-hidden">
          <div className="grid lg:grid-cols-[1fr_360px]">
            <div className="space-y-4 p-5">
              <Field label="Creative brief">
                <Textarea rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Launch of our winter glaze collection: deep forest greens, cosy hosting moments, gift-ready. Limited batch of 200." />
              </Field>
              <div>
                <p className="mb-2 text-[12px] font-medium text-ink-2">Style</p>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  {STYLES.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setStyle(s.id)}
                      className={cn("rounded-xl border p-2.5 text-left transition", style === s.id ? "border-ink bg-ink text-white" : "border-line hover:border-line-strong")}
                    >
                      <p className="text-[12px] font-medium">
                        {s.label}
                        {props.preferredStyles.includes(s.id) ? <span className={cn("ml-1 text-[10px]", style === s.id ? "text-white/70" : "text-accent")}>· brand fit</span> : null}
                      </p>
                      <p className={cn("mt-0.5 line-clamp-2 text-[11px]", style === s.id ? "text-white/70" : "text-faint")}>{s.hint}</p>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="space-y-3 border-t border-line bg-sunken/40 p-5 lg:border-l lg:border-t-0">
              <Field label="Format">
                <Select value={fmt} onChange={(e) => setFmt(e.target.value)}>
                  {FORMATS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label} · {f.w}×{f.h}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Objective">
                  <Select value={objective} onChange={(e) => setObjective(e.target.value)}>
                    {OBJECTIVES.map((o) => (
                      <option key={o} value={o}>
                        {objectiveLabel(o)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Variations">
                  <Select value={count} onChange={(e) => setCount(Number(e.target.value))}>
                    {[1, 2, 3, 4, 5, 6].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Campaign">
                <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                  <option value="">None</option>
                  {props.campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                variant="accent"
                size="lg"
                className="w-full"
                disabled={!brief.trim()}
                loading={busy("gen")}
                onClick={() =>
                  run(() => generateCreativesAction(props.brandId, { brief, format: fmt, style, count, objective, campaignId }), {
                    key: "gen",
                    success: (d) => `${d.ids.length} creatives generated`,
                    onOk: (d) => setFresh(d.ids),
                  })
                }
              >
                <Sparkles /> Generate {count} creative{count > 1 ? "s" : ""}
              </Button>
              {busy("gen") ? <p className="text-center text-[11px] text-muted">Concepts first, then imagery. This can take a minute.</p> : null}
            </div>
          </div>
        </Card>
      ) : null}

      <div className="mb-4 flex items-center justify-between">
        <Segmented value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "draft", label: "Drafts" }, { value: "approved", label: "Approved" }]} />
        <p className="text-[12px] text-muted">{list.length} creatives</p>
      </div>

      {list.length ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
          {list.map((c) => {
            const f = formatById(c.format);
            return (
              <button key={c.id} onClick={() => setOpen(c.id)} className={cn("group overflow-hidden rounded-2xl border bg-surface text-left shadow-card transition hover:-translate-y-0.5 hover:shadow-pop", fresh.includes(c.id) ? "border-accent ring-2 ring-accent/20" : "border-line")}>
                <div className="relative bg-sunken" style={{ aspectRatio: `${f.w}/${f.h}` }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/creatives/${c.id}/image?v=${c.hasImage ? 1 : 0}`} alt={c.concept.headline} loading="lazy" className="absolute inset-0 size-full object-cover" />
                  <div className="absolute left-2 top-2 flex gap-1">
                    {c.status === "approved" ? <Badge tone="success" className="shadow-sm"><Check /> Approved</Badge> : null}
                    {c.parentId ? <Badge className="bg-white/90 shadow-sm"><Layers /> Variation</Badge> : null}
                    {c.imageError ? <Badge tone="danger" className="shadow-sm"><ImageOff /> Image failed</Badge> : null}
                  </div>
                </div>
                <div className="p-3">
                  <p className="truncate text-[13px] font-medium">{c.concept.title}</p>
                  <p className="truncate text-[11px] text-muted">
                    {styleById(c.style).label} · {f.label}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <Empty icon={<Palette />} title="No creatives yet">
          Write a brief, pick a style and generate on-brand variations.
        </Empty>
      )}

      {current ? <CreativeDetail key={current.id} brandId={props.brandId} creative={current} canEdit={canEdit} platforms={props.platforms} onClose={() => setOpen(undefined)} onOpen={setOpen} /> : null}
    </div>
  );
}

function CreativeDetail({ brandId, creative, canEdit, platforms, onClose, onOpen }: { brandId: string; creative: C; canEdit: boolean; platforms: string[]; onClose: () => void; onOpen: (id: string) => void }) {
  const [c, setC] = useState(creative.concept);
  const [styleId, setStyleId] = useState(creative.style);
  const [preview, setPreview] = useState(creative.format);
  const [direction, setDirection] = useState("");
  const [v, setV] = useState(0);
  const { run, busy } = useRun();
  useEffect(() => {
    setC(creative.concept);
  }, [creative.concept]);
  const f = formatById(preview);
  const dirty = JSON.stringify(c) !== JSON.stringify(creative.concept) || styleId !== creative.style;
  const src = `/api/creatives/${creative.id}/image?format=${preview}&v=${v}`;

  const save = () =>
    run(() => updateCreativeAction(brandId, creative.id, { headline: c.headline, subline: c.subline, cta: c.cta, layout: c.layout, palette: c.palette, style: styleId }), {
      key: "save",
      success: "Creative updated",
      onOk: () => setV((x) => x + 1),
    });

  return (
    <Modal open onClose={onClose} wide title={c.title}>
      <div className="grid gap-0 lg:grid-cols-[1.2fr_1fr]">
        <div className="flex flex-col items-center justify-center gap-4 bg-sunken/60 p-6">
          <div className="w-full max-w-[520px] overflow-hidden rounded-xl shadow-pop" style={{ aspectRatio: `${f.w}/${f.h}`, maxHeight: "62vh" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={c.headline} className="size-full object-contain" />
          </div>
          <div className="flex w-full max-w-[520px] flex-wrap items-center gap-2">
            <Select value={preview} onChange={(e) => setPreview(e.target.value)} className="w-auto flex-1">
              {FORMATS.map((x) => (
                <option key={x.id} value={x.id}>
                  Resize: {x.label} · {x.w}×{x.h}
                </option>
              ))}
            </Select>
            <a href={`/api/creatives/${creative.id}/image?format=${preview}&download=1`} className="inline-flex h-9 items-center gap-2 rounded-lg bg-ink px-4 text-[13px] font-medium text-white hover:bg-ink-2">
              <Download className="size-4" /> Download PNG
            </a>
          </div>
          {creative.imageError ? <Notice tone="danger" className="w-full max-w-[520px]">Image generation failed: {creative.imageError}</Notice> : null}
          {!creative.hasImage && !creative.imageError ? <p className="text-[12px] text-muted">Typographic layout (no AI imagery {creative.imageProvider === "none" ? "provider configured" : "yet"}).</p> : null}
        </div>

        <div className="space-y-4 p-5">
          <div className="flex flex-wrap gap-1.5">
            <Badge>{formatById(creative.format).label}</Badge>
            <Badge tone="accent">{styleById(creative.style).label}</Badge>
            {c.objective ? <Badge tone="outline">{objectiveLabel(c.objective)}</Badge> : null}
            <Badge tone={creative.status === "approved" ? "success" : creative.status === "rejected" ? "danger" : "neutral"} className="capitalize">{creative.status}</Badge>
          </div>

          <fieldset disabled={!canEdit} className="space-y-3">
            <Field label="Headline"><Input value={c.headline} onChange={(e) => setC({ ...c, headline: e.target.value })} /></Field>
            <Field label="Supporting line"><Textarea rows={2} value={c.subline} onChange={(e) => setC({ ...c, subline: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Call to action"><Input value={c.cta} onChange={(e) => setC({ ...c, cta: e.target.value })} /></Field>
              <Field label="Layout">
                <Select value={c.layout} onChange={(e) => setC({ ...c, layout: e.target.value as CreativeConcept["layout"] })}>
                  {LAYOUTS.map(([id, l]) => <option key={id} value={id}>{l}</option>)}
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-[1fr_auto] items-end gap-3">
              <Field label="Style">
                <Select value={styleId} onChange={(e) => setStyleId(e.target.value)}>
                  {STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </Select>
              </Field>
              <div className="flex gap-1.5 pb-0.5">
                {(["background", "foreground", "accent"] as const).map((k) => (
                  <label key={k} className="flex flex-col items-center gap-1 text-[10px] text-faint" title={k}>
                    <input type="color" value={/^#[0-9a-f]{6}$/i.test(c.palette[k]) ? c.palette[k] : "#000000"} onChange={(e) => setC({ ...c, palette: { ...c.palette, [k]: e.target.value } })} className="size-8 cursor-pointer rounded-lg border border-line bg-transparent p-0.5" />
                    {k.slice(0, 4)}
                  </label>
                ))}
              </div>
            </div>
          </fieldset>

          {canEdit ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Button disabled={!dirty} loading={busy("save")} onClick={save}>Save edits</Button>
                <Button variant="secondary" loading={busy("img")} onClick={() => run(() => regenerateImageAction(brandId, creative.id), { key: "img", success: "New image generated", onOk: () => setV((x) => x + 1) })}>
                  <RefreshCw /> Regenerate image
                </Button>
                {creative.status !== "approved" ? (
                  <Button variant="secondary" loading={busy("ok")} onClick={() => run(() => setCreativeStatusAction(brandId, creative.id, "approved"), { key: "ok", success: "Approved. Brand memory updated." })}>
                    <Check /> Approve
                  </Button>
                ) : null}
                {creative.status !== "rejected" ? (
                  <Button variant="ghost" loading={busy("no")} onClick={() => run(() => setCreativeStatusAction(brandId, creative.id, "rejected"), { key: "no", success: "Marked as not on-brand" })}>
                    <X /> Not on-brand
                  </Button>
                ) : null}
              </div>

              <div className="rounded-xl border border-line p-3">
                <p className="mb-2 text-[12px] font-medium">Create a variation</p>
                <div className="flex gap-2">
                  <Input value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="e.g. warmer light, product closer, bolder headline" />
                  <Button variant="ai" loading={busy("var")} onClick={() => run(() => variationAction(brandId, creative.id, direction), { key: "var", success: "Variation created", onOk: (d) => d.ids[0] && onOpen(d.ids[0]) })}>
                    <Wand2 /> Vary
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 border-t border-line pt-4">
                <Select id="post-platform" defaultValue={platforms[0] ?? "instagram"} className="w-40">
                  {(platforms.length ? platforms : ["instagram"]).map((p) => <option key={p} value={p}>{p}</option>)}
                </Select>
                <Button
                  variant="secondary"
                  loading={busy("post")}
                  onClick={() => {
                    const platform = (document.getElementById("post-platform") as HTMLSelectElement).value;
                    run(() => createDraftPost(brandId, { platform, format: creative.format, title: c.title, creativeId: creative.id, objective: c.objective ?? undefined, brief: c.brief }), { key: "post", success: "Draft post added to the calendar. Generate its caption there." });
                  }}
                >
                  <Copy /> Add to calendar
                </Button>
                <Button variant="ghost" className="ml-auto text-danger" loading={busy("del")} onClick={() => run(() => deleteCreativeAction(brandId, creative.id), { key: "del", success: "Creative deleted", onOk: onClose })}>
                  <Trash2 />
                </Button>
              </div>
            </>
          ) : null}

          <details className="rounded-xl bg-sunken/60 px-3.5 py-2.5 text-[12px] text-ink-2">
            <summary className="cursor-pointer font-medium text-muted">Art direction</summary>
            <p className="mt-2">{c.imagePrompt}</p>
            <p className="mt-1 text-faint">Treatment: {c.imageTreatment}</p>
            <p className="mt-1 text-faint">Created {format(creative.createdAt, "d MMM yyyy HH:mm")}{creative.imageProvider ? ` · ${creative.imageProvider}` : ""}</p>
          </details>
          <Rationale>{c.rationale}</Rationale>
        </div>
      </div>
    </Modal>
  );
}

