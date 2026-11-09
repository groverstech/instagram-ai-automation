import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { desc, eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.AI_PROVIDER = "mock";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-infra-"));

const { checkConfig, isStrict, deployEnv, enforceConfig } = await import("./config");
const { clientIp } = await import("./client-ip");
const { hashPassword, verifyPassword, needsRehash, verifyDummy } = await import("./auth/password");
const { storage, localDisk, assertKey, StorageKeyError } = await import("./storage");
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
    expect((await migrationStatus(db, src)).pending).toBe(1);
    await migrate(db, { migrationsFolder: src });
    expect((await migrationStatus(db, src)).upToDate).toBe(true);
    const idx = await client.query<{ indexname: string }>("select indexname from pg_indexes where indexname in ('campaigns_brand_idx','competitors_brand_idx','audit_ws_time_idx') order by indexname");
    expect(idx.rows.map((r) => r.indexname)).toEqual(["audit_ws_time_idx", "campaigns_brand_idx", "competitors_brand_idx"]);
    expect((await client.query("select id from campaigns")).rows).toHaveLength(1);
    await client.close();
  });
});

describe("security log access and member audit trail", () => {
  it("records real member changes, and only unscoped owners/admins can read the log", async () => {
    const { changeRoleFor, inviteMemberFor } = await import("./members");
    const { auditTrailFor } = await import("./audit");
    const db = await getDb();
    const [owner] = await db.insert(schema.users).values({ email: "own@x.test", name: "Owner", passwordHash: "x" }).returning();
    const [client] = await db.insert(schema.users).values({ email: "cli@x.test", name: "Client", passwordHash: "x" }).returning();
    const [editor] = await db.insert(schema.users).values({ email: "ed@x.test", name: "Editor", passwordHash: "x" }).returning();
    const [w] = await db.insert(schema.workspaces).values({ name: "Agency", plan: "agency" }).returning();
    const [b] = await db.insert(schema.brands).values({ workspaceId: w.id, name: "Client Brand" }).returning();
    await db.insert(schema.workspaceMembers).values([
      { workspaceId: w.id, userId: owner.id, role: "owner" },
      { workspaceId: w.id, userId: client.id, role: "editor", brandIds: [b.id] },
    ]);
    const sess = (u: { id: string; email: string; name: string }) => ({ sessionId: `s-${u.id}`, activeBrandId: null, user: { id: u.id, email: u.email, name: u.name } });

    const invited = await inviteMemberFor(sess(owner), w.id, "ed@x.test", "viewer");
    await changeRoleFor(sess(owner), w.id, invited.id, "editor");
    const log = await auditTrailFor(sess(owner), w.id);
    expect(log.map((r) => r.action)).toEqual(expect.arrayContaining(["member.invite", "member.role_change"]));
    expect(log.find((r) => r.action === "member.role_change")).toMatchObject({ actorName: "Owner", details: { from: "viewer", to: "editor" } });

    await expect(auditTrailFor(sess(client), w.id)).rejects.toThrow(); // brand-scoped client
    await expect(auditTrailFor(sess(editor), w.id)).rejects.toThrow(); // editor, not admin
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
