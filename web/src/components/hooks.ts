"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "./ui/toast";

type R<T> = { ok: true; data: T } | { ok: false; error: string; status?: number; retryAfter?: number; stepUp?: boolean };

/** Fired when an action needs a recent second factor; StepUpDialog asks for a code, then calls `retry`. */
export const STEP_UP_EVENT = "bp:step-up";
export type StepUpDetail = { retry: () => void; cancel: () => void };

/** Run a server action with pending state, toasts and a refresh. */
export function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [key, setKey] = useState<string | null>(null);
  function run<T>(fn: () => Promise<R<T>>, opts: { success?: string | ((d: T) => string); key?: string; onOk?: (d: T) => void; refresh?: boolean } = {}) {
    setKey(opts.key ?? "default");
    start(async () => {
      let r: R<T>;
      try {
        r = await fn();
      } catch {
        // e.g. the edge limiter answered HTTP 429, or the network dropped.
        toast("The server is busy or unreachable. Please wait a moment and try again.", "error");
        setKey(null);
        return;
      }
      if (r.ok) {
        if (opts.success) toast(typeof opts.success === "function" ? opts.success(r.data) : opts.success);
        opts.onOk?.(r.data);
        if (opts.refresh !== false) router.refresh();
      } else if (r.stepUp && typeof window !== "undefined") {
        // Ask for a code, then run the same action again.
        const detail: StepUpDetail = { retry: () => run(fn, opts), cancel: () => toast("Cancelled: a code is needed to continue.", "error") };
        window.dispatchEvent(new CustomEvent(STEP_UP_EVENT, { detail }));
      } else toast(r.error, "error");
      setKey(null);
    });
  }
  return { run, pending, busy: (k = "default") => pending && key === k };
}
