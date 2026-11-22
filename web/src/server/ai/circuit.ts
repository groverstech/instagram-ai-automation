import "server-only";
import { log } from "../log";

/**
 * Circuit breaker per provider (docs/AI_PROVIDERS.md). After AI_CIRCUIT_THRESHOLD consecutive
 * service failures (server errors, overload, timeouts, network), new calls to that provider fail
 * fast for AI_CIRCUIT_OPEN_MS instead of piling onto a failing service. Then one call is let
 * through ("half-open"): success closes the circuit, failure opens it again. Background jobs wait
 * and retry later; the UI shows "AI service degraded".
 *
 * Rate limits, auth, quota and bad requests don't count: they aren't outages. State is per
 * process (each instance learns independently); that's enough to stop hammering a failing API.
 */
type State = { failures: number; openedAt: number | null; probing: boolean };
const states = new Map<string, State>();

const num = (v: string | undefined, d: number) => (v && /^[1-9]\d*$/.test(v) ? Number(v) : d);
const threshold = () => num(process.env.AI_CIRCUIT_THRESHOLD, 5);
const openMs = () => num(process.env.AI_CIRCUIT_OPEN_MS, 30_000);

function state(provider: string): State {
  let s = states.get(provider);
  if (!s) states.set(provider, (s = { failures: 0, openedAt: null, probing: false }));
  return s;
}

/** Whether a call may go out now. When open, also how long until the next probe. */
export function circuitAllows(provider: string, now = Date.now()): { ok: true } | { ok: false; retryInMs: number } {
  const s = state(provider);
  if (s.openedAt === null) return { ok: true };
  const waited = now - s.openedAt;
  if (waited < openMs()) return { ok: false, retryInMs: openMs() - waited };
  if (s.probing) return { ok: false, retryInMs: 1000 };
  s.probing = true; // half-open: let one call through
  return { ok: true };
}

export function circuitSuccess(provider: string) {
  const s = state(provider);
  if (s.openedAt !== null) log.info("ai.circuit_closed", { provider });
  s.failures = 0;
  s.openedAt = null;
  s.probing = false;
}

/** Record a failure. Only service failures move the circuit; others reset nothing. */
export function circuitFailure(provider: string, serviceFailure: boolean, now = Date.now()) {
  const s = state(provider);
  if (!serviceFailure) {
    if (s.probing) {
      // The probe got an answer (just not a success): the service is reachable again.
      s.openedAt = null;
      s.probing = false;
      s.failures = 0;
    }
    return;
  }
  s.failures++;
  if (s.probing || s.failures >= threshold()) {
    if (s.openedAt === null || s.probing) log.warn("ai.circuit_opened", { provider, failures: s.failures, openMs: openMs() });
    s.openedAt = now;
    s.probing = false;
  }
}

export type CircuitStatus = { provider: string; state: "closed" | "open" | "half_open"; consecutiveFailures: number };
export function circuitStatus(provider: string, now = Date.now()): CircuitStatus {
  const s = state(provider);
  const st = s.openedAt === null ? "closed" : now - s.openedAt < openMs() ? "open" : "half_open";
  return { provider, state: st, consecutiveFailures: s.failures };
}

/** Tests only. */
export function resetCircuits() {
  states.clear();
}
