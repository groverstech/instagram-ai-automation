import "server-only";
import { log } from "../log";
import { circuitAllows, circuitFailure, circuitSuccess } from "./circuit";
import { AIAccountingError, AIStoppedError, AIUnavailableError, classify } from "./errors";
import { openAttempt, settleAttempt, type Ticket } from "./spend-cap";
import { attachUsage, usageFromError, type Usage } from "./llm";
import { addUsage } from "./pricing";
import type { Priced } from "./pricing";
import type { ResolvedRoute } from "./routes";
import { recordAttempt } from "./usage";
import { aiContext } from "./context";

/** Errors that already went through the executor's retry policy: never retried again above it. */
const HANDLED = Symbol.for("brandpilot.aiHandled");
export function handledByExecutor(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && (e as Record<symbol, unknown>)[HANDLED]);
}
function markHandled<E>(e: E): E {
  if (e && typeof e === "object") Object.defineProperty(e, HANDLED, { value: true, enumerable: false, configurable: true });
  return e;
}

/**
 * Runs one AI call under its route's policy (docs/AI_PROVIDERS.md):
 *   - the circuit breaker can stop it before anything is sent;
 *   - each attempt is recorded in the usage ledger: success, retried, failed, refused, unknown
 *     (sent, no response) or blocked, with units, estimated cost and the provider request ID;
 *   - transient failures are retried with exponential backoff and jitter, honouring the
 *     provider's retry-after (up to AI_RETRY_MAX_WAIT_MS; a longer wait fails now, so the job
 *     layer can retry later);
 *   - attempts whose outcome is unknown are retried only on routes that allow it (text yes,
 *     images no: never pay twice for an image without the user deciding);
 *   - the usage of every billed attempt, and the count of unknown ones, travel with the result
 *     or the final error, so the run ledger (agent_runs) totals them exactly once.
 * Provider SDK retries are turned off, so every attempt that reaches the network is seen here.
 */
export type AttemptResult<T> = { value: T; usage: Usage; requestId?: string | null };

export type Pricing = {
  price: (u: Usage) => Priced;
  units: (u: Usage) => Record<string, number>;
  /** Request parameters that drive cost (quality, resolution, complexity, effort), recorded per attempt. */
  params?: Record<string, string | undefined>;
  /** Worst-case cost of one attempt, for the hard spending cap (spend-cap.ts). null: the kind's fallback reserve. */
  worstCaseUsd?: number | null;
};

const num = (v: string | undefined, d: number) => (v && /^\d+$/.test(v.trim()) ? Number(v.trim()) : d);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function backoffMs(attempt: number, retryAfterMs?: number, env: Record<string, string | undefined> = process.env): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const base = num(env.AI_RETRY_BASE_MS, 1000);
  const exp = base * 2 ** (attempt - 1);
  return Math.round(exp * (0.8 + Math.random() * 0.4));
}

