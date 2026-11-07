"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "./ui/toast";

type R<T> = { ok: true; data: T } | { ok: false; error: string; status?: number; retryAfter?: number };

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
      } else toast(r.error, "error");
      setKey(null);
    });
  }
  return { run, pending, busy: (k = "default") => pending && key === k };
}
