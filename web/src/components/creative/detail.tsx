"use client";
import { useState } from "react";
import { format } from "date-fns";
import { AlertTriangle, CalendarPlus, Loader2, Check, ChevronLeft, ChevronRight, ClipboardCopy, Download, FileArchive, Info, PenLine, RefreshCw, ShieldAlert, ShieldCheck, Sparkles, Trash2, Wand2, X, XCircle } from "lucide-react";
import { createDraftPost, deleteCreativeAction, regenerateImageAction, setCreativeStatusAction, updateCreativeAction, variationAction } from "@/app/actions/ai";
import { brandCheckAction, editCopyAction, setVisualSourceAction, writeCopyAction } from "@/app/actions/creative";
import { Badge, Button, Field, Input, Modal, Notice, Segmented, Select, Textarea } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { Rationale } from "@/components/bits";
import { useRun } from "@/components/hooks";
import { FORMATS, STYLES, formatById, objectiveLabel, platformLabel, styleById } from "@/lib/domain";
import { roleAtLeast, type Role } from "@/lib/roles";
import { cn } from "@/lib/utils";
import type { CreativeConcept } from "@/server/agents/schemas";
import type { CopyPack } from "@/server/creative/copy";
import type { CheckStatus } from "@/server/creative/brand-check";
import { LOGO_PLACEMENTS, visualLabel, type ImageProviderInfo, type LogoPlacementId, type StudioCreative, type StudioPhoto, type VisualSourceId } from "./shared";

const LAYOUTS = [
  ["hero_overlay", "Hero overlay"],
  ["split", "Split"],
  ["frame", "Frame"],
  ["typographic", "Typographic"],
  ["editorial_column", "Editorial column"],
  ["badge", "Product badge"],
] as const;
const HEX = /^#[0-9a-f]{6}$/i;
type Tab = "design" | "copy" | "check" | "versions";
type SlideDraft = { headline: string; body: string; imagePrompt?: string };

