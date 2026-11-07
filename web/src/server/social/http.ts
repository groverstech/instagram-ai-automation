import { PlatformError } from "./types";

export async function jsonFetch<T = Record<string, unknown>>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30000) });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const b = body as { error?: { message?: string } | string; message?: string; error_description?: string } | null;
    const msg =
      (typeof b?.error === "object" ? b.error?.message : typeof b?.error === "string" ? b.error : undefined) ??
      b?.error_description ??
      b?.message ??
      text.slice(0, 300);
    throw new PlatformError(`${new URL(url).hostname} ${res.status}: ${msg}`, res.status);
  }
  return body as T;
}

export const form = (o: Record<string, string>) => new URLSearchParams(o);
