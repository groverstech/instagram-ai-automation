"use client";
import { useState, useTransition } from "react";
import { format } from "date-fns";
import { Bot, GitCompare, History, RotateCcw, User } from "lucide-react";
import { compareAction, restoreRevisionAction } from "@/app/actions/strategist";
import { Badge, Button, Card, CardBody, CardHeader, Select } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useRun } from "@/components/hooks";
import { SECTION_META, STATUS_META, type SectionDiff, type SectionKey } from "@/lib/strategy";
import { useCtx } from "./kit";

export type Revision = { id: string; rev: number; source: string; action: string; sections: string[]; note: string | null; actorName: string | null; createdAt: Date };
export type VersionRow = { id: string; version: number; title: string | null; status: string; legacy: boolean; createdAt: Date };

const SOURCE: Record<string, { label: string; icon: React.ReactNode; tone: string }> = {
  ai: { label: "AI", icon: <Bot />, tone: "accent" },
  user: { label: "Edit", icon: <User />, tone: "info" },
  restore: { label: "Restore", icon: <RotateCcw />, tone: "warn" },
  status: { label: "Status", icon: <History />, tone: "neutral" },
};

export function HistoryView({ revisions, versions, currentId, editable }: { revisions: Revision[]; versions: VersionRow[]; currentId: string; editable: boolean }) {
  const ctx = useCtx();
  const { run, busy } = useRun();
  const [a, setA] = useState<string>(revisions.find((r) => r.rev === 1) ? `r:${revisions.find((r) => r.rev === 1)!.id}` : "");
  const [b, setB] = useState<string>("current");
  const [diff, setDiff] = useState<SectionDiff[] | null>(null);
  const [pending, start] = useTransition();
  const v2 = versions.filter((v) => !v.legacy);
  const ref = (x: string) => (x === "current" ? { strategyId: currentId } : x.startsWith("r:") ? { strategyId: currentId, revisionId: x.slice(2) } : { strategyId: x.slice(2) });
  const options = (
    <>
      <option value="current">This version (latest)</option>
      <optgroup label="Earlier revisions of this version">
        {revisions.map((r) => (
          <option key={r.id} value={`r:${r.id}`}>
            Revision {r.rev} · {r.action}
          </option>
        ))}
      </optgroup>
      <optgroup label="Other versions">
        {v2.filter((v) => v.id !== currentId).map((v) => (
          <option key={v.id} value={`v:${v.id}`}>
            v{v.version} · {STATUS_META[v.status]?.label}
          </option>
        ))}
      </optgroup>
    </>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
      <Card>
        <CardHeader title="Change history" description="Every AI generation, edit, status change and restore, newest first." />
        <CardBody>
          <ol className="space-y-3">
            {revisions.map((r) => {
              const s = SOURCE[r.source] ?? SOURCE.status;
              return (
                <li key={r.id} className="flex gap-3">
                  <div className="pt-0.5"><Badge tone={s.tone}>{s.icon} {s.label}</Badge></div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium">{r.action}</p>
                    <p className="text-[11px] text-faint">
                      Revision {r.rev} · {format(new Date(r.createdAt), "d MMM yyyy, HH:mm")} · {r.source === "ai" ? `AI on behalf of ${r.actorName ?? "a teammate"}` : (r.actorName ?? "Unknown")}
                      {r.sections.length && r.sections.length < 7 ? ` · ${r.sections.map((x) => SECTION_META[x as SectionKey]?.label ?? x).join(", ")}` : ""}
                    </p>
                    {r.note ? <p className="mt-1 rounded-lg bg-sunken/70 px-2.5 py-1.5 text-[12px] text-ink-2">{r.note}</p> : null}
                  </div>
                  {editable && r.rev !== revisions[0]?.rev ? (
                    <Button size="sm" variant="ghost" loading={busy(r.id)} onClick={() => run(() => restoreRevisionAction(ctx.brandId, ctx.strategyId, r.id, ctx.rev), { key: r.id, success: `Restored revision ${r.rev}` })}>
                      <RotateCcw /> Restore
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Compare" description="See exactly what changed between two revisions or versions." action={<GitCompare className="size-4 text-faint" />} />
        <CardBody className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Select value={a} onChange={(e) => setA(e.target.value)} aria-label="Compare from">
              <option value="">Choose…</option>
              {options}
            </Select>
            <Select value={b} onChange={(e) => setB(e.target.value)} aria-label="Compare to">
              {options}
            </Select>
          </div>
          <Button
            variant="secondary"
            disabled={!a || a === b || pending}
            onClick={() =>
              start(async () => {
                const r = await compareAction(ctx.brandId, ref(a), ref(b));
                if (r.ok) setDiff(r.data);
                else toast(r.error, "error");
              })
            }
          >
            <GitCompare /> Compare
          </Button>
          {diff ? (
            <div className="space-y-3">
              {diff.filter((d) => d.status !== "same").length === 0 ? <p className="text-[13px] text-muted">No differences.</p> : null}
              {diff
                .filter((d) => d.status !== "same")
                .map((d) => (
                  <details key={d.section} className="rounded-xl border border-line p-3" open>
                    <summary className="cursor-pointer text-[13px] font-medium">
                      {SECTION_META[d.section].label} <Badge className="ml-1">{d.status === "changed" ? `${d.changes.length} change${d.changes.length === 1 ? "" : "s"}` : d.status}</Badge>
                    </summary>
                    <div className="mt-2 space-y-2">
                      {d.changes.slice(0, 40).map((c) => (
                        <div key={c.path} className="text-[12px]">
                          <p className="font-mono text-[11px] text-faint">{c.path}</p>
                          {c.before ? <p className="rounded bg-danger-soft/60 px-2 py-1 text-danger line-through decoration-danger/40">{c.before}</p> : null}
                          {c.after ? <p className="mt-0.5 rounded bg-success-soft/60 px-2 py-1 text-success">{c.after}</p> : null}
                        </div>
                      ))}
                      {d.changes.length > 40 ? <p className="text-[11px] text-faint">…and {d.changes.length - 40} more</p> : null}
                    </div>
                  </details>
                ))}
            </div>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