export async function execute<T>(route: ResolvedRoute, pricing: Pricing, fn: (attempt: number) => Promise<AttemptResult<T>>): Promise<AttemptResult<T>> {
  const maxWait = num(process.env.AI_RETRY_MAX_WAIT_MS, 60_000);
  const { refreshPriceOverrides } = await import("./pricing");
  await refreshPriceOverrides();
  const params = Object.fromEntries(Object.entries(pricing.params ?? {}).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
  let total: Usage = {};
  let billed = false;
  for (let attempt = 1; ; attempt++) {
    const gate = circuitAllows(route.provider);
    if (!gate.ok) {
      await recordAttempt({ route: route.key, provider: route.provider, model: route.model, kind: route.kind, params, attempt, outcome: "blocked", errorKind: "circuit_open" });
      throw markHandled(withTotal(new AIUnavailableError(route.provider, gate.retryInMs), total, billed));
    }
    // Accounting before sending (spend-cap.ts): the cap is checked and the attempt durably recorded
    // as pending, or the request is refused and nothing is sent.
    let ticket: Ticket;
    try {
      ticket = await openAttempt(route, { attempt, params }, pricing.worstCaseUsd ?? null);
    } catch (e) {
      if (classify(e).kind !== "spend_cap") throw e;
      const reason = e instanceof AIAccountingError ? "accounting" : e instanceof AIStoppedError ? "stopped" : "spend_cap";
      // Best effort: with the ledger down this write fails too (and is logged); nothing was sent.
      await recordAttempt({ route: route.key, provider: route.provider, model: route.model, kind: route.kind, params, attempt, outcome: "blocked", errorKind: reason });
      log.warn(reason === "accounting" ? "ai.accounting_unavailable" : reason === "stopped" ? "ai.stopped_request" : "ai.spend_cap", { route: route.key, provider: route.provider });
      throw markHandled(withTotal(e, total, billed));
    }
    const counter = aiContext().attempts;
    if (counter) counter.n++;
    const started = Date.now();
    let r: AttemptResult<T>;
    try {
      r = await fn(attempt);
    } catch (e) {
      const c = classify(e);
      circuitFailure(route.provider, c.serviceFailure);
      const attemptUsage = usageFromError(e);
      const own = attemptUsage ?? {};
      if (attemptUsage) {
        total = addUsage(total, attemptUsage);
        billed = true;
      }
      if (c.outcomeUnknown) {
        total = addUsage(total, { unknownUsageAttempts: 1 });
        billed = true;
      }
      const waitMs = c.retryable ? backoffMs(attempt, c.retryAfterMs) : 0;
      const retry = c.retryable && attempt < route.maxAttempts && (!c.outcomeUnknown || route.retryUnknown) && waitMs <= maxWait;
      const cost = attemptUsage ? safe(() => pricing.price(own), UNPRICED_COST) : null;
      await settleAttempt(ticket, {
        model: own.model ?? own.imageModel ?? route.model,
        outcome: retry ? "retried" : c.kind === "refusal" || c.kind === "content_policy" ? "refused" : c.outcomeUnknown ? "unknown" : c.kind === "not_configured" ? "blocked" : "failed",
        errorKind: c.kind,
        httpStatus: c.status ?? null,
        units: { ...(attemptUsage ? safe(() => pricing.units(own), {}) : {}), ...(c.outcomeUnknown ? { unknownOutcome: 1 } : {}) },
        costUsd: cost?.usd ?? null,
        priceSource: cost?.source ?? (c.outcomeUnknown ? "unknown" : null),
        providerRequestId: c.requestId ?? null,
        latencyMs: Date.now() - started,
      });
      if (!retry) throw markHandled(withTotal(e, total, billed));
      log.warn("ai.retry", { route: route.key, provider: route.provider, attempt, kind: c.kind, waitMs });
      await sleep(waitMs);
      continue;
    }
    circuitSuccess(route.provider);
    const cost = safe(() => pricing.price(r.usage), UNPRICED_COST);
    await settleAttempt(ticket, {
      model: r.usage.model ?? r.usage.imageModel ?? route.model,
      outcome: "success",
      units: safe(() => pricing.units(r.usage), {}),
      costUsd: cost.usd,
      priceSource: cost.source,
      providerRequestId: r.requestId ?? null,
      latencyMs: Date.now() - started,
    });
    total = addUsage(total, r.usage);
    return { value: r.value, usage: total, requestId: r.requestId };
  }
}

/** A pricing bug must never stop an attempt from being settled: it then counts at its reserve (unpriced). */
const UNPRICED_COST: Priced = { usd: null, source: "unpriced" };
function safe<X>(f: () => X, fallback: X): X {
  try {
    return f();
  } catch (e) {
    log.error("ai.pricing_failed", { error: e instanceof Error ? e.message : String(e) });
    return fallback;
  }
}

function withTotal<E>(e: E, total: Usage, billed: boolean): E {
  return billed ? attachUsage(e, total, { replace: true }) : e;
}
