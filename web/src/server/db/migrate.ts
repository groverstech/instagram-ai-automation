import "server-only";
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";

/**
 * Database migrations (ADR-003 in docs/ARCHITECTURE_DECISIONS.md).
 *
 * - On Postgres, migrations run on one dedicated connection holding a session-level advisory
 *   lock. Concurrent runs (several instances starting, or a deploy job racing a web start) are
 *   serialised: the second waits, then finds nothing left to apply.
 * - Recommended for staging/production: run `npm run db:migrate` as its own deploy step, and set
 *   MIGRATE_ON_START=false so app instances never migrate.
 * - Migrations are additive (expand/contract): a release never drops what the previous release
 *   still uses, so rolling back the application is always safe.
 */
export const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

/** Arbitrary constant 64-bit key for pg_advisory_lock, unique to BrandPilot migrations. */
export const MIGRATION_LOCK_KEY = 7_316_244_901_337n;

export function expectedMigrations(dir = MIGRATIONS_DIR): string[] {
  const journal = JSON.parse(fs.readFileSync(path.join(dir, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
  return journal.entries.map((e) => e.tag);
}

type Queryable = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

/** How many journal migrations the database has applied. Works for Postgres and PGlite. */
export async function migrationStatus(db: Queryable, dir = MIGRATIONS_DIR) {
  const expected = expectedMigrations(dir).length;
  let applied = 0;
  try {
    const res = (await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)) as { rows?: { n: number }[] } | { n: number }[];
    const rows = Array.isArray(res) ? res : (res.rows ?? []);
    applied = Number(rows[0]?.n ?? 0);
  } catch {
    applied = 0; // table doesn't exist yet: nothing applied
  }
  return { applied, expected, pending: Math.max(0, expected - applied), upToDate: applied >= expected };
}

/**
 * Apply pending migrations to Postgres under the advisory lock. Returns how many were applied
 * by this call.
 */
export async function runPostgresMigrations(url: string, dir = MIGRATIONS_DIR, opts: { onLocked?: () => void } = {}) {
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  // One connection: an advisory lock belongs to a session, and every statement must use it.
  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const db = drizzle(client);
  try {
    await client`select pg_advisory_lock(${MIGRATION_LOCK_KEY.toString()}::bigint)`;
    opts.onLocked?.();
    await client`create extension if not exists vector`;
    const before = await migrationStatus(db, dir);
    await migrate(db, { migrationsFolder: dir });
    const after = await migrationStatus(db, dir);
    return { applied: after.applied - before.applied, total: after.applied, expected: after.expected };
  } finally {
    await client`select pg_advisory_unlock(${MIGRATION_LOCK_KEY.toString()}::bigint)`.catch(() => {});
    await client.end({ timeout: 5 });
  }
}
