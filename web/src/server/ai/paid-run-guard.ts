import "server-only";

/**
 * Guard for operator commands that make real, paid provider requests (`npm run test:live`,
 * `npm run ai:check-anthropic`). docs/AI_PROVIDERS.md, "Spending cap and run log".
 *
 * preparePaidRun() runs before anything can reach a provider and refuses (throws PaidRunRefused)
 * unless:
 *   - not in CI;
 *   - AI_SPEND_CAP_USD is a valid amount and AI_SPEND_CAP_SINCE a UTC time in the documented format
 *     (e.g. 2026-11-14T00:00:00Z), not in the future;
 *   - the usage ledger is persistent (not an in-memory database), so spending recorded by earlier
 *     runs counts against the cap;
 *   - the spending already recorded since AI_SPEND_CAP_SINCE is below the cap.
 * It then turns on required-cap mode for the process (AI_SPEND_CAP_REQUIRED), so every provider
 * request is checked again by reserveSpend() before it is sent: recorded spend + in-flight
 * reserves + this request's worst-case cost must fit under the cap, and a missing or invalid cap
 * refuses the request.
 *
 * installPaidRequestGuard() wraps fetch so that a request to a paid provider host is blocked unless
 * it holds a reservation under the cap, i.e. it went through the executor (call.ts). A request
 * that would bypass the cap is never sent. Hosts with no cap accounting (embeddings) are blocked.
 *
 * Never reads, prints or compares key values: only whether a variable is present.
 */
type Env = Record<string, string | undefined>;

export class PaidRunRefused extends Error {}

const DEFAULT_CAPPED_HOSTS = ["api.anthropic.com", "api.openai.com"];
/** Paid APIs this app can call without spend-cap accounting: never allowed during a paid run. */
const UNCAPPED_PAID_HOSTS = ["api.voyageai.com"];

function hostOf(url: string | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    return new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Provider hosts whose requests must hold a cap reservation (defaults plus any configured base URLs). */
export function cappedProviderHosts(env: Env = process.env): string[] {
  const hosts = new Set(DEFAULT_CAPPED_HOSTS);
  for (const h of [hostOf(env.ANTHROPIC_BASE_URL), hostOf(env.OPENAI_BASE_URL)]) if (h) hosts.add(h);
  return [...hosts];
}

export function ledgerIsPersistent(env: Env = process.env): boolean {
  if (env.DATABASE_URL?.trim()) return true;
  return (env.PGLITE_DIR ?? "").trim() !== "memory://";
}

export type PaidRunBudget = { capUsd: number; since: string; committedUsd: number; remainingUsd: number };

/**
 * Validates the configuration (no I/O). Exported for tests; preparePaidRun() calls it first.
 * Returns the parsed cap, or throws PaidRunRefused.
 */
export async function checkPaidRunConfig(env: Env = process.env, now = new Date()): Promise<{ capUsd: number; since: Date }> {
  if (/^(1|true|yes)$/i.test(env.CI?.trim() ?? "")) throw new PaidRunRefused("paid provider requests never run in CI (CI is set).");
  const { parseSpendCap } = await import("./spend-cap");
  const parsed = parseSpendCap({ ...env, AI_SPEND_CAP_REQUIRED: "true" }, now);
  if (!parsed.ok) throw new PaidRunRefused(`the spending cap is ${parsed.reason}.`);
  if (parsed.capUsd === null || parsed.capUsd <= 0) throw new PaidRunRefused("the spending cap must be greater than $0.");
  if (!ledgerIsPersistent(env)) {
    throw new PaidRunRefused("the usage ledger is in memory (PGLITE_DIR=memory://), so earlier spending wouldn't count against the cap. Use a persistent PGLITE_DIR or DATABASE_URL.");
  }
  return { capUsd: parsed.capUsd, since: parsed.since };
}

/** Full pre-flight: configuration, then recorded spending. Turns on required-cap mode. Sends nothing. */
export async function preparePaidRun(env: Env = process.env): Promise<PaidRunBudget> {
  const { capUsd, since } = await checkPaidRunConfig(env);
  env.AI_SPEND_CAP_REQUIRED = "true";
  const { committedSpendUsd } = await import("./spend-cap");
  const { usd } = await committedSpendUsd(since, env);
  if (usd >= capUsd - 1e-9) {
    throw new PaidRunRefused(`the spending cap of $${capUsd.toFixed(2)} is already used up: about $${usd.toFixed(4)} recorded since ${since.toISOString()}.`);
  }
  return { capUsd, since: since.toISOString(), committedUsd: usd, remainingUsd: capUsd - usd };
}

const GUARD = Symbol.for("brandpilot.paidRequestGuard");

export function paidRequestGuardInstalled(): boolean {
  return Boolean((globalThis.fetch as unknown as Record<symbol, unknown>)[GUARD]);
}

/** Blocks provider requests that don't hold a spend-cap reservation, and paid hosts with no cap accounting. */
export async function installPaidRequestGuard(env: Env = process.env): Promise<void> {
  if (paidRequestGuardInstalled()) return;
  const { activeReservations } = await import("./spend-cap");
  const capped = new Set(cappedProviderHosts(env));
  const uncapped = new Set(UNCAPPED_PAID_HOSTS);
  const inner = globalThis.fetch;
  const guarded = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = hostOf(url);
    if (host && uncapped.has(host)) throw new PaidRunRefused(`blocked a request to ${host}: it isn't covered by the spending cap.`);
    if (host && capped.has(host) && activeReservations() < 1) {
      throw new PaidRunRefused(`blocked a request to ${host} that holds no reservation under the spending cap.`);
    }
    return inner(input, init);
  }) as typeof fetch;
  Object.defineProperty(guarded, GUARD, { value: true });
  globalThis.fetch = guarded;
}
