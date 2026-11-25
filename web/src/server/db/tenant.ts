import "server-only";
import { sql } from "drizzle-orm";
import { getDb, type DB } from "./client";
import { log } from "../log";

/**
 * Row-level security pilot (launch gate S8; docs/RLS_PILOT.md). Migration 0016 adds policies on
 * brands, posts and creatives that restrict rows to one organisation **when a transaction sets
 * app.org_id**. withTenant runs `fn` in such a transaction when RLS_PILOT=on, so a query in it that
 * forgets its organisation filter still can't read or write another organisation's rows on those
 * tables. With RLS_PILOT off (the default) it just runs `fn` on the shared connection.
 *
 * The application's own checks stay the primary control; this is a second layer.
 */
export function rlsPilotOn(env: Record<string, string | undefined> = process.env) {
  return (env.RLS_PILOT ?? "").trim().toLowerCase() === "on";
}

export async function withTenant<T>(workspaceId: string, fn: (db: DB) => Promise<T>, env: Record<string, string | undefined> = process.env): Promise<T> {
  const db = await getDb();
  if (!rlsPilotOn(env)) return fn(db);
  if (!workspaceId) throw new Error("withTenant needs an organisation id.");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${workspaceId}, true)`);
    return fn(tx as unknown as DB);
  });
}

/**
 * Superusers and roles with BYPASSRLS ignore every policy. Logged once at start-up on Postgres in
 * staging and production, where the app should use an ordinary role (docs/RLS_PILOT.md).
 */
export async function checkRlsRole(db: DB) {
  try {
    type Row = { rolsuper: boolean; rolbypassrls: boolean };
    // postgres-js returns an array of rows; PGlite returns { rows }.
    const r = (await db.execute(sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`)) as unknown;
    const row = (Array.isArray(r) ? r[0] : (r as { rows?: Row[] }).rows?.[0]) as Row | undefined;
    if (row && (row.rolsuper || row.rolbypassrls)) {
      log.warn("db.role_bypasses_rls", { superuser: Boolean(row.rolsuper), bypassRls: Boolean(row.rolbypassrls), hint: "Connect as an ordinary role so row-level security applies (docs/RLS_PILOT.md)." });
      return false;
    }
    return true;
  } catch {
    return null;
  }
}

export class RlsNotEffectiveError extends Error {
  constructor() {
    super("RLS_PILOT=on, but the database role is a superuser or has BYPASSRLS, so row-level security would do nothing. Connect as an ordinary role (docs/RLS_PILOT.md), or turn RLS_PILOT off.");
  }
}

/** In strict environments with the pilot on: fail unless policies actually apply to this role. */
export async function assertRlsEffective(db: DB) {
  // Fail closed: a role check that can't run counts as not effective.
  if ((await checkRlsRole(db)) !== true) throw new RlsNotEffectiveError();
}
