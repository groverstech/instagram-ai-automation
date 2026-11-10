/**
 * Real-Postgres checks (not PGlite). Runs when TEST_DATABASE_URL points at a Postgres 15+ server
 * with pgvector, where the role may create databases. CI provides one as a service container;
 * locally: TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/postgres npm test
 */
import { afterAll, describe, expect, it } from "vitest";

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const created: string[] = [];

async function freshDatabase(tag: string) {
  const { default: postgres } = await import("postgres");
  const admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} });
  const name = `bp_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  created.push(name);
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${name}`;
  return u.toString();
}

afterAll(async () => {
  if (!ADMIN_URL || !created.length) return;
  const { default: postgres } = await import("postgres");
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  for (const name of created) await admin.unsafe(`drop database if exists ${name} with (force)`).catch(() => {});
  await admin.end();
});

describe.skipIf(!ADMIN_URL)("real Postgres", () => {
  it("serialises concurrent migration runs with the advisory lock: each migration applied exactly once", async () => {
    const { runPostgresMigrations, expectedMigrations } = await import("./db/migrate");
    const url = await freshDatabase("mig");
    const results = await Promise.all([runPostgresMigrations(url), runPostgresMigrations(url), runPostgresMigrations(url)]);
    const expected = expectedMigrations().length;
    expect(results.reduce((n, r) => n + r.applied, 0)).toBe(expected); // applied once in total, not 3×
    expect(results.every((r) => r.total === expected)).toBe(true);
    const { default: postgres } = await import("postgres");
    const sql = postgres(url, { max: 1 });
    const [{ n }] = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    expect(n).toBe(expected);
    await sql.end();
  }, 120_000);

  it("runs the app's database client, readiness and audit log on real Postgres", async () => {
    const url = await freshDatabase("app");
    process.env.DATABASE_URL = url;
    process.env.STORAGE_DIR = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "bp-pg-"));
    const { getDb, schema } = await import("./db/client");
    const { readiness } = await import("./health");
    const { audit, auditTrail } = await import("./audit");
    const db = await getDb();
    const [w] = await db.insert(schema.workspaces).values({ name: "PG Co" }).returning();
    await audit({ action: "workspace.update", workspaceId: w.id, actorUserId: "u1", ip: "203.0.113.1", details: { type: "agency" } });
    expect((await auditTrail(w.id))[0]).toMatchObject({ action: "workspace.update", outcome: "success" });
    // Members' sign-ins (the correlated membership subquery) and brand scope on the real driver.
    const [u] = await db.insert(schema.users).values({ email: "pg@x.test", name: "PG", passwordHash: "x" }).returning();
    const [b] = await db.insert(schema.brands).values({ workspaceId: w.id, name: "PG Brand" }).returning();
    await db.insert(schema.workspaceMembers).values({ workspaceId: w.id, userId: u.id, role: "owner", createdAt: new Date(Date.now() - 60_000) });
    await audit({ action: "auth.login", actorUserId: u.id });
    await audit({ action: "brand.create", workspaceId: w.id, brandId: b.id, actorUserId: u.id });
    expect((await auditTrail(w.id)).map((e) => e.action).sort()).toEqual(["auth.login", "brand.create", "workspace.update"]);
    expect((await auditTrail(w.id, { scope: { brandIds: [b.id] } })).map((e) => e.action)).toEqual(["brand.create"]);
    const r = await readiness();
    expect(r.checks.database.ok).toBe(true);
    expect(r.checks.migrations.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(url);
  }, 120_000);

  it("reports pending migrations on an un-migrated database until the deploy step applies them", async () => {
    const url = await freshDatabase("nomig");
    const { runPostgresMigrations, migrationStatus, expectedMigrations } = await import("./db/migrate");
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    // A database the migrate step hasn't run against yet.
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    const db = drizzle(sql);
    expect((await migrationStatus(db)).applied).toBe(0);
    expect((await migrationStatus(db)).pending).toBe(expectedMigrations().length);
    await runPostgresMigrations(url);
    expect((await migrationStatus(db)).upToDate).toBe(true);
    await sql.end();
  }, 120_000);

  it("in production the app never migrates on start: the database stays as the deploy step left it", async () => {
    const url = await freshDatabase("prodstart");
    const saved = { ...process.env };
    const g = globalThis as { __db?: unknown };
    const cached = g.__db;
    try {
      Object.assign(process.env, { DATABASE_URL: url, DEPLOY_ENV: "production" });
      delete process.env.MIGRATE_ON_START;
      g.__db = undefined; // a fresh app process
      const { getDb } = await import("./db/client");
      const { readiness } = await import("./health");
      await getDb();
      const { default: postgres } = await import("postgres");
      const sql = postgres(url, { max: 1, onnotice: () => {} });
      const [{ t }] = await sql`select to_regclass('public.users')::text as t`;
      expect(t).toBeNull(); // no tables were created
      await sql.end();
      const r = await readiness();
      expect(r.checks.migrations.ok).toBe(false); // so the load balancer keeps traffic away
      expect(r.status).toBe("not_ready");
    } finally {
      process.env = saved;
      g.__db = cached;
    }
  }, 120_000);
});
