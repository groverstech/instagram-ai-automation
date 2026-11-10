import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * AI errors and their classification (docs/AI_PROVIDERS.md). Every provider failure maps to one
 * kind, which decides whether it's retried, whether the attempt may have been billed, and what the
 * user is told. Messages never contain API keys or raw provider payloads.
 */

/** No provider configured (missing key or provider turned off). */
export class AIConfigError extends Error {}
/** The model declined the request (billed). */
export class AIRefusalError extends Error {}
/** The model responded, but the output was unusable (truncated, invalid JSON, wrong shape; billed). */
export class AIOutputError extends Error {}
/** The provider is failing repeatedly; calls are paused briefly (circuit breaker). Nothing was sent. */
export class AIUnavailableError extends Error {
  constructor(
    readonly provider: string,
    readonly retryInMs: number,
  ) {
    super("The AI service is having problems right now, so requests are paused for a moment. Please try again shortly.");
  }
}

export class ImageProviderUnavailable extends Error {}
/** The image provider refused the prompt (content policy). The message is safe to show. */
export class ImageRefusedError extends Error {
  constructor(
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}
/** Any other image provider failure; `status` is the HTTP status when there was a response. */
export class ImageProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detail: { reason?: "timeout" | "network"; code?: string; requestId?: string; retryAfterMs?: number; shouldRetry?: boolean } = {},
  ) {
    super(message);
  }
}

export type ErrorKind =
  | "not_configured"
  | "circuit_open"
  | "auth"
  | "permission"
  | "quota"
  | "rate_limit"
  | "overloaded"
  | "server"
  | "timeout"
  | "network"
  | "bad_request"
  | "content_policy"
  | "refusal"
  | "output_invalid"
  | "unknown";

export type Classified = {
  kind: ErrorKind;
  /** Worth another attempt now (transient). */
  retryable: boolean;
  /** Sent, but no response: the provider may have processed and billed it. */
  outcomeUnknown: boolean;
  /** The provider answered (so it billed whatever usage the error carries, if any). */
  responded: boolean;
  /** Counts towards the circuit breaker (the service itself is failing). */
  serviceFailure: boolean;
  status?: number;
  requestId?: string;
  retryAfterMs?: number;
};

