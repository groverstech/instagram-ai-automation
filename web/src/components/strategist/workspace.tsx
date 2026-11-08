"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { format, formatDistanceToNow } from "date-fns";
import { Archive, Check, CheckCircle2, CircleDashed, Compass, Copy, Loader2, MessageSquareWarning, Play, Plus, Send, Sparkles, XCircle } from "lucide-react";
import { archiveStrategyAction, approveStrategyV2Action, newVersionAction, requestRevisionsAction, resumeAction, submitForReviewAction, taskStatusAction } from "@/app/actions/strategist";
import { Badge, Button, Card, CardBody, CardHeader, Empty, Modal, Notice, PageHeader, Select, Textarea } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useRun } from "@/components/hooks";
import { roleAtLeast, type Role } from "@/lib/roles";
import { SECTION_KEYS, SECTION_META, STATUS_META, STRATEGY_PARTS, accountTypeLabel, type SectionKey, type StrategyDoc } from "@/lib/strategy";
import { cn } from "@/lib/utils";
import { StrategyCtx, type Ctx } from "./kit";
import { AudienceView, CampaignsView, CompetitorsView, KpisView, ObjectivesView, PillarsView, ResearchMode, ResearchView, StrategyView } from "./sections";
import { CalendarStats, CalendarView, type Production } from "./calendar";
import { Advisor, type AdvisorMsg } from "./advisor";
import { HistoryView, type Revision, type VersionRow } from "./history";
import { NewStrategyWizard, type PreflightProps } from "./wizard";
import { PillarShare } from "./charts";

type Step = { id: string; label: string; status: "pending" | "running" | "done" | "failed" | "skipped"; error?: string };
type Task = { id: string; status: "queued" | "running" | "succeeded" | "failed"; steps: Step[]; error: string | null; costUsd: number; kind?: string; attempts?: number; maxAttempts?: number; runAfter?: Date | string; recovering?: boolean };

type Props = {
  brand: { id: string; name: string; platforms: string[] };
  brands: { id: string; name: string }[];
  role: Role;
  ai: { provider: string; ready: boolean; model: string; webSearch: boolean };
  preflight: PreflightProps;
  versions: (VersionRow & { schemaVersion: number; month: string })[];
  strategy: {
    id: string;
    version: number;
    title: string | null;
    status: string;
    rev: number;
    revisionNote: string | null;
    approvedAt: Date | null;
    approvedByName: string | null;
    createdAt: Date;
    updatedAt: Date;
    parentId: string | null;
    doc: StrategyDoc;
    blockers: string[];
  } | null;
  legacy: { id: string; month: string; version: number } | null;
  revisions: Revision[];
  task: Task | null;
  running: boolean;
  cost: { costUsd: number; inputTokens: number; outputTokens: number; webSearches: number; unknownUsageCalls?: number } | null;
  chat: AdvisorMsg[];
  startNew: boolean;
  initialTab?: string;
  production?: Production;
};

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "strategy", label: "Strategy" },
  { id: "objectives", label: "Objectives" },
  { id: "audience", label: "Personas" },
  { id: "research", label: "Research" },
  { id: "competitors", label: "Competitors" },
  { id: "pillars", label: "Pillars" },
  { id: "campaigns", label: "Campaigns" },
  { id: "calendar", label: "30-day calendar" },
  { id: "kpis", label: "KPIs" },
  { id: "advisor", label: "Advisor" },
  { id: "history", label: "History" },
] as const;
type TabId = (typeof TABS)[number]["id"];
const TAB_FOR: Record<SectionKey, TabId> = { research: "research", audience: "audience", objectives: "objectives", strategy: "strategy", pillars: "pillars", campaigns: "campaigns", calendar: "calendar" };