export function CreativeDetail(p: {
  brandId: string;
  role: Role;
  creative: StudioCreative;
  family: StudioCreative[];
  platforms: string[];
  brandColors: string[];
  photos: StudioPhoto[];
  imageProvider: ImageProviderInfo;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const { creative } = p;
  const canEdit = roleAtLeast(p.role, "editor");
  const isAdmin = roleAtLeast(p.role, "admin");
  const carousel = creative.kind === "carousel";
  const slides = carousel ? 1 + creative.slides.length : 1;
  const [tab, setTab] = useState<Tab>("design");
  const [slide, setSlide] = useState(0);
  const [preview, setPreview] = useState(creative.format);
  const [loaded, setLoaded] = useState<string | null>(null);
  const { run, busy } = useRun();
  const v = new Date(creative.updatedAt).getTime();
  const f = formatById(preview);
  const src = `/api/creatives/${creative.id}/image?format=${preview}${slide ? `&slide=${slide}` : ""}&v=${v}`;
  const check = creative.brandCheck;
  const blocking = Boolean(check?.blocking);

  const approve = (force: boolean) => run(() => setCreativeStatusAction(p.brandId, creative.id, "approved", force), { key: force ? "force" : "ok", success: "Approved. Brand memory updated." });

  return (
    <Modal open onClose={p.onClose} wide title={creative.concept.title}>
      <div className="grid gap-0 lg:grid-cols-[1.1fr_1fr]">
        {/* Preview */}
        <div className="flex flex-col items-center gap-3 bg-sunken/60 p-4 sm:p-6">
          <div className="relative w-full max-w-[480px] overflow-hidden rounded-xl bg-surface shadow-pop" style={{ aspectRatio: `${f.w}/${f.h}`, maxHeight: "58vh" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img key={src} src={src} alt={creative.concept.headline} className="size-full object-contain" data-testid="creative-preview" onLoad={() => setLoaded(src)} onError={() => setLoaded(`error:${src}`)} />
            {loaded !== src ? (
              <div className="absolute inset-0 grid place-items-center bg-surface/70 text-[12px] text-muted" aria-live="polite">
                {loaded === `error:${src}` ? (
                  <span className="px-6 text-center">{"The preview couldn't be rendered. Try again in a moment."}</span>
                ) : (
                  <span className="flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin" /> Rendering…
                  </span>
                )}
              </div>
            ) : null}
          </div>
          {carousel ? (
            <div className="flex items-center gap-2" aria-label="Slides">
              <Button size="icon" variant="secondary" aria-label="Previous slide" disabled={slide === 0} onClick={() => setSlide(slide - 1)}>
                <ChevronLeft />
              </Button>
              <div className="flex gap-1">
                {Array.from({ length: slides }, (_, i) => (
                  <button key={i} onClick={() => setSlide(i)} aria-label={`Slide ${i + 1}`} aria-current={i === slide} className={cn("size-2 rounded-full", i === slide ? "bg-ink" : "bg-line-strong")} />
                ))}
              </div>
              <span className="w-12 text-center text-[12px] text-muted">
                {slide + 1} / {slides}
              </span>
              <Button size="icon" variant="secondary" aria-label="Next slide" disabled={slide >= slides - 1} onClick={() => setSlide(slide + 1)}>
                <ChevronRight />
              </Button>
            </div>
          ) : null}
          <div className="flex w-full max-w-[480px] flex-wrap items-center gap-2">
            <Select value={preview} onChange={(e) => setPreview(e.target.value)} className="w-auto min-w-0 flex-1" aria-label="Resize">
              {FORMATS.map((x) => (
                <option key={x.id} value={x.id}>
                  Resize: {x.label} · {x.w}×{x.h}
                </option>
              ))}
            </Select>
            <a href={`/api/creatives/${creative.id}/image?format=${preview}${slide ? `&slide=${slide}` : ""}&download=1`} className="inline-flex h-9 items-center gap-2 rounded-lg bg-ink px-3 text-[13px] font-medium text-white hover:bg-ink-2">
              <Download className="size-4" /> PNG
            </a>
            {carousel || creative.copy ? (
              <a href={`/api/creatives/${creative.id}/zip?format=${preview}`} className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium hover:border-line-strong" title={carousel ? "All slides plus caption.txt" : "PNG plus caption.txt"}>
                <FileArchive className="size-4" /> ZIP
              </a>
            ) : null}
          </div>
          {creative.imageError ? (
            <Notice tone="danger" className="w-full max-w-[480px]">
              The visual failed: {creative.imageError}
            </Notice>
          ) : null}
          <p className="text-[12px] text-muted">
            {creative.visualSource === "ai" && creative.imageProvider === "mock" && creative.hasImage ? "Demo image · no AI provider was called" : visualLabel(creative.visualSource)}
            {creative.visualSource === "ai" && !creative.hasImage && !creative.imageError ? " · not generated yet" : ""}
            {creative.imageProvider && creative.imageProvider !== "mock" && creative.visualSource === "ai" && creative.hasImage ? ` · ${creative.imageProvider}` : ""}
          </p>
        </div>

        {/* Panel */}
        <div className="min-w-0 space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap gap-1.5">
            <Badge>{formatById(creative.format).label}</Badge>
            <Badge tone="accent">{styleById(creative.style).label}</Badge>
            {creative.concept.objective ? <Badge tone="outline">{objectiveLabel(creative.concept.objective)}</Badge> : null}
            <Badge tone={creative.status === "approved" ? "success" : creative.status === "rejected" ? "danger" : "neutral"} className="capitalize">
              {creative.status}
            </Badge>
            {creative.strategyId ? <Badge tone="info">From strategy calendar</Badge> : null}
          </div>

          <div className="overflow-x-auto">
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: "design", label: "Design" },
                { value: "copy", label: creative.copy ? "Copy" : "Copy ·" },
                { value: "check", label: check ? `Brand check ${check.score}` : "Brand check" },
                { value: "versions", label: `Versions${p.family.length ? ` ${p.family.length + 1}` : ""}` },
              ]}
            />
          </div>

          {tab === "design" ? <DesignTab {...p} canEdit={canEdit} onSlide={setSlide} /> : null}
          {tab === "copy" ? <CopyTab brandId={p.brandId} creative={creative} canEdit={canEdit} /> : null}
          {tab === "check" ? <CheckTab brandId={p.brandId} creative={creative} canEdit={canEdit} /> : null}
          {tab === "versions" ? <VersionsTab brandId={p.brandId} creative={creative} family={p.family} canEdit={canEdit} onOpen={p.onOpen} /> : null}

          {canEdit ? (
            <div className="space-y-3 border-t border-line pt-4">
              {blocking && creative.status !== "approved" ? (
                <Notice tone="warn">
                  The brand check found blocking issues. Fix them and re-run the check{isAdmin ? ", or approve anyway" : "; an admin can approve anyway"}.
                </Notice>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {creative.status !== "approved" ? (
                  blocking ? (
                    isAdmin ? (
                      <Button variant="danger" loading={busy("force")} onClick={() => approve(true)}>
                        <ShieldAlert /> Approve anyway
                      </Button>
                    ) : null
                  ) : (
                    <Button variant="accent" loading={busy("ok")} onClick={() => approve(false)}>
                      <Check /> Approve
                    </Button>
                  )
                ) : (
                  <Button variant="ghost" loading={busy("draft")} onClick={() => run(() => setCreativeStatusAction(p.brandId, creative.id, "draft"), { key: "draft", success: "Moved back to draft" })}>
                    Back to draft
                  </Button>
                )}
                {creative.status !== "rejected" ? (
                  <Button variant="ghost" loading={busy("no")} onClick={() => run(() => setCreativeStatusAction(p.brandId, creative.id, "rejected"), { key: "no", success: "Marked as not on-brand" })}>
                    <X /> Not on-brand
                  </Button>
                ) : null}
                <AddToCalendar brandId={p.brandId} creative={creative} platforms={p.platforms} />
                <Button variant="ghost" className="ml-auto text-danger" aria-label="Delete creative" loading={busy("del")} onClick={() => confirm("Delete this creative?") && run(() => deleteCreativeAction(p.brandId, creative.id), { key: "del", success: "Creative deleted", onOk: p.onClose })}>
                  <Trash2 />
                </Button>
              </div>
            </div>
          ) : null}

          <p className="text-[11px] text-faint">
            Created {format(new Date(creative.createdAt), "d MMM yyyy HH:mm")} · updated {format(new Date(creative.updatedAt), "d MMM HH:mm")}
          </p>
        </div>
      </div>
    </Modal>
  );
}

function AddToCalendar({ brandId, creative, platforms }: { brandId: string; creative: StudioCreative; platforms: string[] }) {
  const list = platforms.length ? platforms : ["instagram"];
  const [platform, setPlatform] = useState(list[0]);
  const { run, busy } = useRun();
  const copy = creative.copy;
  const variant = copy?.platformVariants.find((x) => x.platform === platform)?.copy;
  return (
    <div className="flex gap-1.5">
      <Select value={platform} onChange={(e) => setPlatform(e.target.value)} className="w-32" aria-label="Platform">
        {list.map((x) => (
          <option key={x} value={x}>
            {platformLabel(x)}
          </option>
        ))}
      </Select>
      <Button
        variant="secondary"
        loading={busy("post")}
        onClick={() =>
          run(
            () =>
              createDraftPost(brandId, {
                platform,
                format: creative.format,
                title: creative.concept.title,
                creativeId: creative.id,
                objective: creative.concept.objective ?? undefined,
                brief: creative.concept.brief,
                caption: variant ?? copy?.primary,
                hashtags: copy?.hashtags,
              }),
            { key: "post", success: copy ? "Draft post added to the calendar with this copy" : "Draft post added to the calendar" },
          )
        }
      >
        <CalendarPlus /> Add to calendar
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- Design

function DesignTab(p: { brandId: string; creative: StudioCreative; canEdit: boolean; brandColors: string[]; photos: StudioPhoto[]; imageProvider: ImageProviderInfo; onSlide: (n: number) => void }) {
  const { creative } = p;
  const [c, setC] = useState<CreativeConcept & { brief?: string; objective?: string | null }>(creative.concept);
  const [styleId, setStyleId] = useState(creative.style);
  const [logo, setLogo] = useState<LogoPlacementId>(creative.logoPlacement as LogoPlacementId);
  const [slides, setSlides] = useState<SlideDraft[]>(creative.slides.map(({ headline, body, imagePrompt }) => ({ headline, body, imagePrompt })));
  const [source, setSource] = useState<VisualSourceId>(creative.visualSource as VisualSourceId);
  const [asset, setAsset] = useState<string | null>(creative.sourceAssetId);
  const { run, busy } = useRun();
  const origSlides = JSON.stringify(creative.slides.map(({ headline, body, imagePrompt }) => ({ headline, body, imagePrompt })));
  const dirty = JSON.stringify(c) !== JSON.stringify(creative.concept) || styleId !== creative.style || logo !== creative.logoPlacement || JSON.stringify(slides) !== origSlides;
  const paletteOk = HEX.test(c.palette.background) && HEX.test(c.palette.foreground) && HEX.test(c.palette.accent);
  const sourceDirty = source !== creative.visualSource || (source === "brand_photo" && asset !== creative.sourceAssetId);

  const save = () =>
    run(
      () =>
        updateCreativeAction(p.brandId, creative.id, {
          title: c.title,
          headline: c.headline,
          subline: c.subline,
          cta: c.cta,
          layout: c.layout,
          palette: c.palette,
          imagePrompt: c.imagePrompt,
          style: styleId,
          logoPlacement: logo,
          ...(creative.kind === "carousel" ? { slides } : {}),
        }),
      { key: "save", success: "Creative updated" },
    );

  return (
    <div className="space-y-4">
      <fieldset disabled={!p.canEdit} className="space-y-3">
        <Field label="Headline">
          <Input value={c.headline} maxLength={140} onChange={(e) => setC({ ...c, headline: e.target.value })} />
        </Field>
        <Field label="Supporting line">
          <Textarea rows={2} value={c.subline} maxLength={300} onChange={(e) => setC({ ...c, subline: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Call to action">
            <Input value={c.cta} maxLength={60} onChange={(e) => setC({ ...c, cta: e.target.value })} />
          </Field>
          <Field label="Layout">
            <Select value={c.layout} onChange={(e) => setC({ ...c, layout: e.target.value as CreativeConcept["layout"] })}>
              {LAYOUTS.map(([id, l]) => (
                <option key={id} value={id}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Style">
            <Select value={styleId} onChange={(e) => setStyleId(e.target.value)}>
              {STYLES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Logo">
            <Select value={logo} onChange={(e) => setLogo(e.target.value as LogoPlacementId)}>
              {LOGO_PLACEMENTS.map(([id, l]) => (
                <option key={id} value={id}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div>
          <p className="mb-1.5 text-[12px] font-medium text-ink-2">Palette</p>
          <div className="space-y-1.5">
            {(["background", "foreground", "accent"] as const).map((k) => (
              <div key={k} className="flex flex-wrap items-center gap-2">
                <span className="w-20 text-[11px] capitalize text-muted">{k === "foreground" ? "Text" : k}</span>
                <input type="color" aria-label={`${k} colour`} value={HEX.test(c.palette[k]) ? c.palette[k] : "#000000"} onChange={(e) => setC({ ...c, palette: { ...c.palette, [k]: e.target.value } })} className="size-7 cursor-pointer rounded-md border border-line bg-transparent p-0.5" />
                <span className="font-mono text-[11px] text-faint">{c.palette[k]}</span>
                <span className="flex gap-1" aria-label="Brand colours">
                  {p.brandColors.filter((x) => HEX.test(x)).map((hex) => (
                    <button key={hex} type="button" title={`Use brand colour ${hex}`} aria-label={`Use ${hex} for ${k}`} onClick={() => setC({ ...c, palette: { ...c.palette, [k]: hex } })} className={cn("size-5 rounded-full border border-line", c.palette[k].toLowerCase() === hex.toLowerCase() && "ring-2 ring-accent ring-offset-1")} style={{ background: hex }} />
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>

        {creative.kind === "carousel" ? (
          <div className="space-y-2">
            <p className="text-[12px] font-medium text-ink-2">Slides (after the cover)</p>
            {slides.map((s, i) => (
              <div key={i} className="rounded-xl border border-line p-2.5" onFocus={() => p.onSlide(i + 1)}>
                <div className="mb-1.5 flex items-center justify-between text-[11px] text-faint">
                  <span>
                    Slide {i + 2}
                    {creative.slides[i]?.hasImage ? " · has a visual" : ""}
                  </span>
                  {p.canEdit && slides.length > 2 ? (
                    <button type="button" className="text-danger" onClick={() => setSlides(slides.filter((_, j) => j !== i))} aria-label={`Remove slide ${i + 2}`}>
                      Remove
                    </button>
                  ) : null}
                </div>
                <Input value={s.headline} maxLength={120} aria-label={`Slide ${i + 2} headline`} onChange={(e) => setSlides(slides.map((x, j) => (j === i ? { ...x, headline: e.target.value } : x)))} />
                <Textarea rows={2} className="mt-1.5" value={s.body} maxLength={400} aria-label={`Slide ${i + 2} body`} onChange={(e) => setSlides(slides.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))} />
              </div>
            ))}
            {p.canEdit && slides.length < 7 ? (
              <Button size="sm" variant="ghost" onClick={() => setSlides([...slides, { headline: "New slide", body: "" }])}>
                + Add slide
              </Button>
            ) : null}
          </div>
        ) : null}

        <Field label="Art direction (image prompt)">
          <Textarea rows={3} value={c.imagePrompt} maxLength={1500} onChange={(e) => setC({ ...c, imagePrompt: e.target.value })} />
        </Field>
      </fieldset>

      {p.canEdit ? (
        <Button disabled={!dirty || !paletteOk || !c.headline.trim()} loading={busy("save")} onClick={save}>
          Save edits
        </Button>
      ) : null}

      {p.canEdit ? (
        <div className="space-y-2 rounded-xl border border-line p-3">
          <p className="text-[12px] font-medium">Visual</p>
          <div className="flex flex-wrap gap-2">
            <Select value={source} onChange={(e) => setSource(e.target.value as VisualSourceId)} className="w-auto min-w-40" aria-label="Visual source">
              <option value="ai" disabled={!p.imageProvider.ready}>
                {p.imageProvider.demo ? "AI image (demo placeholder)" : `AI image${p.imageProvider.ready ? "" : " (not configured)"}`}
              </option>
              <option value="brand_photo" disabled={!p.photos.length}>
                Brand photo{p.photos.length ? "" : " (none approved)"}
              </option>
              <option value="typographic">Type-led</option>
            </Select>
            {sourceDirty ? (
              <Button variant="secondary" loading={busy("src")} onClick={() => run(() => setVisualSourceAction(p.brandId, creative.id, { visualSource: source, sourceAssetId: source === "brand_photo" ? asset : null }), { key: "src", success: "Visual updated" })}>
                Apply
              </Button>
            ) : source !== "typographic" ? (
              <Button variant="secondary" loading={busy("img")} onClick={() => run(() => regenerateImageAction(p.brandId, creative.id), { key: "img", success: source === "ai" ? "New image generated" : "Visual refreshed" })}>
                <RefreshCw /> {source === "ai" ? "Regenerate image" : "Next photo"}
              </Button>
            ) : null}
          </div>
          {source === "brand_photo" ? (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {p.photos.map((ph) => (
                <button key={ph.id} type="button" aria-pressed={asset === ph.id} aria-label={`Use photo ${ph.name}`} onClick={() => setAsset(ph.id)} className={cn("size-14 shrink-0 overflow-hidden rounded-lg border-2", asset === ph.id ? "border-accent" : "border-transparent")} title={ph.name}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/assets/${ph.id}`} alt={ph.name} className="size-full object-cover" loading="lazy" />
                </button>
              ))}
            </div>
          ) : null}
          {source === "ai" && !p.imageProvider.priced && !p.imageProvider.demo ? <p className="text-[11px] text-faint">Image generations are counted in usage; no price is configured (IMAGE_PRICE_USD), so they show as unpriced.</p> : null}
        </div>
      ) : null}

      <Rationale>{c.rationale}</Rationale>
    </div>
  );
}

// ---------------------------------------------------------------- Copy

function CopyTab({ brandId, creative, canEdit }: { brandId: string; creative: StudioCreative; canEdit: boolean }) {
  const pack = creative.copy;
  const { run, busy } = useRun();
  if (!pack) {
    return (
      <div className="space-y-3 rounded-xl border border-dashed border-line p-4 text-center">
        <p className="text-[13px] text-muted">No platform copy yet. The copywriter writes a caption, alternatives, hooks, CTA, hashtags and platform variants, in your brand voice, and checks it against your recent posts for repetition.</p>
        {canEdit ? (
          <Button variant="ai" loading={busy("write")} onClick={() => run(() => writeCopyAction(brandId, creative.id), { key: "write", success: "Copy written" })}>
            <Sparkles /> Write copy
          </Button>
        ) : null}
      </div>
    );
  }
  return <CopyEditor key={pack.generatedAt + (pack.editedAt ?? "")} brandId={brandId} creative={creative} pack={pack} canEdit={canEdit} />;
}

function CopyEditor({ brandId, creative, pack, canEdit }: { brandId: string; creative: StudioCreative; pack: CopyPack; canEdit: boolean }) {
  const [d, setD] = useState({ primary: pack.primary, alternatives: pack.alternatives, short: pack.short, long: pack.long, hooks: pack.hooks, cta: pack.cta, hashtags: pack.hashtags.join(" "), keywords: pack.keywords.join(", ") });
  const { run, busy } = useRun();
  const o = pack.originality;
  const payload = () => ({ ...d, hashtags: d.hashtags.split(/[\s,]+/).filter(Boolean), keywords: d.keywords.split(",").map((x) => x.trim()).filter(Boolean) });
  const dirty = JSON.stringify(payload()) !== JSON.stringify({ primary: pack.primary, alternatives: pack.alternatives, short: pack.short, long: pack.long, hooks: pack.hooks, cta: pack.cta, hashtags: pack.hashtags, keywords: pack.keywords });
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(`${d.primary}\n\n${payload().hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")}`);
      toast("Caption copied");
    } catch {
      toast("Couldn't copy to the clipboard", "error");
    }
  };

  return (
    <div className="space-y-3">
      {o.cliches.length || o.similar.length ? (
        <Notice tone="warn">
          <span className="font-medium">Originality:</span> {o.cliches.length ? `stock phrases (${o.cliches.join(", ")}). ` : ""}
          {o.similar.length ? `Close to a recent caption (${Math.round(o.similar[0].score * 100)}% overlap): “${o.similar[0].text}…”` : ""}
        </Notice>
      ) : (
        <p className="flex items-center gap-1.5 text-[12px] text-success">
          <ShieldCheck className="size-4" /> No stock phrases; not close to your recent captions{o.retried ? " (rewritten once to get there)" : ""}.
        </p>
      )}
      <fieldset disabled={!canEdit} className="space-y-3">
        <Field label={`Caption · ${platformLabel(pack.platform)}`}>
          <Textarea rows={5} value={d.primary} maxLength={2200} onChange={(e) => setD({ ...d, primary: e.target.value })} />
        </Field>
        {d.alternatives.length ? (
          <div>
            <p className="mb-1.5 text-[12px] font-medium text-ink-2">Alternatives</p>
            <div className="space-y-1.5">
              {d.alternatives.map((a, i) => (
                <div key={i} className="flex items-start gap-2 rounded-lg bg-sunken/60 p-2 text-[12px]">
                  <p className="flex-1 whitespace-pre-wrap">{a}</p>
                  {canEdit ? (
                    <button type="button" className="shrink-0 text-accent-ink underline" onClick={() => setD({ ...d, primary: a, alternatives: d.alternatives.map((x, j) => (j === i ? d.primary : x)) })}>
                      Use
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Short version">
            <Textarea rows={2} value={d.short} maxLength={300} onChange={(e) => setD({ ...d, short: e.target.value })} />
          </Field>
          <Field label="Call to action">
            <Input value={d.cta} maxLength={200} onChange={(e) => setD({ ...d, cta: e.target.value })} />
          </Field>
        </div>
        <Field label="Long version">
          <Textarea rows={4} value={d.long} maxLength={2200} onChange={(e) => setD({ ...d, long: e.target.value })} />
        </Field>
        <Field label="Hooks">
          <Textarea rows={3} value={d.hooks.join("\n")} onChange={(e) => setD({ ...d, hooks: e.target.value.split("\n").slice(0, 8) })} />
        </Field>
        <Field label="Hashtags">
          <Input value={d.hashtags} onChange={(e) => setD({ ...d, hashtags: e.target.value })} />
        </Field>
        <Field label="Keywords">
          <Input value={d.keywords} onChange={(e) => setD({ ...d, keywords: e.target.value })} />
        </Field>
      </fieldset>
      {pack.platformVariants.length ? (
        <details className="rounded-xl border border-line px-3 py-2 text-[12px]">
          <summary className="cursor-pointer font-medium">Platform variants ({pack.platformVariants.length})</summary>
          <div className="mt-2 space-y-2">
            {pack.platformVariants.map((x) => (
              <div key={x.platform}>
                <p className="font-medium text-ink-2">{platformLabel(x.platform)}</p>
                <p className="whitespace-pre-wrap text-muted">{x.copy}</p>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canEdit ? (
          <Button disabled={!dirty || !d.primary.trim()} loading={busy("save")} onClick={() => run(() => editCopyAction(brandId, creative.id, payload()), { key: "save", success: "Copy saved" })}>
            <PenLine /> Save copy
          </Button>
        ) : null}
        <Button variant="secondary" onClick={copyText}>
          <ClipboardCopy /> Copy caption
        </Button>
        {canEdit ? (
          <Button variant="ghost" loading={busy("write")} onClick={() => confirm("Rewrite the copy? Your edits will be replaced.") && run(() => writeCopyAction(brandId, creative.id), { key: "write", success: "Copy rewritten" })}>
            <RefreshCw /> Rewrite
          </Button>
        ) : null}
      </div>
      {pack.rationale ? <Rationale>{pack.rationale}</Rationale> : null}
      <p className="text-[11px] text-faint">
        Written {format(new Date(pack.generatedAt), "d MMM HH:mm")}
        {pack.editedAt ? ` · edited ${format(new Date(pack.editedAt), "d MMM HH:mm")}` : ""}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- Brand check

const ICON: Record<CheckStatus, React.ReactNode> = {
  pass: <Check className="size-4 text-success" />,
  warn: <AlertTriangle className="size-4 text-warn" />,
  fail: <XCircle className="size-4 text-danger" />,
  info: <Info className="size-4 text-info" />,
};

function CheckTab({ brandId, creative, canEdit }: { brandId: string; creative: StudioCreative; canEdit: boolean }) {
  const check = creative.brandCheck;
  const { run, busy } = useRun();
  const rerun = canEdit ? (
    <Button variant={check ? "secondary" : "ai"} loading={busy("check")} onClick={() => run(() => brandCheckAction(brandId, creative.id), { key: "check", success: (r) => `Brand check: ${r.score}/100${r.blocking ? ", blocking issues found" : ""}` })}>
      <ShieldCheck /> {check ? "Re-run check" : "Run brand check"}
    </Button>
  ) : null;
  if (!check) {
    return (
      <div className="space-y-3 rounded-xl border border-dashed border-line p-4 text-center">
        <p className="text-[13px] text-muted">Checks legibility (WCAG contrast), palette, logo safe area, copy length and the visual, then a Claude vision review of the rendered creative against your approved brand profile.</p>
        {rerun}
      </div>
    );
  }
  const review = check.review;
  return (
    <div className="space-y-3" data-testid="brand-check">
      {check.stale ? <Notice tone="warn">The creative changed after this check. Re-run it before approving.</Notice> : null}
      <div className="flex flex-wrap items-center gap-3">
        <span className={cn("inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[20px] font-semibold", check.blocking ? "bg-danger-soft text-danger" : check.score >= 80 ? "bg-success-soft text-success" : "bg-warn-soft text-warn")}>
          {check.blocking ? <ShieldAlert className="size-5" /> : <ShieldCheck className="size-5" />}
          {check.score}
          <span className="text-[12px] font-normal">/100</span>
        </span>
        <div className="text-[12px] text-muted">
          <p>{check.blocking ? "Blocking issues: approval needs an admin override." : "No blocking issues."}</p>
          <p>
            {check.mode !== "full" ? "Automated checks only" : check.reviewer?.provider === "mock" ? "Automated checks + demo review (mock AI)" : `Automated checks + vision review${check.reviewer ? ` (${check.reviewer.model})` : ""}`} · {format(new Date(check.checkedAt), "d MMM HH:mm")}
          </p>
        </div>
        <div className="ml-auto">{rerun}</div>
      </div>
      {check.modeNote ? <p className="text-[12px] text-muted">{check.modeNote}</p> : null}

      <ul className="divide-y divide-line rounded-xl border border-line">
        {check.checks.map((x) => (
          <li key={x.id} className="flex items-start gap-2.5 px-3 py-2 text-[12px]">
            <span className="mt-0.5 shrink-0">{ICON[x.status]}</span>
            <span>
              <span className="font-medium">{x.label}</span>
              <span className="block text-muted">{x.detail}</span>
            </span>
          </li>
        ))}
      </ul>

      {review ? (
        <div className="space-y-2">
          <p className="text-[12px] font-medium text-ink-2">{check.reviewer?.provider === "mock" ? "Demo review (mock AI, not a real review)" : "Vision review"} · {review.score}/100</p>
          <p className="text-[13px]">{review.summary}</p>
          {review.issues.length ? (
            <ul className="space-y-1.5">
              {review.issues.map((i, n) => (
                <li key={n} className={cn("rounded-lg px-3 py-2 text-[12px]", i.severity === "blocking" ? "bg-danger-soft" : i.severity === "warning" ? "bg-warn-soft" : "bg-sunken/60")}>
                  <p className="font-medium capitalize">
                    {i.severity} · {i.area}
                  </p>
                  <p>{i.issue}</p>
                  <p className="text-muted">Fix: {i.fix}</p>
                </li>
              ))}
            </ul>
          ) : null}
          {review.strengths.length ? (
            <ul className="list-inside list-disc text-[12px] text-success">
              {review.strengths.map((s, n) => (
                <li key={n}>{s}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- Versions

function VersionsTab({ brandId, creative, family, canEdit, onOpen }: { brandId: string; creative: StudioCreative; family: StudioCreative[]; canEdit: boolean; onOpen: (id: string) => void }) {
  const [direction, setDirection] = useState("");
  const [compare, setCompare] = useState<string | null>(family[0]?.id ?? null);
  const { run, busy } = useRun();
  const other = family.find((x) => x.id === compare);
  return (
    <div className="space-y-3">
      {canEdit ? (
        <div className="rounded-xl border border-line p-3">
          <p className="mb-2 text-[12px] font-medium">Create a variation</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input value={direction} maxLength={500} onChange={(e) => setDirection(e.target.value)} placeholder="e.g. warmer light, product closer, bolder headline" />
            <Button variant="ai" loading={busy("var")} onClick={() => run(() => variationAction(brandId, creative.id, direction), { key: "var", success: "Variation created", onOk: (d) => d.ids[0] && onOpen(d.ids[0]) })}>
              <Wand2 /> Vary
            </Button>
          </div>
        </div>
      ) : null}
      {family.length ? (
        <>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {family.map((x) => (
              <button key={x.id} onClick={() => setCompare(x.id)} className={cn("w-20 shrink-0 overflow-hidden rounded-lg border-2 text-left", compare === x.id ? "border-accent" : "border-transparent")} aria-label={`Compare with ${x.concept.title}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/creatives/${x.id}/image?format=instagram_square&v=${new Date(x.updatedAt).getTime()}`} alt={x.concept.headline} className="aspect-square w-full object-cover" loading="lazy" />
                <p className="truncate px-1 py-0.5 text-[10px]">{x.id === creative.parentId ? "Original" : "Variation"}</p>
              </button>
            ))}
          </div>
          {other ? (
            <div className="grid grid-cols-2 gap-2 text-[12px]">
              {[creative, other].map((x, i) => (
                <div key={x.id} className="space-y-1 rounded-xl border border-line p-2">
                  <p className="text-[11px] font-medium text-faint">{i === 0 ? "This version" : "Compared"}</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/creatives/${x.id}/image?format=instagram_square&v=${new Date(x.updatedAt).getTime()}`} alt={x.concept.headline} className="aspect-square w-full rounded-lg object-cover" />
                  <p className="font-medium">{x.concept.headline}</p>
                  <p className="text-muted">
                    {styleById(x.style).label} · {x.concept.layout.replace("_", " ")}
                  </p>
                  <p className="text-muted">{x.brandCheck ? `Brand check ${x.brandCheck.score}${x.brandCheck.blocking ? " (blocking)" : ""}` : "Not checked"}</p>
                  {i === 1 ? (
                    <Button size="sm" variant="secondary" onClick={() => onOpen(x.id)}>
                      Open
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-[12px] text-muted">No other versions yet. Variations keep the concept and change the direction you give.</p>
      )}
    </div>
  );
}
