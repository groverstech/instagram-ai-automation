"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, ArrowUpRight, Sparkles, X } from "lucide-react";
import { assistantAction } from "@/app/actions/ai";
import { cn } from "@/lib/utils";

type Msg = { id: string; role: "user" | "assistant"; content: string; actions: { label: string; href: string }[]; error?: boolean };

const PROMPTS = [
  "Create a 15-day Instagram campaign for our new product",
  "Generate five premium creatives for Diwali",
  "Analyze my last 30 days of Instagram performance",
  "Suggest content ideas to improve engagement",
  "Create a weekly content calendar",
];

export function Assistant({ brandId, brandName, initial, canRun }: { brandId: string; brandName: string; initial: Msg[]; canRun: boolean }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>(initial);
  const [input, setInput] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: Event) => {
      setOpen(true);
      const detail = (e as CustomEvent<string>).detail;
      if (detail) setInput(detail);
    };
    window.addEventListener("bp:assistant", h);
    return () => window.removeEventListener("bp:assistant", h);
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, pending, open]);

  function send(text: string) {
    const t = text.trim();
    if (!t || pending) return;
    setInput("");
    setMsgs((m) => [...m, { id: crypto.randomUUID(), role: "user", content: t, actions: [] }]);
    start(async () => {
      const r = await assistantAction(brandId, t).catch(() => ({ ok: false as const, error: "The server is busy or unreachable. Please wait a moment and try again." }));
      setMsgs((m) => [...m, r.ok ? { id: crypto.randomUUID(), role: "assistant", content: r.data.text, actions: r.data.actions } : { id: crypto.randomUUID(), role: "assistant", content: r.error, actions: [], error: true }]);
      router.refresh();
    });
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cn("fixed bottom-[max(1.5rem,calc(env(safe-area-inset-bottom)+0.75rem))] right-6 z-40 flex items-center gap-2 rounded-full bg-ink py-2.5 pl-3 pr-4 text-[13px] font-medium text-white shadow-pop transition hover:-translate-y-0.5", open && "pointer-events-none opacity-0")}
      >
        <span className="relative grid size-6 place-items-center">
          <span className="absolute inset-0 animate-spin rounded-full ai-ring [animation-duration:4s]" />
          <span className="absolute inset-[2px] grid place-items-center rounded-full bg-ink">
            <Sparkles className="size-3" />
          </span>
        </span>
        Ask BrandPilot
      </button>

      <AnimatePresence>
        {open ? (
          <motion.aside
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 34 }}
            className="fixed bottom-[max(1rem,calc(env(safe-area-inset-bottom)+0.5rem))] right-4 top-[max(1rem,calc(env(safe-area-inset-top)+0.5rem))] z-50 flex w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop"
          >
            <div className="flex items-center justify-between border-b border-line px-4 py-3 ai-gradient">
              <div>
                <p className="text-[13px] font-semibold">BrandPilot assistant</p>
                <p className="text-[11px] text-muted">Runs real workflows for {brandName}. Everything is a draft until you approve it.</p>
              </div>
              <button onClick={() => setOpen(false)} className="rounded-md p-1.5 text-muted hover:bg-white/60" aria-label="Close assistant">
                <X className="size-4" />
              </button>
            </div>

            <div className="scrollbar-thin flex-1 space-y-3 overflow-y-auto p-4">
              {!msgs.length ? (
                <div className="space-y-2">
                  <p className="mb-3 text-[13px] text-muted">Ask for work, not just answers. Try:</p>
                  {PROMPTS.map((p) => (
                    <button key={p} onClick={() => send(p)} disabled={!canRun} className="block w-full rounded-xl border border-line px-3 py-2.5 text-left text-[13px] text-ink-2 transition hover:border-line-strong hover:bg-sunken/50">
                      {p}
                    </button>
                  ))}
                </div>
              ) : null}
              {msgs.map((m) => (
                <div key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                  <div className={cn("max-w-[88%] rounded-2xl px-3.5 py-2.5 text-[13px]", m.role === "user" ? "bg-ink text-white" : m.error ? "bg-danger-soft text-danger" : "bg-sunken text-ink")}>
                    <p className="whitespace-pre-wrap">{m.content}</p>
                    {m.actions.length ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {m.actions.map((a) => (
                          <Link key={a.href} href={a.href} onClick={() => setOpen(false)} className="inline-flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-[12px] font-medium text-ink shadow-sm hover:bg-white">
                            {a.label} <ArrowUpRight className="size-3" />
                          </Link>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
              {pending ? (
                <div className="flex items-center gap-2 text-[12px] text-muted">
                  <span className="flex gap-1">
                    {[0, 1, 2].map((i) => (
                      <span key={i} className="size-1.5 animate-bounce rounded-full bg-accent" style={{ animationDelay: `${i * 120}ms` }} />
                    ))}
                  </span>
                  Agents are working. Bigger tasks like campaigns can take a minute or two.
                </div>
              ) : null}
              <div ref={end} />
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
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
                      send(input);
                    }
                  }}
                  rows={2}
                  disabled={!canRun}
                  placeholder={canRun ? "Ask your marketing team…" : "Viewers can't run AI tasks"}
                  className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1 text-[13px] focus:outline-none"
                />
                <button disabled={!input.trim() || pending} className="grid size-8 place-items-center rounded-lg bg-ink text-white disabled:opacity-30" aria-label="Send">
                  <ArrowUp className="size-4" />
                </button>
              </div>
            </form>
          </motion.aside>
        ) : null}
      </AnimatePresence>
    </>
  );
}

/** Open the assistant from anywhere, optionally pre-filling a prompt. */
export function openAssistant(prompt?: string) {
  window.dispatchEvent(new CustomEvent("bp:assistant", { detail: prompt ?? "" }));
}
