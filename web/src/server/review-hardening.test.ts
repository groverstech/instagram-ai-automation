import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";

process.env.AI_PROVIDER = "mock";
process.env.PGLITE_DIR = "memory://";
process.env.IMAGE_PROVIDER = "none";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-rev-"));

const { getDb, schema } = await import("./db/client");
const { mockActive, aiStatus, isServiceError, friendlyAIError, AIConfigError, AIRefusalError } = await import("./ai/llm");
const { prepareImage, generateBrandProfile, analyzeAssets } = await import("./agents/brand");
const { buildContext, profileOf } = await import("./agents/context");
const { requireBrandForUser } = await import("./auth/guard");
const { remember, recall } = await import("./memory");
const { storage } = await import("./storage");
const { MIME } = await import("./assets");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AI provider safety and error handling", () => {
  it("ignores AI_PROVIDER=mock in production unless explicitly allowed", () => {
    const env = process.env as Record<string, string | undefined>;
    const prev = env.NODE_ENV;
    try {
      env.NODE_ENV = "production";
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(mockActive()).toBe(false);
      expect(aiStatus().provider).toBe("anthropic");
      env.AI_ALLOW_MOCK_IN_PRODUCTION = "true";
      expect(mockActive()).toBe(true);
    } finally {
      env.NODE_ENV = prev;
      delete env.AI_ALLOW_MOCK_IN_PRODUCTION;
      vi.restoreAllMocks();
    }
  });

  it("classifies service errors and turns them into readable messages", () => {
    const rate = Anthropic.APIError.generate(429, { type: "error" }, "rate limited", new Headers());
    const down = Anthropic.APIError.generate(529, { type: "error" }, "overloaded", new Headers());
    const auth = Anthropic.APIError.generate(401, { type: "error" }, "bad key", new Headers());
    const bad = Anthropic.APIError.generate(400, { type: "error" }, "invalid image", new Headers());
    const conn = new Anthropic.APIConnectionError({ message: "ECONNRESET" });
    expect([rate, down, auth, conn, new AIConfigError("x")].every(isServiceError)).toBe(true);
    expect(isServiceError(bad)).toBe(false);
    expect(isServiceError(new Error("No readable content"))).toBe(false);
    expect(friendlyAIError(rate)).toMatch(/rate-limiting/);
    expect(friendlyAIError(down)).toMatch(/temporarily unavailable/);
    expect(friendlyAIError(auth)).toMatch(/ANTHROPIC_API_KEY/);
    expect(friendlyAIError(conn)).toMatch(/Couldn't reach/);
    expect(friendlyAIError(new AIRefusalError("declined"))).toBe("declined");
    expect(friendlyAIError(new Error("db down"))).toBeNull();
    for (const e of [rate, down, auth, bad]) expect(friendlyAIError(e)).not.toContain("{");
  });
});

describe("image preparation for Claude vision", () => {
  it("downscales large images and keeps transparency", async () => {
    const big = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: "#B5643C" } }).jpeg().toBuffer();
    const out = await prepareImage(big, MIME.jpeg);
    const meta = await sharp(out.data).metadata();
    expect(out.mime).toBe("image/jpeg");
    expect(Math.max(meta.width!, meta.height!)).toBe(1568);
    const alpha = await sharp({ create: { width: 3000, height: 3000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    expect((await prepareImage(alpha, MIME.png)).mime).toBe("image/png");
  });

  it("leaves small images untouched and flattens GIFs", async () => {
    const small = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#222" } }).png().toBuffer();
    const same = await prepareImage(small, MIME.png);
    expect(same.data).toBe(small);
    const gif = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#222" } }).gif().toBuffer();
    expect((await prepareImage(gif, MIME.gif)).mime).toMatch(/png|jpeg/);
  });
});

