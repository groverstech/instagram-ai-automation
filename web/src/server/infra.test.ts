import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { desc, eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.AI_PROVIDER = "mock";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-infra-"));

const { checkConfig, isStrict, deployEnv, enforceConfig, migrateOnStart, configSummary } = await import("./config");
const { clientIp } = await import("./client-ip");
const { hashPassword, verifyPassword, needsRehash, verifyDummy } = await import("./auth/password");
const { storage, localDisk, assertKey, StorageKeyError, createStorage, StorageNotConfigured } = await import("./storage");
const { readiness } = await import("./health");
const { audit, auditTrail } = await import("./audit");
const { getDb, schema } = await import("./db/client");
const { expectedMigrations, migrationStatus } = await import("./db/migrate");

const keys = (env: Record<string, string>) => checkConfig(env).filter((p) => p.level === "error").map((p) => p.key);
const goodProd = {
  DEPLOY_ENV: "production",
  NODE_ENV: "production",
  APP_SECRET: "x".repeat(48),
  DATABASE_URL: "postgres://u:p@db:5432/bp",
  ANTHROPIC_API_KEY: "test-placeholder",
  APP_URL: "https://app.example.com",
  STORAGE_DRIVER: "local",
  ALLOW_LOCAL_STORAGE_IN_PRODUCTION: "true",
  MIGRATE_ON_START: "false",
  TRUSTED_PROXY_HOPS: "1",
};

describe("production configuration validation", () => {
  it("accepts a complete production configuration", () => {
    expect(keys(goodProd)).toEqual([]);
  });

  it("refuses unsafe production settings, naming only the variables (never values)", () => {
    const bad = { ...goodProd, APP_SECRET: "short", DATABASE_URL: "", AI_PROVIDER: "mock", AI_ALLOW_MOCK_IN_PRODUCTION: "true", APP_URL: "http://app.example.com", ALLOW_LOCAL_STORAGE_IN_PRODUCTION: "" };
    const errs = keys(bad);
    expect(errs).toEqual(expect.arrayContaining(["APP_SECRET", "DATABASE_URL", "AI_PROVIDER", "AI_ALLOW_MOCK_IN_PRODUCTION", "APP_URL", "STORAGE_DRIVER"]));
    expect(JSON.stringify(checkConfig(bad))).not.toContain("short");
  });

  it("never lets production depend on local disk without an explicit single-instance opt-in", () => {
    expect(keys({ ...goodProd, ALLOW_LOCAL_STORAGE_IN_PRODUCTION: "" })).toContain("STORAGE_DRIVER");
    expect(keys({ ...goodProd, STORAGE_DRIVER: "s3" })).toContain("STORAGE_DRIVER"); // adapter arrives in PR 4.2
  });

  it("checks the effective AI mode: an ignored mock setting still needs real credentials", () => {
    const staging = { ...goodProd, DEPLOY_ENV: "staging", ANTHROPIC_API_KEY: "" };
    expect(keys({ ...staging, AI_PROVIDER: "mock" })).toContain("ANTHROPIC_API_KEY"); // mock ignored → real provider
    expect(keys({ ...staging, AI_PROVIDER: "mock", AI_ALLOW_MOCK_IN_PRODUCTION: "true" })).not.toContain("ANTHROPIC_API_KEY"); // demo staging
    expect(keys({ ...goodProd, AI_PROVIDER: "mock", AI_ALLOW_MOCK_IN_PRODUCTION: "true" })).toEqual(expect.arrayContaining(["AI_PROVIDER", "AI_ALLOW_MOCK_IN_PRODUCTION"]));
  });

  it("flags half-configured integrations", () => {
    expect(keys({ ...goodProd, META_APP_ID: "123" })).toContain("META_APP_SECRET");
    expect(keys({ ...goodProd, STRIPE_SECRET_KEY: "sk_test_placeholder" })).toContain("STRIPE_WEBHOOK_SECRET");
    expect(keys({ ...goodProd, CRON_SECRET: "too-short" })).toContain("CRON_SECRET");
    expect(keys({ ...goodProd, TRUSTED_PROXY_HOPS: "two" })).toContain("TRUSTED_PROXY_HOPS");
  });

  it("image models: only catalogued ones (gpt-image-1 was shut down); per-image price settings are retired", () => {
    expect(keys({ ...goodProd, OPENAI_IMAGE_MODEL: "gpt-image-1" })).toContain("OPENAI_IMAGE_MODEL");
    expect(keys({ ...goodProd, OPENAI_IMAGE_EDIT_MODEL: "gpt-image-2.6-sunburst", OPENAI_IMAGE_MODEL: "gpt-image-2.6-flare", OPENAI_IMAGE_COMPLEXITY: "medium", OPENAI_IMAGE_PRICE_OUTPUT_PER_MTOK: "30" })).toEqual([]);
    expect(keys({ ...goodProd, OPENAI_IMAGE_COMPLEXITY: "extreme" })).toContain("OPENAI_IMAGE_COMPLEXITY");
    expect(keys({ ...goodProd, OPENAI_IMAGE_PRICE_OUTPUT_PER_MTOK: "lots" })).toContain("OPENAI_IMAGE_PRICE_OUTPUT_PER_MTOK");
    expect(checkConfig({ ...goodProd, IMAGE_PRICE_USD: "0.2" }).filter((i) => i.level === "warning").map((i) => i.key)).toContain("IMAGE_PRICE_USD");
  });

  it("only stops the process in staging/production; local `next start`, demos and E2E keep working", () => {
    let exited: number | null = null;
    const exit = ((code: number) => {
      exited = code;
    }) as (code: number) => never;
    // A local production build without DEPLOY_ENV (the E2E harness): warnings and errors are logged, no exit.
    enforceConfig("test", { NODE_ENV: "production", AI_PROVIDER: "mock", AI_ALLOW_MOCK_IN_PRODUCTION: "true" }, exit);
    expect(exited).toBeNull();
    expect(isStrict({ NODE_ENV: "production" })).toBe(false);
    enforceConfig("test", { ...goodProd, APP_SECRET: "" }, exit);
    expect(exited).toBe(1);
    expect(deployEnv({ DEPLOY_ENV: "nonsense" })).toBe("development");
    expect(keys({ DEPLOY_ENV: "nonsense" })).toContain("DEPLOY_ENV");
  });
});

describe("production safeguards", () => {
  const levelOf = (env: Record<string, string>, key: string) => checkConfig(env).find((p) => p.key === key)?.level;

  it("never migrates at start-up in staging or production unless explicitly asked", () => {
    expect(migrateOnStart({ DEPLOY_ENV: "production" })).toBe(false);
    expect(migrateOnStart({ DEPLOY_ENV: "staging" })).toBe(false);
    expect(migrateOnStart({ DEPLOY_ENV: "production", MIGRATE_ON_START: "yes" })).toBe(false); // invalid → never
    expect(migrateOnStart({ DEPLOY_ENV: "prod" })).toBe(false); // unknown env → strict
    expect(migrateOnStart({ DEPLOY_ENV: "staging", MIGRATE_ON_START: "true" })).toBe(true);
    // Local, demo and E2E behaviour unchanged.
    expect(migrateOnStart({})).toBe(true);
    expect(migrateOnStart({ NODE_ENV: "production" })).toBe(true);
    expect(migrateOnStart({ DEPLOY_ENV: "demo" })).toBe(true);
    expect(migrateOnStart({ MIGRATE_ON_START: "false" })).toBe(false);
  });

  it("production refuses MIGRATE_ON_START=true; staging warns; invalid values are errors", () => {
    expect(levelOf({ ...goodProd, MIGRATE_ON_START: "true" }, "MIGRATE_ON_START")).toBe("error");
    expect(levelOf({ ...goodProd, DEPLOY_ENV: "staging", MIGRATE_ON_START: "true" }, "MIGRATE_ON_START")).toBe("warning");
    expect(levelOf({ ...goodProd, MIGRATE_ON_START: "yes" }, "MIGRATE_ON_START")).toBe("error");
    const unset: Record<string, string> = { ...goodProd };
    delete unset.MIGRATE_ON_START;
    expect(keys(unset)).toEqual([]); // unset is the safe default in production
  });

  it("production refuses local-disk storage unless explicitly allowed, at boot and at run time", () => {
    expect(keys({ ...goodProd, ALLOW_LOCAL_STORAGE_IN_PRODUCTION: "" })).toContain("STORAGE_DRIVER");
    expect(keys({ ...goodProd, ALLOW_LOCAL_STORAGE_IN_PRODUCTION: "yes" })).toEqual(expect.arrayContaining(["ALLOW_LOCAL_STORAGE_IN_PRODUCTION", "STORAGE_DRIVER"]));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-guard-"));
    for (const env of [{ DEPLOY_ENV: "production" }, { DEPLOY_ENV: "staging" }, { DEPLOY_ENV: "prod" }, { DEPLOY_ENV: "production", ALLOW_LOCAL_STORAGE_IN_PRODUCTION: "yes" }]) {
      expect(() => createStorage({ ...env, STORAGE_DIR: dir })).toThrow(StorageNotConfigured);
    }
    expect(createStorage({ DEPLOY_ENV: "production", ALLOW_LOCAL_STORAGE_IN_PRODUCTION: "true", STORAGE_DIR: dir }).driver).toBe("local");
    expect(createStorage({ STORAGE_DIR: dir }).driver).toBe("local"); // development unchanged
    expect(() => createStorage({ STORAGE_DRIVER: "s3" })).toThrow(/PR 4.2/);
    expect(() => createStorage({ STORAGE_DRIVER: "gcs" })).toThrow(StorageNotConfigured);
  });

  it("an unrecognised DEPLOY_ENV fails closed instead of falling back to development", () => {
    expect(isStrict({ DEPLOY_ENV: "prod" })).toBe(true);
    expect(isStrict({ DEPLOY_ENV: " Production " })).toBe(true);
    expect(deployEnv({ DEPLOY_ENV: " Production " })).toBe("production");
    expect(configSummary({ DEPLOY_ENV: "prod" }).deployEnv).toBe("unknown");
    expect(keys({ DEPLOY_ENV: "prod" })).toContain("DEPLOY_ENV");
    const exit = vi.fn() as unknown as (code: number) => never;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const quietW = vi.spyOn(console, "warn").mockImplementation(() => {});
    enforceConfig("test", { ...goodProd, DEPLOY_ENV: "prod" }, exit);
    expect(exit).toHaveBeenCalledWith(1);
    quiet.mockRestore();
    quietW.mockRestore();
  });

  it("invalid values are clear errors, not silent defaults", () => {
    const bad = keys({ ...goodProd, AI_PROVIDER: "antropic", IMAGE_PROVIDER: "dalle", DATABASE_POOL_MAX: "ten", WORKER_DRAIN_MS: "-5", EMAIL_PROVIDER: "smtp", RUN_JOBS_IN_PROCESS: "no" });
    expect(bad).toEqual(expect.arrayContaining(["AI_PROVIDER", "IMAGE_PROVIDER", "DATABASE_POOL_MAX", "WORKER_DRAIN_MS", "EMAIL_PROVIDER", "RUN_JOBS_IN_PROCESS"]));
    // Messages name the setting and what to use, never the value given.
    for (const p of checkConfig({ ...goodProd, AI_PROVIDER: "antropic", DATABASE_POOL_MAX: "ten" })) expect(p.message).not.toMatch(/antropic|ten\b/);
    expect(keys({ ...goodProd, AI_PROVIDER: "anthropic", IMAGE_PROVIDER: "none", DATABASE_POOL_MAX: "20" })).toEqual([]);
  });

  it("warns when NODE_ENV=production runs without DEPLOY_ENV (safeguards off)", () => {
    expect(checkConfig({ NODE_ENV: "production" }).find((p) => p.key === "DEPLOY_ENV")).toMatchObject({ level: "warning" });
    expect(checkConfig({}).some((p) => p.key === "DEPLOY_ENV")).toBe(false);
  });
});

describe("client IP behind proxies", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it("takes the entry appended by the trusted proxy, not the client-supplied leftmost one", () => {
    // Client spoofs 1.1.1.1; our load balancer appends the real address.
    expect(clientIp(h({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }), {})).toBe("203.0.113.9");
    expect(clientIp(h({ "x-forwarded-for": "1.1.1.1, 198.51.100.4, 203.0.113.9" }), { TRUSTED_PROXY_HOPS: "2" })).toBe("198.51.100.4");
    // Backward compatible with a proxy that overwrites the header (one entry).
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.9" }), {})).toBe("203.0.113.9");
  });
  it("uses a configured edge header (e.g. Cloudflare) and ignores X-Forwarded-For then", () => {
    expect(clientIp(h({ "cf-connecting-ip": "2001:db8::5", "x-forwarded-for": "1.1.1.1" }), { CLIENT_IP_HEADER: "cf-connecting-ip" })).toBe("2001:db8::5");
  });
  it("rejects junk and ignores X-Forwarded-For with no trusted proxy", () => {
    expect(clientIp(h({ "x-forwarded-for": "<script>, also-bad" }), {})).toBe("unknown");
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.9" }), { TRUSTED_PROXY_HOPS: "0" })).toBe("unknown");
  });
});

