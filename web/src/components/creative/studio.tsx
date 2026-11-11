"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, CheckCircle2, CircleDashed, GalleryHorizontal, Image as ImageIcon, ImageOff, Layers, Loader2, Palette, ShieldAlert, ShieldCheck, Sparkles, Target, Type, XCircle } from "lucide-react";
import { creativeTaskStatusAction, startCreativesAction } from "@/app/actions/creative";
import { Badge, Button, Card, CardBody, Empty, Field, Notice, PageHeader, Segmented, Select, Textarea } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useRun } from "@/components/hooks";
import { FORMATS, OBJECTIVES, STYLES, formatById, objectiveLabel, styleById } from "@/lib/domain";
import { roleAtLeast, type Role } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { CreativeDetail } from "./detail";
import { LOGO_PLACEMENTS, visualLabel, type ImageProviderInfo, type LogoPlacementId, type StudioCreative, type StudioPhoto, type StudioTask, type VisualSourceId } from "./shared";

export type { VisualSourceId, LogoPlacementId, StudioCreative, StudioTask, StudioPhoto, ImageProviderInfo } from "./shared";

const isLive = (t: StudioTask) => t.status === "queued" || t.status === "running";
const money = (n: number) => (n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

export function CreativeStudio(props: {
  brandId: string;
  role: Role;
  platforms: string[];
  brandColors: string[];
  initialOpen?: string;
  initialBrief?: string;
  initialObjective?: string;
  imageProvider: ImageProviderInfo;
  preferredStyles: string[];
  campaigns: { id: string; name: string }[];
  photos: StudioPhoto[];
  tasks: StudioTask[];
  creatives: StudioCreative[];
}) {
  const canEdit = roleAtLeast(props.role, "editor");
  const [filter, setFilter] = useState<"all" | "draft" | "approved" | "attention">("all");
  const [open, setOpen] = useState<string | undefined>(props.initialOpen);
  const [task, setTask] = useState<StudioTask | null>(props.tasks.find(isLive) ?? null);

  const attention = (c: StudioCreative) => Boolean(c.imageError || c.brandCheck?.blocking || c.brandCheck?.stale);
  const list = useMemo(
    () => props.creatives.filter((c) => filter === "all" || (filter === "attention" ? attention(c) : c.status === filter)),
    [props.creatives, filter],
  );
  const current = props.creatives.find((c) => c.id === open);
  const latestFailed = props.tasks[0] && props.tasks[0].status === "failed" && props.tasks[0].id !== task?.id ? props.tasks[0] : null;

  return (
    <div>
      <PageHeader
        eyebrow="Creative Studio"
        title="On-brand creatives"
        description="Brief the Creative Director: concepts, visuals and platform copy are produced in your brand identity, then checked against it before you approve."
      />

      {canEdit ? <GenerateForm {...props} busyTask={task && isLive(task) ? task : null} onTask={(id) => setTask({ id, status: "queued", steps: [], error: null, costUsd: 0 })} /> : null}

      {task ? <TaskProgress brandId={props.brandId} task={task} onUpdate={setTask} onDismiss={() => setTask(null)} /> : null}
      {!task && latestFailed ? (
        <Notice tone="danger" className="mb-6">
          The last creative job stopped: {latestFailed.error ?? "unknown error"}. Creatives that finished were kept.
        </Notice>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "draft", label: "Drafts" },
            { value: "approved", label: "Approved" },
            { value: "attention", label: "Needs attention" },
          ]}
        />
        <p className="text-[12px] text-muted">{list.length} creatives</p>
      </div>

      {list.length ? (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-4" data-testid="creative-grid">
          {list.map((c) => (
            <CreativeCard key={c.id} c={c} onOpen={() => setOpen(c.id)} />
          ))}
        </div>
      ) : (
        <Empty icon={<Palette />} title={filter === "all" ? "No creatives yet" : "Nothing here"}>
          {filter === "all" ? "Write a brief, choose a visual source and generate on-brand variations, or produce creatives from your strategy's calendar." : "No creatives match this filter."}
        </Empty>
      )}

      {current ? (
        <CreativeDetail
          key={current.id}
          brandId={props.brandId}
          role={props.role}
          creative={current}
          family={props.creatives.filter((x) => x.id === current.parentId || x.parentId === current.id || (current.parentId && x.parentId === current.parentId && x.id !== current.id))}
          platforms={props.platforms}
          brandColors={props.brandColors}
          photos={props.photos}
          imageProvider={props.imageProvider}
          onClose={() => setOpen(undefined)}
          onOpen={setOpen}
        />
      ) : null}
    </div>
  );
}

