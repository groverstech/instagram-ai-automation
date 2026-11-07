import "server-only";
import { AccessError } from "./auth/guard";
import { friendlyAIError } from "./ai/llm";
import { QuotaError } from "./quota";
import { BillingError } from "./billing";
import { UploadError } from "./assets";

export type Result<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

/** Uniform error handling for server actions: friendly messages, no stack traces to clients. */
export async function safe<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e && String((e as { digest: string }).digest).startsWith("NEXT_REDIRECT")) throw e;
    if (e instanceof AccessError || e instanceof QuotaError || e instanceof BillingError || e instanceof UploadError) return { ok: false, error: e.message };
    const ai = friendlyAIError(e);
    if (ai) {
      console.error("[action] AI request failed", e instanceof Error ? e.message : e);
      return { ok: false, error: ai };
    }
    console.error("[action]", e);
    const msg = e instanceof Error ? e.message : "Something went wrong.";
    return { ok: false, error: msg.length > 400 ? msg.slice(0, 400) + "…" : msg };
  }
}