function headerRetryAfter(headers: Headers | Record<string, string> | undefined | null): number | undefined {
  const get = (k: string) => (headers instanceof Headers ? headers.get(k) : headers?.[k]) ?? undefined;
  const ms = Number(get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const s = get("retry-after");
  if (!s) return undefined;
  const n = Number(s);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const date = Date.parse(s);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function shouldRetryHeader(headers: Headers | undefined | null): boolean | undefined {
  const v = headers?.get?.("x-should-retry");
  return v === "true" ? true : v === "false" ? false : undefined;
}

const service = (kind: ErrorKind) => kind === "overloaded" || kind === "server" || kind === "timeout" || kind === "network";

function byStatus(status: number, code?: string): ErrorKind {
  if (status === 401) return "auth";
  if (status === 402) return "quota";
  if (status === 403) return "permission";
  if (status === 429) return code === "insufficient_quota" || code === "billing_hard_limit_reached" ? "quota" : "rate_limit";
  if (status === 529) return "overloaded";
  if (status >= 500) return "server";
  if (status === 408) return "timeout";
  if (status === 409) return "server";
  return "bad_request";
}

const RETRYABLE: ErrorKind[] = ["rate_limit", "overloaded", "server", "timeout", "network", "output_invalid"];

export function classify(e: unknown): Classified {
  const base = (kind: ErrorKind, extra: Partial<Classified> = {}): Classified => ({
    kind,
    retryable: RETRYABLE.includes(kind),
    outcomeUnknown: false,
    responded: true,
    serviceFailure: service(kind),
    ...extra,
  });
  if (e instanceof AIUnavailableError) return base("circuit_open", { retryable: false, responded: false, serviceFailure: false });
  if (e instanceof AIConfigError || e instanceof ImageProviderUnavailable) return base("not_configured", { retryable: false, responded: false, serviceFailure: false });
  if (e instanceof AIRefusalError) return base("refusal");
  if (e instanceof AIOutputError) return base("output_invalid");
  if (e instanceof ImageRefusedError) return base("content_policy", { requestId: e.requestId });
  if (e instanceof ImageProviderError) {
    const d = e.detail;
    if (e.status === undefined) {
      const kind = d.reason === "network" ? "network" : "timeout";
      return base(kind, { outcomeUnknown: true, responded: false });
    }
    const kind = byStatus(e.status, d.code);
    const c = base(kind, { status: e.status, requestId: d.requestId, retryAfterMs: d.retryAfterMs });
    if (d.shouldRetry !== undefined && kind !== "quota") c.retryable = d.shouldRetry;
    return c;
  }
  // Anthropic SDK errors. APIConnectionError is a subclass of APIError: check it first.
  if (e instanceof Anthropic.APIConnectionTimeoutError) return base("timeout", { outcomeUnknown: true, responded: false });
  if (e instanceof Anthropic.APIUserAbortError) return base("timeout", { outcomeUnknown: true, responded: false });
  if (e instanceof Anthropic.APIConnectionError) return base("network", { outcomeUnknown: true, responded: false });
  if (e instanceof Anthropic.APIError) {
    const status = e.status ?? 0;
    const type = (e as { type?: string }).type;
    const kind = type === "billing_error" ? "quota" : type === "overloaded_error" ? "overloaded" : status ? byStatus(status) : "unknown";
    const c = base(kind, { status: e.status ?? undefined, requestId: e.requestID ?? undefined, retryAfterMs: headerRetryAfter(e.headers as Headers | undefined) });
    const hint = shouldRetryHeader(e.headers as Headers | undefined);
    if (hint !== undefined && kind !== "quota") c.retryable = hint;
    return c;
  }
  return base("unknown", { retryable: false, serviceFailure: false });
}

export { headerRetryAfter };

/** True for failures worth retrying (transient). Never auth, quota, refusal, content policy or bad requests. */
export function isRetryable(e: unknown): boolean {
  return classify(e).retryable;
}

/** Errors that mean "the AI service is unavailable", not "this input is bad". Retrying later may work. */
export function isServiceError(e: unknown): boolean {
  const k = classify(e).kind;
  return ["not_configured", "circuit_open", "auth", "permission", "quota", "rate_limit", "overloaded", "server", "timeout", "network"].includes(k);
}

/** User-facing message for AI failures; never exposes raw API payloads or keys. */
export function friendlyAIError(e: unknown): string | null {
  if (e instanceof AIConfigError || e instanceof AIRefusalError || e instanceof AIOutputError || e instanceof AIUnavailableError) return e.message;
  if (e instanceof ImageRefusedError) return e.message;
  if (e instanceof ImageProviderUnavailable) return "No image provider is configured. Choose brand photos or a typographic layout, or set OPENAI_API_KEY on the server.";
  const image = e instanceof ImageProviderError;
  if (!image && !(e instanceof Anthropic.APIError)) return null;
  const service = image ? "image service" : "AI service";
  const key = image ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  const c = classify(e);
  switch (c.kind) {
    case "auth":
      return `The ${service} rejected the API key. Check ${key} on the server.`;
    case "permission":
      return `The ${service} denied access for this API key (permission or model access). Check the provider account.`;
    case "quota":
      return `The ${service} account has run out of credit or hit its spending limit. Check billing with the provider.`;
    case "rate_limit":
      return `The ${service} is rate-limiting requests. Please try again in a minute.`;
    case "timeout":
      return image
        ? "The image service didn't answer in time. It may still have created (and charged for) the image, so it wasn't retried automatically. Try again if no image appears."
        : `The ${service} didn't answer in time. Please try again.`;
    case "network":
      return image ? "Couldn't reach the image service. Please try again shortly." : "Couldn't reach the AI service. Check the server's network connection and try again.";
    case "overloaded":
    case "server":
      return `The ${service} is temporarily unavailable. Please try again shortly.`;
    case "bad_request":
      return image ? "The image service couldn't process this request." : "The AI service couldn't process this request. Try again, or remove unusual files and retry.";
    default:
      return image ? "The image request failed. Please try again." : "The AI request failed. Please try again.";
  }
}