function CreativeCard({ c, onOpen }: { c: StudioCreative; onOpen: () => void }) {
  const f = formatById(c.format);
  const check = c.brandCheck;
  const v = new Date(c.updatedAt).getTime();
  return (
    <button onClick={onOpen} className="group overflow-hidden rounded-2xl border border-line bg-surface text-left shadow-card transition hover:-translate-y-0.5 hover:shadow-pop" aria-label={`Open creative ${c.concept.title}`}>
      <div className="relative bg-sunken" style={{ aspectRatio: `${f.w}/${f.h}` }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/api/creatives/${c.id}/image?v=${v}`} alt={c.concept.headline} loading="lazy" className="absolute inset-0 size-full object-cover" />
        <div className="absolute left-2 top-2 flex flex-wrap gap-1">
          {c.status === "approved" ? (
            <Badge tone="success" className="shadow-sm">
              <Check /> Approved
            </Badge>
          ) : null}
          {c.kind === "carousel" ? (
            <Badge className="bg-white/90 shadow-sm">
              <GalleryHorizontal /> {1 + c.slides.length}
            </Badge>
          ) : null}
          {c.parentId ? (
            <Badge className="bg-white/90 shadow-sm">
              <Layers /> Variation
            </Badge>
          ) : null}
          {c.imageError ? (
            <Badge tone="danger" className="shadow-sm">
              <ImageOff /> Visual failed
            </Badge>
          ) : null}
        </div>
        {check ? (
          <span
            className={cn(
              "absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold shadow-sm",
              check.blocking ? "bg-danger text-white" : check.score >= 80 ? "bg-white/95 text-success" : "bg-white/95 text-warn",
            )}
            title={check.stale ? "Brand check is out of date" : "Brand consistency score"}
          >
            {check.blocking ? <ShieldAlert className="size-3" /> : <ShieldCheck className="size-3" />}
            {check.score}
            {check.stale ? <span className="font-normal opacity-80">· stale</span> : null}
          </span>
        ) : null}
      </div>
      <div className="p-3">
        <p className="truncate text-[13px] font-medium">{c.concept.title}</p>
        <p className="truncate text-[11px] text-muted">
          {styleById(c.style).label} · {f.label} · {visualLabel(c.visualSource)}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {c.copy ? <Badge tone="outline" className="text-[10px]">Copy</Badge> : null}
          {c.strategyId ? (
            <Badge tone="accent" className="text-[10px]">
              <Target /> Strategy
            </Badge>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function GenerateForm(p: {
  brandId: string;
  initialBrief?: string;
  initialObjective?: string;
  imageProvider: ImageProviderInfo;
  preferredStyles: string[];
  campaigns: { id: string; name: string }[];
  photos: StudioPhoto[];
  busyTask: StudioTask | null;
  onTask: (id: string) => void;
}) {
  const [brief, setBrief] = useState(p.initialBrief ?? "");
  const [kind, setKind] = useState<"single" | "carousel">("single");
  const [slideCount, setSlideCount] = useState(5);
  const [fmt, setFmt] = useState<string>("instagram_post");
  const [style, setStyle] = useState<string>(p.preferredStyles[0] ?? "premium_editorial");
  const [count, setCount] = useState(2);
  const [objective, setObjective] = useState<string>(OBJECTIVES.find((o) => o === p.initialObjective) ?? "awareness");
  const [campaignId, setCampaignId] = useState("");
  const [visual, setVisual] = useState<VisualSourceId>(p.imageProvider.ready ? "ai" : p.photos.length ? "brand_photo" : "typographic");
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [logo, setLogo] = useState<LogoPlacementId>("top_left");
  const [slideVisuals, setSlideVisuals] = useState(false);
  const { run, busy } = useRun();
  const total = count;

  useEffect(() => {
    if (kind === "carousel" && fmt !== "instagram_carousel" && !FORMATS.find((f) => f.id === fmt && f.h >= f.w)) setFmt("instagram_carousel");
  }, [kind, fmt]);

  const sources: { id: VisualSourceId; title: string; icon: React.ReactNode; body: string; disabled?: string }[] = [
    {
      id: "ai",
      title: "AI image",
      icon: <Sparkles className="size-4" />,
      body: p.imageProvider.demo
        ? "Demo mode: makes a labelled placeholder. No image API is called."
        : p.imageProvider.ready
          ? `Generated from the art direction (${p.imageProvider.modelLabel ?? p.imageProvider.provider}).${p.imageProvider.priced ? "" : " Image cost is counted but unpriced."}`
          : "",
      disabled: p.imageProvider.ready ? undefined : "No image provider is configured on this server (OPENAI_API_KEY).",
    },
    {
      id: "brand_photo",
      title: "Brand photo",
      icon: <ImageIcon className="size-4" />,
      body: p.photos.length ? `Uses your approved photos (${p.photos.length} available).` : "",
      disabled: p.photos.length ? undefined : "No approved product or reference photos yet. Upload them in My Brand.",
    },
    { id: "typographic", title: "Type-led", icon: <Type className="size-4" />, body: "Brand colours and typography, no photo. Always available." },
  ];

  return (
    <Card className="mb-6 overflow-hidden">
      <div className="grid lg:grid-cols-[1fr_360px]">
        <div className="space-y-4 p-4 sm:p-5">
          <Field label="Creative brief">
            <Textarea rows={3} value={brief} maxLength={2000} onChange={(e) => setBrief(e.target.value)} placeholder="Launch of our winter glaze collection: deep forest greens, cosy hosting moments, gift-ready. Limited batch of 200." />
          </Field>

          <div>
            <p className="mb-2 text-[12px] font-medium text-ink-2">Visual source</p>
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Visual source">
              {sources.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={visual === s.id}
                  disabled={Boolean(s.disabled)}
                  onClick={() => setVisual(s.id)}
                  className={cn(
                    "rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60",
                    visual === s.id ? "border-ink bg-ink text-white" : "border-line hover:border-line-strong",
                  )}
                >
                  <p className="flex items-center gap-1.5 text-[13px] font-medium">
                    {s.icon} {s.title}
                  </p>
                  <p className={cn("mt-1 text-[11px]", visual === s.id ? "text-white/75" : "text-faint")}>{s.disabled ?? s.body}</p>
                </button>
              ))}
            </div>
            {visual === "brand_photo" ? (
              <div className="mt-2 rounded-xl border border-line p-2.5">
                <p className="mb-2 text-[11px] text-muted">{assetIds.length ? `${assetIds.length} selected; they're used in order across creatives and slides.` : "Pick photos, or leave empty to rotate through all approved photos."}</p>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {p.photos.map((ph) => {
                    const on = assetIds.includes(ph.id);
                    return (
                      <button
                        key={ph.id}
                        type="button"
                        aria-pressed={on}
                        aria-label={`Use photo ${ph.name}`}
                        onClick={() => setAssetIds(on ? assetIds.filter((x) => x !== ph.id) : [...assetIds, ph.id].slice(0, 8))}
                        className={cn("relative size-16 shrink-0 overflow-hidden rounded-lg border-2", on ? "border-accent" : "border-transparent")}
                        title={ph.name}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/api/assets/${ph.id}`} alt={ph.name} className="size-full object-cover" loading="lazy" />
                        {on ? <span className="absolute right-0.5 top-0.5 rounded-full bg-accent px-1 text-[10px] font-semibold text-white">{assetIds.indexOf(ph.id) + 1}</span> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>

          <div>
            <p className="mb-2 text-[12px] font-medium text-ink-2">Style</p>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {STYLES.map((s) => (
                <button key={s.id} type="button" onClick={() => setStyle(s.id)} aria-pressed={style === s.id} className={cn("rounded-xl border p-2.5 text-left transition", style === s.id ? "border-ink bg-ink text-white" : "border-line hover:border-line-strong")}>
                  <p className="text-[12px] font-medium">
                    {s.label}
                    {p.preferredStyles.includes(s.id) ? <span className={cn("ml-1 text-[10px]", style === s.id ? "text-white/70" : "text-accent")}>· brand fit</span> : null}
                  </p>
                  <p className={cn("mt-0.5 line-clamp-2 text-[11px]", style === s.id ? "text-white/70" : "text-faint")}>{s.hint}</p>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-3 border-t border-line bg-sunken/40 p-4 sm:p-5 lg:border-l lg:border-t-0">
          <Field label="Type">
            <Segmented
              value={kind}
              onChange={setKind}
              options={[
                { value: "single", label: "Single image" },
                { value: "carousel", label: "Carousel" },
              ]}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Format">
              <Select value={fmt} onChange={(e) => setFmt(e.target.value)} aria-label="Format">
                {FORMATS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label} · {f.w}×{f.h}
                  </option>
                ))}
              </Select>
            </Field>
            {kind === "carousel" ? (
              <Field label="Slides">
                <Select value={slideCount} onChange={(e) => setSlideCount(Number(e.target.value))} aria-label="Slides">
                  {[3, 4, 5, 6, 7, 8].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field label="Variations">
                <Select value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="Variations">
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Objective">
              <Select value={objective} onChange={(e) => setObjective(e.target.value)} aria-label="Objective">
                {OBJECTIVES.map((o) => (
                  <option key={o} value={o}>
                    {objectiveLabel(o)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Logo">
              <Select value={logo} onChange={(e) => setLogo(e.target.value as LogoPlacementId)} aria-label="Logo placement">
                {LOGO_PLACEMENTS.map(([id, l]) => (
                  <option key={id} value={id}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {kind === "carousel" && visual !== "typographic" ? (
            <label className="flex items-start gap-2 text-[12px] text-ink-2">
              <input type="checkbox" checked={slideVisuals} onChange={(e) => setSlideVisuals(e.target.checked)} className="mt-0.5" />
              <span>
                A visual on every slide
                <span className="block text-[11px] text-faint">{visual === "ai" ? `Up to ${slideCount} images instead of 1.` : "Uses more of your photos."}</span>
              </span>
            </label>
          ) : null}
          <Field label="Campaign">
            <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} aria-label="Campaign">
              <option value="">None</option>
              {p.campaigns.map((c) => (
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
            disabled={brief.trim().length < 3 || Boolean(p.busyTask)}
            loading={busy("gen")}
            onClick={() =>
              run(
                () =>
                  startCreativesAction(p.brandId, {
                    brief,
                    format: fmt,
                    style,
                    count: kind === "carousel" ? 1 : count,
                    objective,
                    campaignId: campaignId || undefined,
                    kind,
                    slideCount: kind === "carousel" ? slideCount : undefined,
                    visualSource: visual,
                    sourceAssetIds: visual === "brand_photo" && assetIds.length ? assetIds : undefined,
                    logoPlacement: logo,
                    slideVisuals,
                  }),
                { key: "gen", success: "The Creative Director is on it", onOk: (d) => p.onTask(d.taskId) },
              )
            }
          >
            <Sparkles /> {kind === "carousel" ? `Generate a ${slideCount}-slide carousel` : `Generate ${total} creative${total > 1 ? "s" : ""}`}
          </Button>
          <p className="text-center text-[11px] text-muted">
            {p.busyTask ? "A creative job is already running for this brand." : "Runs in the background: concepts, visuals, platform copy, then a brand check. You can leave this page."}
          </p>
        </div>
      </div>
    </Card>
  );
}

function TaskProgress({ brandId, task, onUpdate, onDismiss }: { brandId: string; task: StudioTask; onUpdate: (t: StudioTask) => void; onDismiss: () => void }) {
  const router = useRouter();
  const done = useRef(task.steps.filter((x) => x.status === "done").length);
  const live = isLive(task);
  useEffect(() => {
    if (!live) return;
    let stop = false;
    const tick = async () => {
      const r = await creativeTaskStatusAction(brandId, task.id).catch(() => null);
      if (stop || !r?.ok) return;
      const t = r.data as StudioTask;
      onUpdate(t);
      const n = t.steps.filter((x) => x.status === "done").length;
      if (n !== done.current || !isLive(t)) {
        done.current = n;
        router.refresh();
      }
      if (t.status === "succeeded") toast("Creatives ready");
      if (t.status === "failed") toast(t.error ?? "The creative job failed", "error");
    };
    const h = setInterval(tick, 2500);
    void tick();
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, [brandId, task.id, live, onUpdate, router]);

  const steps = task.steps.length ? task.steps : [{ id: "q", label: "Starting…", status: "running" as const }];
  const n = steps.filter((x) => x.status === "done").length;
  return (
    <Card className="mb-6 overflow-hidden" aria-live="polite" data-testid="creative-task">
      <div className="ai-gradient flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
        <p className="flex items-center gap-2 text-[13px] font-semibold">
          {task.status === "failed" ? <XCircle className="size-4 text-danger" /> : task.status === "succeeded" ? <CheckCircle2 className="size-4 text-success" /> : <Loader2 className="size-4 animate-spin" />}
          {task.status === "failed"
            ? "The creative job stopped"
            : task.status === "succeeded"
              ? `Done · ${n}/${steps.length} steps`
              : task.recovering
                ? `Recovering after an interruption · ${n}/${steps.length}`
                : task.status === "queued" && (task.attempts ?? 0) > 0
                  ? `Retrying automatically (attempt ${(task.attempts ?? 0) + 1} of ${task.maxAttempts ?? 3})`
                  : `The creative team is working · ${n}/${steps.length}`}
        </p>
        <span className="flex items-center gap-3 text-[12px] text-ink-2/70">
          {task.costUsd > 0 ? <>AI cost ≈ {money(task.costUsd)}</> : null}
          {!live ? (
            <button className="underline" onClick={onDismiss}>
              Dismiss
            </button>
          ) : null}
        </span>
      </div>
      <CardBody className="space-y-3">
        <ol className="grid max-h-56 gap-1.5 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
          {steps.map((st) => (
            <li key={st.id} className="flex items-start gap-2 text-[12px]">
              {st.status === "done" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : st.status === "running" ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-accent" /> : st.status === "failed" ? <XCircle className="mt-0.5 size-4 shrink-0 text-danger" /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-faint" />}
              <span className={cn(st.status === "pending" || st.status === "skipped" ? "text-faint" : "text-ink-2")}>
                {st.label}
                {st.error ? <span className="block text-[11px] text-danger">{st.error}</span> : null}
              </span>
            </li>
          ))}
        </ol>
        {task.status === "failed" ? (
          <p className="flex items-start gap-2 rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {task.error ?? "The job failed."} Creatives that finished were kept.
          </p>
        ) : live ? (
          <p className="text-[12px] text-muted">
            {task.recovering ? "The server restarted mid-job. Finished steps are saved and the rest is picked up automatically; nothing is generated twice." : "Each creative appears below as soon as it's ready. The job keeps going if you leave or the server restarts."}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
