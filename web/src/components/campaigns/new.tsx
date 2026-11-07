"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { format } from "date-fns";
import { Plus, Sparkles } from "lucide-react";
import { createCampaignAction } from "@/app/actions/ai";
import { Button, Field, Input, Modal, Select, Textarea } from "@/components/ui";
import { useRun } from "@/components/hooks";
import { CAMPAIGN_TYPES, OBJECTIVES, PLATFORMS, STYLES, objectiveLabel } from "@/lib/domain";
import { cn } from "@/lib/utils";

export function NewCampaign({ brandId, platforms }: { brandId: string; platforms: string[] }) {
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState("");
  const [type, setType] = useState("launch");
  const [objective, setObjective] = useState("awareness");
  const [start, setStart] = useState(format(new Date(Date.now() + 864e5), "yyyy-MM-dd"));
  const [days, setDays] = useState(15);
  const [sel, setSel] = useState<string[]>(platforms.length ? platforms : ["instagram"]);
  const [style, setStyle] = useState("premium_editorial");
  const [produce, setProduce] = useState(3);
  const { run, busy } = useRun();
  const router = useRouter();
  return (
    <>
      <Button variant="accent" onClick={() => setOpen(true)}>
        <Plus /> New campaign
      </Button>
      <Modal open={open} onClose={() => !busy() && setOpen(false)} title="Plan a campaign">
        <div className="space-y-4 p-5">
          <Field label="Campaign brief">
            <Textarea rows={4} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Launch our winter glaze collection (200 pieces). Build anticipation, then drive pre-orders. Tie in gifting for the holidays." />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              <Select value={type} onChange={(e) => setType(e.target.value)}>
                {CAMPAIGN_TYPES.map((t) => <option key={t} value={t} className="capitalize">{t}</option>)}
              </Select>
            </Field>
            <Field label="Objective">
              <Select value={objective} onChange={(e) => setObjective(e.target.value)}>
                {OBJECTIVES.map((o) => <option key={o} value={o}>{objectiveLabel(o)}</option>)}
              </Select>
            </Field>
            <Field label="Start date"><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
            <Field label="Duration (days)"><Input type="number" min={3} max={90} value={days} onChange={(e) => setDays(Number(e.target.value))} /></Field>
          </div>
          <div>
            <p className="mb-1.5 text-[12px] font-medium text-ink-2">Platforms</p>
            <div className="flex flex-wrap gap-1.5">
              {PLATFORMS.map((p) => {
                const on = sel.includes(p.id);
                return (
                  <button key={p.id} type="button" onClick={() => setSel((s) => (on ? s.filter((x) => x !== p.id) : [...s, p.id]))} className={cn("rounded-lg border px-2.5 py-1.5 text-[12px]", on ? "border-ink bg-ink text-white" : "border-line")}>
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Creative style">
              <Select value={style} onChange={(e) => setStyle(e.target.value)}>
                {STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </Select>
            </Field>
            <Field label="Produce now" hint="Creatives + captions">
              <Select value={produce} onChange={(e) => setProduce(Number(e.target.value))}>
                {[0, 1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n === 0 ? "Plan only" : `First ${n} posts`}</option>)}
              </Select>
            </Field>
          </div>
          <div className="flex items-center justify-end gap-2 pt-2">
            {busy() ? <p className="mr-auto text-[12px] text-muted">Campaign Manager → Creative Director → Copywriter… this can take a few minutes.</p> : null}
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy()}>Cancel</Button>
            <Button
              variant="accent"
              disabled={!brief.trim() || !sel.length}
              loading={busy()}
              onClick={() => run(() => createCampaignAction(brandId, { brief, type, objective, start, days, platforms: sel, style, produceFirst: produce }), { success: "Campaign planned", onOk: (d) => router.push(`/campaigns/${d.campaignId}`) })}
            >
              <Sparkles /> Build campaign
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