const money = (n: number) => (n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`);

export function StrategistWorkspace(p: Props) {
  const router = useRouter();
  const s = p.strategy;
  const [tab, setTab] = useState<TabId>(TABS.some((t) => t.id === p.initialTab) ? (p.initialTab as TabId) : "overview");
  const [wizard, setWizard] = useState(p.startNew && !p.preflight.blocked && roleAtLeast(p.role, "editor"));
  const [task, setTask] = useState<Task | null>(p.task);
  const [revise, setRevise] = useState(false);
  const [note, setNote] = useState("");
  const { run, busy } = useRun();
  const canEdit = roleAtLeast(p.role, "editor");
  const canApprove = roleAtLeast(p.role, "admin");
  const editableStatus = s?.status === "draft" || s?.status === "under_review";
  const working = task?.status === "queued" || task?.status === "running";

  useEffect(() => setTask(p.task), [p.task]);

  // Poll task progress; refresh the page as each section lands so results appear progressively.
  const doneCount = useRef(task?.steps.filter((x) => x.status === "done").length ?? 0);
  useEffect(() => {
    if (!task || !working) return;
    let stop = false;
    const tick = async () => {
      const r = await taskStatusAction(p.brand.id, task.id).catch(() => null);
      if (stop || !r?.ok) return;
      const t = r.data as Task;
      setTask((cur) => (cur && cur.id === t.id ? { ...cur, ...t } : cur));
      const done = t.steps.filter((x) => x.status === "done").length;
      if (done !== doneCount.current || t.status === "succeeded" || t.status === "failed") {
        doneCount.current = done;
        router.refresh();
      }
      if (t.status === "succeeded") toast("Strategy updated");
      if (t.status === "failed") toast(t.error ?? "The AI task failed", "error");
    };
    const h = setInterval(tick, 2500);
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, [task, working, p.brand.id, router]);

  const onTask = useCallback(
    (taskId: string) => {
      doneCount.current = 0;
      setTask({ id: taskId, status: "queued", steps: [], error: null, costUsd: 0, kind: "" });
      router.refresh();
    },
    [router],
  );

  const ctx: Ctx | null = s
    ? { brandId: p.brand.id, strategyId: s.id, rev: s.rev, canEdit: canEdit && editableStatus && !working && !p.running, canApprove: canApprove && editableStatus && !working, canGenerate: canEdit && editableStatus && !working && !p.running && p.ai.ready, onTask }
    : null;

  const header = (
    <PageHeader
      eyebrow="AI Marketing Strategist"
      title={s ? `Marketing strategy v${s.version}` : "Marketing strategy"}
      description={`For ${p.brand.name}. Research, personas, positioning, pillars, campaigns and a 30-day plan, built on your approved Brand Intelligence Profile.`}
      actions={
        <>
          {p.versions.length ? (
            <Select value={s?.id ?? p.legacy?.id ?? ""} onChange={(e) => router.push(`/strategist?v=${e.target.value}`)} className="w-60" aria-label="Strategy version">
              {p.versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.legacy ? `Legacy · ${v.month}` : `v${v.version} · ${STATUS_META[v.status]?.label ?? v.status}`} · {format(new Date(v.createdAt), "d MMM")}
                </option>
              ))}
            </Select>
          ) : null}
          {canEdit ? (
            <Button variant="accent" onClick={() => setWizard(true)} disabled={!p.ai.ready}>
              <Plus /> New strategy
            </Button>
          ) : null}
        </>
      }
    />
  );

  const wizardEl = <NewStrategyWizard open={wizard} onClose={() => setWizard(false)} brand={p.brand} brands={p.brands} preflight={p.preflight} onStarted={(d) => { setWizard(false); router.push(`/strategist?v=${d.strategyId}`); }} />;

  if (!s) {
    return (
      <div>
        {header}
        {p.legacy ? <Notice tone="info" className="mb-6">This is a legacy monthly strategy (from before the Marketing Strategist). It stays available to the dashboard and campaign agents. Create a new strategy to use research, personas, versioning and the 30-day calendar.</Notice> : null}
        {p.preflight.blocked ? <Notice tone="warn" className="mb-6">{p.preflight.blocked}</Notice> : null}
        <Empty icon={<Compass />} title="No marketing strategy yet" action={canEdit ? <Button variant="accent" onClick={() => setWizard(true)} disabled={!p.ai.ready}><Sparkles /> Build a strategy</Button> : undefined}>
          Seven specialist agents research your market, define personas, objectives, positioning and 4–8 content pillars, ideate campaigns and plan your next 30 days, all from your approved brand profile.
        </Empty>
        {wizardEl}
      </div>
    );
  }

  const doc = s.doc;
  const statusMeta = STATUS_META[s.status];
  const missing = SECTION_KEYS.filter((k) => !doc.sections[k]);

  return (
    <StrategyCtx.Provider value={ctx}>
      {header}

      {/* Status & actions */}
      <Card className="mb-5">
        <CardBody className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
            <Badge tone={statusMeta?.tone}>{statusMeta?.label}</Badge>
            <span>{accountTypeLabel(doc.inputs.accountType)}</span>
            <span>·</span>
            <span>Updated {formatDistanceToNow(new Date(s.updatedAt), { addSuffix: true })}</span>
            {s.approvedAt ? <span>· Approved {format(new Date(s.approvedAt), "d MMM yyyy")}{s.approvedByName ? ` by ${s.approvedByName}` : ""}</span> : null}
            {p.cost && p.cost.costUsd > 0 ? <span title={`${p.cost.inputTokens.toLocaleString()} input / ${p.cost.outputTokens.toLocaleString()} output tokens · ${p.cost.webSearches} web searches. An estimate from reported usage; the Anthropic Console is the billing record.`}>· AI cost ≈ {money(p.cost.costUsd)}</span> : null}
            {p.cost?.unknownUsageCalls ? (
              <span className="text-warn" title="Requests that may have reached the AI provider but whose response never arrived (connection lost, timeout or server restart). The provider may have billed them; their cost isn't in the estimate.">
                · +{p.cost.unknownUsageCalls} request{p.cost.unknownUsageCalls === 1 ? "" : "s"} with unknown usage
              </span>
            ) : null}
            {doc.profileRef ? <span>· Brand profile v{doc.profileRef.version}</span> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {s.status === "draft" && canEdit ? (
              <Button variant="secondary" disabled={working || s.blockers.length > 0} title={s.blockers.join(" ")} loading={busy("submit")} onClick={() => run(() => submitForReviewAction(p.brand.id, s.id, s.rev), { key: "submit", success: "Submitted for review" })}>
                <Send /> Submit for review
              </Button>
            ) : null}
            {s.status === "under_review" && canApprove ? (
              <Button variant="secondary" disabled={working} onClick={() => setRevise(true)}>
                <MessageSquareWarning /> Request revisions
              </Button>
            ) : null}
            {editableStatus && canApprove ? (
              <Button variant="accent" disabled={working || s.blockers.length > 0} title={s.blockers.join(" ")} loading={busy("approve")} onClick={() => run(() => approveStrategyV2Action(p.brand.id, s.id, s.rev), { key: "approve", success: "Strategy approved. Agents now build on it." })}>
                <Check /> Approve
              </Button>
            ) : null}
            {(s.status === "approved" || s.status === "archived") && canEdit ? (
              <Button variant={s.status === "approved" ? "secondary" : "accent"} loading={busy("ver")} onClick={() => run(() => newVersionAction(p.brand.id, s.id), { key: "ver", success: "New draft version created", onOk: (d) => router.push(`/strategist?v=${d.strategyId}`) })}>
                <Copy /> {s.status === "approved" ? "Revise as new version" : "Restore as new version"}
              </Button>
            ) : null}
            {s.status !== "archived" && canApprove ? (
              <Button variant="ghost" disabled={working} loading={busy("archive")} onClick={() => run(() => archiveStrategyAction(p.brand.id, s.id, s.rev), { key: "archive", success: "Archived" })}>
                <Archive /> Archive
              </Button>
            ) : null}
          </div>
        </CardBody>
        {s.status === "approved" ? <p className="border-t border-line px-5 py-2.5 text-[12px] text-muted">This approved strategy is locked so it can&apos;t be overwritten. To change it, revise it as a new version; this one stays active until the new version is approved.</p> : null}
        {s.status === "draft" && s.revisionNote ? (
          <div className="border-t border-line bg-warn-soft px-5 py-2.5 text-[12px] text-warn">
            <span className="font-semibold">Revisions requested: </span>
            {s.revisionNote} <span className="text-warn/80">(the agents also see this note when you regenerate sections)</span>
          </div>
        ) : null}
        {editableStatus && s.blockers.length && !working ? <p className="border-t border-line px-5 py-2.5 text-[12px] text-muted">Before approval: {s.blockers.join(" ")}</p> : null}
      </Card>

      {task && (working || task.status === "failed") ? <Progress task={task} canResume={canEdit && !working && missing.length > 0 && editableStatus} onResume={() => run(() => resumeAction(p.brand.id, s.id), { key: "resume", success: "Resuming", onOk: (d) => onTask(d.taskId) })} resuming={busy("resume")} /> : null}
      {!task && missing.length && editableStatus && canEdit ? (
        <Notice tone="info" className="mb-5 flex flex-wrap items-center justify-between gap-2">
          <span>{missing.length} section(s) haven&apos;t been generated yet.</span>
          <Button size="sm" variant="secondary" loading={busy("resume")} onClick={() => run(() => resumeAction(p.brand.id, s.id), { key: "resume", success: "Generating", onOk: (d) => onTask(d.taskId) })}>
            <Play /> Generate missing sections
          </Button>
        </Notice>
      ) : null}

      {/* Tabs: every panel stays mounted, so moving between sections never loses unsaved edits. */}
      <div className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-20 -mx-4 mb-5 border-b border-line bg-canvas/95 px-4 backdrop-blur sm:-mx-6 sm:px-6 md:top-0 md:-mx-10 md:px-10">
        <div className="scrollbar-thin flex gap-1 overflow-x-auto py-2" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn("shrink-0 rounded-lg px-3 py-1.5 text-[13px] font-medium transition", tab === t.id ? "bg-ink text-white" : "text-muted hover:bg-sunken hover:text-ink")}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <Panel on={tab === "overview"}>
        <Overview doc={doc} go={(k) => setTab(k)} working={working} />
      </Panel>
      <Panel on={tab === "strategy"}>
        <StrategyView env={doc.sections.strategy} accountType={accountTypeLabel(doc.inputs.accountType)} />
      </Panel>
      <Panel on={tab === "objectives"}>
        <ObjectivesView env={doc.sections.objectives} />
      </Panel>
      <Panel on={tab === "audience"}>
        <AudienceView env={doc.sections.audience} />
      </Panel>
      <Panel on={tab === "research"}>
        <ResearchView env={doc.sections.research} />
      </Panel>
      <Panel on={tab === "competitors"}>
        <CompetitorsView env={doc.sections.research} />
      </Panel>
      <Panel on={tab === "pillars"}>
        <PillarsView env={doc.sections.pillars} />
      </Panel>
      <Panel on={tab === "campaigns"}>
        <CampaignsView env={doc.sections.campaigns} platforms={doc.inputs.platforms} />
      </Panel>
      <Panel on={tab === "calendar"}>
        <CalendarView env={doc.sections.calendar} doc={doc} status={s.status} production={p.production} canProduce={canEdit && p.ai.ready && s.status === "approved"} />
      </Panel>
      <Panel on={tab === "kpis"}>
        <KpisView env={doc.sections.strategy} />
      </Panel>
      <Panel on={tab === "advisor"}>
        <Advisor brandId={p.brand.id} initial={p.chat} canClear={canEdit} onGo={(k) => setTab(TAB_FOR[k])} />
      </Panel>
      <Panel on={tab === "history"}>
        <HistoryView revisions={p.revisions} versions={p.versions} currentId={s.id} editable={Boolean(ctx?.canEdit)} />
      </Panel>

      <Modal open={revise} onClose={() => setRevise(false)} title="Request revisions">
        <div className="space-y-3 p-5">
          <p className="text-[13px] text-muted">The strategy goes back to draft with your note. The agents read it when sections are regenerated.</p>
          <Textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change?" maxLength={2000} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRevise(false)}>Cancel</Button>
            <Button variant="accent" disabled={!note.trim()} loading={busy("revise")} onClick={() => run(() => requestRevisionsAction(p.brand.id, s.id, note, s.rev), { key: "revise", success: "Sent back for revisions", onOk: () => { setRevise(false); setNote(""); } })}>
              Send back
            </Button>
          </div>
        </div>
      </Modal>
      {wizardEl}
    </StrategyCtx.Provider>
  );
}

function Panel({ on, children }: { on: boolean; children: React.ReactNode }) {
  return <div className={cn(!on && "hidden")} role="tabpanel">{children}</div>;
}

function Progress({ task, canResume, onResume, resuming }: { task: Task; canResume: boolean; onResume: () => void; resuming: boolean }) {
  const steps = task.steps.length ? task.steps : [{ id: "q", label: "Starting…", status: "running" as const }];
  const done = steps.filter((x) => x.status === "done").length;
  return (
    <Card className="mb-5 overflow-hidden" aria-live="polite">
      <div className="ai-gradient flex flex-wrap items-center justify-between gap-2 px-5 py-3">
        <p className="flex items-center gap-2 text-[13px] font-semibold">
          {task.status === "failed" ? <XCircle className="size-4 text-danger" /> : <Loader2 className="size-4 animate-spin" />}
          {task.status === "failed"
            ? "The strategist stopped"
            : task.recovering
              ? `Recovering after an interruption · ${done}/${steps.length} saved`
              : task.status === "queued" && (task.attempts ?? 0) > 0
                ? `Retrying automatically (attempt ${(task.attempts ?? 0) + 1} of ${task.maxAttempts ?? 3})`
                : `The strategist team is working · ${done}/${steps.length}`}
        </p>
        {task.costUsd > 0 ? <span className="text-[12px] text-ink-2/70">AI cost so far ≈ {money(task.costUsd)}</span> : null}
      </div>
      <CardBody className="space-y-3">
        <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((st) => (
            <li key={st.id} className="flex items-start gap-2 text-[12px]">
              {st.status === "done" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : st.status === "running" ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-accent" /> : st.status === "failed" ? <XCircle className="mt-0.5 size-4 shrink-0 text-danger" /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-faint" />}
              <span className={cn(st.status === "pending" || st.status === "skipped" ? "text-faint" : "text-ink-2")}>
                {st.label}
                {SECTION_META[st.id as SectionKey] ? <span className="block text-[11px] text-faint">{SECTION_META[st.id as SectionKey].agent}</span> : null}
              </span>
            </li>
          ))}
        </ol>
        {task.status === "failed" ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger">
            <span>{task.error}{task.error && /saved/i.test(task.error) ? "" : " Completed sections were saved."}</span>
            {canResume ? (
              <Button size="sm" variant="secondary" loading={resuming} onClick={onResume}>
                <Play /> Resume
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="text-[12px] text-muted">
            {task.recovering
              ? "The server restarted while the strategist was working. Finished sections are saved and the remaining ones are being picked up automatically; nothing is generated twice."
              : task.status === "queued" && (task.attempts ?? 0) > 0
                ? `${task.error ?? "A temporary AI service problem interrupted this run."} Next try ${task.runAfter ? `at ${new Date(task.runAfter).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "shortly"}.`
                : "You can keep reading finished sections or leave this page; progress is saved as each agent finishes, and the job continues even if the server restarts."}
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function Overview({ doc, go, working }: { doc: StrategyDoc; go: (t: TabId) => void; working: boolean }) {
  const st = doc.sections.strategy?.data;
  const pillars = doc.sections.pillars?.data.pillars ?? [];
  const personas = doc.sections.audience?.data.personas ?? [];
  const campaigns = doc.sections.campaigns?.data.campaigns ?? [];
  const cal = doc.sections.calendar?.data;
  const research = doc.sections.research?.data;
  const objectives = doc.sections.objectives?.data.marketingObjectives ?? [];
  const tiles = [
    { label: "Personas", value: personas.length, sub: `${personas.filter((x) => x.approved).length} approved`, tab: "audience" as TabId },
    { label: "Content pillars", value: pillars.length, sub: `${pillars.filter((x) => x.approved).length} approved`, tab: "pillars" as TabId },
    { label: "Campaigns", value: campaigns.length, sub: `${campaigns.filter((x) => x.approved).length} approved`, tab: "campaigns" as TabId },
    { label: "Planned posts", value: cal?.entries.length ?? 0, sub: cal ? `from ${format(new Date(`${cal.startDate}T00:00:00`), "d MMM")}` : "not planned", tab: "calendar" as TabId },
    { label: "Verified findings", value: research ? research.findings.filter((f) => f.verified).length : 0, sub: research ? `of ${research.findings.length} · ${research.mode === "web_search" ? "web research" : "no web research"}` : "—", tab: "research" as TabId },
  ];
  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <div className="ai-gradient p-6 md:p-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-2/70">Positioning</p>
          <p className="mt-2 max-w-3xl font-display text-[28px] leading-[1.15] md:text-[32px]">{st?.positioning.statement ?? (working ? "Generating…" : "Not generated yet")}</p>
          {st ? <p className="mt-3 max-w-3xl text-[14px] text-ink-2">{st.executiveSummary}</p> : null}
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {tiles.map((t) => (
          <button key={t.label} onClick={() => go(t.tab)} className="rounded-2xl border border-line bg-surface p-4 text-left shadow-card transition hover:border-line-strong">
            <p className="text-[12px] text-muted">{t.label}</p>
            <p className="mt-1 font-display text-[30px] leading-none tabular-nums">{t.value}</p>
            <p className="mt-1.5 text-[11px] text-faint">{t.sub}</p>
          </button>
        ))}
      </div>
      {research ? <ResearchMode r={research} /> : null}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Content mix" description="Share of content per pillar" />
          <CardBody>{pillars.length ? <PillarShare pillars={pillars} /> : <p className="text-[13px] text-muted">Not generated yet.</p>}</CardBody>
        </Card>
        <Card>
          <CardHeader title="Marketing objectives" />
          <CardBody>
            {objectives.length ? (
              <ul className="space-y-2.5">
                {objectives.map((o) => (
                  <li key={o.id} className="flex items-start justify-between gap-3 text-[13px]">
                    <span>{o.objective}<span className="block text-[11px] text-faint">{o.metric}</span></span>
                    <span className="shrink-0 text-right text-[12px] text-ink-2">{o.target}{o.targetBasis === "suggested" ? <span className="block text-[10px] text-warn">suggested</span> : null}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted">Not generated yet.</p>
            )}
          </CardBody>
        </Card>
      </div>
      {cal ? (
        <Card>
          <CardHeader title="Next 30 days" action={<button onClick={() => go("calendar")} className="text-[12px] font-medium text-accent">Open calendar →</button>} />
          <CardBody>
            <CalendarStats cal={cal} />
          </CardBody>
        </Card>
      ) : null}
      {campaigns.length ? (
        <div>
          <p className="mb-3 text-[13px] font-semibold">Campaigns</p>
          <div className="grid gap-3 md:grid-cols-3">
            {campaigns.slice(0, 3).map((c) => (
              <button key={c.id} onClick={() => go("campaigns")} className="rounded-2xl border border-line bg-surface p-4 text-left shadow-card transition hover:border-line-strong">
                <Badge tone="accent" className="capitalize">{c.kind}</Badge>
                <p className="mt-2 font-medium">{c.name}</p>
                <p className="mt-1 line-clamp-3 text-[12px] text-muted">{c.concept}</p>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <Card>
        <CardHeader title="What's in this strategy" description="The 13 parts and where to find them" />
        <CardBody className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {STRATEGY_PARTS.map((part) => (
            <button key={part.n} onClick={() => go(part.n === 12 ? "kpis" : TAB_FOR[part.section])} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-sunken">
              <span className="w-6 text-[11px] tabular-nums text-faint">{String(part.n).padStart(2, "0")}</span>
              <span className="flex-1">{part.label}</span>
              {doc.sections[part.section] ? <CheckCircle2 className="size-3.5 text-success" /> : <CircleDashed className="size-3.5 text-faint" />}
            </button>
          ))}
        </CardBody>
      </Card>
      {doc.assumptions.length ? (
        <Notice tone="info">
          <span className="font-medium">Assumptions you accepted: </span>
          {doc.assumptions.join(" ")}
        </Notice>
      ) : null}
    </div>
  );
}
