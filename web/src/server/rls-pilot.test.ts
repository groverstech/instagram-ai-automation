/**
 * S8: row-level security pilot (migration 0016, src/server/db/tenant.ts). Real Postgres only:
 * PGlite runs as a superuser, and superusers bypass RLS. The app here connects as an ordinary
 * role, as it must in production. Randomised organisations, brands, posts and creatives.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const dbName = `bp_rls_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const role = `bp_app_${Math.floor(Math.random() * 1e9)}`;
let adminDbUrl = "";

beforeAll(async () => {
  if (!ADMIN_URL) return;
  const { default: postgres } = await import("postgres");
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${dbName}`);
  await admin.unsafe(`create role ${role} login password 'app-pw' nosuperuser nobypassrls`);
  await admin.end();
  const u = new URL(ADMIN_URL);
  u.pathname = `/${dbName}`;
  adminDbUrl = u.toString();
  const { runPostgresMigrations } = await import("./db/migrate");
  await runPostgresMigrations(adminDbUrl);
  const a = postgres(adminDbUrl, { max: 1, onnotice: () => {} });
  await a.unsafe(`grant usage on schema public, drizzle to ${role}; grant select, insert, update, delete on all tables in schema public to ${role}; grant select on all tables in schema drizzle to ${role}; grant execute on all functions in schema public to ${role}`);
  await a.end();
  // The app connects as the ordinary role and never migrates on start.
  const appUrl = new URL(adminDbUrl);
  appUrl.username = role;
  appUrl.password = "app-pw";
  process.env.DATABASE_URL = appUrl.toString();
  process.env.MIGRATE_ON_START = "false";
});

afterAll(async () => {
  if (!ADMIN_URL) return;
  const { default: postgres } = await import("postgres");
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${dbName} with (force)`).catch(() => {});
  await admin.unsafe(`drop role if exists ${role}`).catch(() => {});
  await admin.end();
});

describe.skipIf(!ADMIN_URL)("row-level security pilot", () => {
  type Org = { id: string; brands: string[]; posts: string[]; creatives: string[] };
  const orgs: Org[] = [];

  it("seeds randomised organisations; with no organisation set, behaviour is unchanged (everything visible)", async () => {
    const { getDb, schema } = await import("./db/client");
    const db = await getDb();
    const rand = (n: number) => 1 + Math.floor(Math.random() * n);
    for (let i = 0; i < 5; i++) {
      const [w] = await db.insert(schema.workspaces).values({ name: `RLS org ${i}` }).returning();
      const o: Org = { id: w.id, brands: [], posts: [], creatives: [] };
      for (let b = 0; b < rand(3); b++) {
        const [br] = await db.insert(schema.brands).values({ workspaceId: w.id, name: `B${i}.${b}` }).returning();
        o.brands.push(br.id);
        for (let p = 0; p < rand(4); p++) {
          const [po] = await db.insert(schema.posts).values({ brandId: br.id, platform: "instagram", title: `P${i}.${b}.${p}` }).returning();
          o.posts.push(po.id);
        }
        for (let c = 0; c < rand(3); c++) {
          const [cr] = await db.insert(schema.creatives).values({ brandId: br.id, format: "instagram_portrait", style: "photo", concept: {} }).returning();
          o.creatives.push(cr.id);
        }
      }
      orgs.push(o);
    }
    expect(await db.$count(schema.posts)).toBe(orgs.reduce((n, o) => n + o.posts.length, 0));
  });

  it("under withTenant, a query without any organisation filter sees only that organisation's brands, posts and creatives", async () => {
    process.env.RLS_PILOT = "on";
    const { schema } = await import("./db/client");
    const { withTenant } = await import("./db/tenant");
    for (const o of orgs) {
      const [brands, posts, creatives] = await withTenant(o.id, async (t) => [
        await t.select({ id: schema.brands.id }).from(schema.brands),
        await t.select({ id: schema.posts.id }).from(schema.posts),
        await t.select({ id: schema.creatives.id }).from(schema.creatives),
      ]);
      expect(brands.map((r) => r.id).sort()).toEqual([...o.brands].sort());
      expect(posts.map((r) => r.id).sort()).toEqual([...o.posts].sort());
      expect(creatives.map((r) => r.id).sort()).toEqual([...o.creatives].sort());
    }
  });

  it("can't write into or change another organisation's rows", async () => {
    const { schema } = await import("./db/client");
    const { withTenant } = await import("./db/tenant");
    const [a, b] = orgs;
    const err = await withTenant(a.id, (t) => t.insert(schema.posts).values({ brandId: b.brands[0], platform: "instagram", title: "intruder" })).then(
      () => null,
      (e: Error & { cause?: Error }) => e,
    );
    expect(String(err?.cause?.message ?? err?.message)).toMatch(/row-level security/);
    const changed = await withTenant(a.id, (t) => t.update(schema.posts).set({ title: "hijacked" }).where(sql`true`).returning({ id: schema.posts.id }));
    expect(changed.map((r) => r.id).sort()).toEqual([...a.posts].sort()); // only its own rows
    const deleted = await withTenant(a.id, (t) => t.delete(schema.creatives).where(sql`id = ${b.creatives[0]}`).returning());
    expect(deleted).toEqual([]);
  });

  it("the setting is per transaction: it never leaks to the next query on a pooled connection", async () => {
    const { getDb, schema } = await import("./db/client");
    const { withTenant } = await import("./db/tenant");
    await withTenant(orgs[0].id, (t) => t.select().from(schema.brands));
    const db = await getDb();
    expect(await db.$count(schema.brands)).toBe(orgs.reduce((n, o) => n + o.brands.length, 0));
  });

  it("with RLS_PILOT off, withTenant is a pass-through", async () => {
    process.env.RLS_PILOT = "off";
    const { schema } = await import("./db/client");
    const { withTenant } = await import("./db/tenant");
    const all = await withTenant(orgs[0].id, (t) => t.select({ id: schema.posts.id }).from(schema.posts));
    expect(all.length).toBe(orgs.reduce((n, o) => n + o.posts.length, 0));
  });

  it("the start-up check passes for an ordinary role and flags a superuser", async () => {
    const { getDb } = await import("./db/client");
    const { checkRlsRole } = await import("./db/tenant");
    expect(await checkRlsRole(await getDb())).toBe(true);
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const c = postgres(adminDbUrl, { max: 1, onnotice: () => {} });
    expect(await checkRlsRole(drizzle(c) as never)).toBe(false); // the test admin is a superuser
    await c.end();
  });
});
