import "server-only";
import { AccessError } from "./auth/guard";
import { AIConfigError, AIRefusalError } from "./ai/llm";
import { QuotaError } from "./quota";

export type Result<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

/** Uniform error handling for server actions: friendly messages, no stack traces to clients. */
export async function safe<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e && String((e as { digest: string }).digest).startsWith("NEXT_REDIRECT")) throw e;
    if (e instanceof AccessError || e instanceof AIConfigError || e instanceof AIRefusalError || e instanceof QuotaError) return { ok: false, error: e.message };
    console.error("[action]", e);
    const msg = e instanceof Error ? e.message : "Something went wrong.";
    return { ok: false, error: msg.length > 400 ? msg.slice(0, 400) + "…" : msg };
  }
}