describe("password hashing", () => {
  it("hashes with self-describing stronger parameters and verifies", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^scrypt2\$16384\$8\$5\$/);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    expect(needsRehash(hash)).toBe(false);
  });
  it("still verifies legacy hashes (no forced resets) and flags them for upgrade on login", async () => {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync("legacy-pass", salt, 64); // the previous format: Node defaults
    const legacy = `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
    expect(await verifyPassword("legacy-pass", legacy)).toBe(true);
    expect(needsRehash(legacy)).toBe(true);
  });
  it("refuses tampered parameters and does equal work for unknown accounts", async () => {
    expect(await verifyPassword("x", "scrypt2$1073741824$8$1$AAAA$AAAA")).toBe(false);
    expect(await verifyDummy("anything")).toBe(false);
  });
});

describe("storage abstraction", () => {
  it("rejects keys that could escape the storage root", () => {
    for (const bad of ["/etc/passwd", "../x", "a/../../b", "a//b", "a\\b", "", "a/./b"]) expect(() => assertKey(bad)).toThrow(StorageKeyError);
    expect(() => assertKey("brands/b1/creatives/c1.png")).not.toThrow();
  });
  it("writes atomically, including concurrent writes of the same key", async () => {
    const disk = localDisk(fs.mkdtempSync(path.join(os.tmpdir(), "bp-store-")));
    const key = "brands/b/creatives/same.png";
    await Promise.all(Array.from({ length: 8 }, (_, i) => disk.put(key, Buffer.from(`v${i}`), "image/png")));
    expect((await disk.get(key)).toString()).toMatch(/^v\d$/);
    expect(await disk.exists(key)).toBe(true);
    await disk.remove(key);
    expect(await disk.exists(key)).toBe(false);
    expect(await disk.health()).toEqual({ ok: true });
  });
  it("uses the configured driver", () => {
    expect(storage.driver).toBe("local");
  });
});

describe("readiness", () => {
  it("reports database, migrations, storage and config without exposing values", async () => {
    // Open the database first: readiness allows 3s, and the first getDb() here also creates the
    // test database and applies every migration (took ~4s on a CI runner, so the check timed out).
    await getDb();
    const r = await readiness();
    expect(r.checks.database.ok).toBe(true);
    expect(r.checks.migrations).toMatchObject({ ok: true, detail: `${expectedMigrations().length}/${expectedMigrations().length} applied` });
    expect(r.checks.storage.ok).toBe(true);
    const text = JSON.stringify(r);
    for (const secretish of ["postgres://", process.env.STORAGE_DIR!, "APP_SECRET"]) expect(text).not.toContain(secretish);
  });
});

describe("audit log", () => {
  it("records events with hashed IPs and redacted details, and lists them per workspace", async () => {
    const db = await getDb();
    const [w] = await db.insert(schema.workspaces).values({ name: "Audit Co" }).returning();
    await audit({ action: "member.role_change", workspaceId: w.id, actorUserId: "u1", targetType: "member", targetId: "m1", ip: "203.0.113.9", details: { from: "viewer", to: "editor", apiKey: "sk-should-not-be-stored", note: "Bearer abcdefghijklmnopqrstuvwxyz" } });
    const [row] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.workspaceId, w.id)).orderBy(desc(schema.auditEvents.createdAt));
    expect(row.action).toBe("member.role_change");
    expect(row.ipHash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(row)).not.toContain("203.0.113.9");
    expect(JSON.stringify(row.details)).not.toContain("sk-should-not-be-stored");
    expect(JSON.stringify(row.details)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect((await auditTrail(w.id)).map((e) => e.id)).toContain(row.id);
  });
  it("never breaks the action it records", async () => {
    await expect(audit({ action: "auth.login", details: { circular: undefined } })).resolves.toBeUndefined();
  });
});

describe("migration 0007 on an existing database", () => {
  it("adds the audit table and tenant indexes without touching existing rows", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite-pgvector");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const src = path.join(process.cwd(), "drizzle");
    const old = fs.mkdtempSync(path.join(os.tmpdir(), "bp-mig7-"));
    fs.mkdirSync(path.join(old, "meta"));
    const journal = JSON.parse(fs.readFileSync(path.join(src, "meta/_journal.json"), "utf8"));
    const before = journal.entries.filter((e: { idx: number }) => e.idx < 7);
    for (const e of before) fs.copyFileSync(path.join(src, `${e.tag}.sql`), path.join(old, `${e.tag}.sql`));
    fs.writeFileSync(path.join(old, "meta/_journal.json"), JSON.stringify({ ...journal, entries: before }));
    const client = await PGlite.create({ extensions: { vector } });
    await client.exec("create extension if not exists vector");
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: old });
    await client.exec(`
      insert into workspaces (id, name) values ('w1', 'Legacy');
      insert into brands (id, workspace_id, name) values ('b1', 'w1', 'Legacy Co');
      insert into campaigns (id, brand_id, name, type, objective, start_date, end_date) values ('c1', 'b1', 'Spring', 'launch', 'sales', now(), now());
    `);
    expect((await migrationStatus(db, old)).upToDate).toBe(true);
    expect((await migrationStatus(db, src)).pending).toBe(journal.entries.length - 7);
    await migrate(db, { migrationsFolder: src });
    expect((await migrationStatus(db, src)).upToDate).toBe(true);
    const idx = await client.query<{ indexname: string }>("select indexname from pg_indexes where indexname in ('campaigns_brand_idx','competitors_brand_idx','audit_ws_time_idx') order by indexname");
    expect(idx.rows.map((r) => r.indexname)).toEqual(["audit_ws_time_idx", "campaigns_brand_idx", "competitors_brand_idx"]);
    expect((await client.query("select id from campaigns")).rows).toHaveLength(1);
    await client.close();
  });
});

describe("migration 0008 on an existing database", () => {
  it("adds the usage ledger and route overrides, and backfills each run's organisation", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite-pgvector");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const src = path.join(process.cwd(), "drizzle");
    const old = fs.mkdtempSync(path.join(os.tmpdir(), "bp-mig8-"));
    fs.mkdirSync(path.join(old, "meta"));
    const journal = JSON.parse(fs.readFileSync(path.join(src, "meta/_journal.json"), "utf8"));
    const before = journal.entries.filter((e: { idx: number }) => e.idx < 8);
    for (const e of before) fs.copyFileSync(path.join(src, `${e.tag}.sql`), path.join(old, `${e.tag}.sql`));
    fs.writeFileSync(path.join(old, "meta/_journal.json"), JSON.stringify({ ...journal, entries: before }));
    const client = await PGlite.create({ extensions: { vector } });
    await client.exec("create extension if not exists vector");
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: old });
    await client.exec(`
      insert into workspaces (id, name) values ('w1', 'Legacy');
      insert into brands (id, workspace_id, name) values ('b1', 'w1', 'Legacy Co');
      insert into agent_runs (id, brand_id, agent, task, status, cost_usd) values ('r1', 'b1', 'copywriter', 'Caption', 'succeeded', 0.0123);
      insert into agent_runs (id, brand_id, agent, task, status) values ('r2', null, 'copywriter', 'Orphan', 'failed');
    `);
    await migrate(db, { migrationsFolder: src });
    expect((await migrationStatus(db, src)).upToDate).toBe(true);
    const runs = await client.query<{ id: string; workspace_id: string | null; cost_usd: number | null }>("select id, workspace_id, cost_usd from agent_runs order by id");
    expect(runs.rows).toEqual([
      { id: "r1", workspace_id: "w1", cost_usd: expect.closeTo(0.0123, 6) },
      { id: "r2", workspace_id: null, cost_usd: null },
    ]);
    const tables = await client.query<{ tablename: string }>("select tablename from pg_tables where tablename in ('usage_events','ai_routes') order by tablename");
    expect(tables.rows.map((r) => r.tablename)).toEqual(["ai_routes", "usage_events"]);
    await client.close();
  });
});

describe("member audit trail", () => {
  it("records real member changes with the acting user (access rules: audit-access.test.ts)", async () => {
    const { changeRoleFor, inviteMemberFor } = await import("./members");
    const { auditTrailFor } = await import("./audit");
    const db = await getDb();
    const [owner] = await db.insert(schema.users).values({ email: "own@x.test", name: "Owner", passwordHash: "x" }).returning();
    await db.insert(schema.users).values({ email: "ed@x.test", name: "Editor", passwordHash: "x" });
    const [w] = await db.insert(schema.workspaces).values({ name: "Agency", plan: "agency" }).returning();
    await db.insert(schema.workspaceMembers).values({ workspaceId: w.id, userId: owner.id, role: "owner" });
    const sess = { sessionId: "s-owner", activeBrandId: null, user: { id: owner.id, email: owner.email, name: owner.name } };

    const invited = await inviteMemberFor(sess, w.id, "ed@x.test", "viewer");
    await changeRoleFor(sess, w.id, invited.id, "editor");
    const { rows } = await auditTrailFor(sess, w.id);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["member.invite", "member.role_change", "audit.view"]));
    expect(rows.find((r) => r.action === "member.role_change")).toMatchObject({ actorName: "Owner", details: { from: "viewer", to: "editor" } });
  });
});

describe("outbound request allowlists", () => {
  it("fetches font files only from Google's font CDN", async () => {
    const { isGoogleFontFile } = await import("./creative/render");
    expect(isGoogleFontFile("https://fonts.gstatic.com/s/inter/v13/a.woff2")).toBe(true);
    for (const bad of ["http://fonts.gstatic.com/a.woff2", "https://evil.example/a.woff2", "https://fonts.gstatic.com.evil.example/a", "https://fonts.gstatic.com:8443/a", "https://user:pw@fonts.gstatic.com/a", "file:///etc/passwd", "not a url"]) {
      expect(isGoogleFontFile(bad)).toBe(false);
    }
  });
  it("sends LinkedIn bearer tokens only to LinkedIn's HTTPS hosts", async () => {
    const { isLinkedInUploadUrl } = await import("./social/providers/others");
    expect(isLinkedInUploadUrl("https://www.linkedin.com/dms-uploads/abc?ca=x")).toBe(true);
    expect(isLinkedInUploadUrl("https://api.linkedin.com/rest/images/upload")).toBe(true);
    for (const bad of ["http://www.linkedin.com/x", "https://linkedin.com.evil.example/x", "https://evillinkedin.com/x", "https://169.254.169.254/latest", "https://www.linkedin.com:444/x"]) {
      expect(isLinkedInUploadUrl(bad)).toBe(false);
    }
  });
});

describe("error handling and monitoring", () => {
  it("never shows database or system error messages to users; gives a reference instead", async () => {
    const { safe } = await import("./action");
    const pg = Object.assign(new Error('duplicate key value violates unique constraint "users_email_unique"'), { code: "23505", severity: "ERROR" });
    const sys = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED", errno: -111, syscall: "connect" });
    for (const e of [pg, sys]) {
      const r = await safe(async () => {
        throw e;
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toMatch(/Something went wrong on our side.*Reference [0-9a-f]{8}/);
        expect(r.error).not.toMatch(/constraint|ECONNREFUSED|10\.0\.0\.5/);
      }
    }
    // Intentional, user-facing messages still reach the user.
    const ok = await safe(async () => {
      throw new Error("Enter a competitor name.");
    });
    expect(ok).toMatchObject({ ok: false, error: "Enter a competitor name." });
  });

  it("forwards captured errors to registered reporters with a reference", async () => {
    const { addErrorReporter, captureError } = await import("./monitoring");
    const seen: string[] = [];
    addErrorReporter((_e, ctx) => {
      seen.push(ctx.ref);
    });
    const ref = captureError(new Error("boom"), { where: "test" });
    expect(seen).toContain(ref);
  });
});

describe("email interface", () => {
  it("logs instead of sending until a provider is chosen, and never claims delivery", async () => {
    const { sendEmail } = await import("./email");
    expect(await sendEmail({ to: "owner@example.com", subject: "Credits at 90%", text: "secret body" })).toEqual({ delivered: false, provider: "log" });
  });
  it("refuses in staging/production so a missing provider can't go unnoticed", async () => {
    const { emailProvider, EmailNotConfigured } = await import("./email");
    const prev = process.env.DEPLOY_ENV;
    process.env.DEPLOY_ENV = "production";
    try {
      expect(() => emailProvider()).toThrow(EmailNotConfigured);
    } finally {
      process.env.DEPLOY_ENV = prev;
    }
  });
});

describe("request IDs", () => {
  it("adds an X-Request-Id to responses, keeping a well-formed one from the load balancer", async () => {
    const { NextRequest } = await import("next/server");
    const { middleware } = await import("../middleware");
    const fresh = middleware(new NextRequest("http://localhost/dashboard"));
    expect(fresh.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    const kept = middleware(new NextRequest("http://localhost/api/health/live", { headers: { "x-request-id": "lb-abc12345" } }));
    expect(kept.headers.get("x-request-id")).toBe("lb-abc12345");
    const junk = middleware(new NextRequest("http://localhost/dashboard", { headers: { "x-request-id": "<script>" } }));
    expect(junk.headers.get("x-request-id")).not.toBe("<script>");
  });
});