describe("multi-organisation, multi-brand isolation", () => {
  let agency = "";
  let orgA = "";
  let orgB = "";
  let a1 = "";
  let a2 = "";
  let b1 = "";

  beforeAll(async () => {
    const db = await getDb();
    const [u] = await db.insert(schema.users).values({ email: "agency@example.com", name: "Agency", passwordHash: "x" }).returning();
    const [wa] = await db.insert(schema.workspaces).values({ name: "Org A", plan: "growth" }).returning();
    const [wb] = await db.insert(schema.workspaces).values({ name: "Org B" }).returning();
    await db.insert(schema.workspaceMembers).values([
      { workspaceId: wa.id, userId: u.id, role: "admin" },
      { workspaceId: wb.id, userId: u.id, role: "viewer" },
    ]);
    const brands = await db
      .insert(schema.brands)
      .values([
        { workspaceId: wa.id, name: "A One", tone: "Calm" },
        { workspaceId: wa.id, name: "A Two", tone: "Loud" },
        { workspaceId: wb.id, name: "B One", tone: "Formal" },
      ])
      .returning();
    [agency, orgA, orgB] = [u.id, wa.id, wb.id];
    [a1, a2, b1] = brands.map((b) => b.id);
  });

  const sess = () => ({ sessionId: "s", activeBrandId: null, user: { id: agency, email: "", name: "" } });

  it("applies the user's role per organisation", async () => {
    await expect(requireBrandForUser(sess(), a1, "admin")).resolves.toMatchObject({ role: "admin" });
    await expect(requireBrandForUser(sess(), a2, "editor")).resolves.toBeTruthy();
    await expect(requireBrandForUser(sess(), b1, "viewer")).resolves.toMatchObject({ role: "viewer" });
    await expect(requireBrandForUser(sess(), b1, "editor")).rejects.toThrow(/editor/);
  });

  it("keeps memory, instructions and profiles separate for brands in the same and different organisations", async () => {
    const db = await getDb();
    await remember(a1, [{ kind: "instruction", content: "A1 rule: always mention repairs", source: "user:instruction" }]);
    await remember(a2, [{ kind: "fact", content: "A2 fact about neon sneakers", source: "test" }]);
    await remember(b1, [{ kind: "fact", content: "B1 fact about tax audits", source: "test" }]);
    const [brandA1] = await db.select().from(schema.brands).where(eq(schema.brands.id, a1));
    await generateBrandProfile({ brandId: a1, userId: agency }, brandA1);

    const [ctxA2, ctxB1] = await Promise.all(
      [a2, b1].map(async (id) => {
        const [b] = await db.select().from(schema.brands).where(eq(schema.brands.id, id));
        return buildContext(b, "repairs neon sneakers tax audits");
      }),
    );
    expect(ctxA2.instructions).toEqual([]);
    expect(ctxA2.profile).toBeNull();
    expect(ctxA2.memories.map((m) => m.content)).toEqual(["A2 fact about neon sneakers"]);
    expect(ctxB1.memories.map((m) => m.content)).toEqual(["B1 fact about tax audits"]);
    const recalled = await recall(a1, "neon sneakers tax audits", 20);
    expect(recalled.every((m) => m.content.startsWith("A1"))).toBe(true);
    expect(orgA).not.toBe(orgB);
  });
});

