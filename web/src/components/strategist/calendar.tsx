"use client";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { addDays, format, parseISO } from "date-fns";
import { CalendarCheck, Image as ImageIcon, Palette, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { applyCalendarAction, deleteEntryAction, regenerateEntryAction, upsertEntryAction } from "@/app/actions/strategist";
import { produceFromCalendarAction } from "@/app/actions/creative";
import { Badge, Button, Card, CardBody, CardHeader, Input, Modal, Notice, Segmented, Select, Textarea } from "@/components/ui";
import { PlatformTag } from "@/components/bits";
import { useRun } from "@/components/hooks";
import { FORMATS, OBJECTIVES, STYLES, formatById, objectiveLabel, platformColor, platformLabel } from "@/lib/domain";
import type { CalendarEntry, CalendarSection, Envelope, StrategyDoc } from "@/lib/strategy";
import { cn } from "@/lib/utils";
import { SectionFrame, useCtx } from "./kit";
import { PlatformMix, WeeklyCadence } from "./charts";

type Draft = Omit<CalendarEntry, "id">;

/** Creatives produced from this strategy's calendar, and the defaults for producing more. */
export type Production = {
  creatives: { id: string; entryId: string; status: string; format: string; v: number }[];
  style: string;
  visualSource: "ai" | "brand_photo" | "typographic";
  imageReady: boolean;
  photos: number;
};
type ProduceCtx = { production?: Production; canProduce: boolean; linked: (entryId: string) => Production["creatives"] };
const ProduceContext = createContext<ProduceCtx>({ canProduce: false, linked: () => [] });

/** Style and visual source pickers shared by single and batch production. */
function ProduceOptions({ style, setStyle, visual, setVisual, production }: { style: string; setStyle: (s: string) => void; visual: string; setVisual: (v: Production["visualSource"]) => void; production: Production }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Select value={style} onChange={(e) => setStyle(e.target.value)} aria-label="Creative style">
        {STYLES.map((x) => <option key={x.id} value={x.id}>Style: {x.label}</option>)}
      </Select>
      <Select value={visual} onChange={(e) => setVisual(e.target.value as Production["visualSource"])} aria-label="Visual source">
        <option value="ai" disabled={!production.imageReady}>AI image{production.imageReady ? "" : " (not configured)"}</option>
        <option value="brand_photo" disabled={!production.photos}>Brand photos{production.photos ? ` (${production.photos})` : " (none approved)"}</option>
        <option value="typographic">Type-led (no photo)</option>
      </Select>
    </div>
  );
}

function ProduceWeek({ cal, onClose }: { cal: CalendarSection; onClose: () => void }) {
  const ctx = useCtx();
  const pc = useContext(ProduceContext);
  const router = useRouter();
  const production = pc.production!;
  const today = format(new Date(), "yyyy-MM-dd");
  const upcoming = cal.entries.filter((e) => e.date >= today && !pc.linked(e.id).length);
  const pool = (upcoming.length ? upcoming : cal.entries.filter((e) => !pc.linked(e.id).length)).slice(0, 12);
  const [picked, setPicked] = useState<string[]>(pool.slice(0, 7).map((e) => e.id));
  const [style, setStyle] = useState(production.style);
  const [visual, setVisual] = useState(production.visualSource);
  const { run, busy } = useRun();
  return (
    <Modal open onClose={onClose} title="Produce creatives from the calendar">
      <div className="space-y-3 p-5">
        <p className="text-[13px] text-muted">Each entry becomes a brief (hook, concept, caption direction, pillar, objective and format). The creative team produces the visual, platform copy and a brand check for each. Up to 7 at a time.</p>
        {pool.length ? (
          <div className="max-h-72 space-y-1.5 overflow-y-auto">
            {pool.map((e) => {
              const on = picked.includes(e.id);
              return (
                <label key={e.id} className={cn("flex cursor-pointer items-start gap-2 rounded-lg border p-2 text-[12px]", on ? "border-accent bg-accent-soft/40" : "border-line")}>
                  <input type="checkbox" checked={on} disabled={!on && picked.length >= 7} onChange={() => setPicked(on ? picked.filter((x) => x !== e.id) : [...picked, e.id])} className="mt-0.5" />
                  <span>
                    <span className="text-faint">{format(parseISO(e.date), "EEE d MMM")} · {platformLabel(e.platform)} · {formatById(e.format).label}</span>
                    <span className="block font-medium">{e.hook}</span>
                  </span>
                </label>
              );
            })}
          </div>
        ) : (
          <Notice tone="success">Every calendar entry already has a creative.</Notice>
        )}
        <ProduceOptions style={style} setStyle={setStyle} visual={visual} setVisual={setVisual} production={production} />
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button
          variant="accent"
          disabled={!picked.length}
          loading={busy("produce")}
          onClick={() => run(() => produceFromCalendarAction(ctx.brandId, ctx.strategyId, picked, { style, visualSource: visual }), { key: "produce", success: `Producing ${picked.length} creative${picked.length > 1 ? "s" : ""}`, refresh: false, onOk: () => router.push("/creative-studio") })}
        >
          <Sparkles /> Produce {picked.length}
        </Button>
      </div>
    </Modal>
  );
}

