"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { addDays, addMonths, addWeeks, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, isToday, parse, startOfMonth, startOfWeek } from "date-fns";
import { AlertTriangle, CalendarClock, Check, ChevronLeft, ChevronRight, ExternalLink, Palette, PenLine, Send, Sparkles, Trash2, Undo2, X } from "lucide-react";
import {
  approvePostAction,
  deletePost,
  movePost,
  publishNow,
  rejectPost,
  schedulePost,
  submitForApproval,
  unschedulePost,
  updatePost,
} from "@/app/actions/posts";
import { producePostAction, writeCopyAction } from "@/app/actions/ai";
import { Badge, Button, Field, Input, Notice, PageHeader, Segmented, Select, Textarea } from "@/components/ui";
import { CreativeThumb, PlatformTag, Rationale, StatusBadge } from "@/components/bits";
import { PlanCalendarModal } from "@/components/calendar/plan-modal";
import { useRun } from "@/components/hooks";
import { FORMATS, OBJECTIVES, PLATFORMS, STYLES, objectiveLabel, platformColor } from "@/lib/domain";
import { roleAtLeast, type Role } from "@/lib/roles";
import { cn } from "@/lib/utils";

type Post = {
  id: string;
  title: string | null;
  platform: string;
  format: string;
  pillar: string | null;
  objective: string | null;
  status: string;
  scheduledAt: string | null;
  caption: string | null;
  hashtags: string[];
  creativeId: string | null;
  campaignId: string | null;
  socialAccountId: string | null;
  externalUrl: string | null;
  publishError: string | null;
  rationale: string | null;
  brief: string;
  hooks: string[];
  alternatives: string[];
};
type Account = { id: string; platform: string; name: string; handle: string | null; status: string; canPublish: string };

