"use client";
import { createContext, useContext, useState } from "react";
import { AlertTriangle, Pencil, RefreshCw, X } from "lucide-react";
import { regenerateSectionAction } from "@/app/actions/strategist";
import { Badge, Button, Card, CardBody, Input, Textarea } from "@/components/ui";
import { useRun } from "@/components/hooks";
import { SECTION_META, type Envelope, type SectionKey } from "@/lib/strategy";
import { cn } from "@/lib/utils";

export type Ctx = {
  brandId: string;
  strategyId: string;
  rev: number;
  canEdit: boolean;
  canApprove: boolean;
  /** AI generation is possible (editor+, editable status, nothing running, AI configured). */
  canGenerate: boolean;
  onTask: (taskId: string) => void;
};
export const StrategyCtx = createContext<Ctx | null>(null);
export const useCtx = () => {
  const c = useContext(StrategyCtx);
  if (!c) throw new Error("StrategyCtx missing");
  return c;
};

/** Edit a list of short strings as one-per-line text. */
export function Lines({ value, onChange, rows = 3, placeholder }: { value: string[]; onChange: (v: string[]) => void; rows?: number; placeholder?: string }) {
  const [text, setText] = useState(value.join("\n"));
  return (
    <Textarea
      rows={rows}
      value={text}
      placeholder={placeholder ?? "One per line"}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.split("\n").map((s) => s.trim()).filter(Boolean));
      }}
    />
  );
}

export function TextField({ label, value, onChange, area, rows }: { label: string; value: string; onChange: (v: string) => void; area?: boolean; rows?: number }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-ink-2">{label}</span>
      {area ? <Textarea rows={rows ?? 3} value={value} onChange={(e) => onChange(e.target.value)} /> : <Input value={value} onChange={(e) => onChange(e.target.value)} />}
    </label>
  );
}

export function ListField({ label, value, onChange, rows }: { label: string; value: string[]; onChange: (v: string[]) => void; rows?: number }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-ink-2">
        {label} <span className="font-normal text-faint">· one per line</span>
      </span>
      <Lines value={value} onChange={onChange} rows={rows} />
    </label>
  );
}

export function Bullets({ items, empty = "—" }: { items: string[]; empty?: string }) {
  if (!items.length) return <p className="text-[13px] text-faint">{empty}</p>;
  return (
    <ul className="space-y-1 text-[13px] text-ink-2">
      {items.map((x, i) => (
        <li key={i} className="flex gap-2">
          <span className="mt-[7px] size-1 shrink-0 rounded-full bg-faint" />
          <span>{x}</span>
        </li>
      ))}
    </ul>
  );
}

export function Kicker({ children }: { children: React.ReactNode }) {
  return <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">{children}</p>;
}

export function OriginBadge({ env }: { env: Envelope<unknown> }) {
  const mock = env.provider === "mock";
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {env.origin === "ai" ? <Badge tone="accent">AI generated</Badge> : env.origin === "mixed" ? <Badge tone="info">AI + your edits</Badge> : <Badge tone="info">Written by you</Badge>}
      {mock ? <Badge tone="warn">Demo AI output</Badge> : null}
    </span>
  );
}

/**
 * Frame for every strategy section: origin, staleness, and per-section Edit / Regenerate.
 * `editor` renders the edit form; it receives a close callback.
 */
export function SectionFrame({
  section,
  env,
  title,
  description,
  children,
  editor,
  extra,
}: {
  section: SectionKey;
  env: Envelope<unknown> | undefined;
  title?: string;
  description?: string;
  children: React.ReactNode;
  editor?: (close: () => void) => React.ReactNode;
  extra?: React.ReactNode;
}) {
  const ctx = useCtx();
  const [editing, setEditing] = useState(false);
  const [regen, setRegen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const { run, busy } = useRun();
  const label = title ?? SECTION_META[section].label;
  const regenerate = () =>
    run(() => regenerateSectionAction(ctx.brandId, ctx.strategyId, section, instruction), {
      key: "regen",
      success: `${SECTION_META[section].agent} is regenerating ${label.toLowerCase()}`,
      onOk: (d) => {
        setRegen(false);
        setInstruction("");
        ctx.onTask(d.taskId);
      },
    });

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-[16px] font-semibold">{label}</h2>
          {description ? <p className="mt-0.5 text-[13px] text-muted">{description}</p> : null}
          {env ? (
            <div className="mt-2">
              <OriginBadge env={env} />
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {extra}
          {env && editor && ctx.canEdit && !editing ? (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              <Pencil /> Edit
            </Button>
          ) : null}
          {ctx.canGenerate && !editing ? (
            <Button size="sm" variant="ai" onClick={() => setRegen((x) => !x)}>
              <RefreshCw /> {env ? "Regenerate" : "Generate"}
            </Button>
          ) : null}
        </div>
      </div>
      {regen ? (
        <div className="flex flex-col gap-2 border-b border-line bg-sunken/50 px-5 py-3 sm:flex-row sm:items-center">
          <Input value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Optional direction, e.g. “more focus on gifting”" className="flex-1" maxLength={1000} />
          <div className="flex gap-2">
            <Button size="sm" variant="accent" loading={busy("regen")} onClick={regenerate}>
              {env ? "Regenerate this section" : "Generate"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRegen(false)} aria-label="Cancel">
              <X />
            </Button>
          </div>
        </div>
      ) : null}
      {env?.stale ? (
        <div className="flex items-start gap-2 border-b border-line bg-warn-soft px-5 py-2.5 text-[12px] text-warn">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          An earlier section changed after this was generated. Review it, or regenerate it to bring it in line.
        </div>
      ) : null}
      <CardBody className={cn(editing && "bg-sunken/30")}>{env ? (editing && editor ? editor(() => setEditing(false)) : children) : <p className="text-[13px] text-muted">Not generated yet.</p>}</CardBody>
    </Card>
  );
}

export function SaveBar({ onSave, onCancel, loading, note }: { onSave: () => void; onCancel: () => void; loading?: boolean; note?: string }) {
  return (
    <div className="sticky bottom-20 z-10 mt-5 flex flex-wrap items-center justify-end gap-2 rounded-xl border border-line bg-surface/95 p-2.5 shadow-card backdrop-blur md:bottom-4">
      {note ? <p className="mr-auto px-1 text-[12px] text-muted">{note}</p> : null}
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button variant="accent" loading={loading} onClick={onSave}>
        Save changes
      </Button>
    </div>
  );
}

export function Pill({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-2", className)}>{children}</span>;
}
