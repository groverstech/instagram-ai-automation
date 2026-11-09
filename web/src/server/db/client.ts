import "server-only";
import path from "node:path";
import fs from "node:fs";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";
import { MIGRATIONS_DIR, migrationStatus, runPostgresMigrations } from "./migrate";

export type DB = PgliteDatabase<typeof schema>;

const MIGRATIONS = MIGRATIONS_DIR;

type GlobalDb = { __db?: Promise<DB> };
const g = globalThis as unknown as GlobalDb;

async function create(): Promise<DB> {
  const url = process.env.DATABASE_URL;
  if (url) {
    // Migrations: under an advisory lock on their own connection (src/server/db/migrate.ts).
    // MIGRATE_ON_START=false leaves them to the `npm run db:migrate` deploy step.
    if (process.env.MIGRATE_ON_START !== "false") await runPostgresMigrations(url, MIGRATIONS);
    const { default: postgres } = await import("postgres");
    const max = Number(process.env.DATABASE_POOL_MAX ?? 10);
    const sql = postgres(url, { max: Number.isFinite(max) && max > 0 ? max : 10, prepare: false, onnotice: () => {} });
    const db = drizzlePg(sql, { schema });
    if (process.env.MIGRATE_ON_START === "false") {
      const st = await migrationStatus(db, MIGRATIONS);
      if (!st.upToDate) console.warn(JSON.stringify({ ts: new Date().toISOString(), level: "warn", event: "db.migrations_pending", pending: st.pending }));
    }
    // Both drivers expose the same query-builder surface for everything this app uses.
    return db as unknown as DB;
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const dataDir = process.env.PGLITE_DIR ?? path.join(process.cwd(), ".data", "pg");
  if (dataDir !== "memory://") fs.mkdirSync(dataDir, { recursive: true });
  const client = await PGlite.create({ dataDir, extensions: { vector } });
  await client.exec("create extension if not exists vector");
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder: MIGRATIONS });
  return db;
}

export function getDb(): Promise<DB> {
  if (!g.__db) {
    g.__db = create().catch((e) => {
      g.__db = undefined;
      throw e;
    });
  }
  return g.__db;
}

export { schema };
