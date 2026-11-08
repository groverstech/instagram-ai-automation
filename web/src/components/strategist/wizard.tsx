"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { addDays, format } from "date-fns";
import { ArrowLeft, ArrowRight, Check, Sparkles } from "lucide-react";
import { startStrategyAction } from "@/app/actions/strategist";
import { switchBrand } from "@/app/actions/brand";
import { Badge, Button, Field, Input, Modal, Notice, Select, Textarea } from "@/components/ui";
import { useRun } from "@/components/hooks";
import { PLATFORMS } from "@/lib/domain";
import { ACCOUNT_TYPES, CAMPAIGN_KINDS, accountTypeLabel, type StrategyInputs } from "@/lib/strategy";
import { cn } from "@/lib/utils";

export type PreflightProps = {
  profile: { id: string; version: number } | null;
  newerDraft: { id: string; version: number } | null;
  blocked: string | null;
  questions: { id: string; question: string; why: string; critical: boolean; assumption: string; prefill?: string }[];
  defaults: { accountType: StrategyInputs["accountType"]; businessObjectives: string[]; marketingGoals: string; platforms: string[] };
  workspaceType: string;
};

const STEPS = ["Brand", "Brand profile", "Objectives", "Missing info", "Review"] as const;
const KIND_LABEL: Record<string, string> = { seasonal: "Seasonal", launch: "Launch", promotional: "Promotional", awareness: "Awareness", engagement: "Engagement", evergreen: "Evergreen" };

type Draft = {
  accountType: StrategyInputs["accountType"];
  objectives: string;
  marketingGoals: string;
  platforms: string[];
  startDate: string;
  postsPerWeek: number;
  campaignKinds: string[];
  keyDates: string;
  focus: string;
  budget: string;
  answers: Record<string, string>;
  assumeFor: string[];
};

