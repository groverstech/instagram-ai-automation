import "server-only";
import { AccessError } from "./auth/guard";
import { friendlyAIError } from "./ai/llm";
import { QuotaError } from "./quota";
import { BillingError } from "./billing";
import { UploadError } from "./assets";
import { RateLimitError } from "./ratelimit";
import { log } from "./log";
import { UserFacingError } from "./jobs/engine";
import { MemberError } from "./members";

export type Result<T = undefined> = { ok: true; data: T } | { ok: false; error: string; status?: number; retryAfter?: number };

/** Uniform error handling for server actions: friendly messages, no stack traces to clients. */
export async function safe<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e && String((e as { digest: string }).digest).startsWith("NEXT_REDIRECT")) throw e;
    if (e instanceof RateLimitError) return { ok: false, error: e.message, status: 429, retryAfter: e.retryAfter };
    if (e instanceof AccessError || e instanceof QuotaError || e instanceof BillingError || e instanceof UploadError || e instanceof UserFacingError || e instanceof MemberError) return { ok: false, error: e.message };
    if (e && typeof e === "object" && (e as { name?: string }).name === "ZodError") {
      const issues = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues ?? [];
      return { ok: false, error: `Please check your input: ${issues.slice(0, 3).map((i) => `${i.path.join(".") || "value"} — ${i.message}`).join("; ")}` };
    }
    const ai = friendlyAIError(e);
    if (ai) {
      log.error("action.ai_failed", { error: e instanceof Error ? e.message : String(e) });
      return { ok: false, error: ai };
    }
    log.error("action.failed", { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack?.split("\n").slice(0, 6).join("\n") : undefined });
    const msg = e instanceof Error ? e.message : "Something went wrong.";
    return { ok: false, error: msg.length > 400 ? msg.slice(0, 400) + "…" : msg };
  }
}