export function CalendarView(props: {
  brandId: string;
  role: Role;
  month: string;
  platforms: string[];
  initialPost?: string;
  campaigns: { id: string; name: string }[];
  accounts: Account[];
  creatives: { id: string; format: string; status: string; title: string }[];
  posts: Post[];
}) {
  const monthDate = parse(`${props.month}-01`, "yyyy-MM-dd", new Date());
  const [view, setView] = useState<"month" | "week">("month");
  const [weekStart, setWeekStart] = useState(() => startOfWeek(isSameMonth(new Date(), monthDate) ? new Date() : monthDate, { weekStartsOn: 1 }));
  const [selected, setSelected] = useState<string | undefined>(props.initialPost);
  const [platformFilter, setPlatformFilter] = useState("all");
  const [planOpen, setPlanOpen] = useState(false);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<Record<string, string>>({});
  const { run } = useRun();
  const canEdit = roleAtLeast(props.role, "editor");

  const posts = useMemo(
    () => props.posts.map((p) => (optimistic[p.id] ? { ...p, scheduledAt: optimistic[p.id] } : p)).filter((p) => platformFilter === "all" || p.platform === platformFilter),
    [props.posts, optimistic, platformFilter],
  );
  const days = useMemo(() => {
    if (view === "week") return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    const s = startOfWeek(startOfMonth(monthDate), { weekStartsOn: 1 });
    const e = endOfWeek(endOfMonth(monthDate), { weekStartsOn: 1 });
    const out: Date[] = [];
    for (let d = s; d <= e; d = addDays(d, 1)) out.push(d);
    return out;
  }, [view, weekStart, monthDate]);

  const byDay = (d: Date) => posts.filter((p) => p.scheduledAt && isSameDay(new Date(p.scheduledAt), d)).sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!));
  const current = props.posts.find((p) => p.id === selected);
  const counts = props.posts.reduce<Record<string, number>>((acc, p) => ((acc[p.status] = (acc[p.status] ?? 0) + 1), acc), {});

  function drop(d: Date, id: string) {
    setDragOver(null);
    const p = props.posts.find((x) => x.id === id);
    if (!p || ["published", "publishing"].includes(p.status)) return;
    const t = new Date(d);
    const prev = p.scheduledAt ? new Date(p.scheduledAt) : new Date();
    t.setHours(prev.getHours(), prev.getMinutes());
    setOptimistic((o) => ({ ...o, [id]: t.toISOString() }));
    run(() => movePost(props.brandId, id, t.toISOString()), { success: `Moved to ${format(t, "EEE d MMM")}` });
  }

  const navHref = (delta: number) => `/calendar?m=${format(addMonths(monthDate, delta), "yyyy-MM")}`;

  return (
    <div>
      <PageHeader
        eyebrow="Content Calendar"
        title={view === "month" ? format(monthDate, "MMMM yyyy") : `${format(weekStart, "d MMM")} – ${format(addDays(weekStart, 6), "d MMM yyyy")}`}
        description="Drag posts to reschedule. Drafts → approval → scheduled → published. Nothing goes live without an admin's approval."
        actions={
          canEdit ? (
            <Button variant="accent" onClick={() => setPlanOpen(true)}>
              <Sparkles /> Plan with AI
            </Button>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          {view === "month" ? (
            <>
              <Link href={navHref(-1)} className="grid size-8 place-items-center rounded-lg border border-line bg-surface hover:bg-sunken" aria-label="Previous month"><ChevronLeft className="size-4" /></Link>
              <Link href="/calendar" className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[12px] font-medium hover:bg-sunken">Today</Link>
              <Link href={navHref(1)} className="grid size-8 place-items-center rounded-lg border border-line bg-surface hover:bg-sunken" aria-label="Next month"><ChevronRight className="size-4" /></Link>
            </>
          ) : (
            <>
              <button onClick={() => setWeekStart((w) => addWeeks(w, -1))} className="grid size-8 place-items-center rounded-lg border border-line bg-surface hover:bg-sunken" aria-label="Previous week"><ChevronLeft className="size-4" /></button>
              <button onClick={() => setWeekStart(startOfWeek(new Date(), { weekStartsOn: 1 }))} className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[12px] font-medium hover:bg-sunken">This week</button>
              <button onClick={() => setWeekStart((w) => addWeeks(w, 1))} className="grid size-8 place-items-center rounded-lg border border-line bg-surface hover:bg-sunken" aria-label="Next week"><ChevronRight className="size-4" /></button>
            </>
          )}
        </div>
        <Segmented value={view} onChange={setView} options={[{ value: "month", label: "Month" }, { value: "week", label: "Week" }]} />
        <Select value={platformFilter} onChange={(e) => setPlatformFilter(e.target.value)} className="h-8 w-40 text-[12px]">
          <option value="all">All platforms</option>
          {PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </Select>
        <div className="ml-auto flex flex-wrap gap-1.5 text-[12px]">
          {Object.entries(counts).map(([s, n]) => (
            <span key={s} className="flex items-center gap-1"><StatusBadge status={s} /><span className="text-muted">{n}</span></span>
          ))}
        </div>
      </div>

      <div className="flex gap-6">
        <div className="min-w-0 flex-1 overflow-x-auto rounded-2xl border border-line bg-surface shadow-card">
          <div className="min-w-[680px]">
          <div className="grid grid-cols-7 border-b border-line bg-sunken/50 text-[11px] font-semibold uppercase tracking-wider text-faint">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="px-3 py-2">{d}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {days.map((d) => {
              const key = d.toISOString();
              const items = byDay(d);
              const outside = view === "month" && !isSameMonth(d, monthDate);
              return (
                <div
                  key={key}
                  onDragOver={(e) => {
                    if (!canEdit) return;
                    e.preventDefault();
                    setDragOver(key);
                  }}
                  onDragLeave={() => setDragOver((k) => (k === key ? null : k))}
                  onDrop={(e) => {
                    e.preventDefault();
                    drop(d, e.dataTransfer.getData("text/post"));
                  }}
                  className={cn("border-b border-r border-line p-1.5 transition-colors [&:nth-child(7n)]:border-r-0", view === "week" ? "min-h-[460px]" : "min-h-[124px]", outside && "bg-sunken/30", dragOver === key && "bg-accent-soft")}
                >
                  <div className={cn("mb-1 flex size-6 items-center justify-center rounded-full text-[12px]", isToday(d) ? "bg-ink font-semibold text-white" : outside ? "text-faint" : "text-ink-2")}>{format(d, "d")}</div>
                  <div className="space-y-1">
                    {items.map((p) => (
                      <button
                        key={p.id}
                        draggable={canEdit && !["published", "publishing"].includes(p.status)}
                        onDragStart={(e) => e.dataTransfer.setData("text/post", p.id)}
                        onClick={() => setSelected(p.id)}
                        className={cn(
                          "group flex w-full items-center gap-1.5 overflow-hidden rounded-lg border bg-surface px-1.5 py-1 text-left text-[11px] shadow-sm transition hover:shadow-md",
                          selected === p.id ? "border-ink ring-1 ring-ink" : "border-line",
                          p.status === "draft" && "border-dashed",
                        )}
                        style={{ borderLeft: `3px solid ${platformColor(p.platform)}` }}
                      >
                        {view === "week" && p.creativeId ? <CreativeThumb id={p.creativeId} className="size-8 shrink-0 rounded" /> : null}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{p.title ?? "Untitled"}</span>
                          <span className="flex items-center gap-1 text-faint">
                            {format(new Date(p.scheduledAt!), "HH:mm")}
                            <StatusDot status={p.status} />
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          </div>
        </div>

        {current ? (
          <PostPanel
            key={current.id}
            post={current}
            brandId={props.brandId}
            role={props.role}
            accounts={props.accounts}
            creatives={props.creatives}
            campaignName={props.campaigns.find((c) => c.id === current.campaignId)?.name}
            onClose={() => setSelected(undefined)}
          />
        ) : null}
      </div>

      <PlanCalendarModal open={planOpen} onClose={() => setPlanOpen(false)} brandId={props.brandId} platforms={props.platforms} />
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const c: Record<string, string> = { draft: "bg-faint", pending_approval: "bg-warn", approved: "bg-info", scheduled: "bg-accent", publishing: "bg-accent", published: "bg-success", failed: "bg-danger" };
  return <span className={cn("inline-block size-1.5 rounded-full", c[status] ?? "bg-faint")} />;
}

function PostPanel({ post, brandId, role, accounts, creatives, campaignName, onClose }: { post: Post; brandId: string; role: Role; accounts: Account[]; creatives: { id: string; format: string; status: string; title: string }[]; campaignName?: string; onClose: () => void }) {
  const canEdit = roleAtLeast(role, "editor");
  const isAdmin = roleAtLeast(role, "admin");
  const locked = ["publishing", "published"].includes(post.status);
  const [f, setF] = useState({
    title: post.title ?? "",
    caption: post.caption ?? "",
    hashtags: post.hashtags.join(" "),
    platform: post.platform,
    format: post.format,
    objective: post.objective ?? "engagement",
    when: post.scheduledAt ? format(new Date(post.scheduledAt), "yyyy-MM-dd'T'HH:mm") : "",
    socialAccountId: post.socialAccountId ?? "",
    creativeId: post.creativeId ?? "",
  });
  const [style, setStyle] = useState("premium_editorial");
  const [reason, setReason] = useState("");
  const { run, busy } = useRun();
  const platformAccounts = accounts.filter((a) => a.platform === f.platform && a.status === "active");
  const dirty =
    f.title !== (post.title ?? "") ||
    f.caption !== (post.caption ?? "") ||
    f.hashtags !== post.hashtags.join(" ") ||
    f.platform !== post.platform ||
    f.format !== post.format ||
    f.objective !== (post.objective ?? "engagement") ||
    f.socialAccountId !== (post.socialAccountId ?? "") ||
    f.creativeId !== (post.creativeId ?? "") ||
    f.when !== (post.scheduledAt ? format(new Date(post.scheduledAt), "yyyy-MM-dd'T'HH:mm") : "");

  const save = () =>
    run(
      () =>
        updatePost(brandId, post.id, {
          title: f.title,
          caption: f.caption,
          hashtags: f.hashtags.split(/[\s,]+/).map((h) => h.replace(/^#/, "")).filter(Boolean),
          platform: f.platform,
          format: f.format,
          objective: f.objective,
          scheduledAt: f.when ? new Date(f.when).toISOString() : undefined,
          socialAccountId: f.socialAccountId || null,
          creativeId: f.creativeId || null,
        }),
      { key: "save", success: "Post saved" },
    );

  return (
    <aside className="fixed inset-0 z-50 overflow-y-auto bg-surface pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] scrollbar-thin md:sticky md:pb-0 md:pt-0 md:inset-auto md:top-6 md:z-auto md:h-fit md:max-h-[calc(100vh-3rem)] md:w-[380px] md:shrink-0 md:rounded-2xl md:border md:border-line md:shadow-pop">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <PlatformTag platform={post.platform} />
          <StatusBadge status={post.status} />
        </div>
        <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-sunken" aria-label="Close"><X className="size-4" /></button>
      </div>

      <div className="space-y-4 p-4">
        {post.status === "failed" && post.publishError ? (
          <Notice tone="danger"><span className="flex gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{post.publishError}</span></Notice>
        ) : null}
        {post.status === "published" && post.externalUrl ? (
          <a href={post.externalUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-xl bg-success-soft px-3 py-2 text-[13px] font-medium text-success">
            View live post <ExternalLink className="size-3.5" />
          </a>
        ) : null}

        <div className="overflow-hidden rounded-xl border border-line bg-sunken">
          {f.creativeId ? (
            <CreativeThumb id={f.creativeId} format={f.format} className="w-full" />
          ) : (
            <div className="grid aspect-square place-items-center text-center text-[12px] text-muted">
              <div>
                <Palette className="mx-auto mb-2 size-5 text-faint" />
                No creative yet
              </div>
            </div>
          )}
        </div>

        <fieldset disabled={!canEdit || locked} className="space-y-3">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Select value={f.creativeId} onChange={(e) => setF({ ...f, creativeId: e.target.value })} className="text-[12px]">
              <option value="">— Attach a creative —</option>
              {creatives.map((c) => <option key={c.id} value={c.id}>{c.title}{c.status === "approved" ? " ✓" : ""}</option>)}
            </Select>
            {canEdit && !locked ? (
              <Button variant="ai" size="sm" className="h-9" title="Generate creative + caption" loading={busy("produce")} onClick={() => run(() => producePostAction(brandId, post.id, style), { key: "produce", success: "Creative and caption generated" })}>
                <Sparkles />
              </Button>
            ) : null}
          </div>
          {canEdit && !locked && !f.creativeId ? (
            <Select value={style} onChange={(e) => setStyle(e.target.value)} className="h-8 text-[12px]">
              {STYLES.map((s) => <option key={s.id} value={s.id}>Style for AI creative: {s.label}</option>)}
            </Select>
          ) : null}

          <Field label="Title"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Caption" hint={`${f.caption.length} chars`}>
            <Textarea rows={6} value={f.caption} onChange={(e) => setF({ ...f, caption: e.target.value })} placeholder="Write or generate a caption…" />
          </Field>
          {canEdit && !locked ? (
            <Button
              variant="secondary"
              size="sm"
              loading={busy("copy")}
              onClick={() =>
                run(() => writeCopyAction(brandId, { brief: `${f.title}. ${post.brief}`, platform: f.platform, objective: f.objective, pillar: post.pillar ?? undefined }), {
                  key: "copy",
                  refresh: false,
                  success: "Caption written. Review it, then save.",
                  onOk: (d) => setF((x) => ({ ...x, caption: d.primary, hashtags: d.hashtags.join(" ") })),
                })
              }
            >
              <PenLine /> {f.caption ? "Rewrite caption" : "Write caption"}
            </Button>
          ) : null}
          {post.alternatives.length ? (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-muted">Alternative captions ({post.alternatives.length})</summary>
              <div className="mt-2 space-y-1.5">
                {post.alternatives.map((a) => (
                  <button key={a} type="button" onClick={() => setF({ ...f, caption: a })} className="block w-full rounded-lg border border-line p-2 text-left hover:bg-sunken">{a}</button>
                ))}
              </div>
            </details>
          ) : null}
          <Field label="Hashtags"><Input value={f.hashtags} onChange={(e) => setF({ ...f, hashtags: e.target.value })} placeholder="slowmade ceramics" /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Platform">
              <Select value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value, socialAccountId: "" })}>
                {PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </Select>
            </Field>
            <Field label="Format">
              <Select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })}>
                {FORMATS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </Select>
            </Field>
            <Field label="Objective">
              <Select value={f.objective} onChange={(e) => setF({ ...f, objective: e.target.value })}>
                {OBJECTIVES.map((o) => <option key={o} value={o}>{objectiveLabel(o)}</option>)}
              </Select>
            </Field>
            <Field label="Date & time"><Input type="datetime-local" value={f.when} onChange={(e) => setF({ ...f, when: e.target.value })} /></Field>
          </div>
          <Field label="Publish to">
            <Select value={f.socialAccountId} onChange={(e) => setF({ ...f, socialAccountId: e.target.value })}>
              <option value="">{platformAccounts.length ? "Choose account" : "No connected account"}</option>
              {platformAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.handle ? ` (@${a.handle})` : ""}</option>)}
            </Select>
          </Field>
          {!platformAccounts.length ? <p className="text-[12px] text-muted">Connect a {f.platform} account in <Link href="/accounts" className="underline">Social Accounts</Link> to publish.</p> : null}
        </fieldset>

        <div className="flex flex-wrap gap-1.5 text-[12px] text-muted">
          {post.pillar ? <Badge>{post.pillar}</Badge> : null}
          {campaignName ? <Badge tone="accent">{campaignName}</Badge> : null}
        </div>

        {canEdit && !locked ? (
          <div className="space-y-2 border-t border-line pt-4">
            {dirty ? <Button className="w-full" loading={busy("save")} onClick={save}>Save changes</Button> : null}
            {!dirty && post.status === "draft" ? (
              <Button className="w-full" variant="secondary" loading={busy("submit")} onClick={() => run(() => submitForApproval(brandId, post.id), { key: "submit", success: "Sent for approval" })}>
                <Send /> Submit for approval
              </Button>
            ) : null}
            {!dirty && isAdmin && ["draft", "pending_approval"].includes(post.status) ? (
              <Button className="w-full" variant="accent" loading={busy("approve")} onClick={() => run(() => approvePostAction(brandId, post.id), { key: "approve", success: "Approved" })}>
                <Check /> Approve
              </Button>
            ) : null}
            {!dirty && isAdmin && post.status === "pending_approval" ? (
              <div className="flex gap-2">
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Feedback for the AI (optional)" className="text-[12px]" />
                <Button variant="ghost" loading={busy("reject")} onClick={() => run(() => rejectPost(brandId, post.id, reason), { key: "reject", success: "Sent back to draft" })}>
                  <Undo2 />
                </Button>
              </div>
            ) : null}
            {!dirty && isAdmin && ["approved", "failed"].includes(post.status) ? (
              <div className="grid grid-cols-2 gap-2">
                <Button variant="accent" loading={busy("sched")} onClick={() => run(() => schedulePost(brandId, post.id), { key: "sched", success: "Scheduled. It will publish at the set time." })}>
                  <CalendarClock /> Schedule
                </Button>
                <Button variant="secondary" loading={busy("now")} onClick={() => confirm("Publish this post now to the connected account?") && run(() => publishNow(brandId, post.id), { key: "now", success: "Published" })}>
                  <Send /> Publish now
                </Button>
              </div>
            ) : null}
            {isAdmin && post.status === "scheduled" ? (
              <Button className="w-full" variant="secondary" loading={busy("unsched")} onClick={() => run(() => unschedulePost(brandId, post.id), { key: "unsched", success: "Unscheduled" })}>
                <Undo2 /> Unschedule
              </Button>
            ) : null}
            {!isAdmin && post.status === "pending_approval" ? <p className="text-center text-[12px] text-muted">Waiting for an admin to approve.</p> : null}
            <button onClick={() => confirm("Delete this post?") && run(() => deletePost(brandId, post.id), { key: "del", success: "Post deleted", onOk: onClose })} className="flex w-full items-center justify-center gap-1.5 pt-1 text-[12px] text-faint hover:text-danger">
              <Trash2 className="size-3.5" /> Delete post
            </button>
          </div>
        ) : null}
        {post.brief ? <p className="text-[12px] text-faint">Brief: {post.brief}</p> : null}
        <Rationale>{post.rationale}</Rationale>
      </div>
    </aside>
  );
}