describe("AI failures don't poison assets", () => {
  it("a missing API key stops analysis without marking assets as failed", async () => {
    const db = await getDb();
    const [ws] = await db.insert(schema.workspaces).values({ name: "NoKey" }).returning();
    const [brand] = await db.insert(schema.brands).values({ workspaceId: ws.id, name: "NoKey Co" }).returning();
    const key = `brands/${brand.id}/assets/n.txt`;
    await storage.put(key, Buffer.from("Our tone is warm."), MIME.text);
    await db.insert(schema.brandAssets).values({ brandId: brand.id, kind: "document", name: "n.txt", path: key, mime: MIME.text, size: 17 });

    const env = process.env as Record<string, string | undefined>;
    const saved = { p: env.AI_PROVIDER, k: env.ANTHROPIC_API_KEY, t: env.ANTHROPIC_AUTH_TOKEN };
    env.AI_PROVIDER = "";
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    try {
      await expect(generateBrandProfile({ brandId: brand.id, userId: "u" }, brand)).rejects.toBeInstanceOf(AIConfigError);
      const [asset] = await db.select().from(schema.brandAssets).where(eq(schema.brandAssets.brandId, brand.id));
      expect(asset.analysisError).toBeNull();
      expect(asset.analysis).toBeNull();
    } finally {
      env.AI_PROVIDER = saved.p;
      if (saved.k) env.ANTHROPIC_API_KEY = saved.k;
      if (saved.t) env.ANTHROPIC_AUTH_TOKEN = saved.t;
    }
    // With the provider back, the same asset is analysed normally.
    expect(await analyzeAssets({ brandId: brand.id, userId: "u" }, brand)).toEqual({ analyzed: 1, failed: 0 });
  });

  it("re-analysis retries assets that failed earlier", async () => {
    const db = await getDb();
    const [ws] = await db.insert(schema.workspaces).values({ name: "Retry" }).returning();
    const [brand] = await db.insert(schema.brands).values({ workspaceId: ws.id, name: "Retry Co" }).returning();
    const key = `brands/${brand.id}/assets/r.txt`;
    await storage.put(key, Buffer.from("Values: honesty."), MIME.text);
    await db.insert(schema.brandAssets).values({ brandId: brand.id, kind: "document", name: "r.txt", path: key, mime: MIME.text, size: 16, analysisError: "Earlier outage" });
    const { assets } = await generateBrandProfile({ brandId: brand.id, userId: "u" }, brand);
    expect(assets).toEqual({ analyzed: 1, failed: 0 });
  });
});

describe("migration upgrade from a pre-phase database", () => {
  it("applies 0002 and 0003 on top of existing data and keeps legacy profiles readable", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite-pgvector");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const src = path.join(process.cwd(), "drizzle");
    const old = fs.mkdtempSync(path.join(os.tmpdir(), "bp-mig-"));
    fs.mkdirSync(path.join(old, "meta"));
    const journal = JSON.parse(fs.readFileSync(path.join(src, "meta/_journal.json"), "utf8"));
    // State of main before this branch: migrations 0000 and 0001 only.
    const before = journal.entries.filter((e: { idx: number }) => e.idx < 2);
    for (const e of before) fs.copyFileSync(path.join(src, `${e.tag}.sql`), path.join(old, `${e.tag}.sql`));
    fs.writeFileSync(path.join(old, "meta/_journal.json"), JSON.stringify({ ...journal, entries: before }));

    const client = await PGlite.create({ extensions: { vector } });
    await client.exec("create extension if not exists vector");
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: old });
    // State as on main before this branch: v1 profile row, no new columns.
    await client.exec(`
      insert into workspaces (id, name) values ('w1', 'Legacy');
      insert into brands (id, workspace_id, name) values ('b1', 'w1', 'Legacy Co');
      insert into brand_profiles (id, brand_id, version, status, data)
        values ('p1', 'b1', 1, 'approved', '{"summary":"Legacy summary","positioning":{"statement":"Old","category":"X","differentiators":[]},"usps":["Durable"]}');
      insert into assistant_messages (id, brand_id, user_id, role, content) values ('m1', 'b1', 'u', 'user', 'hi');
    `);
    await migrate(db, { migrationsFolder: src });

    const row = (await client.query<{ schema_version: number; section_status: unknown; data: unknown; id: string; version: number }>("select * from brand_profiles where id = 'p1'")).rows[0];
    expect(row.schema_version).toBe(1);
    expect(row.section_status).toEqual({});
    const p = profileOf({ id: row.id, version: row.version, schemaVersion: row.schema_version, data: row.data } as never)!;
    expect(p.summary).toBe("Legacy summary");
    expect(p.identity.usps[0]).toMatchObject({ text: "Durable", source: "inferred" });
    const msg = (await client.query<{ channel: string }>("select channel from assistant_messages where id = 'm1'")).rows[0];
    expect(msg.channel).toBe("workflow");
    const asset = await client.query("select column_name from information_schema.columns where table_name = 'brand_assets' and column_name in ('status','analysis_error','extracted_text')");
    expect(asset.rows).toHaveLength(3);
    const rl = await client.query("select table_name from information_schema.tables where table_name in ('rate_limit_buckets','ai_task_leases')");
    expect(rl.rows).toHaveLength(2);
    await client.close();
  });
});