export function NewStrategyWizard({ open, onClose, brand, brands, preflight, onStarted }: { open: boolean; onClose: () => void; brand: { id: string; name: string }; brands: { id: string; name: string }[]; preflight: PreflightProps; onStarted: (d: { strategyId: string; taskId: string }) => void }) {
  const storeKey = `bp-strategy-wizard:${brand.id}`;
  const initial = (): Draft => ({
    accountType: preflight.defaults.accountType,
    objectives: preflight.defaults.businessObjectives.join("\n"),
    marketingGoals: preflight.defaults.marketingGoals,
    platforms: preflight.defaults.platforms,
    startDate: format(addDays(new Date(), 1), "yyyy-MM-dd"),
    postsPerWeek: 5,
    campaignKinds: ["seasonal", "awareness"],
    keyDates: "",
    focus: "",
    budget: "",
    answers: Object.fromEntries(preflight.questions.filter((q) => q.prefill).map((q) => [q.id, q.prefill!])),
    assumeFor: [],
  });
  const [d, setD] = useState<Draft>(initial);
  const [step, setStep] = useState(0);
  const router = useRouter();
  const { run, busy } = useRun();

  // Keep the draft across navigation and reloads (per brand, this browser tab only).
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storeKey);
      if (saved) setD({ ...initial(), ...JSON.parse(saved) });
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeKey]);
  useEffect(() => {
    try {
      sessionStorage.setItem(storeKey, JSON.stringify(d));
    } catch {}
  }, [d, storeKey]);

  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const objectives = d.objectives.split("\n").map((s) => s.trim()).filter(Boolean);
  const unanswered = preflight.questions.filter((q) => q.critical && !d.answers[q.id]?.trim() && !d.assumeFor.includes(q.id));
  const canNext = [true, !preflight.blocked, objectives.length > 0 && d.platforms.length > 0 && Boolean(d.startDate), unanswered.length === 0, true][step];

  const submit = () =>
    run(
      () =>
        startStrategyAction(brand.id, {
          accountType: d.accountType,
          businessObjectives: objectives,
          marketingGoals: d.marketingGoals,
          platforms: d.platforms,
          startDate: d.startDate,
          postsPerWeek: d.postsPerWeek,
          campaignKinds: d.campaignKinds,
          keyDates: d.keyDates,
          focus: d.focus,
          budget: d.budget,
          answers: d.answers,
          assumeFor: d.assumeFor,
        }),
      {
        key: "start",
        success: "The strategist team is on it. You can watch progress here.",
        onOk: (r) => {
          try {
            sessionStorage.removeItem(storeKey);
          } catch {}
          onStarted(r);
        },
      },
    );

  return (
    <Modal open={open} onClose={onClose} title="New marketing strategy" wide>
      <div className="border-b border-line px-5 py-3">
        <ol className="flex gap-1 overflow-x-auto text-[12px]">
          {STEPS.map((s, i) => (
            <li key={s} className={cn("flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1", i === step ? "bg-ink text-white" : i < step ? "text-ink-2" : "text-faint")}>
              <span className={cn("grid size-4 place-items-center rounded-full text-[10px]", i < step ? "bg-success text-white" : "border border-current")}>{i < step ? <Check className="size-2.5" /> : i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
      </div>

      <div className="min-h-[340px] space-y-4 p-5">
        {step === 0 ? (
          <>
            <p className="text-[13px] text-muted">The strategy is built for one brand and stays inside its workspace. Agencies: switch client here.</p>
            <Field label="Brand">
              <Select
                aria-label="Brand"
                value={brand.id}
                onChange={(e) =>
                  run(async () => {
                    await switchBrand(e.target.value);
                    router.refresh();
                    return { ok: true as const, data: undefined };
                  })
                }
              >
                {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </Field>
            <Field label="Account type" hint={`Workspace type: ${preflight.workspaceType}`}>
              <Select aria-label="Account type" value={d.accountType} onChange={(e) => set({ accountType: e.target.value as Draft["accountType"] })}>
                {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{accountTypeLabel(t)}</option>)}
              </Select>
            </Field>
            <p className="text-[12px] text-faint">The strategy adapts to the account type: a creator&apos;s plan prioritises community and partnerships; an agency plan adds client-facing rationale and reporting.</p>
          </>
        ) : null}

        {step === 1 ? (
          preflight.blocked ? (
            <Notice tone="warn">
              {preflight.blocked}{" "}
              <Link href="/brand" className="font-medium underline">
                Open My Brand →
              </Link>
            </Notice>
          ) : (
            <div className="space-y-3">
              <Notice tone="success">The strategist will build on your approved Brand Intelligence Profile (v{preflight.profile?.version}), your brand instructions, approved assets and brand memory.</Notice>
              {preflight.newerDraft ? <Notice tone="info">A newer draft (v{preflight.newerDraft.version}) exists but isn&apos;t approved, so it won&apos;t be used. Approve it in My Brand if it&apos;s better.</Notice> : null}
            </div>
          )
        ) : null}

        {step === 2 ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Business objectives" hint="one per line" className="md:col-span-2">
              <Textarea rows={3} value={d.objectives} onChange={(e) => set({ objectives: e.target.value })} placeholder={"Grow online sales\nOpen a second studio"} />
            </Field>
            <Field label="Marketing goals & targets" hint="numbers help" className="md:col-span-2">
              <Textarea rows={2} value={d.marketingGoals} onChange={(e) => set({ marketingGoals: e.target.value })} placeholder="e.g. 300 newsletter sign-ups and +15% website visits from social by March" />
            </Field>
            <div className="md:col-span-2">
              <p className="mb-1.5 text-[12px] font-medium text-ink-2">Platforms</p>
              <div className="flex flex-wrap gap-1.5">
                {PLATFORMS.map((p) => {
                  const on = d.platforms.includes(p.id);
                  return (
                    <button key={p.id} type="button" aria-pressed={on} onClick={() => set({ platforms: on ? d.platforms.filter((x) => x !== p.id) : [...d.platforms, p.id] })} className={cn("rounded-full border px-3 py-1.5 text-[12px]", on ? "border-ink bg-ink text-white" : "border-line text-ink-2")}>
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <Field label="Calendar starts">
              <Input type="date" value={d.startDate} onChange={(e) => set({ startDate: e.target.value })} />
            </Field>
            <Field label="Posts per week (all platforms)">
              <Input type="number" min={1} max={28} value={d.postsPerWeek} onChange={(e) => set({ postsPerWeek: Math.max(1, Math.min(28, Number(e.target.value) || 1)) })} />
            </Field>
            <div className="md:col-span-2">
              <p className="mb-1.5 text-[12px] font-medium text-ink-2">Campaign types to consider</p>
              <div className="flex flex-wrap gap-1.5">
                {CAMPAIGN_KINDS.map((k) => {
                  const on = d.campaignKinds.includes(k);
                  return (
                    <button key={k} type="button" aria-pressed={on} onClick={() => set({ campaignKinds: on ? d.campaignKinds.filter((x) => x !== k) : [...d.campaignKinds, k] })} className={cn("rounded-full border px-3 py-1.5 text-[12px]", on ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-2")}>
                      {KIND_LABEL[k]}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="space-y-4">
            <p className="text-[13px] text-muted">Answer what you can. For anything else, let the AI assume: assumptions are listed in the strategy so nothing is presented as fact.</p>
            {preflight.questions.map((q) => (
              <div key={q.id} className="rounded-xl border border-line p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[13px] font-medium">{q.question}</p>
                  {q.critical ? <Badge tone="warn">Needed</Badge> : <Badge>Optional</Badge>}
                </div>
                <p className="mt-0.5 text-[12px] text-faint">{q.why}</p>
                <Textarea rows={2} className="mt-2" value={d.answers[q.id] ?? ""} disabled={d.assumeFor.includes(q.id)} onChange={(e) => set({ answers: { ...d.answers, [q.id]: e.target.value } })} />
                <label className="mt-2 flex items-start gap-2 text-[12px] text-ink-2">
                  <input type="checkbox" className="mt-0.5" checked={d.assumeFor.includes(q.id)} onChange={(e) => set({ assumeFor: e.target.checked ? [...d.assumeFor, q.id] : d.assumeFor.filter((x) => x !== q.id) })} />
                  <span>
                    Let the AI assume <span className="text-faint">· {q.assumption}</span>
                  </span>
                </label>
              </div>
            ))}
            <Field label="Key dates, launches or events" hint="optional">
              <Textarea rows={2} value={d.keyDates} onChange={(e) => set({ keyDates: e.target.value })} placeholder="e.g. Winter glaze launch on 18 Jan; studio closed 1–3 Feb" />
            </Field>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Focus for this strategy" hint="optional">
                <Input value={d.focus} onChange={(e) => set({ focus: e.target.value })} placeholder="e.g. grow workshop bookings" />
              </Field>
              <Field label="Budget & resources" hint="optional">
                <Input value={d.budget} onChange={(e) => set({ budget: e.target.value })} placeholder="e.g. 1 person, no paid ads" />
              </Field>
            </div>
          </div>
        ) : null}

        {step === 4 ? (
          <div className="space-y-3 text-[13px]">
            <Row k="Brand" v={brand.name} />
            <Row k="Account type" v={accountTypeLabel(d.accountType)} />
            <Row k="Objectives" v={objectives.join(" · ")} />
            <Row k="Platforms" v={d.platforms.map((p) => PLATFORMS.find((x) => x.id === p)?.label ?? p).join(", ")} />
            <Row k="Calendar" v={`30 days from ${d.startDate}, ~${d.postsPerWeek} posts/week`} />
            {d.assumeFor.length ? <Row k="Assumptions" v={preflight.questions.filter((q) => d.assumeFor.includes(q.id)).map((q) => q.assumption).join(" ")} /> : null}
            <Notice tone="info">
              Seven specialist agents run in sequence: market research → audience → objectives → strategy → pillars → campaigns → 30-day calendar. This takes a few minutes; you can leave this page and come back. Nothing is published.
            </Notice>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-4">
        <Button variant="ghost" onClick={() => (step ? setStep(step - 1) : onClose())}>
          <ArrowLeft /> {step ? "Back" : "Cancel"}
        </Button>
        {step < STEPS.length - 1 ? (
          <Button onClick={() => setStep(step + 1)} disabled={!canNext}>
            Continue <ArrowRight />
          </Button>
        ) : (
          <Button variant="accent" loading={busy("start")} onClick={submit}>
            <Sparkles /> Generate strategy
          </Button>
        )}
      </div>
    </Modal>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 border-b border-line pb-2.5">
      <span className="text-faint">{k}</span>
      <span>{v || "—"}</span>
    </div>
  );
}
