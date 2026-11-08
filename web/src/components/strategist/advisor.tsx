"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { ArrowUp, Trash2 } from "lucide-react";
import { advisorAction, clearAdvisorAction } from "@/app/actions/strategist";
import { Badge, Button, Card } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { SECTION_META, type SectionKey } from "@/lib/strategy";
import { cn } from "@/lib/utils";

type Meta = { basis?: string; referencedSections?: SectionKey[]; usesUnverifiedResearch?: boolean; followUps?: string[]; suggestedActions?: { label: string; section: SectionKey }[]; strategyVersion?: number | null; strategyStatus?: string | null } | null;
export type AdvisorMsg = { id: string; role: "user" | "assistant"; content: string; meta: Meta; error?: boolean };

const BASIS: Record<string, { label: string; tone: string }> = {
  approved_strategy: { label: "From your approved strategy", tone: "success" },
  draft_strategy: { label: "From a draft strategy (not approved)", tone: "warn" },
  brand_profile: { label: "From your brand profile", tone: "info" },
  general_guidance: { label: "General guidance", tone: "warn" },
};
const PROMPTS = ["What should we post this week and why?", "Which persona should we prioritise first?", "How do we turn followers into leads?", "What would you cut from this plan if we had half the time?", "How should we respond to price objections in comments?"];

export function Advisor({ brandId, initial, canClear, onGo }: { brandId: string; initial: AdvisorMsg[]; canClear: boolean; onGo: (s: SectionKey) => void }) {
  const [msgs, setMsgs] = useState(initial);
  const [input, setInput] = useState("");
  const [pending, start] = useTransition();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [msgs, pending]);

  function ask(q: string) {
    const question = q.trim();
    if (!question || pending) return;
    setInput("");
    setMsgs((m) => [...m, { id: `local-${Date.now()}`, role: "user", content: question, meta: null }]);
    start(async () => {
      const r = await advisorAction(brandId, question).catch(() => ({ ok: false as const, error: "The server is busy or unreachable. Please try again." }));
      setMsgs((m) => [...m, r.ok ? { id: r.data.id, role: "assistant", content: r.data.answer, meta: r.data.meta as Meta } : { id: `err-${Date.now()}`, role: "assistant", content: r.error, meta: null, error: true }]);
    });
  }

  return (
    <Card className="flex min-h-[560px] flex-col overflow-hidden">
      <div className="ai-gradient flex items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <p className="text-[14px] font-semibold">Marketing Advisor</p>
          <p className="text-[12px] text-muted">Ask about your strategy. Answers use your brand intelligence and approved strategy, and say when they don&apos;t.</p>
        </div>
        {canClear && msgs.length ? (
          <Button variant="ghost" size="sm" onClick={() => start(async () => { const r = await clearAdvisorAction(brandId); if (r.ok) setMsgs([]); else toast(r.error, "error"); })}>
            <Trash2 /> Clear
          </Button>
        ) : null}
      </div>
      <div className="scrollbar-thin flex-1 space-y-4 overflow-y-auto p-5">
        {!msgs.length ? (
          <div className="flex flex-wrap gap-2">
            {PROMPTS.map((p) => (
              <button key={p} disabled={pending} onClick={() => ask(p)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-left text-[13px] text-ink-2 transition hover:border-line-strong">
                {p}
              </button>
            ))}
          </div>
        ) : null}
        {msgs.map((m) => (
          <div key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div className={cn("max-w-[92%] rounded-2xl px-4 py-3 text-[13px] sm:max-w-[80%]", m.role === "user" ? "bg-ink text-white" : m.error ? "bg-danger-soft text-danger" : "border border-line bg-surface")}>
              {m.role === "assistant" && m.meta?.basis ? (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  <Badge tone={BASIS[m.meta.basis]?.tone}>{BASIS[m.meta.basis]?.label}{m.meta.strategyVersion ? ` · v${m.meta.strategyVersion}` : ""}</Badge>
                  {m.meta.usesUnverifiedResearch ? <Badge tone="warn">Relies on unverified research</Badge> : null}
                </div>
              ) : null}
              <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
              {m.role === "assistant" && m.meta ? (
                <div className="mt-2.5 space-y-2 border-t border-line pt-2 text-[12px]">
                  {m.meta.referencedSections?.length ? <p className="text-muted">Based on: {m.meta.referencedSections.map((s) => SECTION_META[s]?.label ?? s).join(", ")}</p> : null}
                  {m.meta.suggestedActions?.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {m.meta.suggestedActions.map((a) => (
                        <button key={a.label} onClick={() => onGo(a.section)} className="rounded-full bg-accent-soft px-2.5 py-1 text-accent-ink hover:bg-accent-soft/70">
                          {a.label} →
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {m.meta.followUps?.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {m.meta.followUps.slice(0, 3).map((f) => (
                        <button key={f} disabled={pending} onClick={() => ask(f)} className="rounded-full border border-line px-2.5 py-1 text-ink-2 hover:border-line-strong">
                          {f}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ))}
        {pending ? <div className="w-28 animate-pulse rounded-2xl border border-line px-4 py-3 text-[13px] text-muted">Thinking…</div> : null}
        <div ref={end} />
      </div>
      <form
        className="flex items-end gap-2 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask(input);
            }
          }}
          rows={1}
          maxLength={4000}
          placeholder="Ask the advisor…"
          aria-label="Ask the Marketing Advisor"
          className="max-h-40 min-h-[40px] flex-1 resize-none rounded-xl border border-line bg-surface px-3 py-2.5 text-[13px] focus:border-accent/60 focus:outline-none"
        />
        <Button type="submit" variant="accent" size="icon" disabled={!input.trim() || pending} aria-label="Send">
          <ArrowUp />
        </Button>
      </form>
    </Card>
  );
}
