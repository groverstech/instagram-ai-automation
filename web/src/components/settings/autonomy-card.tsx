"use client";
import { useState } from "react";
import { Bot, ShieldCheck, ShieldAlert } from "lucide-react";
import { updateAutonomyAction } from "@/app/actions/autonomy";
import { Badge, Button, Card, CardBody, CardHeader, Field, Input, Notice, Select } from "@/components/ui";
import { useRun } from "@/components/hooks";
import type { Rules } from "@/server/autonomy/policy";

type Level = "advisor" | "assisted" | "autonomous";
export type AutonomyView = {
  level: Level;
  effective: Level;
  platformAllowsAutonomous: boolean;
  planMax: Level | null;
  suspended: { at: string; reason: string } | null;
  paused: boolean;
  aiStopped: boolean;
  rules: Rules;
  rulesVersion: number;
  accounts: { id: string; platform: string; name: string; handle: string | null; level: Level | null; effective: Level }[];
  recent: { id: string; at: string; action: string; decision: string; level: string; actorType: string; reasons: string[]; postId: string | null; policyVersion: number }[];
};

const LEVELS: { id: Level; title: string; text: string }[] = [
  { id: "advisor", title: "Advisor", text: "The AI analyses and suggests. It doesn't add posts to the calendar and never publishes. People create, approve and publish." },
  { id: "assisted", title: "Assisted", text: "The AI plans and creates drafts. A person approves every post before it's scheduled or published." },
  { id: "autonomous", title: "Autonomous", text: "The AI may schedule and publish its own posts, only within the rules below. Restricted content always waits for a person." },
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const label = (l: string) => LEVELS.find((x) => x.id === l)?.title ?? l;

/**
 * Settings → Autonomy (docs/AUTONOMY.md). Owners change it (with a fresh second factor); admins see
 * it and the decision log. Autonomous is unavailable while the platform switch is off.
 */
export function AutonomyCard({ brandId, brandName, view, canEdit }: { brandId: string; brandName: string; view: AutonomyView; canEdit: boolean }) {
  const { run, busy } = useRun();
  const [level, setLevel] = useState<Level>(view.level);
  const [r, setR] = useState(view.rules);
  const [pillars, setPillars] = useState(view.rules.allowedPillars.join(", "));
  const [banned, setBanned] = useState(view.rules.bannedTopics.join(", "));
  const [domains, setDomains] = useState(view.rules.linkDomains.join(", "));
  const [accounts, setAccounts] = useState(Object.fromEntries(view.accounts.map((a) => [a.id, a.level])) as Record<string, Level | null>);
  const autonomousBlocked = !view.platformAllowsAutonomous || (view.planMax !== null && view.planMax !== "autonomous");
  const num = (k: keyof Rules) => (e: React.ChangeEvent<HTMLInputElement>) => setR({ ...r, [k]: Math.max(0, Math.round(Number(e.target.value) || 0)) });
  const toggle = (k: "allowedDays" | "allowedHours", v: number) => setR({ ...r, [k]: r[k].includes(v) ? r[k].filter((x) => x !== v) : [...r[k], v].sort((a, b) => a - b) });

  return (
    <Card aria-label="Autonomy">
      <CardHeader
        title={<span className="inline-flex items-center gap-2"><Bot className="size-4" /> Autonomy · {brandName}</span>}
        description="How much the AI may do on its own for this brand. The emergency pause always wins."
        action={<Badge tone={view.effective === "autonomous" ? "warn" : "accent"}>In effect: {label(view.effective)}</Badge>}
      />
      <CardBody className="space-y-4 text-[13px]">
        {view.paused ? <Notice tone="warn">Publishing is paused for this brand: nothing is published at any level until an admin resumes it.</Notice> : null}
        {view.aiStopped ? <Notice tone="warn">AI is stopped by the platform operator: the AI creates and approves nothing until it&apos;s resumed.</Notice> : null}
        {view.suspended ? (
          <Notice tone="danger">
            <span className="flex gap-2"><ShieldAlert className="mt-0.5 size-4 shrink-0" />Autonomous was suspended automatically on {new Date(view.suspended.at).toLocaleString()}: {view.suspended.reason}. The brand works as Assisted until an owner chooses the level again.</span>
          </Notice>
        ) : null}

        <fieldset className="grid gap-2" disabled={!canEdit}>
          <legend className="sr-only">Autonomy level</legend>
          {LEVELS.map((l) => {
            const off = l.id === "autonomous" && autonomousBlocked;
            return (
              <label key={l.id} className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${level === l.id ? "border-accent bg-accent-soft/40" : "border-line"} ${off ? "cursor-not-allowed opacity-60" : ""}`}>
                <input type="radio" name="autonomy-level" value={l.id} checked={level === l.id} disabled={off || !canEdit} onChange={() => setLevel(l.id)} className="mt-1" />
                <span>
                  <span className="font-medium">{l.title}</span>
                  {l.id === "assisted" ? <span className="ml-2 text-[11px] text-faint">default</span> : null}
                  <span className="block text-muted">{l.text}</span>
                  {off ? <span className="mt-1 block text-[12px] text-warn">{!view.platformAllowsAutonomous ? "Not available during the private beta: the platform owner hasn't enabled autonomous publishing." : "Not included in your plan."}</span> : null}
                </span>
              </label>
            );
          })}
        </fieldset>

        <details className="rounded-xl border border-line p-3">
          <summary className="cursor-pointer font-medium">Rules for autonomous posts (version {view.rulesVersion})</summary>
          <p className="mt-2 text-[12px] text-muted">Checked when the AI would schedule a post and again immediately before it&apos;s published. Prices and promotions, giveaways, health or legal claims, competitor mentions, sensitive topics, banned topics and links outside the allowed domains always need a person.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Max per account per day"><Input type="number" min={0} max={10} value={r.maxPerDay} onChange={num("maxPerDay")} disabled={!canEdit} /></Field>
            <Field label="Max per account per week"><Input type="number" min={0} max={50} value={r.maxPerWeek} onChange={num("maxPerWeek")} disabled={!canEdit} /></Field>
            <Field label="Minimum hours between posts"><Input type="number" min={0} max={168} value={r.minGapHours} onChange={num("minGapHours")} disabled={!canEdit} /></Field>
            <Field label="Warm-up: first posts per account a person approves"><Input type="number" min={0} max={50} value={r.warmup} onChange={num("warmup")} disabled={!canEdit} /></Field>
          </div>
          <div className="mt-3">
            <p className="mb-1 text-[12px] font-medium">Days</p>
            <div className="flex flex-wrap gap-1">
              {DAYS.map((d, i) => (
                <button key={d} type="button" disabled={!canEdit} aria-pressed={r.allowedDays.includes(i)} onClick={() => toggle("allowedDays", i)} className={`rounded-md border px-2 py-1 text-[12px] ${r.allowedDays.includes(i) ? "border-accent bg-accent-soft" : "border-line"}`}>{d}</button>
              ))}
            </div>
          </div>
          <div className="mt-3">
            <p className="mb-1 text-[12px] font-medium">Hours (UTC)</p>
            <div className="flex flex-wrap gap-1">
              {Array.from({ length: 24 }, (_, h) => (
                <button key={h} type="button" disabled={!canEdit} aria-pressed={r.allowedHours.includes(h)} aria-label={`${h}:00 UTC`} onClick={() => toggle("allowedHours", h)} className={`w-9 rounded-md border py-1 text-[11px] tabular-nums ${r.allowedHours.includes(h) ? "border-accent bg-accent-soft" : "border-line"}`}>{h}</button>
              ))}
            </div>
          </div>
          <div className="mt-3 grid gap-3">
            <Field label="Allowed pillars (comma-separated; empty = any)"><Input value={pillars} onChange={(e) => setPillars(e.target.value)} disabled={!canEdit} /></Field>
            <Field label="Banned topics (comma-separated; always need a person)"><Input value={banned} onChange={(e) => setBanned(e.target.value)} disabled={!canEdit} /></Field>
            <Field label="Allowed link domains (comma-separated)"><Input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com" disabled={!canEdit} /></Field>
          </div>
        </details>

        {view.accounts.length ? (
          <div>
            <p className="mb-1 text-[12px] font-medium">Per account (can be lower than the brand, never higher)</p>
            <ul className="divide-y divide-line">
              {view.accounts.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0 truncate">{a.name}{a.handle ? ` · @${a.handle}` : ""} <span className="text-[11px] text-faint">({a.platform}; in effect: {label(a.effective)})</span></span>
                  <Select aria-label={`Autonomy for ${a.name}`} className="h-8 w-40 text-[12px]" value={accounts[a.id] ?? ""} disabled={!canEdit} onChange={(e) => setAccounts({ ...accounts, [a.id]: (e.target.value || null) as Level | null })}>
                    <option value="">Follow the brand</option>
                    <option value="advisor">Advisor</option>
                    <option value="assisted">Assisted</option>
                    <option value="autonomous" disabled={autonomousBlocked}>Autonomous</option>
                  </Select>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {canEdit ? (
          <Button
            loading={busy("autonomy")}
            onClick={() =>
              run(
                () =>
                  updateAutonomyAction(brandId, {
                    level,
                    rules: { ...r, allowedPillars: list(pillars), bannedTopics: list(banned), linkDomains: list(domains).map((d) => d.toLowerCase()) },
                    accounts: Object.entries(accounts).map(([id, l]) => ({ id, level: l })),
                  }),
                { key: "autonomy", success: "Autonomy saved" },
              )
            }
          >
            <ShieldCheck /> Save autonomy
          </Button>
        ) : (
          <p className="text-[12px] text-faint">Only organisation owners can change autonomy.</p>
        )}

        <details className="rounded-xl border border-line p-3">
          <summary className="cursor-pointer font-medium">Decision log ({view.recent.length})</summary>
          {view.recent.length ? (
            <ol className="mt-2 space-y-2 text-[12px]">
              {view.recent.map((e) => (
                <li key={e.id}>
                  <span className="font-medium">{new Date(e.at).toLocaleString()}</span> · {e.actorType === "user" ? "Owner" : e.actorType === "system" ? "Safeguard" : "AI"} · {e.action.replace("_", " ")} → <span className="font-medium">{e.decision.replace("_", " ")}</span> ({label(e.level)}, rules v{e.policyVersion})
                  {e.reasons.length ? <span className="block text-muted">{e.reasons.join("; ")}</span> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-[12px] text-muted">No decisions yet.</p>
          )}
        </details>
      </CardBody>
    </Card>
  );
}
