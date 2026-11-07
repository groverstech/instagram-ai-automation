import "server-only";
import path from "node:path";
import fs from "node:fs";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import * as schema from "./schema";

export type DB = PgliteDatabase<typeof schema>;

const MIGRATIONS = path.join(process.cwd(), "drizzle");

type GlobalDb = { __db?: Promise<DB> };
const g = globalThis as unknown as GlobalDb;

async function create(): Promise<DB> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { default: postgres } = await import("postgres");
    const sql = postgres(url, { max: 10, prepare: false });
    await sql`create extension if not exists vector`;
    const db = drizzlePg(sql, { schema });
    await migratePg(db, { migrationsFolder: MIGRATIONS });
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
