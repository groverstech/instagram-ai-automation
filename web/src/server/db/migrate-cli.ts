// `npm run db:migrate`: apply database migrations as a separate deploy step (ADR-003).
// Safe to run concurrently with other instances (advisory lock). Exits non-zero on failure so
// the deploy pipeline stops before new application code starts.
import { enforceConfig } from "../config";
import { expectedMigrations, runPostgresMigrations } from "./migrate";
import { log } from "../log";

async function main() {
  enforceConfig("migrate");
  const url = process.env.DATABASE_URL;
  const started = Date.now();
  if (!url) {
    // Development: PGlite migrates when the client is created.
    const { getDb } = await import("./client");
    await getDb();
    log.info("db.migrate.done", { database: "pglite", expected: expectedMigrations().length, ms: Date.now() - started });
    return;
  }
  const res = await runPostgresMigrations(url, undefined, {
    onLocked: () => log.info("db.migrate.locked"),
  });
  log.info("db.migrate.done", { database: "postgres", applied: res.applied, total: res.total, expected: res.expected, ms: Date.now() - started });
  if (res.total < res.expected) throw new Error(`Only ${res.total} of ${res.expected} migrations are applied.`);
}

main().then(
  () => process.exit(0),
  (e) => {
    log.error("db.migrate.failed", { error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  },
);
