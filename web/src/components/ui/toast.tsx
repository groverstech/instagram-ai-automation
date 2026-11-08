"use client";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, AlertCircle } from "lucide-react";

type T = { id: number; kind: "success" | "error"; text: string };

export function toast(text: string, kind: T["kind"] = "success") {
  window.dispatchEvent(new CustomEvent("bp:toast", { detail: { text, kind } }));
}

export function Toaster() {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<{ text: string; kind: T["kind"] }>).detail;
      const id = Date.now() + Math.random();
      setItems((x) => [...x, { id, ...d }]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), d.kind === "error" ? 7000 : 3500);
    };
    window.addEventListener("bp:toast", h);
    return () => window.removeEventListener("bp:toast", h);
  }, []);
  return (
    <div className="pointer-events-none fixed left-1/2 top-[max(1rem,calc(env(safe-area-inset-top)+0.5rem))] z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      <AnimatePresence>
        {items.map((t) => (
          <motion.div key={t.id} initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="pointer-events-auto flex max-w-md items-start gap-2 rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[13px] shadow-pop">
            {t.kind === "success" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" />}
            <span>{t.text}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
