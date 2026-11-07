"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { AlertTriangle, ArrowUp, Sparkles, Trash2 } from "lucide-react";
import { askBrandAction, clearBrandChatAction } from "@/app/actions/brand";
import { Badge, Button, Card } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

type Meta = { basis?: "brand_knowledge" | "mixed" | "general_guidance"; usedSections?: string[]; unconfirmed?: boolean; missingInfo?: string[]; followUps?: string[] } | null;
export type ChatMsg = { id: string; role: "user" | "assistant"; content: string; meta: Meta; error?: boolean };

const PROMPTS = [
  "Describe my brand identity.",
  "Who is my ideal customer?",
  "What makes my brand different?",
  "What visual style should my Instagram account follow?",
  "Suggest five content pillars.",
  "What type of content should we avoid?",
  "How should our brand communicate with customers?",
];

const SECTION_LABELS: Record<string, string> = {
  identity: "Brand identity",
  audience: "Target audience",
  communication: "Communication",
  visual: "Visual identity",
  marketing: "Marketing",
  memory: "Brand memory",
  assets: "Approved assets",
};

const BASIS: Record<string, { label: string; tone: string }> = {
  brand_knowledge: { label: "From your brand profile", tone: "success" },
  mixed: { label: "Brand profile + general guidance", tone: "info" },
  general_guidance: { label: "General guidance — not brand-specific", tone: "warn" },
};

export function BrandChat({ brandId, initial, canAsk, canClear, hasProfile }: { brandId: string; initial: ChatMsg[]; canAsk: boolean; canClear: boolean; hasProfile: boolean }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>(initial);
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
      const r = await askBrandAction(brandId, question).catch(() => ({ ok: false as const, error: "The server is busy or unreachable. Please wait a moment and try again." }));
      setMsgs((m) => [
        ...m,
        r.ok
          ? { id: r.data.id, role: "assistant", content: r.data.answer, meta: r.data.meta as Meta }
          : { id: `err-${Date.now()}`, role: "assistant", content: r.error, meta: null, error: true },
      ]);
    });
  }

  return (
    <Card className="flex min-h-[560px] flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4 ai-gradient">
        <div>
          <p className="text-[14px] font-semibold">Ask about your brand</p>
          <p className="text-[12px] text-muted">Answers come from your saved brand profile, instructions, approved assets and memory.</p>
        </div>
        {canClear && msgs.length ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              start(async () => {
                const r = await clearBrandChatAction(brandId);
                if (r.ok) setMsgs([]);
                else toast(r.error, "error");
              })
            }
          >
            <Trash2 /> Clear
          </Button>
        ) : null}
      </div>

      <div className="scrollbar-thin flex-1 space-y-4 overflow-y-auto p-5">
        {!hasProfile ? (
          <div className="flex gap-2 rounded-xl bg-warn-soft px-3.5 py-2.5 text-[13px] text-warn">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            No Brand Intelligence Profile yet, so answers can only use your onboarding answers. Generate the profile for grounded answers.
          </div>
        ) : null}
        {!msgs.length ? (
          <div>
            <p className="mb-3 text-[13px] text-muted">Try one of these:</p>
            <div className="flex flex-wrap gap-2">
              {PROMPTS.map((p) => (
                <button key={p} disabled={!canAsk || pending} onClick={() => ask(p)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-left text-[13px] text-ink-2 transition hover:border-line-strong hover:bg-sunken/50 disabled:opacity-50">
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {msgs.map((m) => (
          <div key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div className={cn("max-w-[92%] rounded-2xl px-4 py-3 text-[13px] sm:max-w-[80%]", m.role === "user" ? "bg-ink text-white" : m.error ? "bg-danger-soft text-danger" : "border border-line bg-surface")}>
              {m.role === "assistant" && m.meta?.basis ? (
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <Badge tone={BASIS[m.meta.basis]?.tone}>{BASIS[m.meta.basis]?.label}</Badge>
                  {m.meta.unconfirmed ? <Badge tone="accent">Uses unconfirmed AI suggestions</Badge> : null}
                </div>
              ) : null}
              <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
              {m.role === "assistant" && m.meta ? (
                <div className="mt-3 space-y-2 border-t border-line pt-2.5 text-[12px]">
                  {m.meta.usedSections?.length ? (
                    <p className="text-muted">
                      Based on: <span className="text-ink-2">{m.meta.usedSections.map((s) => SECTION_LABELS[s] ?? s).join(", ")}</span>
                    </p>
                  ) : null}
                  {m.meta.missingInfo?.length ? (
                    <p className="text-muted">
                      Would improve with: <span className="text-ink-2">{m.meta.missingInfo.join("; ")}</span>
                    </p>
                  ) : null}
                  {m.meta.followUps?.length ? (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {m.meta.followUps.slice(0, 3).map((f) => (
                        <button key={f} disabled={!canAsk || pending} onClick={() => ask(f)} className="rounded-full bg-sunken px-2.5 py-1 text-left text-[12px] text-ink-2 hover:bg-line">
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
        {pending ? (
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <Sparkles className="size-3.5 animate-pulse text-accent" /> Reading your brand profile…
          </div>
        ) : null}
        <div ref={end} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
        className="border-t border-line p-3"
      >
        <div className="flex items-end gap-2 rounded-xl border border-line bg-canvas p-1.5 focus-within:border-accent/50">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask(input);
              }
            }}
            rows={2}
            maxLength={2000}
            disabled={!canAsk}
            aria-label="Ask a question about your brand"
            placeholder={canAsk ? "Ask anything about your brand…" : "You don't have access to ask questions"}
            className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1 text-[13px] focus:outline-none"
          />
          <button disabled={!input.trim() || pending || !canAsk} className="grid size-8 place-items-center rounded-lg bg-ink text-white disabled:opacity-30" aria-label="Send">
            <ArrowUp className="size-4" />
          </button>
        </div>
      </form>
    </Card>
  );
}
