import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "./db/client";
import { migrationStatus } from "./db/migrate";
import { storage } from "./storage";
import { configSummary } from "./config";

/**
 * Readiness: can this instance serve traffic? Database reachable, schema current, storage
 * writable, and configuration free of errors. Reports states and counts only: never
 * configuration values, connection strings or secrets.
 */
export type Check = { ok: boolean; ms?: number; detail?: string };

const TIMEOUT_MS = 3000;
async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; ms: number; error?: string }> {
  const started = Date.now();
  try {
    const value = await Promise.race([fn(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS))]);
    return { value, ms: Date.now() - started };
  } catch (e) {
    return { ms: Date.now() - started, error: e instanceof Error && e.message === "timeout" ? "timeout" : "unavailable" };
  }
}

export function version() {
  return process.env.APP_VERSION || process.env.GIT_SHA || "dev";
}

export async function readiness() {
  const checks: Record<string, Check> = {};

  const db = await timed(async () => {
    const d = await getDb();
    await d.execute(sql`select 1`);
    return d;
  });
  checks.database = { ok: !db.error, ms: db.ms, ...(db.error ? { detail: db.error } : {}) };

  if (db.value) {
    const m = await timed(() => migrationStatus(db.value!));
    checks.migrations = m.value
      ? { ok: m.value.upToDate, detail: `${m.value.applied}/${m.value.expected} applied`, ms: m.ms }
      : { ok: false, detail: m.error, ms: m.ms };
  } else {
    checks.migrations = { ok: false, detail: "database unavailable" };
  }

  const st = await timed(() => storage.health());
  checks.storage = st.value ? { ok: st.value.ok, ms: st.ms, detail: `${storage.driver}${st.value.detail ? `: ${st.value.detail}` : ""}` } : { ok: false, ms: st.ms, detail: st.error };

  const cfg = configSummary();
  checks.config = { ok: cfg.errors === 0, detail: `${cfg.errors} errors, ${cfg.warnings} warnings` };

  const ready = Object.values(checks).every((c) => c.ok);
  return { status: ready ? ("ready" as const) : ("not_ready" as const), version: version(), deployEnv: cfg.deployEnv, checks };
}
