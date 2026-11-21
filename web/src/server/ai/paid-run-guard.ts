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

export type LedgerInfo = {
  /** postgres: DATABASE_URL (durable across restarts and container replacement when it is managed Postgres). pglite-file: a local file, lost with this machine or container. */
  storage: "postgres" | "pglite-file" | "pglite-memory";
  durable: boolean;
  /** When this database started keeping the ledger (ai_ledger_meta); spending before it isn't recorded here. */
  createdAt: Date | null;
};

/** Where the usage ledger lives and since when it has been kept. Opens the database; sends nothing. */
export async function ledgerInfo(env: Env = process.env): Promise<LedgerInfo> {
  const storage = env.DATABASE_URL?.trim() ? "postgres" : (env.PGLITE_DIR ?? "").trim() === "memory://" ? "pglite-memory" : "pglite-file";
  const { getDb, schema } = await import("../db/client");
  const { eq } = await import("drizzle-orm");
  const db = await getDb();
  const [row] = await db.select().from(schema.aiLedgerMeta).where(eq(schema.aiLedgerMeta.key, "ledger"));
  return { storage, durable: storage === "postgres", createdAt: row?.createdAt ?? null };
}

export type PaidRunBudget = {
  capUsd: number;
  since: string;
  committedUsd: number;
  pendingAttempts: number;
  remainingUsd: number;
  ledger: { storage: LedgerInfo["storage"]; durable: boolean; createdAt: string };
  /** What the cap covers, in plain words: printed by the commands. */
  coverage: string;
};

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

/**
 * Full pre-flight: configuration, the ledger's durability and coverage, then recorded spending.
 * Turns on required-cap mode. Sends nothing.
 *
 * Durability: the cap can only count spending this ledger has recorded. With DATABASE_URL (managed
 * Postgres) the ledger survives restarts and container replacement. A local PGlite file does not
 * survive this machine or container, so a run on it is refused unless the operator acknowledges a
 * single-session validation (AI_SPEND_LEDGER_SINGLE_SESSION=true). Either way, AI_SPEND_CAP_SINCE
 * must not be earlier than the ledger's creation: spending before it isn't recorded here, and the
 * cap must not appear to cover it.
 */
export async function preparePaidRun(env: Env = process.env): Promise<PaidRunBudget> {
  const { capUsd, since } = await checkPaidRunConfig(env);
  let ledger: LedgerInfo;
  try {
    ledger = await ledgerInfo(env);
  } catch (e) {
    throw new PaidRunRefused(`the usage ledger (database) is unavailable, so spending can't be recorded: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!ledger.createdAt) throw new PaidRunRefused("the usage ledger has no creation record (ai_ledger_meta): apply the database migrations first.");
  if (!ledger.durable && !/^(1|true|yes)$/i.test(env.AI_SPEND_LEDGER_SINGLE_SESSION?.trim() ?? "")) {
    throw new PaidRunRefused(
      `the usage ledger is a local file (${ledger.storage}) that won't survive this machine or container, so the cap can't cover spending from other sessions. ` +
        "Use DATABASE_URL (managed Postgres), or acknowledge a single-session validation with AI_SPEND_LEDGER_SINGLE_SESSION=true.",
    );
  }
  if (since.getTime() < ledger.createdAt.getTime()) {
    const from = ledger.createdAt.toISOString().replace(/\.\d+Z$/, "Z");
    throw new PaidRunRefused(
      `this usage ledger was created at ${ledger.createdAt.toISOString()}, after AI_SPEND_CAP_SINCE (${since.toISOString()}): spending between those times isn't recorded here, so the cap can't cover it. ` +
        `Set AI_SPEND_CAP_SINCE to ${from} or later, and lower AI_SPEND_CAP_USD by anything the provider consoles show was spent before then.`,
    );
  }
  env.AI_SPEND_CAP_REQUIRED = "true";
  const { committedSpendUsd } = await import("./spend-cap");
  let usd: number;
  let pendingAttempts: number;
  try {
    ({ usd, pendingAttempts } = await committedSpendUsd(since, env));
  } catch (e) {
    throw new PaidRunRefused(`recorded spending couldn't be read from the usage ledger: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (usd >= capUsd - 1e-9) {
    throw new PaidRunRefused(`the spending cap of $${capUsd.toFixed(2)} is already used up: about $${usd.toFixed(4)} recorded since ${since.toISOString()}.`);
  }
  const coverage = ledger.durable
    ? `The cap covers every request recorded in this database (${ledger.storage}) since ${since.toISOString()}.`
    : `SINGLE-SESSION LEDGER: the cap covers only requests recorded on this machine since ${since.toISOString()}. Spending from earlier sessions or other containers is NOT counted; check the provider consoles.`;
  return {
    capUsd,
    since: since.toISOString(),
    committedUsd: usd,
    pendingAttempts,
    remainingUsd: capUsd - usd,
    ledger: { storage: ledger.storage, durable: ledger.durable, createdAt: ledger.createdAt.toISOString() },
    coverage,
  };
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