function EntryCreatives({ entry }: { entry: CalendarEntry }) {
  const ctx = useCtx();
  const pc = useContext(ProduceContext);
  const router = useRouter();
  const linked = pc.linked(entry.id);
  const [style, setStyle] = useState(pc.production?.style ?? "premium_editorial");
  const [visual, setVisual] = useState(pc.production?.visualSource ?? "typographic");
  const { run, busy } = useRun();
  if (!pc.production || (!linked.length && !pc.canProduce)) return null;
  return (
    <div className="space-y-2 border-t border-line px-5 py-4">
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-ink-2"><Palette className="size-4" /> Creatives</p>
      {linked.length ? (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {linked.map((c) => (
            <Link key={c.id} href={`/creative-studio?c=${c.id}`} className="relative w-20 shrink-0 overflow-hidden rounded-lg border border-line" aria-label="Open linked creative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/creatives/${c.id}/image?format=instagram_square&v=${c.v}`} alt="Linked creative" className="aspect-square w-full object-cover" loading="lazy" />
              <span className="block px-1 py-0.5 text-[10px] capitalize text-muted">{c.status}</span>
            </Link>
          ))}
        </div>
      ) : null}
      {pc.canProduce ? (
        <div className="space-y-2">
          <ProduceOptions style={style} setStyle={setStyle} visual={visual} setVisual={setVisual} production={pc.production} />
          <Button variant="ai" loading={busy("one")} onClick={() => run(() => produceFromCalendarAction(ctx.brandId, ctx.strategyId, [entry.id], { style, visualSource: visual }), { key: "one", success: "Creating the creative", refresh: false, onOk: () => router.push("/creative-studio") })}>
            <Sparkles /> {linked.length ? "Create another creative" : "Create creative"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function LinkedMark({ id }: { id: string }) {
  const n = useContext(ProduceContext).linked(id).length;
  return n ? (
    <span className="ml-auto inline-flex items-center gap-0.5 text-accent-ink" title={`${n} linked creative${n > 1 ? "s" : ""}`}>
      <ImageIcon className="size-3" />
      {n > 1 ? n : null}
    </span>
  ) : null;
}
const toDraft = (e: CalendarEntry): Draft => {
  const { id: _id, ...d } = e;
  void _id;
  return d;
};

export function CalendarStats({ cal }: { cal: CalendarSection }) {
  const counts = cal.platforms.map((p) => ({ platform: p, n: cal.entries.filter((e) => e.platform === p).length }));
  const start = parseISO(cal.startDate);
  const weeks = Array.from({ length: Math.ceil(cal.days / 7) }, (_, w) => {
    const from = format(addDays(start, w * 7), "yyyy-MM-dd");
    const to = format(addDays(start, Math.min(w * 7 + 6, cal.days - 1)), "yyyy-MM-dd");
    const span = Math.min(7, cal.days - w * 7);
    return { label: span < 7 ? `Days ${w * 7 + 1}–${w * 7 + span}` : `Wk ${w + 1}`, n: cal.entries.filter((e) => e.date >= from && e.date <= to).length };
  });
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div>
        <p className="mb-3 text-[12px] font-medium text-ink-2">Posts per platform</p>
        <PlatformMix counts={counts} />
      </div>
      <div>
        <p className="mb-3 text-[12px] font-medium text-ink-2">Posts per week</p>
        <WeeklyCadence weeks={weeks} />
      </div>
    </div>
  );
}

export function CalendarView({ env, doc, status, production, canProduce = false }: { env?: Envelope<CalendarSection>; doc: StrategyDoc; status: string; production?: Production; canProduce?: boolean }) {
  const ctx = useCtx();
  const [produce, setProduce] = useState(false);
  const pc = useMemo<ProduceCtx>(() => ({ production, canProduce: canProduce && Boolean(production), linked: (id) => production?.creatives.filter((c) => c.entryId === id) ?? [] }), [production, canProduce]);
  const cal = env?.data;
  const [view, setView] = useState<"grid" | "list">("grid");
  const [platform, setPlatform] = useState("all");
  const [open, setOpen] = useState<CalendarEntry | "new" | null>(null);
  const { run, busy } = useRun();
  useEffect(() => {
    if (window.matchMedia("(max-width: 767px)").matches) setView("list");
  }, []);
  const entries = useMemo(() => (cal?.entries ?? []).filter((e) => platform === "all" || e.platform === platform), [cal, platform]);
  const pillars = doc.sections.pillars?.data.pillars.map((p) => p.name) ?? [];
  const campaigns = doc.sections.campaigns?.data.campaigns.map((c) => c.name) ?? [];

  return (
    <ProduceContext.Provider value={pc}>
    <div className="space-y-6">
      <SectionFrame
        section="calendar"
        title="30-day content calendar"
        env={env}
        description="Every entry is a brief your team can execute. Click an entry to edit, reschedule, delete or regenerate it."
        extra={
          cal ? (
            <>
              {ctx.canEdit ? (
                <Button size="sm" variant="secondary" onClick={() => setOpen("new")}>
                  <Plus /> Add entry
                </Button>
              ) : null}
              {pc.canProduce ? (
                <Button size="sm" variant="ai" onClick={() => setProduce(true)}>
                  <Sparkles /> Produce creatives
                </Button>
              ) : null}
              {status === "approved" ? (
                <Button size="sm" variant="accent" loading={busy("apply")} onClick={() => run(() => applyCalendarAction(ctx.brandId, ctx.strategyId), { key: "apply", success: (d) => `${d.added} draft posts on the content calendar${d.kept ? ` (${d.kept} already approved were kept)` : ""}` })}>
                  <CalendarCheck /> {cal.appliedAt ? "Re-apply to content calendar" : "Add to content calendar"}
                </Button>
              ) : null}
            </>
          ) : null
        }
      >
        {cal ? (
          <div className="space-y-4">
            {cal.notes ? <p className="text-[12px] text-muted">{cal.notes}</p> : null}
            {cal.appliedAt ? <Notice tone="success">Added to the content calendar on {format(new Date(cal.appliedAt), "d MMM yyyy, HH:mm")} as drafts. Nothing is published until each post is approved.</Notice> : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Segmented value={view} onChange={setView} options={[{ value: "grid", label: "Calendar" }, { value: "list", label: "List" }]} />
              <Select value={platform} onChange={(e) => setPlatform(e.target.value)} className="h-8 w-44 text-[12px]" aria-label="Filter by platform">
                <option value="all">All platforms ({cal.entries.length})</option>
                {cal.platforms.map((p) => (
                  <option key={p} value={p}>
                    {platformLabel(p)} ({cal.entries.filter((e) => e.platform === p).length})
                  </option>
                ))}
              </Select>
            </div>
            {view === "grid" ? <MonthGrid cal={cal} entries={entries} onOpen={setOpen} /> : <EntryList entries={entries} onOpen={setOpen} />}
          </div>
        ) : null}
      </SectionFrame>
      {cal ? (
        <Card>
          <CardHeader title="Calendar at a glance" />
          <CardBody>
            <CalendarStats cal={cal} />
          </CardBody>
        </Card>
      ) : null}
      {cal && open ? <EntryModal key={open === "new" ? "new" : open.id} entry={open === "new" ? null : open} cal={cal} pillars={pillars} campaigns={campaigns} onClose={() => setOpen(null)} /> : null}
      {cal && produce ? <ProduceWeek cal={cal} onClose={() => setProduce(false)} /> : null}
    </div>
    </ProduceContext.Provider>
  );
}

function MonthGrid({ cal, entries, onOpen }: { cal: CalendarSection; entries: CalendarEntry[]; onOpen: (e: CalendarEntry) => void }) {
  const start = parseISO(cal.startDate);
  const lead = (start.getDay() + 6) % 7; // Monday-first grid
  const cells = Array.from({ length: lead + cal.days }, (_, i) => (i < lead ? null : addDays(start, i - lead)));
  while (cells.length % 7) cells.push(null);
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[760px] grid-cols-7 gap-px overflow-hidden rounded-xl border border-line bg-line">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="bg-sunken px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">
            {d}
          </div>
        ))}
        {cells.map((d, i) => {
          const key = d ? format(d, "yyyy-MM-dd") : `x${i}`;
          const day = d ? entries.filter((e) => e.date === key) : [];
          return (
            <div key={key} className={cn("min-h-[104px] bg-surface p-1.5", !d && "bg-sunken/40")}>
              {d ? <p className="mb-1 text-[11px] text-faint">{format(d, d.getDate() === 1 || key === cal.startDate ? "d MMM" : "d")}</p> : null}
              <div className="space-y-1">
                {day.map((e) => (
                  <button key={e.id} onClick={() => onOpen(e)} className="block w-full rounded-md border border-line bg-surface px-1.5 py-1 text-left text-[11px] leading-snug transition hover:border-line-strong hover:shadow-card" title={`${platformLabel(e.platform)} · ${e.pillar}: ${e.hook}`}>
                    <span className="flex items-center gap-1 text-faint">
                      <span className="size-1.5 shrink-0 rounded-full" style={{ background: platformColor(e.platform) }} />
                      {e.time} · {platformLabel(e.platform)}
                      <LinkedMark id={e.id} />
                    </span>
                    <span className="line-clamp-2 text-ink">{e.hook}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EntryList({ entries, onOpen }: { entries: CalendarEntry[]; onOpen: (e: CalendarEntry) => void }) {
  const byDate = entries.reduce<Record<string, CalendarEntry[]>>((m, e) => ((m[e.date] ??= []).push(e), m), {});
  return (
    <div className="space-y-4">
      {Object.entries(byDate).map(([date, list]) => (
        <div key={date}>
          <p className="mb-1.5 text-[12px] font-semibold text-ink-2">{format(parseISO(date), "EEEE d MMMM")}</p>
          <div className="space-y-2">
            {list.map((e) => (
              <button key={e.id} onClick={() => onOpen(e)} className="block w-full rounded-xl border border-line p-3 text-left transition hover:border-line-strong">
                <div className="flex flex-wrap items-center gap-2 text-[12px]">
                  <PlatformTag platform={e.platform} />
                  <span className="text-faint">{e.time}</span>
                  <Badge>{e.pillar}</Badge>
                  <span className="text-faint">{formatById(e.format).label}</span>
                  {e.campaign ? <Badge tone="accent">{e.campaign}</Badge> : null}
                  <LinkedMark id={e.id} />
                </div>
                <p className="mt-1.5 text-[13px] font-medium">{e.hook}</p>
                <p className="mt-0.5 line-clamp-2 text-[12px] text-muted">{e.creativeConcept}</p>
              </button>
            ))}
          </div>
        </div>
      ))}
      {!entries.length ? <p className="text-[13px] text-muted">No entries.</p> : null}
    </div>
  );
}

function EntryModal({ entry, cal, pillars, campaigns, onClose }: { entry: CalendarEntry | null; cal: CalendarSection; pillars: string[]; campaigns: string[]; onClose: () => void }) {
  const ctx = useCtx();
  const blank: Draft = { date: cal.startDate, time: "10:00", platform: cal.platforms[0] as Draft["platform"], pillar: pillars[0] ?? "", objective: "engagement", format: "instagram_post", creativeConcept: "", hook: "", captionDirection: "", cta: "", hashtags: [], campaign: "" };
  const [d, setD] = useState<Draft>(entry ? toDraft(entry) : blank);
  const [tags, setTags] = useState(d.hashtags.join(" "));
  const [instruction, setInstruction] = useState("");
  const { run, busy } = useRun();
  const editable = ctx.canEdit;
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });
  const end = format(addDays(parseISO(cal.startDate), cal.days - 1), "yyyy-MM-dd");
  const save = () =>
    run(() => upsertEntryAction(ctx.brandId, ctx.strategyId, entry?.id ?? null, { ...d, hashtags: tags.split(/[\s,]+/).map((t) => t.replace(/^#/, "")).filter(Boolean) }, ctx.rev), { key: "save", success: entry ? "Entry updated" : "Entry added", onOk: onClose });

  return (
    <Modal open onClose={onClose} title={entry ? `${platformLabel(entry.platform)} · ${format(parseISO(entry.date), "EEE d MMM")}` : "New calendar entry"} wide>
      <div className="grid gap-4 p-5 md:grid-cols-2">
        <label className="block text-[12px]">
          <span className="mb-1 block font-medium text-ink-2">Date</span>
          <Input type="date" min={cal.startDate} max={end} value={d.date} disabled={!editable} onChange={(e) => set({ date: e.target.value })} />
        </label>
        <label className="block text-[12px]">
          <span className="mb-1 block font-medium text-ink-2">Time</span>
          <Input type="time" value={d.time} disabled={!editable} onChange={(e) => set({ time: e.target.value })} />
        </label>
        <label className="block text-[12px]">
          <span className="mb-1 block font-medium text-ink-2">Platform</span>
          <Select value={d.platform} disabled={!editable} onChange={(e) => set({ platform: e.target.value as Draft["platform"] })}>
            {cal.platforms.map((p) => <option key={p} value={p}>{platformLabel(p)}</option>)}
          </Select>
        </label>
        <label className="block text-[12px]">
          <span className="mb-1 block font-medium text-ink-2">Format</span>
          <Select value={d.format} disabled={!editable} onChange={(e) => set({ format: e.target.value as Draft["format"] })}>
            {FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </Select>
        </label>
        <label className="block text-[12px]">
          <span className="mb-1 block font-medium text-ink-2">Pillar</span>
          <Select value={d.pillar} disabled={!editable} onChange={(e) => set({ pillar: e.target.value })}>
            {[...new Set([...pillars, d.pillar])].filter(Boolean).map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
        </label>
        <label className="block text-[12px]">
          <span className="mb-1 block font-medium text-ink-2">Objective</span>
          <Select value={d.objective} disabled={!editable} onChange={(e) => set({ objective: e.target.value as Draft["objective"] })}>
            {OBJECTIVES.map((o) => <option key={o} value={o}>{objectiveLabel(o)}</option>)}
          </Select>
        </label>
        <label className="block text-[12px] md:col-span-2">
          <span className="mb-1 block font-medium text-ink-2">Hook</span>
          <Input value={d.hook} disabled={!editable} onChange={(e) => set({ hook: e.target.value })} />
        </label>
        <label className="block text-[12px] md:col-span-2">
          <span className="mb-1 block font-medium text-ink-2">Creative concept</span>
          <Textarea rows={3} value={d.creativeConcept} disabled={!editable} onChange={(e) => set({ creativeConcept: e.target.value })} />
        </label>
        <label className="block text-[12px] md:col-span-2">
          <span className="mb-1 block font-medium text-ink-2">Caption direction</span>
          <Textarea rows={2} value={d.captionDirection} disabled={!editable} onChange={(e) => set({ captionDirection: e.target.value })} />
        </label>
        <label className="block text-[12px]">
          <span className="mb-1 block font-medium text-ink-2">Call to action</span>
          <Input value={d.cta} disabled={!editable} onChange={(e) => set({ cta: e.target.value })} />
        </label>
        <label className="block text-[12px]">
          <span className="mb-1 block font-medium text-ink-2">Campaign</span>
          <Select value={d.campaign} disabled={!editable} onChange={(e) => set({ campaign: e.target.value })}>
            <option value="">None</option>
            {campaigns.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </label>
        <label className="block text-[12px] md:col-span-2">
          <span className="mb-1 block font-medium text-ink-2">Hashtags</span>
          <Input value={tags} disabled={!editable} onChange={(e) => setTags(e.target.value)} placeholder="slowmade designdetails" />
        </label>
      </div>
      {entry ? <EntryCreatives entry={entry} /> : null}
      {editable ? (
        <div className="flex flex-col gap-3 border-t border-line px-5 py-4">
          {entry && ctx.canGenerate ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Regenerate with direction (optional), e.g. “make it a reel”" className="flex-1" maxLength={500} />
              <Button variant="ai" loading={busy("regen")} onClick={() => run(() => regenerateEntryAction(ctx.brandId, ctx.strategyId, entry.id, instruction, ctx.rev), { key: "regen", success: "Entry regenerated", onOk: onClose })}>
                <RefreshCw /> Regenerate
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap justify-between gap-2">
            {entry ? (
              <Button variant="danger" loading={busy("del")} onClick={() => run(() => deleteEntryAction(ctx.brandId, ctx.strategyId, entry.id, ctx.rev), { key: "del", success: "Entry deleted", onOk: onClose })}>
                <Trash2 /> Delete
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button variant="accent" loading={busy("save")} onClick={save}>{entry ? "Save" : "Add entry"}</Button>
            </div>
          </div>
        </div>
      ) : (
        <p className="border-t border-line px-5 py-3 text-[12px] text-muted">This strategy is read-only for you{ctx.canEdit ? "" : " (viewer access)"}.</p>
      )}
    </Modal>
  );
}
